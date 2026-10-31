import { PLATFORM_CAPABILITIES } from "@/social/platforms";
import {
  DriverError,
  type ConnectedAccount,
  type ConnectFinishInput,
  type ConnectStartInput,
  type ConnectStartResult,
  type DriverChannel,
  type DriverContext,
  type FindExistingInput,
  type MediaAsset,
  type MetricsRequest,
  type MetricsResult,
  type Platform,
  type PostMetrics,
  type PublishInput,
  type RefreshResult,
  type TestResult,
  type UploadState,
} from "@/social/types";
import type { PlatformDriver } from "./extras";
import {
  asNumber,
  asRecord,
  asString,
  call,
  errorCode,
  errorMessage,
  isoIn,
  pendingError,
  pollBudget,
  requireApp,
  retryAfterMs,
  sameText,
  sinceMs,
  sleep,
  type CallOptions,
  type HttpResponse,
  type PublishResultWithUsage,
} from "./http";

/**
 * Meta: a shared Graph client and the Facebook Pages + Instagram drivers.
 * - facebook:         Facebook Login for Business → long-lived user token → Page tokens (no expiry)
 * - instagram:        the same login; Instagram business accounts linked to the Pages
 * - instagram_login:  Instagram API with Instagram Login (graph.instagram.com, 60-day token)
 * Threads lives in ./threads.ts (its own host, same error format).
 *
 * Docs: developers.facebook.com/docs/pages-api/posts, /video-api/guides/reels-publishing,
 * /instagram-platform/content-publishing, /instagram-platform/reference/refresh_access_token.
 */

/** Graph API version (Meta ships one about every quarter and keeps each for 2 years). */
export const META_GRAPH_VERSION = "v26.0";
export const FB_GRAPH = `https://graph.facebook.com/${META_GRAPH_VERSION}`;
export const IG_GRAPH = `https://graph.instagram.com/${META_GRAPH_VERSION}`;
const FB_DIALOG = `https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth`;
const RUPLOAD = `https://rupload.facebook.com/video-upload/${META_GRAPH_VERSION}`;

// ── Errors ──

const RATE_LIMIT_CODES = new Set(["4", "17", "32", "613", "80001", "80002", "80003", "80004", "80005", "80006", "80008", "80014"]);
const AUTH_CODES = new Set(["190", "102", "10", "200", "3", "463", "467"]);

/** Maps a Graph error (Facebook, Instagram, Threads) to a DriverError. */
export function metaError(ctx: DriverContext, platform: Platform, res: HttpResponse): DriverError {
  const err = asRecord(asRecord(res.data).error);
  const code = asString(err.code);
  const sub = asString(err.error_subcode);
  const message = errorMessage(res.data, `HTTP ${res.status}`);
  const base = { status: res.status, code: errorCode(res.data), platform };
  if (RATE_LIMIT_CODES.has(code) || res.status === 429 || sub === "2207042") {
    // IG 2207042: the 24 h publishing limit is reached.
    return new DriverError(message, "rate_limit", { ...base, retryAfterMs: retryAfterMs(res.headers, ctx.now()) ?? (sub === "2207042" ? 3_600_000 : 15 * 60_000) });
  }
  if (code === "9007" || sub === "2207027") return pendingError(platform, message, 30_000);
  if (AUTH_CODES.has(code) || (Number(code) >= 200 && Number(code) < 300) || res.status === 401) return new DriverError(message, "auth", base);
  if (err.is_transient === true || code === "1" || code === "2" || res.status >= 500) return new DriverError(message, "network", base);
  if (code === "368") return new DriverError(message, "validation", base);
  if (/^2207\d+/.test(sub) || code === "352" || code === "351" || code === "324") return new DriverError(message, "media", base);
  return new DriverError(message, "validation", base);
}

/** Graph call with Bearer auth and Meta error mapping. */
export function graph<T = Record<string, unknown>>(ctx: DriverContext, platform: Platform, url: string, token: string | null, options: CallOptions = {}): Promise<HttpResponse<T>> {
  return call<T>(ctx, platform, url, {
    ...options,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.headers ?? {}) },
    mapError: (res) => metaError(ctx, platform, res),
  });
}

const tokenOf = (channel: DriverChannel, platform: Platform) => {
  const t = channel.credentials.accessToken;
  if (!t) throw new DriverError("The channel has no access token: reconnect it.", "auth", { platform });
  return t;
};

const images = (media: MediaAsset[]) => media.filter((m) => m.kind === "image" || m.kind === "gif");
const videos = (media: MediaAsset[]) => media.filter((m) => m.kind === "video");
const state = <T = Record<string, unknown>>(s: UploadState, key: string): T | undefined => s[key] as T | undefined;

// ── Facebook Login (Pages and Instagram with Facebook Login) ──

function fbLoginUrl(ctx: DriverContext, input: ConnectStartInput, scopes: string[]): string {
  const app = requireApp(ctx, "facebook");
  const u = new URL(FB_DIALOG);
  u.searchParams.set("client_id", app.clientId);
  u.searchParams.set("redirect_uri", ctx.redirectUri);
  u.searchParams.set("state", input.state);
  u.searchParams.set("response_type", "code");
  const configId = app.extra.configId;
  if (configId) {
    u.searchParams.set("config_id", configId);
    u.searchParams.set("override_default_response_type", "true");
  } else {
    u.searchParams.set("scope", scopes.join(","));
  }
  return u.toString();
}

