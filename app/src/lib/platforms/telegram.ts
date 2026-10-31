import { DriverError, type DriverChannel, type DriverContext, type MediaAsset, type PublishInput, type UploadState } from "@/social/types";
import type { PlatformDriver } from "./extras";
import { asNumber, asRecord, asString, call, fileName, multipart, retryAfterMs, textWithLink, type HttpResponse, type MultipartPart, type PublishResultWithUsage } from "./http";

/**
 * Telegram channels and groups through a bot (@BotFather token) that is an administrator of the
 * chat. Plain text (no parse mode, so nothing needs MarkdownV2 escaping), photos, videos, GIFs and
 * albums (sendMediaGroup, 2-10 items). Media is passed by URL when Telegram can fetch it (≤ 5 MB
 * photos, ≤ 20 MB other files) and streamed as multipart otherwise. No analytics in the Bot API.
 * Docs: core.telegram.org/bots/api.
 */

export const TELEGRAM_API = "https://api.telegram.org";
const P = "telegram" as const;
const MB = 1024 * 1024;
const TOKEN_RE = /^\d{5,15}:[A-Za-z0-9_-]{30,64}$/;

function tgError(ctx: DriverContext, res: HttpResponse): DriverError {
  const d = asRecord(res.data);
  const description = asString(d.description) || `HTTP ${res.status}`;
  const code = asString(d.error_code) || String(res.status);
  const base = { status: res.status, code, platform: P };
  if (res.status === 429) return new DriverError(description, "rate_limit", { ...base, retryAfterMs: retryAfterMs(res.headers, ctx.now(), asRecord(d.parameters).retry_after) ?? 30_000 });
  if (res.status === 401 || res.status === 404) return new DriverError("Telegram rejected the bot token.", "auth", base);
  if (res.status === 403 || /chat not found|not enough rights|need administrator|CHAT_ADMIN_REQUIRED|bot is not a member/i.test(description)) return new DriverError(description, "auth", base);
  if (/HTTP URL|wrong file|file is too big|failed to get|IMAGE_PROCESS_FAILED|PHOTO_INVALID|wrong type of the web page content/i.test(description)) return new DriverError(description, "media", base);
  if (res.status >= 500) return new DriverError(description, "network", base);
  return new DriverError(description, "validation", base);
}

function method<T = Record<string, unknown>>(ctx: DriverContext, botToken: string, name: string, options: { json?: unknown; body?: BodyInit; contentType?: string; length?: number } = {}) {
  return call<{ ok: boolean; result: T }>(ctx, P, `${TELEGRAM_API}/bot${botToken}/${name}`, {
    method: "POST",
    json: options.json,
    body: options.body,
    headers: options.contentType ? { "Content-Type": options.contentType } : {},
    contentLength: options.length,
    mapError: (r) => tgError(ctx, r),
  });
}

const creds = (c: DriverChannel) => {
  const botToken = c.credentials.botToken ?? "";
  const chatId = c.credentials.chatId ?? c.externalId;
  if (!botToken) throw new DriverError("The bot token is missing: reconnect the channel.", "auth", { platform: P });
  return { botToken, chatId };
};

/** Public link of a message: t.me/<username>/<id>, or t.me/c/<internal id>/<id> for private chats. */
export function telegramLink(chat: { id: string; username?: string }, messageId: number | string): string {
  if (chat.username) return `https://t.me/${chat.username.replace(/^@/, "")}/${messageId}`;
  const internal = chat.id.replace(/^-100/, "");
  return /^\d+$/.test(internal) ? `https://t.me/c/${internal}/${messageId}` : "";
}

const byUrl = (m: MediaAsset) => /^https:\/\//.test(m.url) && m.size <= (m.kind === "image" ? 5 * MB : 20 * MB);
const sendKind = (m: MediaAsset) => (m.kind === "video" ? "video" : m.kind === "gif" ? "animation" : "photo");

