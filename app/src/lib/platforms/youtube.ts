import { PLATFORM_CAPABILITIES } from "@/social/platforms";
import { DriverError, type DriverChannel, type DriverContext, type MetricsResult, type PostMetrics, type PublishInput, type UploadState } from "@/social/types";
import type { PlatformDriver } from "./extras";
import { asNumber, asRecord, asString, bytesBody, call, errorMessage, isoIn, pendingError, pollBudget, readAll, readRange, requireApp, type CallOptions, type HttpResponse, type PublishResultWithUsage } from "./http";
import { pkceChallenge } from "./pkce";

/**
 * YouTube (Data API v3) with Google OAuth: youtube.upload + youtube.readonly, offline access
 * (refresh tokens; 7-day refresh tokens while the consent screen is in Testing). Videos go up
 * with the resumable protocol in 8 MB chunks; the session URL and offset live in uploadState so a
 * timed-out tick resumes where it stopped. Shorts are classified by YouTube (vertical ≤ 3 min).
 * Docs: developers.google.com/youtube/v3/docs/videos/insert, /youtube/v3/guides/using_resumable_upload_protocol.
 */

const AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const REVOKE = "https://oauth2.googleapis.com/revoke";
export const YT_API = "https://www.googleapis.com/youtube/v3";
const YT_UPLOAD = "https://www.googleapis.com/upload/youtube/v3";
const P = "youtube" as const;
/** Resumable chunk size (a multiple of 256 KiB). */
export const YT_CHUNK = 8 * 1024 * 1024;
/** Quota units of the calls we make (determine_quota_cost); uploads have their own daily bucket. */
export const YT_UNITS = { list: 1, thumbnail: 50, delete: 50 };

function ytError(ctx: DriverContext, res: HttpResponse): DriverError {
  const d = asRecord(res.data);
  const err = asRecord(d.error);
  const reason = asString(asRecord(Array.isArray(err.errors) ? err.errors[0] : null).reason) || asString(d.error);
  const message = errorMessage(res.data, `HTTP ${res.status}`);
  const base = { status: res.status, code: reason, platform: P };
  if (reason === "quotaExceeded" || reason === "uploadLimitExceeded" || reason === "dailyLimitExceeded" || reason === "rateLimitExceeded") {
    return new DriverError(`YouTube quota: ${message}`, reason === "rateLimitExceeded" ? "rate_limit" : "quota", { ...base, retryAfterMs: reason === "rateLimitExceeded" ? 60_000 : 3 * 3_600_000 });
  }
  if (res.status === 401 || reason === "invalid_grant" || reason === "authError") return new DriverError(message, "auth", base);
  if (res.status === 403 && /insufficient|forbidden|youtubeSignupRequired|accountClosed|accountSuspended/i.test(`${reason} ${message}`)) return new DriverError(message, "auth", base);
  if (res.status === 429) return new DriverError(message, "rate_limit", { ...base, retryAfterMs: 60_000 });
  if (res.status >= 500) return new DriverError(message, "network", base);
  if (/mediaBodyRequired|invalidVideo|uploadedFile|videoTooLong/i.test(reason)) return new DriverError(message, "media", base);
  return new DriverError(message, "validation", base);
}

function api<T = Record<string, unknown>>(ctx: DriverContext, url: string, tok: string, options: CallOptions = {}) {
  return call<T>(ctx, P, url, { ...options, headers: { Authorization: `Bearer ${tok}`, ...(options.headers ?? {}) }, mapError: (r) => ytError(ctx, r) });
}

const token = (c: DriverChannel) => {
  if (!c.credentials.accessToken) throw new DriverError("The channel has no access token: reconnect it.", "auth", { platform: P });
  return c.credentials.accessToken;
};

/** YouTube refuses "<" and ">" in titles and descriptions. */
const clean = (s: string) => s.replace(/[<>]/g, "");

