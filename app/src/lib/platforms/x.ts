import { extractUrls } from "@/social/normalize";
import { PLATFORM_CAPABILITIES } from "@/social/platforms";
import { DriverError, type DriverChannel, type DriverContext, type MediaAsset, type MetricsResult, type PostMetrics, type PublishInput, type UploadState } from "@/social/types";
import { xPostCostMicros, type PlatformDriver } from "./extras";
import { pkceChallenge } from "./pkce";
import {
  asNumber,
  asRecord,
  asString,
  call,
  errorCode,
  errorMessage,
  isoIn,
  multipart,
  pendingError,
  pollBudget,
  readRange,
  requireApp,
  retryAfterMs,
  sameText,
  sinceMs,
  sleep,
  textWithLink,
  type CallOptions,
  type HttpResponse,
  type PublishResultWithUsage,
  type PublishUsage,
} from "./http";

/**
 * X (api.x.com v2): OAuth 2.0 authorization code + PKCE (confidential client, Basic auth on the
 * token endpoint), single-use rotating refresh tokens (2 h access tokens), chunked media upload
 * v2 (initialize → append → finalize → status), threads and the first comment as self-replies.
 * Every created post is billed by X (pay-per-use credits): the cost is reported in `usage`.
 * Docs: docs.x.com/x-api/media/quickstart/media-upload-chunked, /fundamentals/authentication/oauth-2-0.
 */

export const X_API = "https://api.x.com";
const AUTHORIZE = "https://x.com/i/oauth2/authorize";
const P = "x" as const;
/** Append chunk size: X recommends ≤ 5 MB (8 MB max). */
export const X_CHUNK = 4 * 1024 * 1024;

function xError(ctx: DriverContext, res: HttpResponse): DriverError {
  const message = errorMessage(res.data, `HTTP ${res.status}`);
  const d = asRecord(res.data);
  const code = errorCode(res.data) || asString(d.type);
  const base = { status: res.status, code, platform: P };
  if (res.status === 429) return new DriverError(message, "rate_limit", { ...base, retryAfterMs: retryAfterMs(res.headers, ctx.now()) ?? 15 * 60_000 });
  if (res.status === 401 || asString(d.error) === "invalid_grant" || asString(d.error) === "invalid_token") return new DriverError(message, "auth", base);
  if (res.status === 402 || /credit|usage cap|client-not-enrolled/i.test(message)) return new DriverError(`X API credits: ${message}`, "quota", { ...base, retryable: false });
  if (res.status === 403) {
    if (/duplicate/i.test(message)) return new DriverError(message, "validation", { ...base, code: "duplicate" });
    if (/media/i.test(message) && /scope|permission/i.test(message)) return new DriverError(`${message} (reconnect: the media.write scope is needed)`, "auth", base);
    return new DriverError(message, "validation", base);
  }
  if (res.status >= 500) return new DriverError(message, "network", base);
  if (res.status === 413) return new DriverError(message, "media", base);
  return new DriverError(message, "validation", base);
}

function api<T = Record<string, unknown>>(ctx: DriverContext, path: string, tok: string, options: CallOptions = {}) {
  return call<T>(ctx, P, path.startsWith("http") ? path : `${X_API}${path}`, { ...options, headers: { Authorization: `Bearer ${tok}`, ...(options.headers ?? {}) }, mapError: (r) => xError(ctx, r) });
}

const accessToken = (c: DriverChannel) => {
  if (!c.credentials.accessToken) throw new DriverError("The channel has no access token: reconnect it.", "auth", { platform: P });
  return c.credentials.accessToken;
};