/** Code → short-lived user token → long-lived (60 days) user token. */
async function fbUserToken(ctx: DriverContext, platform: Platform, input: ConnectFinishInput): Promise<{ token: string; expiresAt: string | null; userId: string }> {
  if (input.query.error) throw new DriverError(input.query.error_description || "The connection was cancelled.", "auth", { platform, code: input.query.error });
  const code = input.query.code;
  if (!code) throw new DriverError("No authorization code was returned.", "auth", { platform });
  const app = requireApp(ctx, platform);
  const short = await graph(ctx, platform, `${FB_GRAPH}/oauth/access_token`, null, {
    query: { client_id: app.clientId, client_secret: app.clientSecret, redirect_uri: ctx.redirectUri, code },
  });
  const shortToken = asString(short.data.access_token);
  if (!shortToken) throw new DriverError("Facebook returned no access token.", "auth", { platform });
  const long = await graph(ctx, platform, `${FB_GRAPH}/oauth/access_token`, null, {
    query: { grant_type: "fb_exchange_token", client_id: app.clientId, client_secret: app.clientSecret, fb_exchange_token: shortToken },
  });
  const token = asString(long.data.access_token) || shortToken;
  // The app-scoped user id identifies the person in Meta's data deletion callbacks.
  let userId = "";
  try {
    userId = asString((await graph(ctx, platform, `${FB_GRAPH}/me`, token, { query: { fields: "id" } })).data.id);
  } catch {
    userId = "";
  }
  return { token, expiresAt: isoIn(ctx, asNumber(long.data.expires_in)), userId };
}

interface FbPage {
  id: string;
  name: string;
  username: string;
  accessToken: string;
  tasks: string[];
  picture: string;
  instagram: { id: string; username: string; name: string; picture: string } | null;
}

async function fbPages(ctx: DriverContext, platform: Platform, userToken: string): Promise<FbPage[]> {
  const pages: FbPage[] = [];
  let url: string | null = `${FB_GRAPH}/me/accounts`;
  let query: CallOptions["query"] = {
    fields: "id,name,username,access_token,tasks,picture.type(large){url},instagram_business_account{id,username,name,profile_picture_url}",
    limit: 100,
  };
  for (let i = 0; url && i < 10; i++) {
    const res: HttpResponse<Record<string, unknown>> = await graph(ctx, platform, url, userToken, { query });
    for (const raw of Array.isArray(res.data.data) ? res.data.data : []) {
      const p = asRecord(raw);
      const ig = asRecord(p.instagram_business_account);
      pages.push({
        id: asString(p.id),
        name: asString(p.name),
        username: asString(p.username),
        accessToken: asString(p.access_token),
        tasks: Array.isArray(p.tasks) ? p.tasks.map(String) : [],
        picture: asString(asRecord(asRecord(p.picture).data).url),
        instagram: ig.id ? { id: asString(ig.id), username: asString(ig.username), name: asString(ig.name), picture: asString(ig.profile_picture_url) } : null,
      });
    }
    const next: string = asString(asRecord(res.data.paging).next);
    url = next || null;
    query = undefined;
  }
  return pages.filter((p) => p.id && p.accessToken);
}

// ── Facebook Pages driver ──

/** Video upload through rupload.facebook.com from a public URL (no bytes through our server). */
async function ruploadFromUrl(ctx: DriverContext, platform: Platform, videoId: string, token: string, fileUrl: string): Promise<void> {
  await call(ctx, platform, `${RUPLOAD}/${videoId}`, {
    method: "POST",
    headers: { Authorization: `OAuth ${token}`, file_url: fileUrl },
    mapError: (res) => metaError(ctx, platform, res),
  });
}

async function fbPermalink(ctx: DriverContext, id: string, token: string, fallback: string): Promise<string> {
  try {
    const res = await graph(ctx, "facebook", `${FB_GRAPH}/${id}`, token, { query: { fields: "permalink_url" } });
    const link = asString(res.data.permalink_url);
    return link ? (link.startsWith("http") ? link : `https://www.facebook.com${link}`) : fallback;
  } catch {
    return fallback;
  }
}

