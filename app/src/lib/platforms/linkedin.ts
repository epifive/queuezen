import { PLATFORM_CAPABILITIES } from "@/social/platforms";
import { DriverError, type DriverChannel, type DriverContext, type MediaAsset, type PublishInput, type UploadState } from "@/social/types";
import type { PlatformDriver } from "./extras";
import {
  asNumber,
  asRecord,
  asString,
  bytesBody,
  call,
  errorMessage,
  httpError,
  isoIn,
  pendingError,
  pollBudget,
  readAll,
  readRange,
  requireApp,
  sleep,
  type CallOptions,
  type HttpResponse,
  type PublishResultWithUsage,
} from "./http";

/**
 * LinkedIn personal profiles ("Share on LinkedIn" + "Sign In with LinkedIn using OpenID Connect"):
 * w_member_social, 60-day tokens without refresh (re-auth reminders), the versioned Posts API
 * (/rest/posts) with the Images and Videos APIs. Profile posts have no analytics API.
 * Docs: learn.microsoft.com/linkedin/marketing/community-management/shares/posts-api, /videos-api.
 */

/** LinkedIn-Version header (YYYYMM). October 2026 is the latest; each version lives about a year. */
export const LINKEDIN_VERSION = "202610";
export const LI_API = "https://api.linkedin.com";
const AUTHORIZE = "https://www.linkedin.com/oauth/v2/authorization";
const TOKEN = "https://www.linkedin.com/oauth/v2/accessToken";
const P = "linkedin" as const;

function liError(ctx: DriverContext, res: HttpResponse): DriverError {
  const d = asRecord(res.data);
  const message = errorMessage(res.data, `HTTP ${res.status}`);
  if (res.status === 401 || asString(d.serviceErrorCode) === "65601" || asString(d.code) === "REVOKED_ACCESS_TOKEN" || asString(d.code) === "EXPIRED_ACCESS_TOKEN") {
    return new DriverError(message, "auth", { status: res.status, code: asString(d.code) || asString(d.serviceErrorCode), platform: P });
  }
  if (res.status === 403 && /scope|permission|ACCESS_DENIED/i.test(`${message} ${asString(d.code)}`)) return new DriverError(message, "auth", { status: 403, code: asString(d.code), platform: P });
  if (res.status === 422 && /duplicate/i.test(message)) return new DriverError(message, "validation", { status: 422, code: "duplicate", platform: P });
  return httpError(ctx, P, res);
}

const version = (ctx: DriverContext) => (/^\d{6}$/.test(ctx.app?.extra.apiVersion ?? "") ? ctx.app!.extra.apiVersion : LINKEDIN_VERSION);

function rest<T = Record<string, unknown>>(ctx: DriverContext, path: string, tok: string, options: CallOptions = {}) {
  return call<T>(ctx, P, path.startsWith("http") ? path : `${LI_API}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${tok}`, "LinkedIn-Version": version(ctx), "X-Restli-Protocol-Version": "2.0.0", ...(options.headers ?? {}) },
    mapError: (r) => liError(ctx, r),
  });
}

const token = (c: DriverChannel) => {
  if (!c.credentials.accessToken) throw new DriverError("The channel has no access token: reconnect it.", "auth", { platform: P });
  return c.credentials.accessToken;
};
const authorUrn = (c: DriverChannel) => (c.externalId.startsWith("urn:") ? c.externalId : `urn:li:person:${c.externalId}`);
const postUrl = (urn: string) => `https://www.linkedin.com/feed/update/${urn}/`;

/** Uploads an image (≤ 8 MB, read whole) and returns its urn:li:image. */
async function uploadImage(ctx: DriverContext, tok: string, owner: string, bytes: Uint8Array, contentType: string): Promise<string> {
  const init = await rest(ctx, "/rest/images?action=initializeUpload", tok, { method: "POST", json: { initializeUploadRequest: { owner } } });
  const value = asRecord(init.data.value);
  const uploadUrl = asString(value.uploadUrl);
  const image = asString(value.image);
  if (!uploadUrl || !image) throw new DriverError("LinkedIn didn't start the image upload.", "unknown", { platform: P });
  await call(ctx, P, uploadUrl, { method: "PUT", headers: { Authorization: `Bearer ${tok}`, "Content-Type": contentType }, body: bytesBody(bytes), mapError: (r) => liError(ctx, r) });
  return image;
}

