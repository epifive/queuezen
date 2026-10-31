import { PLATFORM_CAPABILITIES } from "@/social/platforms";
import { DriverError, type DriverChannel, type DriverContext, type MediaAsset, type MetricsResult, type PostMetrics, type PublishInput, type UploadState } from "@/social/types";
import type { PlatformDriver } from "./extras";
import { asNumber, asRecord, asString, call, fileName, httpError, multipart, pendingError, pollBudget, sameText, sinceMs, sleep, textWithLink, type CallOptions, type HttpResponse, type PlatformContext, type PublishResultWithUsage } from "./http";
import { pkceChallenge } from "./pkce";

/**
 * Mastodon (any instance): an app is registered on each instance the first time someone connects
 * from it (POST /api/v1/apps, cached per instance and redirect URI), then OAuth with PKCE.
 * Tokens never expire. Media goes through /api/v2/media (processed asynchronously, polled),
 * statuses use the Idempotency-Key header, threads and the first comment are replies.
 * Docs: docs.joinmastodon.org/methods/apps, /methods/oauth, /methods/media, /methods/statuses.
 */

const P = "mastodon" as const;
const SCOPES = PLATFORM_CAPABILITIES.mastodon.auth.scopes.join(" ");

/** "mastodon.social", "https://mastodon.social/", "@me@mastodon.social" → "https://mastodon.social". */
export function normalizeInstance(input: string): string {
  let v = input.trim().toLowerCase();
  const at = /^@?[^@\s]+@([^@\s]+)$/.exec(v);
  if (at) v = at[1];
  if (!/^https?:\/\//.test(v)) v = `https://${v}`;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new DriverError("Enter your Mastodon server, e.g. mastodon.social.", "validation", { platform: P, code: "instance" });
  }
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(u.hostname) && !/^(localhost|127\.0\.0\.1)$/.test(u.hostname)) {
    throw new DriverError("Enter your Mastodon server, e.g. mastodon.social.", "validation", { platform: P, code: "instance" });
  }
  return `${u.protocol}//${u.host}`;
}

function mastoError(ctx: DriverContext, res: HttpResponse): DriverError {
  if (res.status === 401 || res.status === 403) {
    const msg = asString(asRecord(res.data).error) || `HTTP ${res.status}`;
    return new DriverError(msg, res.status === 401 ? "auth" : "validation", { status: res.status, platform: P });
  }
  return httpError(ctx, P, res);
}

function api<T = Record<string, unknown>>(ctx: DriverContext, instance: string, path: string, tok: string | null, options: CallOptions = {}) {
  return call<T>(ctx, P, `${instance}${path}`, { ...options, headers: { ...(tok ? { Authorization: `Bearer ${tok}` } : {}), ...(options.headers ?? {}) }, mapError: (r) => mastoError(ctx, r) });
}

const instanceOf = (c: DriverChannel) => c.credentials.instanceUrl || asString(c.meta.instance);
const token = (c: DriverChannel) => {
  if (!c.credentials.accessToken) throw new DriverError("The channel has no access token: reconnect it.", "auth", { platform: P });
  return c.credentials.accessToken;
};

/** The app of this site on the instance (registered on first use). */
async function appFor(ctx: DriverContext, instance: string): Promise<{ clientId: string; clientSecret: string }> {
  const store = (ctx as PlatformContext).mastodonApps;
  const cached = await store?.get(instance, ctx.redirectUri);
  if (cached) return cached;
  const siteName = ctx.app?.extra.siteName || "Queuezen";
  const res = await api(ctx, instance, "/api/v1/apps", null, {
    method: "POST",
    json: { client_name: siteName, redirect_uris: ctx.redirectUri, scopes: SCOPES, website: ctx.app?.extra.siteUrl || undefined },
  });
  const app = { clientId: asString(res.data.client_id), clientSecret: asString(res.data.client_secret) };
  if (!app.clientId || !app.clientSecret) throw new DriverError("The Mastodon server didn't register the app.", "unknown", { platform: P });
  await store?.save(instance, ctx.redirectUri, app);
  return app;
}

