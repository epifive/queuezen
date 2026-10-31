import { DriverError, type ChannelCredentials, type DriverChannel, type DriverContext, type MediaAsset, type MetricsResult, type PostMetrics, type PublishInput, type UploadState } from "@/social/types";
import type { PlatformDriver } from "./extras";
import { asNumber, asRecord, asString, bytesBody, call, errorMessage, httpError, jwtPayload, readAll, sameText, sinceMs, type CallOptions, type HttpResponse, type PublishResultWithUsage } from "./http";

/**
 * Bluesky (AT Protocol) with an app password: com.atproto.server.createSession once, then the
 * stored session (access JWT ~2 h, refresh JWT ~90 days) is refreshed by the token job. Posts
 * carry byte-offset facets for links, mentions and hashtags, up to 4 images (≤ 2 MB, alt text),
 * a video, or an external link card we build from the post's link details. Thread parts and
 * the first comment are replies (root + parent refs). The record key is chosen up front and
 * saved, so a retry finds the post instead of creating it twice.
 * Docs: docs.bsky.app/docs/advanced-guides/post-richtext, /docs/tutorials/creating-a-post.
 */

/** Default entryway (createSession); the account's own PDS comes from its DID document. */
export const BSKY_SERVICE = "https://bsky.social";
const P = "bluesky" as const;
const APP_PASSWORD_RE = /^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/i;

interface Session {
  accessJwt: string;
  refreshJwt: string;
  did: string;
  pds?: string;
}

function bskyError(ctx: DriverContext, res: HttpResponse): DriverError {
  const d = asRecord(res.data);
  const code = asString(d.error);
  const message = errorMessage(res.data, `HTTP ${res.status}`);
  const base = { status: res.status, code, platform: P };
  if (code === "ExpiredToken") return new DriverError(message, "auth", { ...base, retryable: true });
  if (code === "InvalidToken" || code === "AuthenticationRequired" || code === "AccountTakedown" || code === "AuthFactorTokenRequired" || res.status === 401) {
    return new DriverError(code === "AuthenticationRequired" ? "Bluesky refused the handle or app password." : message, "auth", base);
  }
  if (code === "BlobTooLarge" || code === "InvalidMimeType") return new DriverError(message, "media", base);
  return httpError(ctx, P, res);
}

function xrpc<T = Record<string, unknown>>(ctx: DriverContext, base: string, nsid: string, jwt: string | null, options: CallOptions = {}) {
  return call<T>(ctx, P, `${base.replace(/\/+$/, "")}/xrpc/${nsid}`, {
    ...options,
    headers: { ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}), ...(options.headers ?? {}) },
    mapError: (r) => bskyError(ctx, r),
  });
}

function pdsFromDidDoc(doc: unknown): string {
  const services = asRecord(doc).service;
  for (const raw of Array.isArray(services) ? services : []) {
    const s = asRecord(raw);
    if (asString(s.id).endsWith("#atproto_pds") || asString(s.type) === "AtprotoPersonalDataServer") return asString(s.serviceEndpoint);
  }
  return "";
}

const service = (c: ChannelCredentials) => c.extra?.service || BSKY_SERVICE;

async function createSession(ctx: DriverContext, svc: string, identifier: string, password: string): Promise<Session & { handle: string }> {
  const res = await xrpc(ctx, svc, "com.atproto.server.createSession", null, { method: "POST", json: { identifier, password } });
  const d = res.data;
  const did = asString(d.did);
  if (!did || !asString(d.accessJwt)) throw new DriverError("Bluesky didn't open a session.", "auth", { platform: P });
  return { accessJwt: asString(d.accessJwt), refreshJwt: asString(d.refreshJwt), did, pds: pdsFromDidDoc(d.didDoc) || svc, handle: asString(d.handle) };
}

function expiryOf(jwt: string): string | null {
  const exp = asNumber(jwtPayload(jwt).exp);
  return exp ? new Date(exp * 1000).toISOString() : null;
}