/** Video upload in the parts LinkedIn asks for (4 MB), ETags kept in uploadState for resume. */
async function uploadVideo(ctx: DriverContext, tok: string, owner: string, asset: MediaAsset, s: UploadState, save: (p: UploadState) => Promise<void>): Promise<string> {
  type Part = { uploadUrl: string; firstByte: number; lastByte: number };
  let v = asRecord(s.video) as { urn?: string; token?: string; parts?: Part[]; etags?: string[]; finalized?: boolean };
  if (!v.urn) {
    const init = await rest(ctx, "/rest/videos?action=initializeUpload", tok, {
      method: "POST",
      json: { initializeUploadRequest: { owner, fileSizeBytes: asset.size, uploadCaptions: false, uploadThumbnail: false } },
    });
    const value = asRecord(init.data.value);
    const parts = (Array.isArray(value.uploadInstructions) ? value.uploadInstructions : []).map((raw) => {
      const r = asRecord(raw);
      return { uploadUrl: asString(r.uploadUrl), firstByte: asNumber(r.firstByte) ?? 0, lastByte: asNumber(r.lastByte) ?? 0 };
    });
    v = { urn: asString(value.video), token: asString(value.uploadToken), parts, etags: [] };
    if (!v.urn || !parts.length) throw new DriverError("LinkedIn didn't start the video upload.", "unknown", { platform: P });
    await save({ video: v });
  }
  const etags = [...(v.etags ?? [])];
  for (let i = etags.length; i < (v.parts ?? []).length; i++) {
    const part = v.parts![i];
    const bytes = await readRange(asset, part.firstByte, part.lastByte + 1);
    const res = await call(ctx, P, part.uploadUrl, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: bytesBody(bytes), mapError: (r) => liError(ctx, r) });
    const etag = res.headers.get("etag") ?? "";
    if (!etag) throw new DriverError("LinkedIn didn't confirm an uploaded video part.", "network", { platform: P });
    etags.push(etag);
    v = { ...v, etags: [...etags] };
    await save({ video: v });
  }
  if (!v.finalized) {
    await rest(ctx, "/rest/videos?action=finalizeUpload", tok, { method: "POST", json: { finalizeUploadRequest: { video: v.urn, uploadToken: v.token ?? "", uploadedPartIds: etags } } });
    v = { ...v, finalized: true };
    await save({ video: v });
  }
  // Wait until LinkedIn has processed the video (posting earlier fails).
  const deadline = ctx.now() + pollBudget(ctx);
  for (let delay = 3_000; ; delay = Math.min(delay * 2, 15_000)) {
    const res = await rest(ctx, `/rest/videos/${encodeURIComponent(v.urn!)}`, tok);
    const status = asString(res.data.status);
    if (status === "AVAILABLE") break;
    if (status === "PROCESSING_FAILED") throw new DriverError("LinkedIn couldn't process the video.", "media", { platform: P, code: "processing_failed" });
    if (ctx.now() + delay > deadline) throw pendingError(P, "LinkedIn is still processing the video.", 60_000);
    await sleep(ctx, delay);
  }
  return v.urn!;
}

async function fetchThumbnail(ctx: DriverContext, url: string): Promise<{ bytes: Uint8Array; type: string } | null> {
  try {
    const res = await ctx.fetch(url, { redirect: "follow" });
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok || !/^image\/(jpeg|png|gif)/.test(type)) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    return buf.length && buf.length <= 5 * 1024 * 1024 ? { bytes: buf, type: type.split(";")[0] } : null;
  } catch {
    return null;
  }
}