function basicAuth(clientId: string, clientSecret: string): Record<string, string> {
  if (!clientSecret) return {};
  return { Authorization: `Basic ${btoa(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`)}` };
}

async function tokenRequest(ctx: DriverContext, form: Record<string, string>) {
  const app = requireApp(ctx, P);
  return call(ctx, P, `${X_API}/2/oauth2/token`, {
    method: "POST",
    headers: basicAuth(app.clientId, app.clientSecret),
    form: { ...form, client_id: app.clientId },
    mapError: (r) => xError(ctx, r),
  });
}

function credentialsFrom(ctx: DriverContext, data: Record<string, unknown>, previousRefresh?: string) {
  const expiresAt = isoIn(ctx, asNumber(data.expires_in) ?? 7200);
  return {
    credentials: {
      accessToken: asString(data.access_token),
      refreshToken: asString(data.refresh_token) || previousRefresh,
      expiresAt,
      tokenType: "bearer",
      scopes: asString(data.scope).split(/\s+/).filter(Boolean),
    },
    expiresAt,
  };
}

function mediaCategory(m: MediaAsset): string {
  if (m.kind === "video") return "tweet_video";
  if (m.kind === "gif" || m.mime === "image/gif") return "tweet_gif";
  return "tweet_image";
}

/** Chunked upload v2 with resumable progress in uploadState.media[assetId] = { id, segment, finalized, ready }. */
async function uploadMedia(ctx: DriverContext, tok: string, asset: MediaAsset, s: UploadState, save: (patch: UploadState) => Promise<void>): Promise<string> {
  const all = asRecord(s.media);
  const key = String(asset.id);
  const st = { ...asRecord(all[key]) } as { id?: string; segment?: number; finalized?: boolean; ready?: boolean; createdAt?: number };
  const persist = async () => {
    const next = { ...asRecord(s.media), [key]: { ...st } };
    await save({ media: next });
  };
  // Media ids expire after 24 h: start again when an old one is about to.
  if (st.id && st.createdAt && ctx.now() - st.createdAt > 23 * 3_600_000) {
    st.id = undefined;
    st.segment = 0;
    st.finalized = false;
    st.ready = false;
  }
  if (st.ready && st.id) return st.id;
  if (!st.id) {
    const init = await api(ctx, "/2/media/upload/initialize", tok, { method: "POST", json: { media_type: asset.mime, total_bytes: asset.size, media_category: mediaCategory(asset) } });
    st.id = asString(asRecord(init.data.data).id);
    if (!st.id) throw new DriverError("X didn't start the media upload.", "unknown", { platform: P });
    st.segment = 0;
    st.createdAt = ctx.now();
    await persist();
  }
  const total = Math.max(1, Math.ceil(asset.size / X_CHUNK));
  while (!st.finalized && (st.segment ?? 0) < total) {
    const i = st.segment ?? 0;
    const start = i * X_CHUNK;
    const bytes = await readRange(asset, start, Math.min(asset.size, start + X_CHUNK));
    const body = multipart([
      { name: "segment_index", value: String(i) },
      { name: "media", filename: "chunk", contentType: "application/octet-stream", bytes },
    ]);
    await api(ctx, `/2/media/upload/${st.id}/append`, tok, { method: "POST", body: body.body, headers: { "Content-Type": body.contentType }, contentLength: body.length });
    st.segment = i + 1;
    await persist();
  }
  let processing: Record<string, unknown> = {};
  if (!st.finalized) {
    const fin = await api(ctx, `/2/media/upload/${st.id}/finalize`, tok, { method: "POST" });
    processing = asRecord(asRecord(fin.data.data).processing_info);
    st.finalized = true;
    await persist();
  } else {
    processing = { state: "pending" };
  }
  const deadline = ctx.now() + pollBudget(ctx);
  while (processing.state && processing.state !== "succeeded") {
    if (processing.state === "failed") {
      const err = asRecord(processing.error);
      throw new DriverError(`X couldn't process the media: ${asString(err.message) || asString(err.name) || "failed"}`, "media", { platform: P, code: "media_failed" });
    }
    const wait = Math.max(1, asNumber(processing.check_after_secs) ?? 2) * 1000;
    if (ctx.now() + wait > deadline) throw pendingError(P, "X is still processing the video.", wait);
    await sleep(ctx, wait);
    const res = await api(ctx, "/2/media/upload", tok, { query: { command: "STATUS", media_id: st.id } });
    processing = asRecord(asRecord(res.data.data).processing_info);
    if (!Object.keys(processing).length) break;
  }
  if (asset.altText && asset.kind !== "video") {
    try {
      await api(ctx, "/2/media/metadata", tok, { method: "POST", json: { id: st.id, metadata: { alt_text: { text: asset.altText.slice(0, 1000) } } } });
    } catch {
      // Alt text is best effort.
    }
  }
  st.ready = true;
  await persist();
  return st.id;
}

const cost = PLATFORM_CAPABILITIES.x.cost ?? { perPost: 0.015, perPostWithUrl: 0.2 };