async function myChannel(ctx: DriverContext, tok: string) {
  const res = await api(ctx, `${YT_API}/channels`, tok, { query: { part: "snippet,statistics", mine: true } });
  const item = asRecord(Array.isArray(res.data.items) ? res.data.items[0] : null);
  if (!item.id) throw new DriverError("This Google account has no YouTube channel yet. Create one on youtube.com and connect again.", "validation", { platform: P, code: "no_channel" });
  const sn = asRecord(item.snippet);
  const thumbs = asRecord(sn.thumbnails);
  const custom = asString(sn.customUrl);
  return {
    id: asString(item.id),
    title: asString(sn.title),
    handle: custom ? (custom.startsWith("@") ? custom : `@${custom}`) : "",
    avatar: asString(asRecord(thumbs.high).url) || asString(asRecord(thumbs.default).url),
    subscribers: asNumber(asRecord(item.statistics).subscriberCount) ?? null,
  };
}

/** Asks the upload session how far it got (308 + Range) or whether it already finished (200/201). */
async function sessionStatus(ctx: DriverContext, tok: string, url: string, total: number): Promise<{ done: Record<string, unknown> | null; offset: number; gone: boolean }> {
  try {
    const res = await api(ctx, url, tok, { method: "PUT", headers: { "Content-Range": `bytes */${total}` }, body: bytesBody(new Uint8Array(0)), contentLength: 0, okStatuses: [308] });
    if (res.status === 308) {
      const range = res.headers.get("range");
      const m = range ? /bytes=0-(\d+)/.exec(range) : null;
      return { done: null, offset: m ? Number(m[1]) + 1 : 0, gone: false };
    }
    return { done: asRecord(res.data), offset: total, gone: false };
  } catch (error) {
    if (error instanceof DriverError && (error.status === 404 || error.status === 410)) return { done: null, offset: 0, gone: true };
    throw error;
  }
}

const watchUrl = (id: string, short: boolean) => (short ? `https://www.youtube.com/shorts/${id}` : `https://www.youtube.com/watch?v=${id}`);