async function uploadMedia(ctx: DriverContext, instance: string, tok: string, asset: MediaAsset, s: UploadState, save: (p: UploadState) => Promise<void>): Promise<string> {
  const all = asRecord(s.media);
  const saved = asRecord(all[String(asset.id)]);
  let id = asString(saved.id);
  if (id && saved.ready) return id;
  if (!id) {
    const body = multipart([
      { name: "file", filename: fileName(asset), contentType: asset.mime, size: asset.size, open: () => asset.open() },
      ...(asset.altText ? [{ name: "description", value: asset.altText.slice(0, 1500) }] : []),
    ]);
    const res = await api(ctx, instance, "/api/v2/media", tok, { method: "POST", body: body.body, headers: { "Content-Type": body.contentType }, contentLength: body.length });
    id = asString(res.data.id);
    if (!id) throw new DriverError("The Mastodon server didn't accept the media.", "media", { platform: P });
    const ready = res.status === 200 && !!res.data.url;
    await save({ media: { ...asRecord(s.media), [String(asset.id)]: { id, ready } } });
    if (ready) return id;
  }
  const deadline = ctx.now() + pollBudget(ctx);
  for (let delay = 1_500; ; delay = Math.min(delay * 2, 10_000)) {
    const res = await api(ctx, instance, `/api/v1/media/${id}`, tok, { okStatuses: [206] });
    if (res.status === 200 && res.data.url) break;
    if (ctx.now() + delay > deadline) throw pendingError(P, "The Mastodon server is still processing the media.", 30_000);
    await sleep(ctx, delay);
  }
  await save({ media: { ...asRecord(s.media), [String(asset.id)]: { id, ready: true } } });
  return id;
}