export const xDriver: PlatformDriver = {
  platform: P,

  async connectStart(ctx, input) {
    const app = requireApp(ctx, P);
    const u = new URL(AUTHORIZE);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", app.clientId);
    u.searchParams.set("redirect_uri", ctx.redirectUri);
    u.searchParams.set("scope", PLATFORM_CAPABILITIES.x.auth.scopes.join(" "));
    u.searchParams.set("state", input.state);
    u.searchParams.set("code_challenge", await pkceChallenge(input.codeVerifier));
    u.searchParams.set("code_challenge_method", "S256");
    return { kind: "redirect", url: u.toString() };
  },

  async connectFinish(ctx, input) {
    if (input.query.error) throw new DriverError(input.query.error_description || "The connection was cancelled.", "auth", { platform: P, code: input.query.error });
    if (!input.query.code) throw new DriverError("No authorization code was returned.", "auth", { platform: P });
    const res = await tokenRequest(ctx, { grant_type: "authorization_code", code: input.query.code, redirect_uri: ctx.redirectUri, code_verifier: input.codeVerifier });
    const { credentials, expiresAt } = credentialsFrom(ctx, res.data);
    if (!credentials.accessToken) throw new DriverError("X returned no access token.", "auth", { platform: P });
    if (credentials.scopes.length && !credentials.scopes.includes("media.write")) {
      // Older apps without media.write can post text only; keep going but remember it.
    }
    const me = await api(ctx, "/2/users/me", credentials.accessToken, { query: { "user.fields": "profile_image_url,username,name,public_metrics" } });
    const u = asRecord(me.data.data);
    const username = asString(u.username);
    return [
      {
        externalId: asString(u.id),
        name: asString(u.name) || username,
        handle: username ? `@${username}` : "",
        avatarUrl: asString(u.profile_image_url).replace("_normal.", "_400x400."),
        profileUrl: username ? `https://x.com/${username}` : "",
        credentials,
        tokenExpiresAt: expiresAt,
        meta: { followers: asNumber(asRecord(u.public_metrics).followers_count) ?? null, mediaWrite: !credentials.scopes.length || credentials.scopes.includes("media.write") },
      },
    ];
  },

  async refresh(ctx, channel) {
    const rt = channel.credentials.refreshToken;
    if (!rt) throw new DriverError("No refresh token (offline.access): reconnect the account.", "auth", { platform: P });
    const res = await tokenRequest(ctx, { grant_type: "refresh_token", refresh_token: rt });
    const { credentials, expiresAt } = credentialsFrom(ctx, res.data, rt);
    if (!credentials.accessToken) throw new DriverError("X didn't refresh the token.", "auth", { platform: P });
    return { credentials: { ...channel.credentials, ...credentials }, tokenExpiresAt: expiresAt };
  },

  async testConnection(ctx, channel) {
    try {
      const me = await api(ctx, "/2/users/me", accessToken(channel), { query: { "user.fields": "profile_image_url,username,name,public_metrics" } });
      const u = asRecord(me.data.data);
      const username = asString(u.username);
      return { ok: true, account: { name: asString(u.name), handle: username ? `@${username}` : channel.handle, avatarUrl: asString(u.profile_image_url).replace("_normal.", "_400x400."), meta: { ...channel.meta, followers: asNumber(asRecord(u.public_metrics).followers_count) ?? null } } };
    } catch (error) {
      return { ok: false, error: error instanceof DriverError ? error : new DriverError(String(error), "unknown", { platform: P }) };
    }
  },

  async publish(ctx, input: PublishInput): Promise<PublishResultWithUsage> {
    const { channel, content } = input;
    const tok = accessToken(channel);
    const s = { ...input.target.uploadState };
    const save = async (patch: UploadState) => {
      Object.assign(s, patch);
      await input.saveState(patch);
    };
    let uploads = 0;
    const reply = content.options.x?.replySettings;
    const tweet = async (key: string, text: string, extra: Record<string, unknown>): Promise<string> => {
      const done = asString(asRecord(s[key]).id);
      if (done) return done;
      await save({ [`${key}Sending`]: true });
      const res = await api(ctx, "/2/tweets", tok, { method: "POST", json: { text, ...extra } });
      const id = asString(asRecord(res.data.data).id);
      if (!id) throw new DriverError("X didn't return the post id.", "unknown", { platform: P });
      const withUrl = extractUrls(text).length > 0;
      const billed = [...(Array.isArray(s.billed) ? (s.billed as NonNullable<PublishUsage["billed"]>) : []), { id, url: withUrl, micros: xPostCostMicros(withUrl, cost) }];
      await save({ [key]: { id }, billed });
      return id;
    };

    const mediaIds: string[] = [];
    for (const asset of input.media.slice(0, 4)) {
      const before = asRecord(asRecord(s.media)[String(asset.id)]).ready;
      mediaIds.push(await uploadMedia(ctx, tok, asset, s, save));
      if (!before) uploads += 1;
    }
    const text = textWithLink(content);
    if (!text && !mediaIds.length) throw new DriverError("The post is empty.", "validation", { platform: P });
    const mainId = await tweet("main", text, {
      ...(mediaIds.length ? { media: { media_ids: mediaIds } } : {}),
      ...(reply && reply !== "everyone" ? { reply_settings: reply } : {}),
    });
    const handle = channel.handle.replace(/^@/, "") || "i";
    const permalink = `https://x.com/${handle}/status/${mainId}`;
    const warnings: string[] = [];
    const threadIds: string[] = [];
    let previous = mainId;
    for (const [i, part] of content.thread.entries()) {
      if (!part.trim()) continue;
      try {
        previous = await tweet(`part${i}`, part.trim(), { reply: { in_reply_to_tweet_id: previous } });
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
        firstCommentId = await tweet("comment", content.firstComment.trim(), { reply: { in_reply_to_tweet_id: mainId } });
      } catch (error) {
        if (error instanceof DriverError && error.retryable) throw error;
        warnings.push(`First comment failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // Cost of every post this publication created, including those of earlier (failed) attempts.
    const billed = Array.isArray(s.billed) ? (s.billed as NonNullable<PublishUsage["billed"]>) : [];
    const usage: PublishUsage = { posts: billed.length, uploads, costMicros: billed.reduce((n, b) => n + b.micros, 0), billed };
    return { externalId: mainId, permalink, threadIds: threadIds.length ? threadIds : undefined, firstCommentId, warnings: warnings.length ? warnings : undefined, usage };
  },

  async deleteRemote(ctx, channel, externalId) {
    await api(ctx, `/2/tweets/${externalId}`, accessToken(channel), { method: "DELETE" });
  },

  async fetchMetrics(ctx, channel, items) {
    const out: MetricsResult[] = [];
    for (let i = 0; i < items.length; i += 100) {
      const batch = items.slice(i, i + 100);
      const res = await api(ctx, "/2/tweets", accessToken(channel), { query: { ids: batch.map((b) => b.externalId).join(","), "tweet.fields": "public_metrics" } });
      for (const raw of Array.isArray(res.data.data) ? res.data.data : []) {
        const t = asRecord(raw);
        const pm = asRecord(t.public_metrics);
        const metrics: PostMetrics = {};
        const set = (field: keyof PostMetrics, v: unknown) => {
          const n = asNumber(v);
          if (n !== undefined) metrics[field] = n;
        };
        set("likes", pm.like_count);
        set("shares", pm.retweet_count);
        set("comments", pm.reply_count);
        set("quotes", pm.quote_count);
        set("impressions", pm.impression_count);
        out.push({ externalId: asString(t.id), metrics });
      }
    }
    return out;
  },

  async findExisting(ctx, input) {
    const main = asRecord(input.uploadState.main);
    if (main.id) {
      const handle = input.channel.handle.replace(/^@/, "") || "i";
      return { externalId: asString(main.id), permalink: `https://x.com/${handle}/status/${asString(main.id)}` };
    }
    if (!input.uploadState.mainSending) return null;
    try {
      const res = await api(ctx, `/2/users/${input.channel.externalId}/tweets`, accessToken(input.channel), {
        query: { max_results: 5, "tweet.fields": "created_at,text", start_time: new Date(sinceMs(input.since) - 60_000).toISOString() },
      });
      const text = textWithLink(input.content);
      for (const raw of Array.isArray(res.data.data) ? res.data.data : []) {
        const t = asRecord(raw);
        // X shortens links to t.co: compare the text without URLs.
        const strip = (v: string) => v.replace(/https?:\/\/\S+/g, "").trim();
        if (sameText(strip(asString(t.text)), strip(text))) {
          const handle = input.channel.handle.replace(/^@/, "") || "i";
          return { externalId: asString(t.id), permalink: `https://x.com/${handle}/status/${asString(t.id)}` };
        }
      }
    } catch {
      return null;
    }
    return null;
  },

  async revoke(ctx, channel) {
    const app = ctx.app;
    const tok = channel.credentials.refreshToken || channel.credentials.accessToken;
    if (!app || !tok) return false;
    try {
      await call(ctx, P, `${X_API}/2/oauth2/revoke`, {
        method: "POST",
        headers: basicAuth(app.clientId, app.clientSecret),
        form: { token: tok, token_type_hint: channel.credentials.refreshToken ? "refresh_token" : "access_token", client_id: app.clientId },
      });
      return true;
    } catch {
      return false;
    }
  },
};