/**
 * A usable session for one call: the stored one, or a fresh createSession with the app password
 * when the access token expired (doesn't rotate the stored refresh token).
 */
async function sessionFor(ctx: DriverContext, channel: DriverChannel): Promise<Session> {
  const c = channel.credentials;
  const s = c.session;
  const exp = s ? asNumber(jwtPayload(s.accessJwt).exp) : undefined;
  if (s && (!exp || exp * 1000 > ctx.now() + 60_000)) return s;
  if (c.identifier && c.appPassword) return createSession(ctx, service(c), c.identifier, c.appPassword);
  if (s) return s;
  throw new DriverError("The Bluesky session is missing: reconnect the account.", "auth", { platform: P });
}

const pdsOf = (s: Session, c: ChannelCredentials) => s.pds || service(c);

// ── Rich text facets ──

export interface Facet {
  index: { byteStart: number; byteEnd: number };
  features: Array<{ $type: "app.bsky.richtext.facet#link"; uri: string } | { $type: "app.bsky.richtext.facet#mention"; did: string } | { $type: "app.bsky.richtext.facet#tag"; tag: string }>;
}

const utf8 = new TextEncoder();
const byteLen = (s: string) => utf8.encode(s).length;

export interface FacetSpan {
  type: "link" | "mention" | "tag";
  start: number;
  end: number;
  value: string;
}