async function fbComment(ctx: DriverContext, objectId: string, token: string, message: string, warnings: string[]): Promise<string | undefined> {
  try {
    const res = await graph(ctx, "facebook", `${FB_GRAPH}/${objectId}/comments`, token, { method: "POST", json: { message } });
    return asString(res.data.id) || undefined;
  } catch (error) {
    warnings.push(`First comment failed: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

export const facebookDriver: PlatformDriver = {
  platform: "facebook",

  async connectStart(ctx, input): Promise<ConnectStartResult> {
    return { kind: "redirect", url: fbLoginUrl(ctx, input, PLATFORM_CAPABILITIES.facebook.auth.scopes) };
  },

  async connectFinish(ctx, input): Promise<ConnectedAccount[]> {
    const user = await fbUserToken(ctx, "facebook", input);
    const pages = await fbPages(ctx, "facebook", user.token);
    const usable = pages.filter((p) => !p.tasks.length || p.tasks.includes("CREATE_CONTENT"));
    if (!usable.length) throw new DriverError("No Facebook Pages were shared, or you can't create content on them. Reconnect and select at least one Page.", "validation", { platform: "facebook", code: "no_pages" });
    return usable.map((p) => ({
      externalId: p.id,
      name: p.name,
      handle: p.username ? `@${p.username}` : "",
      avatarUrl: p.picture,
      profileUrl: `https://www.facebook.com/${p.username || p.id}`,
      credentials: { accessToken: p.accessToken, tokenType: "page", scopes: PLATFORM_CAPABILITIES.facebook.auth.scopes },
      tokenExpiresAt: null,
      meta: { pageId: p.id, tasks: p.tasks, userTokenExpiresAt: user.expiresAt, metaUserId: user.userId },
    }));
  },

  async refresh(): Promise<RefreshResult | null> {
    return null; // Page tokens derived from a long-lived user token don't expire.
  },

  async testConnection(ctx, channel): Promise<TestResult> {
    try {
      const res = await graph(ctx, "facebook", `${FB_GRAPH}/${channel.externalId}`, tokenOf(channel, "facebook"), {
        query: { fields: "id,name,username,picture.type(large){url},followers_count" },
      });
      const d = res.data;
      return {
        ok: true,
        account: {
          name: asString(d.name) || channel.name,
          handle: asString(d.username) ? `@${asString(d.username)}` : channel.handle,
          avatarUrl: asString(asRecord(asRecord(d.picture).data).url),
          meta: { ...channel.meta, followers: asNumber(d.followers_count) ?? null },
        },
      };
    } catch (error) {
      return { ok: false, error: error instanceof DriverError ? error : new DriverError(String(error), "unknown", { platform: "facebook" }) };
    }
  },

  async publish(ctx, input: PublishInput): Promise<PublishResultWithUsage> {
    const { channel, content, media } = input;
    const token = tokenOf(channel, "facebook");
    const page = channel.externalId;
    const postType = content.options.facebook?.postType ?? "feed";
    const s = { ...input.target.uploadState };
    const save = async (patch: UploadState) => {
      Object.assign(s, patch);
      await input.saveState(patch);
    };
    const warnings: string[] = [];
    const message = content.text.trim();
    let postId = asString(state<{ id: string }>(s, "published")?.id);
    let permalink = asString(state<{ permalink: string }>(s, "published")?.permalink);

    if (!postId) {
      const vids = videos(media);
      const imgs = images(media);
      if (postType === "reel" || postType === "story") {
        const isStory = postType === "story";
        const edge = isStory ? "video_stories" : "video_reels";
        if (isStory && !vids.length) {
          const photo = imgs[0];
          if (!photo) throw new DriverError("A story needs a photo or a video.", "validation", { platform: "facebook" });
          let photoId = asString(s.storyPhotoId);
          if (!photoId) {
            const up = await graph(ctx, "facebook", `${FB_GRAPH}/${page}/photos`, token, { method: "POST", json: { url: photo.url, published: false } });
            photoId = asString(up.data.id);
            await save({ storyPhotoId: photoId });
          }
          const res = await graph(ctx, "facebook", `${FB_GRAPH}/${page}/photo_stories`, token, { method: "POST", json: { photo_id: photoId } });
          postId = asString(res.data.post_id) || photoId;
          permalink = `https://www.facebook.com/stories/${page}`;
        } else {
          const video = vids[0];
          if (!video) throw new DriverError(`A ${isStory ? "story" : "Reel"} needs a video.`, "validation", { platform: "facebook" });
          let videoId = asString(s.videoId);
          if (!videoId) {
            const start = await graph(ctx, "facebook", `${FB_GRAPH}/${page}/${edge}`, token, { method: "POST", json: { upload_phase: "start" } });
            videoId = asString(start.data.video_id);
            if (!videoId) throw new DriverError("Facebook didn't start the upload.", "unknown", { platform: "facebook" });
            await save({ videoId, phase: "started" });
          }
          if (s.phase === "started") {
            await ruploadFromUrl(ctx, "facebook", videoId, token, video.url);
            await save({ phase: "uploaded" });
          }
          // Finishing has no idempotency key: mark it before the call so a retry checks first (findExisting).
          await save({ phase: "finishing" });
          const fin = await graph(ctx, "facebook", `${FB_GRAPH}/${page}/${edge}`, token, {
            method: "POST",
            json: isStory ? { upload_phase: "finish", video_id: videoId } : { upload_phase: "finish", video_id: videoId, video_state: "PUBLISHED", description: message },
          });
          postId = asString(fin.data.post_id) || videoId;
          permalink = isStory ? `https://www.facebook.com/stories/${page}` : `https://www.facebook.com/reel/${videoId}`;
        }
      } else if (vids.length) {
        const video = vids[0];
        await save({ phase: "video_posting" });
        const res = await graph(ctx, "facebook", `${FB_GRAPH}/${page}/videos`, token, {
          method: "POST",
          json: { file_url: video.url, description: message },
        });
        postId = asString(res.data.id);
        permalink = `https://www.facebook.com/${page}/videos/${postId}`;
      } else if (imgs.length === 1) {
        await save({ phase: "photo_posting" });
        const res = await graph(ctx, "facebook", `${FB_GRAPH}/${page}/photos`, token, {
          method: "POST",
          json: { url: imgs[0].url, caption: content.link && !message.includes(content.link) ? `${message}\n\n${content.link}`.trim() : message, published: true },
        });
        postId = asString(res.data.post_id) || asString(res.data.id);
      } else if (imgs.length > 1) {
        const photoIds: string[] = Array.isArray(s.photoIds) ? (s.photoIds as unknown[]).map(String) : [];
        for (let i = photoIds.length; i < imgs.length; i++) {
          const up = await graph(ctx, "facebook", `${FB_GRAPH}/${page}/photos`, token, { method: "POST", json: { url: imgs[i].url, published: false } });
          photoIds.push(asString(up.data.id));
          await save({ photoIds: [...photoIds] });
        }
        await save({ phase: "feed_posting" });
        const res = await graph(ctx, "facebook", `${FB_GRAPH}/${page}/feed`, token, {
          method: "POST",
          json: { message: content.link && !message.includes(content.link) ? `${message}\n\n${content.link}`.trim() : message, attached_media: photoIds.map((id) => ({ media_fbid: id })) },
        });
        postId = asString(res.data.id);
      } else {
        if (!message && !content.link) throw new DriverError("The post is empty.", "validation", { platform: "facebook" });
        await save({ phase: "feed_posting" });
        const res = await graph(ctx, "facebook", `${FB_GRAPH}/${page}/feed`, token, {
          method: "POST",
          json: { message, ...(content.link ? { link: content.link } : {}) },
        });
        postId = asString(res.data.id);
      }
      if (!postId) throw new DriverError("Facebook didn't return a post id.", "unknown", { platform: "facebook" });
      if (!permalink) permalink = await fbPermalink(ctx, postId, token, `https://www.facebook.com/${postId}`);
      await save({ published: { id: postId, permalink } });
    }

    let firstCommentId = asString(s.firstCommentId) || undefined;
    if (content.firstComment.trim() && postType !== "story" && !firstCommentId) {
      firstCommentId = await fbComment(ctx, postId, token, content.firstComment.trim(), warnings);
      if (firstCommentId) await save({ firstCommentId });
    }
    return { externalId: postId, permalink, firstCommentId, warnings: warnings.length ? warnings : undefined, usage: { posts: 1, apiCalls: 2 } };
  },

  async deleteRemote(ctx, channel, externalId) {
    await graph(ctx, "facebook", `${FB_GRAPH}/${externalId}`, tokenOf(channel, "facebook"), { method: "DELETE" });
  },

  async fetchMetrics(ctx, channel, items: MetricsRequest[]): Promise<MetricsResult[]> {
    const token = tokenOf(channel, "facebook");
    const out: MetricsResult[] = [];
    for (let i = 0; i < items.length; i += 50) {
      const batch = items.slice(i, i + 50);
      let counts: Record<string, unknown> = {};
      try {
        const res = await graph(ctx, "facebook", `${FB_GRAPH}/`, token, {
          query: { ids: batch.map((b) => b.externalId).join(","), fields: "shares,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0)" },
        });
        counts = asRecord(res.data);
      } catch (error) {
        if (error instanceof DriverError && (error.kind === "auth" || error.kind === "rate_limit")) throw error;
      }
      for (const item of batch) {
        const c = asRecord(counts[item.externalId]);
        const metrics: PostMetrics = {};
        const likes = asNumber(asRecord(asRecord(c.reactions).summary).total_count);
        const comments = asNumber(asRecord(asRecord(c.comments).summary).total_count);
        const shares = asNumber(asRecord(c.shares).count);
        if (likes !== undefined) metrics.likes = likes;
        if (comments !== undefined) metrics.comments = comments;
        if (Object.keys(c).length) metrics.shares = shares ?? 0;
        try {
          const ins = await graph(ctx, "facebook", `${FB_GRAPH}/${item.externalId}/insights`, token, { query: { metric: "post_media_view,post_clicks" } });
          for (const row of Array.isArray(ins.data.data) ? ins.data.data : []) {
            const r = asRecord(row);
            const v = asNumber(asRecord(Array.isArray(r.values) ? r.values[0] : null).value);
            if (v === undefined) continue;
            if (r.name === "post_media_view") metrics.views = v;
            if (r.name === "post_clicks") metrics.clicks = v;
          }
        } catch (error) {
          if (error instanceof DriverError && error.kind === "rate_limit") throw error;
        }
        if (Object.keys(metrics).length) out.push({ externalId: item.externalId, metrics });
      }
    }
    return out;
  },

  async findExisting(ctx, input: FindExistingInput) {
    const s = input.uploadState;
    const published = asRecord(s.published);
    if (published.id) return { externalId: asString(published.id), permalink: asString(published.permalink) };
    const token = tokenOf(input.channel, "facebook");
    const page = input.channel.externalId;
    const since = Math.floor(sinceMs(input.since) / 1000) - 60;
    if (s.videoId && (s.phase === "finishing" || s.phase === "uploaded")) {
      // A Reel / video story whose finish call may have gone through.
      try {
        const res = await graph(ctx, "facebook", `${FB_GRAPH}/${asString(s.videoId)}`, token, { query: { fields: "id,status,permalink_url" } });
        const st = asRecord(res.data.status);
        const phase = asString(asRecord(st.publishing_phase).status);
        if (phase === "complete" || asString(st.video_status) === "ready") {
          const id = asString(s.videoId);
          return { externalId: id, permalink: `https://www.facebook.com/reel/${id}` };
        }
      } catch {
        return null;
      }
      return null;
    }
    if (!s.phase) return null; // Nothing irreversible was attempted.
    const edge = s.phase === "video_posting" ? "videos" : "published_posts";
    try {
      const res = await graph(ctx, "facebook", `${FB_GRAPH}/${page}/${edge}`, token, {
        query: { fields: edge === "videos" ? "id,description,created_time,permalink_url" : "id,message,created_time,permalink_url", since, limit: 25 },
      });
      for (const raw of Array.isArray(res.data.data) ? res.data.data : []) {
        const p = asRecord(raw);
        const text = asString(p.message) || asString(p.description);
        const created = Date.parse(asString(p.created_time));
        if (Number.isFinite(created) && created < sinceMs(input.since) - 60_000) continue;
        if (sameText(text, input.content.text)) {
          const link = asString(p.permalink_url);
          return { externalId: asString(p.id), permalink: link.startsWith("http") ? link : `https://www.facebook.com${link || `/${asString(p.id)}`}` };
        }
      }
    } catch {
      return null;
    }
    return null;
  },
};

