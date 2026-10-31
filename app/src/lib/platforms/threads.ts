import { PLATFORM_CAPABILITIES } from "@/social/platforms";
import { DriverError, type DriverChannel, type DriverContext, type MediaAsset, type PostMetrics, type PublishInput, type UploadState } from "@/social/types";
import type { PlatformDriver } from "./extras";
import { asNumber, asRecord, asString, isoIn, requireApp, sameText, sinceMs, type PublishResultWithUsage } from "./http";
import { graph, metaWaitContainer } from "./meta";

/**
 * Threads (graph.threads.com): container → wait → threads_publish. Carousels of 2-20 items,
 * link attachments, reply control and a topic tag; thread parts and the first comment are
 * replies to the previous post (reply_to_id). Tokens: 1 h → 60 days, refreshed with
 * th_refresh_token once they are 24 h old.
 * Docs: developers.facebook.com/docs/threads/posts, /threads/get-started/long-lived-tokens.
 */

export const THREADS_ROOT = "https://graph.threads.com";
export const THREADS_API = `${THREADS_ROOT}/v1.0`;
const AUTHORIZE = "https://threads.com/oauth/authorize";
const P = "threads" as const;

const token = (c: DriverChannel) => {
  if (!c.credentials.accessToken) throw new DriverError("The channel has no access token: reconnect it.", "auth", { platform: P });
  return c.credentials.accessToken;
};

const flavor = { platform: P, base: THREADS_API };