export const youtubeDriver: PlatformDriver = {
  platform: P,

  async connectStart(ctx, input) {
    const app = requireApp(ctx, P);
    const u = new URL(AUTHORIZE);
    u.searchParams.set("client_id", app.clientId);
    u.searchParams.set("redirect_uri", ctx.redirectUri);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", PLATFORM_CAPABILITIES.youtube.auth.scopes.join(" "));
    u.searchParams.set("access_type", "offline");
    u.searchParams.set("prompt", "consent");
    u.searchParams.set("include_granted_scopes", "true");
    u.searchParams.set("state", input.state);
    if (input.codeVerifier) {
      u.searchParams.set("code_challenge", await pkceChallenge(input.codeVerifier));
      u.searchParams.set("code_challenge_method", "S256");
    }
    return { kind: "redirect", url: u.toString() };
  },

  async connectFinish(ctx, input) {
    if (input.query.error) throw new DriverError(input.query.error === "access_denied" ? "The connection was cancelled." : input.query.error, "auth", { platform: P, code: input.query.error });
    if (!input.query.code) throw new DriverError("No authorization code was returned.", "auth", { platform: P });
    const app = requireApp(ctx, P);
    const res = await call(ctx, P, TOKEN, {
      method: "POST",
      form: { code: input.query.code, client_id: app.clientId, client_secret: app.clientSecret, redirect_uri: ctx.redirectUri, grant_type: "authorization_code", ...(input.codeVerifier ? { code_verifier: input.codeVerifier } : {}) },
      mapError: (r) => ytError(ctx, r),
    });
    const tok = asString(res.data.access_token);
    if (!tok) throw new DriverError("Google returned no access token.", "auth", { platform: P });
    const scopes = asString(res.data.scope).split(/\s+/).filter(Boolean);
    if (scopes.length && !scopes.some((s) => s.endsWith("youtube.upload"))) {
      throw new DriverError("Allow Queuezen to upload videos on the Google consent screen (the upload box was unticked).", "auth", { platform: P, code: "scope" });
    }
    const expiresAt = isoIn(ctx, asNumber(res.data.expires_in) ?? 3600);
    const ch = await myChannel(ctx, tok);
    return [
      {
        externalId: ch.id,
        name: ch.title,
        handle: ch.handle,
        avatarUrl: ch.avatar,
        profileUrl: `https://www.youtube.com/channel/${ch.id}`,
        credentials: { accessToken: tok, refreshToken: asString(res.data.refresh_token) || undefined, expiresAt, scopes, tokenType: "bearer" },
        tokenExpiresAt: expiresAt,
        meta: { subscribers: ch.subscribers },
      },
    ];
  },

  async refresh(ctx, channel) {
    const rt = channel.credentials.refreshToken;
    if (!rt) throw new DriverError("No refresh token: reconnect the YouTube channel.", "auth", { platform: P });
    const app = requireApp(ctx, P);
    const res = await call(ctx, P, TOKEN, { method: "POST", form: { client_id: app.clientId, client_secret: app.clientSecret, refresh_token: rt, grant_type: "refresh_token" }, mapError: (r) => ytError(ctx, r) });
    const tok = asString(res.data.access_token);
    if (!tok) throw new DriverError("Google didn't refresh the token.", "auth", { platform: P });
    const expiresAt = isoIn(ctx, asNumber(res.data.expires_in) ?? 3600);
    return { credentials: { ...channel.credentials, accessToken: tok, refreshToken: asString(res.data.refresh_token) || rt, expiresAt }, tokenExpiresAt: expiresAt };
  },

  async testConnection(ctx, channel) {
    try {
      const ch = await myChannel(ctx, token(channel));
      return { ok: true, account: { name: ch.title, handle: ch.handle || channel.handle, avatarUrl: ch.avatar, meta: { ...channel.meta, subscribers: ch.subscribers } } };
    } catch (error) {
      return { ok: false, error: error instanceof DriverError ? error : new DriverError(String(error), "unknown", { platform: P }) };
    }
  },

  async publish(ctx, input: PublishInput): Promise<PublishResultWithUsage> {
    const { channel, content } = input;
    const tok = token(channel);
    const s = { ...input.target.uploadState };
    const save = async (patch: UploadState) => {
      Object.assign(s, patch);
      await input.saveState(patch);
    };
    const video = input.media.find((m) => m.kind === "video");
    if (!video) throw new DriverError("A YouTube post needs a video.", "validation", { platform: P });
    const opts = content.options.youtube;
    const short = (video.height ?? 0) >= (video.width ?? 1) && (video.duration ?? 999) <= 180;
    let uploads = 0;
    let units = 0;
    let videoId = asString(s.videoId);

    if (!videoId) {
      let sessionUrl = asString(s.sessionUrl);
      let offset = asNumber(s.offset) ?? 0;
      if (sessionUrl) {
        const st = await sessionStatus(ctx, tok, sessionUrl, video.size);
        if (st.done) videoId = asString(st.done.id);
        else if (st.gone) {
          sessionUrl = "";
          offset = 0;
        } else offset = st.offset;
      }
      if (!videoId && !sessionUrl) {
        const title = clean(opts?.title?.trim() || content.text.split("\n")[0] || "Video").slice(0, 100);
        const res = await api(ctx, `${YT_UPLOAD}/videos`, tok, {
          method: "POST",
          query: { uploadType: "resumable", part: "snippet,status", notifySubscribers: opts?.notifySubscribers ?? true },
          headers: { "X-Upload-Content-Length": String(video.size), "X-Upload-Content-Type": video.mime },
          json: {
            snippet: { title, description: clean(content.text).slice(0, 5000), tags: (opts?.tags ?? []).slice(0, 30), categoryId: opts?.categoryId || "22" },
            status: { privacyStatus: opts?.privacy ?? "public", selfDeclaredMadeForKids: opts?.madeForKids ?? false, embeddable: true },
          },
        });
        sessionUrl = res.headers.get("location") ?? "";
        if (!sessionUrl) throw new DriverError("YouTube didn't open an upload session.", "unknown", { platform: P });
        offset = 0;
        uploads = 1;
        await save({ sessionUrl, offset, total: video.size, uploadStartedAt: new Date(ctx.now()).toISOString() });
      }
      const deadline = ctx.now() + pollBudget(ctx, 240_000);
      while (!videoId) {
        if (ctx.now() > deadline) throw pendingError(P, `Uploading to YouTube: ${Math.floor((offset / Math.max(1, video.size)) * 100)}% done.`, 1_000);
        const end = Math.min(video.size, offset + YT_CHUNK);
        const bytes = await readRange(video, offset, end);
        const res = await api(ctx, sessionUrl, tok, {
          method: "PUT",
          headers: { "Content-Type": video.mime, "Content-Range": `bytes ${offset}-${end - 1}/${video.size}` },
          body: bytesBody(bytes),
          contentLength: bytes.length,
          okStatuses: [308],
        });
        if (res.status === 308) {
          const m = /bytes=0-(\d+)/.exec(res.headers.get("range") ?? "");
          offset = m ? Number(m[1]) + 1 : offset;
          await save({ offset });
        } else {
          videoId = asString(asRecord(res.data).id);
          if (!videoId) throw new DriverError("YouTube didn't return the video id.", "unknown", { platform: P });
        }
      }
      await save({ videoId, sessionUrl: null });
    }

    const warnings: string[] = [];
    const thumbId = opts?.thumbnailMediaId;
    const thumb = thumbId ? input.media.find((m) => m.id === thumbId && m.kind !== "video") : undefined;
    if (thumb && !s.thumbnailSet) {
      try {
        const bytes = await readAll(thumb, 2 * 1024 * 1024, P);
        await api(ctx, `${YT_UPLOAD}/thumbnails/set`, tok, { method: "POST", query: { videoId }, headers: { "Content-Type": thumb.mime }, body: bytesBody(bytes) });
        units += YT_UNITS.thumbnail;
        await save({ thumbnailSet: true });
      } catch (error) {
        warnings.push(`Custom thumbnail failed: ${error instanceof Error ? error.message : String(error)} (it needs a verified YouTube account)`);
      }
    }
    return { externalId: videoId, permalink: watchUrl(videoId, short), warnings: warnings.length ? warnings : undefined, usage: { posts: 1, uploads, quotaUnits: units } };
  },

  async deleteRemote(ctx, channel, externalId) {
    try {
      await api(ctx, `${YT_API}/videos`, token(channel), { method: "DELETE", query: { id: externalId } });
    } catch (error) {
      if (error instanceof DriverError && error.status === 403) {
        throw new DriverError("Deleting needs the full YouTube scope, which Queuezen doesn't ask for. Delete the video in YouTube Studio.", "validation", { platform: P, code: "unsupported" });
      }
      throw error;
    }
  },

  async fetchMetrics(ctx, channel, items) {
    const out: MetricsResult[] = [];
    for (let i = 0; i < items.length; i += 50) {
      const batch = items.slice(i, i + 50);
      const res = await api(ctx, `${YT_API}/videos`, token(channel), { query: { part: "statistics", id: batch.map((b) => b.externalId).join(",") } });
      for (const raw of Array.isArray(res.data.items) ? res.data.items : []) {
        const v = asRecord(raw);
        const st = asRecord(v.statistics);
        const metrics: PostMetrics = {};
        const views = asNumber(st.viewCount);
        const likes = asNumber(st.likeCount);
        const comments = asNumber(st.commentCount);
        if (views !== undefined) metrics.views = views;
        if (likes !== undefined) metrics.likes = likes;
        if (comments !== undefined) metrics.comments = comments;
        out.push({ externalId: asString(v.id), metrics });
      }
    }
    return out;
  },

  async findExisting(ctx, input) {
    const s = input.uploadState;
    const id = asString(s.videoId);
    if (id) return { externalId: id, permalink: watchUrl(id, false) };
    const url = asString(s.sessionUrl);
    if (!url) return null;
    // The upload session itself is idempotent: if it completed, it hands back the video.
    try {
      const total = asNumber(s.total);
      if (!total) return null;
      const st = await sessionStatus(ctx, token(input.channel), url, total);
      const vid = st.done ? asString(st.done.id) : "";
      return vid ? { externalId: vid, permalink: watchUrl(vid, false) } : null;
    } catch {
      return null;
    }
  },

  async revoke(ctx, channel) {
    const tok = channel.credentials.refreshToken || channel.credentials.accessToken;
    if (!tok) return false;
    try {
      await call(ctx, P, REVOKE, { method: "POST", form: { token: tok } });
      return true;
    } catch {
      return false;
    }
  },
};