/** Links, @handles and #tags in a text with their UTF-16 positions (byte offsets come later). */
export function detectFacets(text: string): FacetSpan[] {
  const spans: FacetSpan[] = [];
  const url = /(^|[\s(])((https?:\/\/[^\s<>"]+)|((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}(?:\/[^\s<>"]*)?))/gi;
  for (const m of text.matchAll(url)) {
    let value = m[2];
    const start = (m.index ?? 0) + m[1].length;
    // Bare domains must end in a real-looking TLD and not be part of an e-mail or handle.
    if (!m[3] && (text[start - 1] === "@" || !/\.(com|net|org|io|co|ai|app|dev|me|info|social|xyz|blog|news|tech|uk|de|fr|in|eu|us|ca|au|jp|br|es|it|nl)\b/i.test(value))) continue;
    value = value.replace(/[.,;:!?'")\]]+$/, (tail) => (tail.includes(")") && value.includes("(") ? tail.replace(/[^)]/g, "") : ""));
    spans.push({ type: "link", start, end: start + value.length, value: m[3] ? value : `https://${value}` });
  }
  const mention = /(^|[\s(])@((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*[a-z0-9])/gi;
  for (const m of text.matchAll(mention)) {
    const start = (m.index ?? 0) + m[1].length;
    spans.push({ type: "mention", start, end: start + 1 + m[2].length, value: m[2].toLowerCase() });
  }
  const tag = /(^|\s)[#＃]([^\s#]*[^\d\s\p{P}#][^\s#]*)/gu;
  for (const m of text.matchAll(tag)) {
    if (!m[2]) continue;
    const raw = m[2].replace(/\p{P}+$/gu, "");
    if (!raw || raw.length > 64) continue;
    const start = (m.index ?? 0) + m[1].length;
    spans.push({ type: "tag", start, end: start + 1 + raw.length, value: raw });
  }
  // Drop overlaps (a link containing "#fragment", a mention inside a URL…): first span wins.
  spans.sort((a, b) => a.start - b.start);
  const out: FacetSpan[] = [];
  for (const s of spans) if (!out.length || s.start >= out[out.length - 1].end) out.push(s);
  return out;
}

/** Facets with UTF-8 byte offsets; mentions resolve their handle to a DID (unresolved ones stay plain text). */
export async function buildFacets(text: string, resolve: (handle: string) => Promise<string | null>): Promise<Facet[]> {
  const facets: Facet[] = [];
  for (const span of detectFacets(text)) {
    const byteStart = byteLen(text.slice(0, span.start));
    const byteEnd = byteStart + byteLen(text.slice(span.start, span.end));
    if (span.type === "link") facets.push({ index: { byteStart, byteEnd }, features: [{ $type: "app.bsky.richtext.facet#link", uri: span.value }] });
    else if (span.type === "tag") facets.push({ index: { byteStart, byteEnd }, features: [{ $type: "app.bsky.richtext.facet#tag", tag: span.value }] });
    else {
      const did = await resolve(span.value);
      if (did) facets.push({ index: { byteStart, byteEnd }, features: [{ $type: "app.bsky.richtext.facet#mention", did }] });
    }
  }
  return facets;
}

// ── Record keys (TID) ──

const TID_CHARS = "234567abcdefghijklmnopqrstuvwxyz";

/** A TID record key from a microsecond timestamp and a clock id (13 base32-sortable chars). */
export function makeTid(micros: number, clock: number): string {
  let n = BigInt(Math.floor(micros)) * BigInt(1024) + BigInt(clock & 1023);
  let out = "";
  for (let i = 0; i < 13; i++) {
    out = TID_CHARS[Number(n % BigInt(32))] + out;
    n /= BigInt(32);
  }
  return out;
}

const rkeyOf = (uri: string) => uri.split("/").pop() ?? "";
const postLink = (handle: string, did: string, uri: string) => `https://bsky.app/profile/${handle.replace(/^@/, "") || did}/post/${rkeyOf(uri)}`;

export const blueskyDriver: PlatformDriver = {
  platform: P,

  async connectStart() {
    return {
      kind: "form",
      fields: [
        { name: "identifier", label: "dash.channels.form.bskyHandle", type: "text", placeholder: "you.bsky.social", required: true },
        { name: "appPassword", label: "dash.channels.form.bskyPassword", type: "password", placeholder: "xxxx-xxxx-xxxx-xxxx", hint: "dash.channels.form.bskyPasswordHint", required: true },
      ],
    };
  },

  async connectFinish(ctx, input) {
    const identifier = (input.form.identifier ?? "").trim().replace(/^@/, "");
    const password = (input.form.appPassword ?? "").trim();
    if (!identifier) throw new DriverError("Enter your Bluesky handle.", "validation", { platform: P, code: "identifier" });
    if (!APP_PASSWORD_RE.test(password)) {
      throw new DriverError("Use an app password (xxxx-xxxx-xxxx-xxxx) from Bluesky → Settings → Privacy and security → App passwords, not your account password.", "validation", { platform: P, code: "app_password" });
    }
    const svc = BSKY_SERVICE;
    const session = await createSession(ctx, svc, identifier, password);
    let name = session.handle;
    let avatar = "";
    let followers: number | null = null;
    try {
      const prof = await xrpc(ctx, session.pds || svc, "app.bsky.actor.getProfile", session.accessJwt, { query: { actor: session.did } });
      name = asString(prof.data.displayName) || session.handle;
      avatar = asString(prof.data.avatar);
      followers = asNumber(prof.data.followersCount) ?? null;
    } catch {
      // The profile is cosmetic.
    }
    return [
      {
        externalId: session.did,
        name,
        handle: `@${session.handle}`,
        avatarUrl: avatar,
        profileUrl: `https://bsky.app/profile/${session.handle}`,
        credentials: { identifier, appPassword: password, session: { accessJwt: session.accessJwt, refreshJwt: session.refreshJwt, did: session.did, pds: session.pds }, extra: { service: svc } },
        tokenExpiresAt: expiryOf(session.accessJwt),
        meta: { followers },
      },
    ];
  },

  async refresh(ctx, channel) {
    const c = channel.credentials;
    const s = c.session;
    let next: Session | null = null;
    if (s?.refreshJwt) {
      try {
        const res = await xrpc(ctx, pdsOf(s, c), "com.atproto.server.refreshSession", s.refreshJwt, { method: "POST" });
        next = { accessJwt: asString(res.data.accessJwt), refreshJwt: asString(res.data.refreshJwt) || s.refreshJwt, did: asString(res.data.did) || s.did, pds: pdsFromDidDoc(res.data.didDoc) || s.pds };
      } catch (error) {
        if (!(error instanceof DriverError) || error.kind !== "auth") throw error;
      }
    }
    if (!next?.accessJwt) {
      if (!c.identifier || !c.appPassword) throw new DriverError("The Bluesky session expired: reconnect the account.", "auth", { platform: P });
      next = await createSession(ctx, service(c), c.identifier, c.appPassword);
    }
    return { credentials: { ...c, session: { accessJwt: next.accessJwt, refreshJwt: next.refreshJwt, did: next.did, pds: next.pds } }, tokenExpiresAt: expiryOf(next.accessJwt) };
  },

  async testConnection(ctx, channel) {
    try {
      const s = await sessionFor(ctx, channel);
      const prof = await xrpc(ctx, pdsOf(s, channel.credentials), "app.bsky.actor.getProfile", s.accessJwt, { query: { actor: s.did } });
      return { ok: true, account: { name: asString(prof.data.displayName) || asString(prof.data.handle), handle: `@${asString(prof.data.handle)}`, avatarUrl: asString(prof.data.avatar), meta: { ...channel.meta, followers: asNumber(prof.data.followersCount) ?? null } } };
    } catch (error) {
      return { ok: false, error: error instanceof DriverError ? error : new DriverError(String(error), "unknown", { platform: P }) };
    }
  },

  async publish(ctx, input: PublishInput): Promise<PublishResultWithUsage> {
    const { channel, content } = input;
    const sess = await sessionFor(ctx, channel);
    const pds = pdsOf(sess, channel.credentials);
    const st = { ...input.target.uploadState };
    const save = async (patch: UploadState) => {
      Object.assign(st, patch);
      await input.saveState(patch);
    };
    const handles = new Map<string, string | null>();
    const resolve = async (handle: string) => {
      if (!handles.has(handle)) {
        try {
          const res = await xrpc(ctx, pds, "com.atproto.identity.resolveHandle", sess.accessJwt, { query: { handle } });
          handles.set(handle, asString(res.data.did) || null);
        } catch {
          handles.set(handle, null);
        }
      }
      return handles.get(handle) ?? null;
    };
    const upload = async (asset: MediaAsset, max: number): Promise<Record<string, unknown>> => {
      const saved = asRecord(asRecord(st.blobs)[String(asset.id)]);
      if (saved.ref) return saved;
      if (asset.size > max) throw new DriverError(`The file is too big for Bluesky (${Math.ceil(asset.size / 1048576)} MB).`, "media", { platform: P });
      // Images are small; videos are streamed (never held in memory).
      const body = asset.kind === "video" ? await asset.open() : bytesBody(await readAll(asset, max, P));
      const res = await xrpc(ctx, pds, "com.atproto.repo.uploadBlob", sess.accessJwt, { method: "POST", headers: { "Content-Type": asset.mime }, body, contentLength: asset.kind === "video" ? asset.size : undefined });
      const blob = asRecord(res.data.blob);
      await save({ blobs: { ...asRecord(st.blobs), [String(asset.id)]: blob } });
      return blob;
    };
    // Record keys are chosen before the first write, so a retry can look the post up.
    let clock = asNumber(st.clock) ?? Math.floor(Math.random() * 1024);
    if (st.clock === undefined) await save({ clock });
    const base = asNumber(st.tidBase) ?? ctx.now() * 1000;
    if (st.tidBase === undefined) await save({ tidBase: base });
    const createPost = async (key: string, index: number, text: string, extra: Record<string, unknown>): Promise<{ uri: string; cid: string }> => {
      const done = asRecord(st[key]);
      if (done.uri) return { uri: asString(done.uri), cid: asString(done.cid) };
      const rkey = makeTid(base + index, clock);
      const record = {
        $type: "app.bsky.feed.post",
        text,
        createdAt: new Date(ctx.now()).toISOString(),
        ...(content.options.bluesky?.langs?.length ? { langs: content.options.bluesky.langs.slice(0, 3) } : {}),
        ...extra,
      };
      const facets = await buildFacets(text, resolve);
      if (facets.length) Object.assign(record, { facets });
      try {
        const res = await xrpc(ctx, pds, "com.atproto.repo.createRecord", sess.accessJwt, { method: "POST", json: { repo: sess.did, collection: "app.bsky.feed.post", rkey, record } });
        const out = { uri: asString(res.data.uri), cid: asString(res.data.cid) };
        await save({ [key]: out });
        return out;
      } catch (error) {
        // Same key already written by an attempt that timed out: read it back.
        if (error instanceof DriverError && error.status === 400 && /already exists|RecordAlreadyExists|InvalidSwap/i.test(`${error.code} ${error.message}`)) {
          const got = await xrpc(ctx, pds, "com.atproto.repo.getRecord", sess.accessJwt, { query: { repo: sess.did, collection: "app.bsky.feed.post", rkey } });
          const out = { uri: asString(got.data.uri), cid: asString(got.data.cid) };
          await save({ [key]: out });
          return out;
        }
        clock = (clock + 1) & 1023;
        throw error;
      }
    };

    const imgs = input.media.filter((m) => m.kind !== "video").slice(0, 4);
    const video = input.media.find((m) => m.kind === "video");
    let embed: Record<string, unknown> | undefined;
    if (video) {
      const blob = await upload(video, 100 * 1024 * 1024);
      embed = { $type: "app.bsky.embed.video", video: blob, ...(video.altText ? { alt: video.altText.slice(0, 1000) } : {}), ...(video.width && video.height ? { aspectRatio: { width: video.width, height: video.height } } : {}) };
    } else if (imgs.length) {
      const images = [];
      for (const img of imgs) {
        const blob = await upload(img, 2 * 1024 * 1024);
        images.push({ image: blob, alt: img.altText.slice(0, 2000), ...(img.width && img.height ? { aspectRatio: { width: img.width, height: img.height } } : {}) });
      }
      embed = { $type: "app.bsky.embed.images", images };
    } else if (content.link) {
      let thumb: Record<string, unknown> | undefined = Object.keys(asRecord(st.thumb)).length ? asRecord(st.thumb) : undefined;
      if (!thumb && content.linkMeta?.imageUrl) {
        try {
          const res = await ctx.fetch(content.linkMeta.imageUrl, { redirect: "follow" });
          const type = (res.headers.get("content-type") ?? "").split(";")[0];
          if (res.ok && /^image\//.test(type)) {
            const bytes = new Uint8Array(await res.arrayBuffer());
            if (bytes.length <= 1_000_000) {
              const up = await xrpc(ctx, pds, "com.atproto.repo.uploadBlob", sess.accessJwt, { method: "POST", headers: { "Content-Type": type }, body: bytesBody(bytes) });
              thumb = asRecord(up.data.blob);
              await save({ thumb });
            }
          }
        } catch {
          thumb = undefined;
        }
      }
      embed = {
        $type: "app.bsky.embed.external",
        external: { uri: content.link, title: content.linkMeta?.title ?? "", description: content.linkMeta?.description ?? "", ...(thumb ? { thumb } : {}) },
      };
    }
    const text = content.text.trim();
    if (!text && !embed) throw new DriverError("The post is empty.", "validation", { platform: P });
    const root = await createPost("main", 0, text, embed ? { embed } : {});
    const handle = channel.handle;
    const warnings: string[] = [];
    const threadIds: string[] = [];
    let parent = root;
    for (const [i, part] of content.thread.entries()) {
      if (!part.trim()) continue;
      try {
        parent = await createPost(`part${i}`, i + 1, part.trim(), { reply: { root, parent } });
        threadIds.push(parent.uri);
      } catch (error) {
        if (error instanceof DriverError && error.retryable) throw error;
        warnings.push(`Thread part ${i + 2} failed: ${error instanceof Error ? error.message : String(error)}`);
        break;
      }
    }
    let firstCommentId: string | undefined;
    if (content.firstComment.trim()) {
      try {
        firstCommentId = (await createPost("comment", 100, content.firstComment.trim(), { reply: { root, parent: root } })).uri;
      } catch (error) {
        if (error instanceof DriverError && error.retryable) throw error;
        warnings.push(`First comment failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { externalId: root.uri, permalink: postLink(handle, sess.did, root.uri), threadIds: threadIds.length ? threadIds : undefined, firstCommentId, warnings: warnings.length ? warnings : undefined, usage: { posts: 1 + threadIds.length + (firstCommentId ? 1 : 0) } };
  },

  async deleteRemote(ctx, channel, externalId) {
    const s = await sessionFor(ctx, channel);
    await xrpc(ctx, pdsOf(s, channel.credentials), "com.atproto.repo.deleteRecord", s.accessJwt, { method: "POST", json: { repo: s.did, collection: "app.bsky.feed.post", rkey: rkeyOf(externalId) } });
  },

  async fetchMetrics(ctx, channel, items) {
    const s = await sessionFor(ctx, channel);
    const out: MetricsResult[] = [];
    for (let i = 0; i < items.length; i += 25) {
      const batch = items.slice(i, i + 25);
      const params = new URLSearchParams();
      for (const b of batch) params.append("uris", b.externalId);
      const res = await call(ctx, P, `${pdsOf(s, channel.credentials).replace(/\/+$/, "")}/xrpc/app.bsky.feed.getPosts?${params.toString()}`, {
        headers: { Authorization: `Bearer ${s.accessJwt}` },
        mapError: (r) => bskyError(ctx, r),
      });
      for (const raw of Array.isArray(res.data.posts) ? res.data.posts : []) {
        const p = asRecord(raw);
        const metrics: PostMetrics = {};
        const set = (field: keyof PostMetrics, v: unknown) => {
          const n = asNumber(v);
          if (n !== undefined) metrics[field] = n;
        };
        set("likes", p.likeCount);
        set("shares", p.repostCount);
        set("comments", p.replyCount);
        set("quotes", p.quoteCount);
        out.push({ externalId: asString(p.uri), metrics });
      }
    }
    return out;
  },

  async findExisting(ctx, input) {
    const main = asRecord(input.uploadState.main);
    if (main.uri) return { externalId: asString(main.uri), permalink: postLink(input.channel.handle, input.channel.externalId, asString(main.uri)) };
    const base = asNumber(input.uploadState.tidBase);
    const clock = asNumber(input.uploadState.clock);
    try {
      const s = await sessionFor(ctx, input.channel);
      const pds = pdsOf(s, input.channel.credentials);
      if (base !== undefined && clock !== undefined) {
        try {
          const got = await xrpc(ctx, pds, "com.atproto.repo.getRecord", s.accessJwt, { query: { repo: s.did, collection: "app.bsky.feed.post", rkey: makeTid(base, clock) } });
          const uri = asString(got.data.uri);
          if (uri) return { externalId: uri, permalink: postLink(input.channel.handle, s.did, uri) };
        } catch {
          // Not there: fall through to the feed.
        }
      }
      const feed = await xrpc(ctx, pds, "app.bsky.feed.getAuthorFeed", s.accessJwt, { query: { actor: s.did, limit: 10, filter: "posts_no_replies" } });
      for (const raw of Array.isArray(feed.data.feed) ? feed.data.feed : []) {
        const post = asRecord(asRecord(raw).post);
        const record = asRecord(post.record);
        const at = Date.parse(asString(record.createdAt));
        if (Number.isFinite(at) && at < sinceMs(input.since) - 60_000) continue;
        if (sameText(asString(record.text), input.content.text)) return { externalId: asString(post.uri), permalink: postLink(input.channel.handle, s.did, asString(post.uri)) };
      }
    } catch {
      return null;
    }
    return null;
  },

  async revoke(ctx, channel) {
    const s = channel.credentials.session;
    if (!s?.refreshJwt) return false;
    try {
      await xrpc(ctx, pdsOf(s, channel.credentials), "com.atproto.server.deleteSession", s.refreshJwt, { method: "POST" });
      return true;
    } catch {
      return false;
    }
  },
};