// ── Instagram (both APIs share the publishing flow) ──

interface IgFlavor {
  platform: "instagram" | "instagram_login";
  base: string;
}

const IG_FB: IgFlavor = { platform: "instagram", base: FB_GRAPH };
const IG_LOGIN: IgFlavor = { platform: "instagram_login", base: IG_GRAPH };

/** Polls a container until FINISHED (Meta asks for about one poll a minute; we poll faster at first). */
async function waitContainer(ctx: DriverContext, flavor: { platform: Platform; base: string }, id: string, token: string, field: "status_code" | "status"): Promise<void> {
  const deadline = ctx.now() + pollBudget(ctx);
  let delay = 2_000;
  for (let i = 0; ; i++) {
    const res = await graph(ctx, flavor.platform, `${flavor.base}/${id}`, token, { query: { fields: field === "status_code" ? "status_code,status" : "status,error_message" } });
    const code = asString(res.data[field]).toUpperCase();
    if (code === "FINISHED" || code === "PUBLISHED") return;
    if (code === "ERROR") {
      const detail = asString(res.data.error_message) || asString(res.data.status) || "processing failed";
      throw new DriverError(`The media couldn't be processed: ${detail}`, "media", { platform: flavor.platform, code: "container_error" });
    }
    if (code === "EXPIRED") throw new DriverError("The upload container expired (24 h). It will be created again.", "network", { platform: flavor.platform, code: "container_expired" });
    if (ctx.now() + delay > deadline) throw pendingError(flavor.platform, "The media is still processing.", 60_000);
    await sleep(ctx, delay);
    delay = Math.min(delay * 2, 15_000);
    if (i > 50) throw pendingError(flavor.platform, "The media is still processing.", 60_000);
  }
}

