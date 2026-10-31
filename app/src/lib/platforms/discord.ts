import { DriverError, type DriverChannel, type DriverContext, type PublishInput, type UploadState } from "@/social/types";
import type { PlatformDriver } from "./extras";
import { asNumber, asRecord, asString, call, fileName, multipart, retryAfterMs, textWithLink, type HttpResponse, type MultipartPart, type PublishResultWithUsage } from "./http";

/**
 * Discord channels through a pasted webhook URL (Channel settings → Integrations → Webhooks).
 * Messages are sent with ?wait=true so Discord returns the message (its id for delete), files go
 * as streamed multipart (files[n] + payload_json with alt text descriptions). Forum channels need
 * a thread name. No analytics.
 * Docs: docs.discord.com/developers/resources/webhook#execute-webhook.
 */

const P = "discord" as const;
const WEBHOOK_RE = /^https:\/\/(?:(?:canary|ptb)\.)?(?:discord|discordapp)\.com\/api(?:\/v\d+)?\/webhooks\/(\d{15,25})\/([A-Za-z0-9_-]{30,100})\/?$/;

/** The canonical webhook URL, or null when the text isn't a Discord webhook URL. */
export function parseWebhookUrl(input: string): { url: string; id: string } | null {
  const m = WEBHOOK_RE.exec(input.trim());
  return m ? { url: `https://discord.com/api/webhooks/${m[1]}/${m[2]}`, id: m[1] } : null;
}

function dcError(ctx: DriverContext, res: HttpResponse): DriverError {
  const d = asRecord(res.data);
  const message = asString(d.message) || `HTTP ${res.status}`;
  const code = asString(d.code) || String(res.status);
  const base = { status: res.status, code, platform: P };
  if (res.status === 429) return new DriverError(message, "rate_limit", { ...base, retryAfterMs: retryAfterMs(res.headers, ctx.now(), d.retry_after) ?? 5_000 });
  if (res.status === 401 || res.status === 403 || code === "10015" || (res.status === 404 && /webhook/i.test(message))) return new DriverError("The Discord webhook was deleted or is invalid.", "auth", base);
  if (res.status === 413 || code === "40005") return new DriverError(message, "media", base);
  if (res.status >= 500) return new DriverError(message, "network", base);
  return new DriverError(message, "validation", base);
}

const hook = (c: DriverChannel) => {
  const url = c.credentials.webhookUrl;
  if (!url) throw new DriverError("The webhook URL is missing: reconnect the channel.", "auth", { platform: P });
  return url;
};

export const discordDriver: PlatformDriver = {
  platform: P,

  async connectStart() {
    return {
      kind: "form",
      fields: [{ name: "webhookUrl", label: "dash.channels.form.discordWebhook", type: "password", placeholder: "https://discord.com/api/webhooks/…", hint: "dash.channels.form.discordWebhookHint", required: true }],
    };
  },

  async connectFinish(ctx, input) {
    const parsed = parseWebhookUrl(input.form.webhookUrl ?? "");
    if (!parsed) throw new DriverError("Paste a Discord webhook URL (https://discord.com/api/webhooks/…).", "validation", { platform: P, code: "webhook" });
    const res = await call(ctx, P, parsed.url, { mapError: (r) => dcError(ctx, r) });
    const d = res.data;
    const avatar = asString(d.avatar);
    return [
      {
        externalId: asString(d.id) || parsed.id,
        name: asString(d.name) || "Discord webhook",
        handle: asString(d.channel_id) ? `#${asString(d.channel_id)}` : "",
        avatarUrl: avatar ? `https://cdn.discordapp.com/avatars/${asString(d.id)}/${avatar}.png` : "",
        profileUrl: asString(d.guild_id) && asString(d.channel_id) ? `https://discord.com/channels/${asString(d.guild_id)}/${asString(d.channel_id)}` : "",
        credentials: { webhookUrl: parsed.url },
        tokenExpiresAt: null,
        meta: { guildId: asString(d.guild_id), channelId: asString(d.channel_id) },
      },
    ];
  },

  async refresh() {
    return null;
  },

  async testConnection(ctx, channel) {
    try {
      const res = await call(ctx, P, hook(channel), { mapError: (r) => dcError(ctx, r) });
      return { ok: true, account: { name: asString(res.data.name) || channel.name } };
    } catch (error) {
      return { ok: false, error: error instanceof DriverError ? error : new DriverError(String(error), "unknown", { platform: P }) };
    }
  },

  async publish(ctx, input: PublishInput): Promise<PublishResultWithUsage> {
    const { channel, content } = input;
    const url = hook(channel);
    const s = { ...input.target.uploadState };
    const save = async (patch: UploadState) => {
      Object.assign(s, patch);
      await input.saveState(patch);
    };
    const done = asRecord(s.published);
    if (done.id) return { externalId: asString(done.externalId) || asString(done.id), permalink: asString(done.permalink), usage: { posts: 1 } };
    const opts = content.options.discord;
    const text = textWithLink(content);
    const media = input.media.slice(0, 10);
    if (!text && !media.length) throw new DriverError("The post is empty.", "validation", { platform: P });
    const payload: Record<string, unknown> = {
      content: text.slice(0, 2000),
      allowed_mentions: { parse: [] },
      ...(opts?.username ? { username: opts.username.slice(0, 80) } : {}),
      ...(opts?.avatarUrl ? { avatar_url: opts.avatarUrl } : {}),
      ...(opts?.threadName ? { thread_name: opts.threadName.slice(0, 100) } : {}),
      ...(media.length ? { attachments: media.map((m, i) => ({ id: i, filename: fileName(m), ...(m.altText ? { description: m.altText.slice(0, 1024) } : {}) })) } : {}),
    };
    await save({ sending: true });
    let res: HttpResponse;
    const target = `${url}?wait=true`;
    if (media.length) {
      const parts: MultipartPart[] = [{ name: "payload_json", value: JSON.stringify(payload) }, ...media.map((m, i) => ({ name: `files[${i}]`, filename: fileName(m), contentType: m.mime, size: m.size, open: () => m.open() }))];
      const body = multipart(parts);
      res = await call(ctx, P, target, { method: "POST", body: body.body, headers: { "Content-Type": body.contentType }, contentLength: body.length, mapError: (r) => dcError(ctx, r) });
    } else {
      res = await call(ctx, P, target, { method: "POST", json: payload, mapError: (r) => dcError(ctx, r) });
    }
    const d = asRecord(res.data);
    const id = asString(d.id);
    if (!id) throw new DriverError("Discord didn't return the message.", "unknown", { platform: P });
    const channelId = asString(d.channel_id) || asString(channel.meta.channelId);
    const guild = asString(channel.meta.guildId);
    const inThread = channelId && channelId !== asString(channel.meta.channelId);
    const externalId = inThread ? `${id}:${channelId}` : id;
    const permalink = guild && channelId ? `https://discord.com/channels/${guild}/${channelId}/${id}` : "";
    await save({ published: { id, externalId, permalink } });
    return { externalId, permalink, usage: { posts: 1, apiCalls: asNumber(1) } };
  },

  async deleteRemote(ctx, channel, externalId) {
    const [id, thread] = externalId.split(":");
    await call(ctx, P, `${hook(channel)}/messages/${id}`, { method: "DELETE", query: thread ? { thread_id: thread } : undefined, mapError: (r) => dcError(ctx, r) });
  },

  async fetchMetrics() {
    return [];
  },

  async findExisting(_ctx, input) {
    const done = asRecord(input.uploadState.published);
    return done.id ? { externalId: asString(done.externalId) || asString(done.id), permalink: asString(done.permalink) } : null;
  },
};