/** Creates and publishes one Threads post; returns its id. Progress is saved under `key`. */
async function postOne(
  ctx: DriverContext,
  channel: DriverChannel,
  s: UploadState,
  save: (patch: UploadState) => Promise<void>,
  key: string,
  body: { text: string; media: MediaAsset[]; replyTo?: string; link?: string; replyControl?: string; topicTag?: string },
): Promise<string> {
  const done = asString(asRecord(s[key]).id);
  if (done) return done;
  const tok = token(channel);
  const user = channel.externalId;
  const create = (params: Record<string, string | boolean | undefined>) => graph(ctx, P, `${THREADS_API}/${user}/threads`, tok, { method: "POST", form: params });
  const common = {
    ...(body.replyTo ? { reply_to_id: body.replyTo } : {}),
    ...(body.replyControl && body.replyControl !== "everyone" ? { reply_control: body.replyControl } : {}),
    ...(body.topicTag ? { topic_tag: body.topicTag.replace(/^#/, "").slice(0, 50) } : {}),
  };
  const containerKey = `${key}Container`;
  let container = asString(s[containerKey]);
  if (!container) {
    const m = body.media;
    if (m.length > 1) {
      const childKey = `${key}Children`;
      const children: string[] = Array.isArray(s[childKey]) ? (s[childKey] as unknown[]).map(String) : [];
      for (let i = children.length; i < Math.min(m.length, 20); i++) {
        const item = m[i];
        const res = await create(
          item.kind === "video"
            ? { media_type: "VIDEO", video_url: item.url, is_carousel_item: true }
            : { media_type: "IMAGE", image_url: item.url, is_carousel_item: true, ...(item.altText ? { alt_text: item.altText.slice(0, 1000) } : {}) },
        );
        children.push(asString(res.data.id));
        await save({ [childKey]: [...children] });
      }
      for (const child of children) await metaWaitContainer(ctx, flavor, child, tok, "status");
      const res = await create({ media_type: "CAROUSEL", children: children.join(","), text: body.text, ...common });
      container = asString(res.data.id);
    } else if (m.length === 1) {
      const item = m[0];
      const res = await create(
        item.kind === "video"
          ? { media_type: "VIDEO", video_url: item.url, text: body.text, ...common }
          : { media_type: "IMAGE", image_url: item.url, text: body.text, ...(item.altText ? { alt_text: item.altText.slice(0, 1000) } : {}), ...common },
      );
      container = asString(res.data.id);
    } else {
      const res = await create({ media_type: "TEXT", text: body.text, ...(body.link ? { link_attachment: body.link } : {}), ...common });
      container = asString(res.data.id);
    }
    if (!container) throw new DriverError("Threads didn't create the post container.", "unknown", { platform: P });
    await save({ [containerKey]: container });
  }
  if (body.media.length) await metaWaitContainer(ctx, flavor, container, tok, "status");
  await save({ [`${key}Publishing`]: true });
  const pub = await graph(ctx, P, `${THREADS_API}/${user}/threads_publish`, tok, { method: "POST", form: { creation_id: container } });
  const id = asString(pub.data.id);
  if (!id) throw new DriverError("Threads didn't return the post id.", "unknown", { platform: P });
  await save({ [key]: { id } });
  return id;
}

export const threadsDriver: PlatformDriver = {
  platform: P,

  async connectStart(ctx, input) {
    const app = requireApp(ctx, P);
    const u = new URL(AUTHORIZE);
    u.searchParams.set("client_id", app.clientId);
    u.searchParams.set("redirect_uri", ctx.redirectUri);
    u.searchParams.set("scope", PLATFORM_CAPABILITIES.threads.auth.scopes.join(","));
    u.searchParams.set("response_type", "code");
    u.searchParams.set("state", input.state);
    return { kind: "redirect", url: u.toString() };
  },

  async connectFinish(ctx, input) {
    if (input.query.error) throw new DriverError(input.query.error_description || "The connection was cancelled.", "auth", { platform: P, code: input.query.error });
    const code = (input.query.code ?? "").replace(/#_$/, "");
    if (!code) throw new DriverError("No authorization code was returned.", "auth", { platform: P });
    const app = requireApp(ctx, P);
    const short = await graph(ctx, P, `${THREADS_ROOT}/oauth/access_token`, null, {
      method: "POST",
      form: { client_id: app.clientId, client_secret: app.clientSecret, code, grant_type: "authorization_code", redirect_uri: ctx.redirectUri },
    });
    const shortToken = asString(short.data.access_token);
    if (!shortToken) throw new DriverError("Threads returned no access token.", "auth", { platform: P });
    const long = await graph(ctx, P, `${THREADS_ROOT}/access_token`, null, { query: { grant_type: "th_exchange_token", client_secret: app.clientSecret, access_token: shortToken } });
    const tok = asString(long.data.access_token) || shortToken;
    const expiresAt = isoIn(ctx, asNumber(long.data.expires_in) ?? 60 * 86_400);
    const me = await graph(ctx, P, `${THREADS_API}/me`, tok, { query: { fields: "id,username,name,threads_profile_picture_url" } });
    const username = asString(me.data.username);
    return [
      {
        externalId: asString(me.data.id) || asString(short.data.user_id),
        name: asString(me.data.name) || username,
        handle: username ? `@${username}` : "",
        avatarUrl: asString(me.data.threads_profile_picture_url),
        profileUrl: username ? `https://www.threads.com/@${username}` : "",
        credentials: { accessToken: tok, expiresAt, scopes: PLATFORM_CAPABILITIES.threads.auth.scopes, extra: { issuedAt: new Date(ctx.now()).toISOString() } },
        tokenExpiresAt: expiresAt,
        meta: { metaUserId: asString(short.data.user_id) },
      },
    ];
  },

  async refresh(ctx, channel) {
    const issued = Date.parse(channel.credentials.extra?.issuedAt ?? "");
    if (Number.isFinite(issued) && ctx.now() - issued < 24 * 3_600_000) return null;
    const res = await graph(ctx, P, `${THREADS_ROOT}/refresh_access_token`, null, { query: { grant_type: "th_refresh_token", access_token: token(channel) } });
    const tok = asString(res.data.access_token);
    if (!tok) throw new DriverError("Threads didn't refresh the token.", "auth", { platform: P });
    const expiresAt = isoIn(ctx, asNumber(res.data.expires_in) ?? 60 * 86_400);
    return { credentials: { ...channel.credentials, accessToken: tok, expiresAt, extra: { ...(channel.credentials.extra ?? {}), issuedAt: new Date(ctx.now()).toISOString() } }, tokenExpiresAt: expiresAt };
  },

  async testConnection(ctx, channel) {
    try {
      const me = await graph(ctx, P, `${THREADS_API}/me`, token(channel), { query: { fields: "id,username,name,threads_profile_picture_url" } });
      const username = asString(me.data.username);
      return { ok: true, account: { name: asString(me.data.name) || username, handle: username ? `@${username}` : channel.handle, avatarUrl: asString(me.data.threads_profile_picture_url) } };
    } catch (error) {
      return { ok: false, error: error instanceof DriverError ? error : new DriverError(String(error), "unknown", { platform: P }) };
    }
  },

  async publish(ctx, input: PublishInput): Promise<PublishResultWithUsage> {
    const { channel, content } = input;
    const s = { ...input.target.uploadState };
    const save = async (patch: UploadState) => {
      Object.assign(s, patch);
      await input.saveState(patch);
    };
    const opts = content.options.threads;
    const text = content.text.trim();
    const link = content.link.trim();
    if (!text && !input.media.length && !link) throw new DriverError("The post is empty.", "validation", { platform: P });
    const mainId = await postOne(ctx, channel, s, save, "main", {
      text,
      media: input.media,
      link: input.media.length ? undefined : link || undefined,
      replyControl: opts?.replyControl,
      topicTag: opts?.topicTag,
    });
    const tok = token(channel);
    let permalink = asString(asRecord(s.main).permalink);
    if (!permalink) {
      try {
        const res = await graph(ctx, P, `${THREADS_API}/${mainId}`, tok, { query: { fields: "permalink" } });
        permalink = asString(res.data.permalink);
      } catch {
        permalink = "";
      }
      if (!permalink) permalink = `https://www.threads.com/${channel.handle || ""}`;
      await save({ main: { id: mainId, permalink } });
    }
    const warnings: string[] = [];
    const threadIds: string[] = [];
    let previous = mainId;
    for (const [i, part] of content.thread.entries()) {
      if (!part.trim()) continue;
      try {
        previous = await postOne(ctx, channel, s, save, `part${i}`, { text: part.trim(), media: [], replyTo: previous });
        threadIds.push(previous);
      } catch (error) {
        if (error instanceof DriverError && error.retryable) throw error;
        warnings.push(`Thread part ${i + 2} failed: ${error instanceof Error ? error.message : String(error)}`);
        break;
      }
    }
    let firstCommentId: string | undefined;
    if (content.firstComment.trim()) {
      try {
        firstCommentId = await postOne(ctx, channel, s, save, "comment", { text: content.firstComment.trim(), media: [], replyTo: mainId });
      } catch (error) {
        if (error instanceof DriverError && error.retryable) throw error;
        warnings.push(`First comment failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return {
      externalId: mainId,
      permalink,
      threadIds: threadIds.length ? threadIds : undefined,
      firstCommentId,
      warnings: warnings.length ? warnings : undefined,
      usage: { posts: 1 + threadIds.length + (firstCommentId ? 1 : 0) },
    };
  },

  async deleteRemote(ctx, channel, externalId) {
    await graph(ctx, P, `${THREADS_API}/${externalId}`, token(channel), { method: "DELETE" });
  },

  async fetchMetrics(ctx, channel, items) {
    const out = [];
    for (const item of items) {
      try {
        const res = await graph(ctx, P, `${THREADS_API}/${item.externalId}/insights`, token(channel), { query: { metric: "views,likes,replies,reposts,quotes" } });
        const metrics: PostMetrics = {};
        for (const row of Array.isArray(res.data.data) ? res.data.data : []) {
          const r = asRecord(row);
          const v = asNumber(asRecord(r.total_value).value) ?? asNumber(asRecord(Array.isArray(r.values) ? r.values[0] : null).value);
          if (v === undefined) continue;
          const name = asString(r.name);
          if (name === "views") metrics.views = v;
          else if (name === "likes") metrics.likes = v;
          else if (name === "replies") metrics.comments = v;
          else if (name === "reposts") metrics.shares = v;
          else if (name === "quotes") metrics.quotes = v;
        }
        if (Object.keys(metrics).length) out.push({ externalId: item.externalId, metrics });
      } catch (error) {
        if (error instanceof DriverError && (error.kind === "rate_limit" || error.kind === "auth")) throw error;
      }
    }
    return out;
  },

  async findExisting(ctx, input) {
    const main = asRecord(input.uploadState.main);
    if (main.id) return { externalId: asString(main.id), permalink: asString(main.permalink) };
    if (!input.uploadState.mainPublishing) return null;
    try {
      const res = await graph(ctx, P, `${THREADS_API}/${input.channel.externalId}/threads`, token(input.channel), {
        query: { fields: "id,text,timestamp,permalink", limit: 10, since: Math.floor(sinceMs(input.since) / 1000) - 60 },
      });
      for (const raw of Array.isArray(res.data.data) ? res.data.data : []) {
        const m = asRecord(raw);
        if (sameText(asString(m.text), input.content.text)) return { externalId: asString(m.id), permalink: asString(m.permalink) };
      }
    } catch {
      return null;
    }
    return null;
  },
};

/** Admin Test: Threads has no app-token endpoint; check that the id is numeric and the secret looks right. */
export function checkThreadsApp(clientId: string, clientSecret: string): string | null {
  if (!/^\d{6,25}$/.test(clientId)) return "The Threads app ID should be a number (Meta app dashboard → Use cases → Threads → Settings).";
  if (!/^[a-f0-9]{32}$/i.test(clientSecret)) return "The Threads app secret should be 32 hexadecimal characters.";
  return null;
}