async function igCheckLimit(ctx: DriverContext, flavor: IgFlavor, ig: string, token: string): Promise<void> {
  try {
    const res = await graph(ctx, flavor.platform, `${flavor.base}/${ig}/content_publishing_limit`, token, { query: { fields: "quota_usage,config" } });
    const row = asRecord(Array.isArray(res.data.data) ? res.data.data[0] : null);
    const used = asNumber(row.quota_usage);
    const total = asNumber(asRecord(row.config).quota_total);
    if (used !== undefined && total !== undefined && total > 0 && used >= total) {
      throw new DriverError(`Instagram's publishing limit is reached (${used} of ${total} posts in 24 h).`, "rate_limit", { platform: flavor.platform, code: "publishing_limit", retryAfterMs: 3_600_000 });
    }
  } catch (error) {
    if (error instanceof DriverError && (error.kind === "rate_limit" || error.kind === "auth")) throw error;
  }
}

function igPublisher(flavor: IgFlavor) {
  const P = flavor.platform;
  return async function publish(ctx: DriverContext, input: PublishInput): Promise<PublishResultWithUsage> {
    const { channel, content } = input;
    const token = tokenOf(channel, P);
    const ig = channel.externalId;
    const opts = content.options.instagram;
    const postType = opts?.postType ?? "feed";
    const s = { ...input.target.uploadState };
    const save = async (patch: UploadState) => {
      Object.assign(s, patch);
      await input.saveState(patch);
    };
    const warnings: string[] = [];
    let media = [...input.media];
    let coverUrl = "";
    if (opts?.coverMediaId && media.length > 1) {
      const cover = media.find((m) => m.id === opts.coverMediaId);
      if (cover) {
        coverUrl = cover.url;
        media = media.filter((m) => m !== cover);
      }
    }
    const caption = content.text.trim();
    const collaborators = (opts?.collaborators ?? []).filter(Boolean).slice(0, 3);
    let mediaId = asString(asRecord(s.published).id);

    if (!mediaId) {
      if (!media.length) throw new DriverError("Instagram posts need at least one image or video.", "validation", { platform: P });
      let containerId = asString(s.containerId);
      if (!containerId) {
        await igCheckLimit(ctx, flavor, ig, token);
        const create = (body: Record<string, unknown>) => graph(ctx, P, `${flavor.base}/${ig}/media`, token, { method: "POST", json: body });
        const itemBody = (m: MediaAsset): Record<string, unknown> => (m.kind === "video" ? { media_type: "VIDEO", video_url: m.url } : { image_url: m.url });
        if (postType === "story") {
          const m = media[0];
          const res = await create(m.kind === "video" ? { media_type: "STORIES", video_url: m.url } : { media_type: "STORIES", image_url: m.url });
          containerId = asString(res.data.id);
        } else if (postType === "reel" || (media.length === 1 && media[0].kind === "video")) {
          const v = media.find((m) => m.kind === "video");
          if (!v) throw new DriverError("A Reel needs a video.", "validation", { platform: P });
          const res = await create({
            media_type: "REELS",
            video_url: v.url,
            caption,
            share_to_feed: opts?.shareToFeed ?? true,
            ...(collaborators.length ? { collaborators } : {}),
            ...(coverUrl ? { cover_url: coverUrl } : {}),
          });
          containerId = asString(res.data.id);
        } else if (media.length === 1) {
          const m = media[0];
          const res = await create({ image_url: m.url, caption, ...(m.altText ? { alt_text: m.altText.slice(0, 1000) } : {}), ...(collaborators.length ? { collaborators } : {}) });
          containerId = asString(res.data.id);
        } else {
          const children: string[] = Array.isArray(s.children) ? (s.children as unknown[]).map(String) : [];
          for (let i = children.length; i < Math.min(media.length, 10); i++) {
            const res = await create({ ...itemBody(media[i]), is_carousel_item: true, ...(media[i].kind !== "video" && media[i].altText ? { alt_text: media[i].altText.slice(0, 1000) } : {}) });
            children.push(asString(res.data.id));
            await save({ children: [...children] });
          }
          for (const [i, child] of children.entries()) if (media[i]?.kind === "video") await waitContainer(ctx, { platform: P, base: flavor.base }, child, token, "status_code");
          const res = await create({ media_type: "CAROUSEL", children: children.join(","), caption, ...(collaborators.length ? { collaborators } : {}) });
          containerId = asString(res.data.id);
        }
        if (!containerId) throw new DriverError("Instagram didn't create the media container.", "unknown", { platform: P });
        await save({ containerId, containerCreatedAt: new Date(ctx.now()).toISOString() });
      }
      try {
        await waitContainer(ctx, { platform: P, base: flavor.base }, containerId, token, "status_code");
      } catch (error) {
        if (error instanceof DriverError && error.code === "container_expired") await save({ containerId: null, children: null });
        throw error;
      }
      await save({ publishing: true });
      const pub = await graph(ctx, P, `${flavor.base}/${ig}/media_publish`, token, { method: "POST", json: { creation_id: containerId } });
      mediaId = asString(pub.data.id);
      if (!mediaId) throw new DriverError("Instagram didn't return the published media id.", "unknown", { platform: P });
      let permalink = "";
      try {
        const res = await graph(ctx, P, `${flavor.base}/${mediaId}`, token, { query: { fields: "permalink" } });
        permalink = asString(res.data.permalink);
      } catch {
        permalink = "";
      }
      await save({ published: { id: mediaId, permalink: permalink || `https://www.instagram.com/${channel.handle.replace(/^@/, "")}` } });
    }

    const published = asRecord(s.published);
    let firstCommentId = asString(s.firstCommentId) || undefined;
    if (content.firstComment.trim() && postType !== "story" && !firstCommentId) {
      try {
        const res = await graph(ctx, P, `${flavor.base}/${mediaId}/comments`, token, { method: "POST", json: { message: content.firstComment.trim() } });
        firstCommentId = asString(res.data.id) || undefined;
        if (firstCommentId) await save({ firstCommentId });
      } catch (error) {
        warnings.push(`First comment failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { externalId: mediaId, permalink: asString(published.permalink), firstCommentId, warnings: warnings.length ? warnings : undefined, usage: { posts: 1 } };
  };
}

function igMetrics(flavor: IgFlavor) {
  return async function fetchMetrics(ctx: DriverContext, channel: DriverChannel, items: MetricsRequest[]): Promise<MetricsResult[]> {
    const token = tokenOf(channel, flavor.platform);
    const out: MetricsResult[] = [];
    for (const item of items) {
      const metrics: PostMetrics = {};
      try {
        const res = await graph(ctx, flavor.platform, `${flavor.base}/${item.externalId}/insights`, token, { query: { metric: "views,reach,likes,comments,saved,shares" } });
        for (const row of Array.isArray(res.data.data) ? res.data.data : []) {
          const r = asRecord(row);
          const v = asNumber(asRecord(r.total_value).value) ?? asNumber(asRecord(Array.isArray(r.values) ? r.values[0] : null).value);
          if (v === undefined) continue;
          const name = asString(r.name);
          if (name === "views") metrics.views = v;
          else if (name === "reach") metrics.reach = v;
          else if (name === "likes") metrics.likes = v;
          else if (name === "comments") metrics.comments = v;
          else if (name === "saved") metrics.saves = v;
          else if (name === "shares") metrics.shares = v;
        }
      } catch (error) {
        if (error instanceof DriverError && (error.kind === "rate_limit" || error.kind === "auth")) throw error;
        // Stories and old media reject some metrics: fall back to the public counters.
        try {
          const res = await graph(ctx, flavor.platform, `${flavor.base}/${item.externalId}`, token, { query: { fields: "like_count,comments_count" } });
          const l = asNumber(res.data.like_count);
          const c = asNumber(res.data.comments_count);
          if (l !== undefined) metrics.likes = l;
          if (c !== undefined) metrics.comments = c;
        } catch {
          // Deleted media: nothing to report.
        }
      }
      if (Object.keys(metrics).length) out.push({ externalId: item.externalId, metrics });
    }
    return out;
  };
}

function igFindExisting(flavor: IgFlavor) {
  return async function findExisting(ctx: DriverContext, input: FindExistingInput) {
    const published = asRecord(input.uploadState.published);
    if (published.id) return { externalId: asString(published.id), permalink: asString(published.permalink) };
    if (!input.uploadState.publishing) return null; // media_publish was never called.
    try {
      const res = await graph(ctx, flavor.platform, `${flavor.base}/${input.channel.externalId}/media`, tokenOf(input.channel, flavor.platform), {
        query: { fields: "id,caption,timestamp,permalink", limit: 10 },
      });
      for (const raw of Array.isArray(res.data.data) ? res.data.data : []) {
        const m = asRecord(raw);
        const at = Date.parse(asString(m.timestamp));
        if (Number.isFinite(at) && at < sinceMs(input.since) - 60_000) continue;
        if (sameText(asString(m.caption), input.content.text) || (!input.content.text.trim() && !asString(m.caption))) {
          return { externalId: asString(m.id), permalink: asString(m.permalink) };
        }
      }
    } catch {
      return null;
    }
    return null;
  };
}

const igDeleteUnsupported = async () => {
  throw new DriverError("Instagram doesn't allow deleting posts through its API. Delete it in the Instagram app.", "validation", { platform: "instagram", code: "unsupported" });
};

export const instagramDriver: PlatformDriver = {
  platform: "instagram",
  async connectStart(ctx, input) {
    return { kind: "redirect", url: fbLoginUrl(ctx, input, PLATFORM_CAPABILITIES.instagram.auth.scopes) };
  },
  async connectFinish(ctx, input) {
    const user = await fbUserToken(ctx, "instagram", input);
    const pages = await fbPages(ctx, "instagram", user.token);
    const linked = pages.filter((p) => p.instagram);
    if (!linked.length) {
      throw new DriverError("None of the shared Facebook Pages has an Instagram business or creator account linked. Link one in the Page settings, or use Instagram Login.", "validation", { platform: "instagram", code: "no_accounts" });
    }
    return linked.map((p) => {
      const ig = p.instagram!;
      return {
        externalId: ig.id,
        name: ig.name || ig.username,
        handle: ig.username ? `@${ig.username}` : "",
        avatarUrl: ig.picture,
        profileUrl: ig.username ? `https://www.instagram.com/${ig.username}` : "",
        credentials: { accessToken: p.accessToken, tokenType: "page", scopes: PLATFORM_CAPABILITIES.instagram.auth.scopes },
        tokenExpiresAt: null,
        meta: { pageId: p.id, pageName: p.name, metaUserId: user.userId },
      };
    });
  },
  async refresh() {
    return null;
  },
  async testConnection(ctx, channel) {
    try {
      const res = await graph(ctx, "instagram", `${FB_GRAPH}/${channel.externalId}`, tokenOf(channel, "instagram"), { query: { fields: "id,username,name,profile_picture_url,followers_count" } });
      const d = res.data;
      return { ok: true, account: { name: asString(d.name) || asString(d.username), handle: d.username ? `@${asString(d.username)}` : channel.handle, avatarUrl: asString(d.profile_picture_url), meta: { ...channel.meta, followers: asNumber(d.followers_count) ?? null } } };
    } catch (error) {
      return { ok: false, error: error instanceof DriverError ? error : new DriverError(String(error), "unknown", { platform: "instagram" }) };
    }
  },
  publish: igPublisher(IG_FB),
  deleteRemote: igDeleteUnsupported,
  fetchMetrics: igMetrics(IG_FB),
  findExisting: igFindExisting(IG_FB),
};