export const linkedinDriver: PlatformDriver = {
  platform: P,

  async connectStart(ctx, input) {
    const app = requireApp(ctx, P);
    const u = new URL(AUTHORIZE);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", app.clientId);
    u.searchParams.set("redirect_uri", ctx.redirectUri);
    u.searchParams.set("state", input.state);
    u.searchParams.set("scope", PLATFORM_CAPABILITIES.linkedin.auth.scopes.join(" "));
    return { kind: "redirect", url: u.toString() };
  },

  async connectFinish(ctx, input) {
    if (input.query.error) throw new DriverError(input.query.error_description || "The connection was cancelled.", "auth", { platform: P, code: input.query.error });
    if (!input.query.code) throw new DriverError("No authorization code was returned.", "auth", { platform: P });
    const app = requireApp(ctx, P);
    const res = await call(ctx, P, TOKEN, {
      method: "POST",
      form: { grant_type: "authorization_code", code: input.query.code, redirect_uri: ctx.redirectUri, client_id: app.clientId, client_secret: app.clientSecret },
      mapError: (r) => liError(ctx, r),
    });
    const tok = asString(res.data.access_token);
    if (!tok) throw new DriverError("LinkedIn returned no access token.", "auth", { platform: P });
    const expiresAt = isoIn(ctx, asNumber(res.data.expires_in) ?? 60 * 86_400);
    const me = await call(ctx, P, `${LI_API}/v2/userinfo`, { headers: { Authorization: `Bearer ${tok}` }, mapError: (r) => liError(ctx, r) });
    const sub = asString(me.data.sub);
    if (!sub) throw new DriverError("LinkedIn didn't return the member id.", "auth", { platform: P });
    return [
      {
        externalId: sub,
        name: asString(me.data.name) || [asString(me.data.given_name), asString(me.data.family_name)].filter(Boolean).join(" "),
        handle: asString(me.data.email),
        avatarUrl: asString(me.data.picture),
        profileUrl: "https://www.linkedin.com/in/me/",
        credentials: {
          accessToken: tok,
          refreshToken: asString(res.data.refresh_token) || undefined,
          expiresAt,
          refreshExpiresAt: isoIn(ctx, asNumber(res.data.refresh_token_expires_in)),
          scopes: asString(res.data.scope).split(/[\s,]+/).filter(Boolean),
        },
        tokenExpiresAt: expiresAt,
        meta: { personUrn: `urn:li:person:${sub}` },
      },
    ];
  },

  async refresh(ctx, channel) {
    // Refresh tokens exist only for approved partners; profiles reconnect every 60 days.
    const rt = channel.credentials.refreshToken;
    const app = ctx.app;
    if (!rt || !app) return null;
    const res = await call(ctx, P, TOKEN, {
      method: "POST",
      form: { grant_type: "refresh_token", refresh_token: rt, client_id: app.clientId, client_secret: app.clientSecret },
      mapError: (r) => liError(ctx, r),
    });
    const tok = asString(res.data.access_token);
    if (!tok) return null;
    const expiresAt = isoIn(ctx, asNumber(res.data.expires_in) ?? 60 * 86_400);
    return { credentials: { ...channel.credentials, accessToken: tok, refreshToken: asString(res.data.refresh_token) || rt, expiresAt }, tokenExpiresAt: expiresAt };
  },

  async testConnection(ctx, channel) {
    try {
      const me = await call(ctx, P, `${LI_API}/v2/userinfo`, { headers: { Authorization: `Bearer ${token(channel)}` }, mapError: (r) => liError(ctx, r) });
      return { ok: true, account: { name: asString(me.data.name) || channel.name, avatarUrl: asString(me.data.picture) } };
    } catch (error) {
      return { ok: false, error: error instanceof DriverError ? error : new DriverError(String(error), "unknown", { platform: P }) };
    }
  },

  async publish(ctx, input: PublishInput): Promise<PublishResultWithUsage> {
    const { channel, content } = input;
    const tok = token(channel);
    const owner = authorUrn(channel);
    const s = { ...input.target.uploadState };
    const save = async (patch: UploadState) => {
      Object.assign(s, patch);
      await input.saveState(patch);
    };
    let urn = asString(asRecord(s.published).urn);
    if (!urn) {
      const vids = input.media.filter((m) => m.kind === "video");
      const imgs = input.media.filter((m) => m.kind !== "video");
      let postContent: Record<string, unknown> | undefined;
      if (vids.length) {
        const video = await uploadVideo(ctx, tok, owner, vids[0], s, save);
        postContent = { media: { id: video } };
      } else if (imgs.length) {
        const ids: string[] = Array.isArray(s.images) ? (s.images as unknown[]).map(String) : [];
        for (let i = ids.length; i < Math.min(imgs.length, 20); i++) {
          ids.push(await uploadImage(ctx, tok, owner, await readAll(imgs[i], 8 * 1024 * 1024, P), imgs[i].mime));
          await save({ images: [...ids] });
        }
        postContent =
          ids.length === 1
            ? { media: { id: ids[0], ...(imgs[0].altText ? { altText: imgs[0].altText.slice(0, 4086) } : {}) } }
            : { multiImage: { images: ids.map((id, i) => ({ id, ...(imgs[i]?.altText ? { altText: imgs[i].altText.slice(0, 4086) } : {}) })) } };
      } else if (content.link) {
        let thumbnail = asString(s.thumbnail);
        if (!thumbnail && content.linkMeta?.imageUrl) {
          const img = await fetchThumbnail(ctx, content.linkMeta.imageUrl);
          if (img) {
            try {
              thumbnail = await uploadImage(ctx, tok, owner, img.bytes, img.type);
              await save({ thumbnail });
            } catch {
              thumbnail = "";
            }
          }
        }
        postContent = {
          article: {
            source: content.link,
            title: (content.linkMeta?.title || content.link).slice(0, 400),
            ...(content.linkMeta?.description ? { description: content.linkMeta.description.slice(0, 4086) } : {}),
            ...(thumbnail ? { thumbnail } : {}),
          },
        };
      }
      const commentary = escapeLittleText(content.text.trim());
      if (!commentary && !postContent) throw new DriverError("The post is empty.", "validation", { platform: P });
      await save({ posting: true });
      const res = await rest(ctx, "/rest/posts", tok, {
        method: "POST",
        json: {
          author: owner,
          commentary,
          visibility: content.options.linkedin?.visibility ?? "PUBLIC",
          distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
          ...(postContent ? { content: postContent } : {}),
          lifecycleState: "PUBLISHED",
          isReshareDisabledByAuthor: false,
        },
      });
      urn = res.headers.get("x-restli-id") ?? res.headers.get("x-linkedin-id") ?? asString(res.data.id);
      if (!urn) throw new DriverError("LinkedIn didn't return the post id.", "unknown", { platform: P });
      await save({ published: { urn } });
    }
    const warnings: string[] = [];
    let firstCommentId = asString(s.firstCommentId) || undefined;
    if (content.firstComment.trim() && !firstCommentId) {
      try {
        const res = await rest(ctx, `/rest/socialActions/${encodeURIComponent(urn)}/comments`, tok, {
          method: "POST",
          json: { actor: owner, object: urn, message: { text: escapeLittleText(content.firstComment.trim()) } },
        });
        firstCommentId = res.headers.get("x-restli-id") ?? (asString(res.data.id) || "comment");
        await save({ firstCommentId });
      } catch (error) {
        warnings.push(`First comment failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { externalId: urn, permalink: postUrl(urn), firstCommentId, warnings: warnings.length ? warnings : undefined, usage: { posts: 1 } };
  },

  async deleteRemote(ctx, channel, externalId) {
    await rest(ctx, `/rest/posts/${encodeURIComponent(externalId)}`, token(channel), { method: "DELETE" });
  },

  async fetchMetrics() {
    return []; // r_member_social is closed: no analytics for profile posts.
  },

  async findExisting(_ctx, input) {
    // Reading a member's posts needs r_member_social (closed), so only what we saved can tell.
    const urn = asString(asRecord(input.uploadState.published).urn);
    return urn ? { externalId: urn, permalink: postUrl(urn) } : null;
  },

  async revoke(ctx, channel) {
    const app = ctx.app;
    const tok = channel.credentials.accessToken;
    if (!app || !tok) return false;
    try {
      await call(ctx, P, "https://www.linkedin.com/oauth/v2/revoke", { method: "POST", form: { client_id: app.clientId, client_secret: app.clientSecret, token: tok } });
      return true;
    } catch {
      return false;
    }
  },
};

/**
 * The Posts API reads `commentary` as "little text": these characters must be escaped or the
 * text is cut / misread (mentions and hashtags are written with their own syntax).
 */
export function escapeLittleText(text: string): string {
  const escaped = text.replace(/[\\|{}@[\]()<>#*_~]/g, (c) => `\\${c}`);
  // Hashtags stay clickable: #tag → {hashtag|\#|tag} (the tag's own "_" was escaped above).
  return escaped.replace(/(^|[^\p{L}\p{N}\\])\\#((?:[\p{L}\p{N}]|\\_)+)/gu, (_m, pre: string, tag: string) => `${pre}{hashtag|\\#|${tag}}`);
}