export const telegramDriver: PlatformDriver = {
  platform: P,

  async connectStart() {
    return {
      kind: "form",
      fields: [
        { name: "botToken", label: "dash.channels.form.tgToken", type: "password", placeholder: "123456789:AA…", hint: "dash.channels.form.tgTokenHint", required: true },
        { name: "chatId", label: "dash.channels.form.tgChat", type: "text", placeholder: "@mychannel", hint: "dash.channels.form.tgChatHint", required: true },
      ],
    };
  },

  async connectFinish(ctx, input) {
    const botToken = (input.form.botToken ?? "").trim();
    let chatId = (input.form.chatId ?? "").trim().replace(/^https?:\/\/t\.me\//, "");
    if (!TOKEN_RE.test(botToken)) throw new DriverError("That doesn't look like a bot token from @BotFather (123456789:AA…).", "validation", { platform: P, code: "token" });
    if (!chatId) throw new DriverError("Enter the channel username (@name) or its numeric id.", "validation", { platform: P, code: "chat" });
    if (!/^-?\d+$/.test(chatId) && !chatId.startsWith("@")) chatId = `@${chatId}`;
    const me = await method(ctx, botToken, "getMe");
    const bot = asRecord(me.data.result);
    const chatRes = await method(ctx, botToken, "getChat", { json: { chat_id: chatId } });
    const chat = asRecord(chatRes.data.result);
    const id = asString(chat.id);
    const member = await method(ctx, botToken, "getChatMember", { json: { chat_id: id, user_id: asNumber(bot.id) } });
    const m = asRecord(member.data.result);
    const status = asString(m.status);
    const isChannel = asString(chat.type) === "channel";
    const canPost = isChannel ? status === "creator" || (status === "administrator" && m.can_post_messages !== false) : status !== "left" && status !== "kicked" && m.can_send_messages !== false;
    if (!canPost) {
      throw new DriverError(`Add @${asString(bot.username)} to the channel as an administrator with "Post messages" allowed, then try again.`, "validation", { platform: P, code: "not_admin" });
    }
    const username = asString(chat.username);
    return [
      {
        externalId: id,
        name: asString(chat.title) || [asString(chat.first_name), asString(chat.last_name)].filter(Boolean).join(" ") || username || id,
        handle: username ? `@${username}` : "",
        avatarUrl: "",
        profileUrl: username ? `https://t.me/${username}` : "",
        credentials: { botToken, chatId: id },
        tokenExpiresAt: null,
        meta: { chatType: asString(chat.type), username, botUsername: asString(bot.username) },
      },
    ];
  },

  async refresh() {
    return null;
  },

  async testConnection(ctx, channel) {
    try {
      const { botToken, chatId } = creds(channel);
      await method(ctx, botToken, "getMe");
      const res = await method(ctx, botToken, "getChat", { json: { chat_id: chatId } });
      const chat = asRecord(res.data.result);
      return { ok: true, account: { name: asString(chat.title) || channel.name, handle: chat.username ? `@${asString(chat.username)}` : channel.handle } };
    } catch (error) {
      return { ok: false, error: error instanceof DriverError ? error : new DriverError(String(error), "unknown", { platform: P }) };
    }
  },

  async publish(ctx, input: PublishInput): Promise<PublishResultWithUsage> {
    const { channel, content } = input;
    const { botToken, chatId } = creds(channel);
    const s = { ...input.target.uploadState };
    const save = async (patch: UploadState) => {
      Object.assign(s, patch);
      await input.saveState(patch);
    };
    const opts = content.options.telegram;
    const common = { chat_id: chatId, ...(opts?.silent ? { disable_notification: true } : {}) };
    const text = textWithLink(content);
    const media = input.media.slice(0, 10);
    const ids: number[] = Array.isArray(s.messageIds) ? (s.messageIds as unknown[]).map(Number) : [];
    if (!s.sent) {
      if (!text && !media.length) throw new DriverError("The post is empty.", "validation", { platform: P });
      const captionFits = text.length <= 1024;
      const caption = media.length && captionFits ? text : "";
      await save({ sending: true });
      if (media.length === 1) {
        const m = media[0];
        const kind = sendKind(m);
        const name = `send${kind[0].toUpperCase()}${kind.slice(1)}`;
        let res: HttpResponse<{ ok: boolean; result: Record<string, unknown> }>;
        if (byUrl(m)) {
          res = await method(ctx, botToken, name, { json: { ...common, [kind]: m.url, ...(caption ? { caption } : {}) } });
        } else {
          const parts: MultipartPart[] = [
            { name: "chat_id", value: chatId },
            ...(opts?.silent ? [{ name: "disable_notification", value: "true" }] : []),
            ...(caption ? [{ name: "caption", value: caption }] : []),
            { name: kind, filename: fileName(m), contentType: m.mime, size: m.size, open: () => m.open() },
          ];
          const body = multipart(parts);
          res = await method(ctx, botToken, name, { body: body.body, contentType: body.contentType, length: body.length });
        }
        ids.push(asNumber(res.data.result.message_id) ?? 0);
      } else if (media.length > 1) {
        const uploads: MultipartPart[] = [];
        const items = media.map((m, i) => {
          const type = m.kind === "video" ? "video" : "photo";
          let ref = m.url;
          if (!byUrl(m)) {
            ref = `attach://file${i}`;
            uploads.push({ name: `file${i}`, filename: fileName(m), contentType: m.mime, size: m.size, open: () => m.open() });
          }
          return { type, media: ref, ...(i === 0 && caption ? { caption } : {}) };
        });
        let res: HttpResponse<{ ok: boolean; result: unknown }>;
        if (uploads.length) {
          const body = multipart([{ name: "chat_id", value: chatId }, ...(opts?.silent ? [{ name: "disable_notification", value: "true" }] : []), { name: "media", value: JSON.stringify(items) }, ...uploads]);
          res = await method(ctx, botToken, "sendMediaGroup", { body: body.body, contentType: body.contentType, length: body.length });
        } else {
          res = await method(ctx, botToken, "sendMediaGroup", { json: { ...common, media: items } });
        }
        for (const raw of Array.isArray(res.data.result) ? res.data.result : []) ids.push(asNumber(asRecord(raw).message_id) ?? 0);
      }
      if (!media.length || (text && !captionFits)) {
        const res = await method(ctx, botToken, "sendMessage", { json: { ...common, text, ...(opts?.disablePreview ? { link_preview_options: { is_disabled: true } } : {}) } });
        ids.push(asNumber(res.data.result.message_id) ?? 0);
      }
      await save({ sent: true, messageIds: ids });
    }
    const first = ids[0];
    if (!first) throw new DriverError("Telegram didn't return the message id.", "unknown", { platform: P });
    const username = asString(channel.meta.username);
    return { externalId: ids.join(","), permalink: telegramLink({ id: chatId, username }, first), usage: { posts: 1 } };
  },

  async deleteRemote(ctx, channel, externalId) {
    const { botToken, chatId } = creds(channel);
    const ids = externalId.split(",").map(Number).filter((n) => n > 0);
    if (ids.length) await method(ctx, botToken, "deleteMessages", { json: { chat_id: chatId, message_ids: ids } });
  },

  async fetchMetrics() {
    return []; // The Bot API has no view counts.
  },

  async findExisting(_ctx, input) {
    // Bots can't read a channel's history: only what we saved can tell.
    const ids = Array.isArray(input.uploadState.messageIds) ? (input.uploadState.messageIds as unknown[]).map(Number) : [];
    if (!input.uploadState.sent || !ids[0]) return null;
    const chatId = input.channel.credentials.chatId ?? input.channel.externalId;
    return { externalId: ids.join(","), permalink: telegramLink({ id: chatId, username: asString(input.channel.meta.username) }, ids[0]) };
  },
};