// ── Instagram API with Instagram Login ──

const IG_AUTHORIZE = "https://www.instagram.com/oauth/authorize";
const IG_TOKEN = "https://api.instagram.com/oauth/access_token";
const IG_ROOT = "https://graph.instagram.com";

export const instagramLoginDriver: PlatformDriver = {
  platform: "instagram_login",
  async connectStart(ctx, input) {
    const app = requireApp(ctx, "instagram_login");
    const u = new URL(IG_AUTHORIZE);
    u.searchParams.set("client_id", app.clientId);
    u.searchParams.set("redirect_uri", ctx.redirectUri);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", PLATFORM_CAPABILITIES.instagram_login.auth.scopes.join(","));
    u.searchParams.set("state", input.state);
    return { kind: "redirect", url: u.toString() };
  },
  async connectFinish(ctx, input) {
    const P = "instagram_login" as const;
    if (input.query.error) throw new DriverError(input.query.error_description || "The connection was cancelled.", "auth", { platform: P, code: input.query.error });
    const code = (input.query.code ?? "").replace(/#_$/, "");
    if (!code) throw new DriverError("No authorization code was returned.", "auth", { platform: P });
    const app = requireApp(ctx, P);
    const short = await graph(ctx, P, IG_TOKEN, null, {
      method: "POST",
      form: { client_id: app.clientId, client_secret: app.clientSecret, grant_type: "authorization_code", redirect_uri: ctx.redirectUri, code },
    });
    const row = asRecord(Array.isArray(short.data.data) ? short.data.data[0] : short.data);
    const shortToken = asString(row.access_token);
    if (!shortToken) throw new DriverError("Instagram returned no access token.", "auth", { platform: P });
    const long = await graph(ctx, P, `${IG_ROOT}/access_token`, null, { query: { grant_type: "ig_exchange_token", client_secret: app.clientSecret, access_token: shortToken } });
    const token = asString(long.data.access_token) || shortToken;
    const expiresAt = isoIn(ctx, asNumber(long.data.expires_in) ?? 60 * 86_400);
    const me = await graph(ctx, P, `${IG_GRAPH}/me`, token, { query: { fields: "user_id,username,name,profile_picture_url,account_type,followers_count" } });
    const id = asString(me.data.user_id) || asString(row.user_id) || asString(me.data.id);
    const username = asString(me.data.username);
    return [
      {
        externalId: id,
        name: asString(me.data.name) || username,
        handle: username ? `@${username}` : "",
        avatarUrl: asString(me.data.profile_picture_url),
        profileUrl: username ? `https://www.instagram.com/${username}` : "",
        credentials: { accessToken: token, expiresAt, scopes: PLATFORM_CAPABILITIES.instagram_login.auth.scopes, extra: { issuedAt: new Date(ctx.now()).toISOString() } },
        tokenExpiresAt: expiresAt,
        meta: { accountType: asString(me.data.account_type), followers: asNumber(me.data.followers_count) ?? null, metaUserId: asString(row.user_id) },
      },
    ];
  },
  async refresh(ctx, channel) {
    const P = "instagram_login" as const;
    const issued = Date.parse(channel.credentials.extra?.issuedAt ?? "");
    // Long-lived tokens can only be refreshed once they are at least 24 hours old.
    if (Number.isFinite(issued) && ctx.now() - issued < 24 * 3_600_000) return null;
    const res = await graph(ctx, P, `${IG_ROOT}/refresh_access_token`, null, { query: { grant_type: "ig_refresh_token", access_token: tokenOf(channel, P) } });
    const token = asString(res.data.access_token);
    if (!token) throw new DriverError("Instagram didn't refresh the token.", "auth", { platform: P });
    const expiresAt = isoIn(ctx, asNumber(res.data.expires_in) ?? 60 * 86_400);
    return { credentials: { ...channel.credentials, accessToken: token, expiresAt, extra: { ...(channel.credentials.extra ?? {}), issuedAt: new Date(ctx.now()).toISOString() } }, tokenExpiresAt: expiresAt };
  },
  async testConnection(ctx, channel) {
    try {
      const res = await graph(ctx, "instagram_login", `${IG_GRAPH}/me`, tokenOf(channel, "instagram_login"), { query: { fields: "user_id,username,name,profile_picture_url,followers_count" } });
      const d = res.data;
      return { ok: true, account: { name: asString(d.name) || asString(d.username), handle: d.username ? `@${asString(d.username)}` : channel.handle, avatarUrl: asString(d.profile_picture_url), meta: { ...channel.meta, followers: asNumber(d.followers_count) ?? null } } };
    } catch (error) {
      return { ok: false, error: error instanceof DriverError ? error : new DriverError(String(error), "unknown", { platform: "instagram_login" }) };
    }
  },
  publish: igPublisher(IG_LOGIN),
  deleteRemote: igDeleteUnsupported,
  fetchMetrics: igMetrics(IG_LOGIN),
  findExisting: igFindExisting(IG_LOGIN),
};

/** For the admin Test button: an app access token proves the Meta app id and secret. */
export async function testMetaApp(ctx: DriverContext, platform: Platform, base = FB_GRAPH): Promise<string> {
  const app = requireApp(ctx, platform);
  const res = await graph(ctx, platform, `${base}/oauth/access_token`, null, { query: { client_id: app.clientId, client_secret: app.clientSecret, grant_type: "client_credentials" } });
  if (!asString(res.data.access_token)) throw new DriverError("Meta returned no app token.", "auth", { platform });
  return "The app id and secret are valid.";
}

export { waitContainer as metaWaitContainer };