export const mastodonDriver: PlatformDriver = {
  platform: P,

  async connectStart(ctx, input) {
    if (!input.form.instance) {
      return { kind: "form", fields: [{ name: "instance", label: "dash.channels.form.mastodonInstance", type: "text", placeholder: "mastodon.social", hint: "dash.channels.form.mastodonInstanceHint", required: true }] };
    }
    const instance = normalizeInstance(input.form.instance);
    const app = await appFor(ctx, instance);
    const u = new URL(`${instance}/oauth/authorize`);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", app.clientId);
    u.searchParams.set("redirect_uri", ctx.redirectUri);
    u.searchParams.set("scope", SCOPES);
    u.searchParams.set("state", input.state);
    u.searchParams.set("code_challenge", await pkceChallenge(input.codeVerifier));
    u.searchParams.set("code_challenge_method", "S256");
    return { kind: "redirect", url: u.toString(), carry: { instance } };
  },

  async connectFinish(ctx, input) {
    if (input.query.error) throw new DriverError(input.query.error_description || "The connection was cancelled.", "auth", { platform: P, code: input.query.error });
    const instance = input.carry.instance;
    if (!instance || !input.query.code) throw new DriverError("No authorization code was returned.", "auth", { platform: P });
    const app = await appFor(ctx, instance);
    const res = await api(ctx, instance, "/oauth/token", null, {
      method: "POST",
      form: { grant_type: "authorization_code", code: input.query.code, client_id: app.clientId, client_secret: app.clientSecret, redirect_uri: ctx.redirectUri, scope: SCOPES, code_verifier: input.codeVerifier },
    });
    const tok = asString(res.data.access_token);
    if (!tok) throw new DriverError("The Mastodon server returned no access token.", "auth", { platform: P });
    const me = await api(ctx, instance, "/api/v1/accounts/verify_credentials", tok);
    const acct = asString(me.data.acct) || asString(me.data.username);
    const host = new URL(instance).host;
    return [
      {
        externalId: `${asString(me.data.id)}@${host}`,
        name: asString(me.data.display_name) || acct,
        handle: `@${acct.includes("@") ? acct : `${acct}@${host}`}`,
        avatarUrl: asString(me.data.avatar),
        profileUrl: asString(me.data.url),
        credentials: { accessToken: tok, instanceUrl: instance, clientId: app.clientId, clientSecret: app.clientSecret, scopes: SCOPES.split(" ") },
        tokenExpiresAt: null,
        meta: { instance, accountId: asString(me.data.id), followers: asNumber(me.data.followers_count) ?? null },
      },
    ];
  },

  async refresh() {
    return null; // Mastodon tokens don't expire.
  },

  async testConnection(ctx, channel) {
    try {
      const me = await api(ctx, instanceOf(channel), "/api/v1/accounts/verify_credentials", token(channel));
      return { ok: true, account: { name: asString(me.data.display_name) || asString(me.data.acct), avatarUrl: asString(me.data.avatar), profileUrl: asString(me.data.url), meta: { ...channel.meta, followers: asNumber(me.data.followers_count) ?? null } } };
    } catch (error) {
      return { ok: false, error: error instanceof DriverError ? error : new DriverError(String(error), "unknown", { platform: P }) };
    }
  },

  async publish(ctx, input: PublishInput): Promise<PublishResultWithUsage> {
    const { channel, content } = input;
    const instance = instanceOf(channel);
    const tok = token(channel);
    const s = { ...input.target.uploadState };
    const save = async (patch: UploadState) => {
      Object.assign(s, patch);
      await input.saveState(patch);
    };
    const opts = content.options.mastodon;
    const mediaIds: string[] = [];
    for (const asset of input.media.slice(0, 4)) mediaIds.push(await uploadMedia(ctx, instance, tok, asset, s, save));
    const status = async (key: string, text: string, extra: Record<string, unknown>): Promise<{ id: string; url: string }> => {
      const done = asRecord(s[key]);
      if (done.id) return { id: asString(done.id), url: asString(done.url) };
      const res = await api(ctx, instance, "/api/v1/statuses", tok, {
        method: "POST",
        headers: { "Idempotency-Key": `${input.target.idempotencyKey}:${key}` },
        json: {
          status: text,
          visibility: opts?.visibility ?? "public",
          ...(opts?.spoilerText ? { spoiler_text: opts.spoilerText } : {}),
          ...(opts?.language ? { language: opts.language } : {}),
          ...extra,
        },
      });
      const out = { id: asString(res.data.id), url: asString(res.data.url) || asString(res.data.uri) };
      if (!out.id) throw new DriverError("The Mastodon server didn't return the post.", "unknown", { platform: P });
      await save({ [key]: out });
      return out;
    };
    const text = textWithLink(content);
    if (!text && !mediaIds.length) throw new DriverError("The post is empty.", "validation", { platform: P });
    const main = await status("main", text, mediaIds.length ? { media_ids: mediaIds } : {});
    const warnings: string[] = [];
    const threadIds: string[] = [];
    let previous = main.id;
    for (const [i, part] of content.thread.entries()) {
      if (!part.trim()) continue;
      try {
        previous = (await status(`part${i}`, part.trim(), { in_reply_to_id: previous })).id;
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
        firstCommentId = (await status("comment", content.firstComment.trim(), { in_reply_to_id: main.id })).id;
      } catch (error) {
        if (error instanceof DriverError && error.retryable) throw error;
        warnings.push(`First comment failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { externalId: main.id, permalink: main.url, threadIds: threadIds.length ? threadIds : undefined, firstCommentId, warnings: warnings.length ? warnings : undefined, usage: { posts: 1 + threadIds.length + (firstCommentId ? 1 : 0) } };
  },

  async deleteRemote(ctx, channel, externalId) {
    await api(ctx, instanceOf(channel), `/api/v1/statuses/${externalId}`, token(channel), { method: "DELETE" });
  },

  async fetchMetrics(ctx, channel, items) {
    const out: MetricsResult[] = [];
    for (const item of items) {
      try {
        const res = await api(ctx, instanceOf(channel), `/api/v1/statuses/${item.externalId}`, token(channel));
        const metrics: PostMetrics = {};
        const set = (f: keyof PostMetrics, v: unknown) => {
          const n = asNumber(v);
          if (n !== undefined) metrics[f] = n;
        };
        set("likes", res.data.favourites_count);
        set("shares", res.data.reblogs_count);
        set("comments", res.data.replies_count);
        out.push({ externalId: item.externalId, metrics });
      } catch (error) {
        if (error instanceof DriverError && (error.kind === "rate_limit" || error.kind === "auth")) throw error;
      }
    }
    return out;
  },

  async findExisting(ctx, input) {
    const main = asRecord(input.uploadState.main);
    if (main.id) return { externalId: asString(main.id), permalink: asString(main.url) };
    // The Idempotency-Key makes a retry within an hour return the same status; look further back too.
    const accountId = asString(input.channel.meta.accountId);
    if (!accountId) return null;
    try {
      const res = await api(ctx, instanceOf(input.channel), `/api/v1/accounts/${accountId}/statuses`, token(input.channel), { query: { limit: 10, exclude_replies: true } });
      for (const raw of Array.isArray(res.data) ? res.data : []) {
        const st = asRecord(raw);
        const at = Date.parse(asString(st.created_at));
        if (Number.isFinite(at) && at < sinceMs(input.since) - 60_000) continue;
        const plain = asString(st.content).replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
        if (sameText(plain, input.content.text)) return { externalId: asString(st.id), permalink: asString(st.url) };
      }
    } catch {
      return null;
    }
    return null;
  },

  async revoke(ctx, channel) {
    const c = channel.credentials;
    if (!c.accessToken || !c.clientId || !c.clientSecret) return false;
    try {
      await call(ctx, P, `${instanceOf(channel)}/oauth/revoke`, { method: "POST", form: { client_id: c.clientId, client_secret: c.clientSecret, token: c.accessToken } });
      return true;
    } catch {
      return false;
    }
  },
};
