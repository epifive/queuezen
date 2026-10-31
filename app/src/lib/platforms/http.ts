import { DriverError, type DriverContext, type MediaAsset, type Platform, type PostContent, type PublishResult } from "@/social/types";

/**
 * Shared toolkit of the platform drivers: HTTP calls through the injected `ctx.fetch`, mapping of
 * platform answers to DriverError kinds, Retry-After parsing, ranged media reads, a streaming
 * multipart body (videos are never loaded into memory) and small text helpers.
 *
 * Dependency-free apart from the contract, so the driver unit tests can bundle it without a DB.
 */

// ── Context extensions ──

/** Stored Mastodon app of an instance (client secret in clear, only inside the server). */
export interface MastodonAppRecord {
  clientId: string;
  clientSecret: string;
}

/**
 * Optional extras on top of the contract's DriverContext. The runtime (./runtime.ts) fills them;
 * tests inject fakes. Drivers work without them (sleep falls back to setTimeout).
 */
export interface PlatformContext extends DriverContext {
  /** Wait between status polls (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
  /** Mastodon apps registered per instance and redirect URI. */
  mastodonApps?: {
    get(instance: string, redirectUri: string): Promise<MastodonAppRecord | null>;
    save(instance: string, redirectUri: string, app: MastodonAppRecord): Promise<void>;
  };
  /** Longest a single publish call may poll a platform before handing back "pending" (ms). */
  pollBudgetMs?: number;
}

export function sleep(ctx: DriverContext, ms: number): Promise<void> {
  const fn = (ctx as PlatformContext).sleep;
  if (fn) return fn(ms);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function pollBudget(ctx: DriverContext, fallbackMs = 45_000): number {
  return (ctx as PlatformContext).pollBudgetMs ?? fallbackMs;
}

// ── Publish extras (read by the publishing engine and the usage meters) ──

/**
 * Usage of one publish call, attached to PublishResult as `usage` (see ./extras.ts):
 * - posts:       items created on the network (X: every tweet of a thread and the reply)
 * - uploads:     media uploads (YouTube counts against its 100 uploads/day per project)
 * - quotaUnits:  YouTube Data API quota units spent
 * - costMicros:  X API price in micro-dollars ($0.015 = 15,000)
 */
export interface PublishUsage {
  posts?: number;
  uploads?: number;
  apiCalls?: number;
  quotaUnits?: number;
  costMicros?: number;
  /** X: what each created post cost (url = it contained a link). */
  billed?: Array<{ id: string; url: boolean; micros: number }>;
}

export type PublishResultWithUsage = PublishResult & { usage?: PublishUsage };

/** Thrown when an upload / container is still processing: retry after `retryAfterMs`, not a failure. */
export const PENDING_CODE = "pending";

export function pendingError(platform: Platform, message: string, retryAfterMs = 60_000): DriverError {
  return new DriverError(message, "network", { retryable: true, code: PENDING_CODE, retryAfterMs, platform });
}

// ── HTTP ──

export interface HttpResponse<T = unknown> {
  status: number;
  headers: Headers;
  data: T;
  text: string;
}

export interface CallOptions {
  method?: string;
  headers?: Record<string, string>;
  /** JSON body (sets Content-Type). */
  json?: unknown;
  /** application/x-www-form-urlencoded body. */
  form?: Record<string, string | number | boolean | undefined | null>;
  /** Raw body (multipart streams, bytes). */
  body?: BodyInit | null;
  /** Query parameters appended to the URL (undefined / null skipped). */
  query?: Record<string, string | number | boolean | undefined | null>;
  /** HTTP statuses that are not errors besides 2xx (e.g. 308 for YouTube resumable). */
  okStatuses?: number[];
  /** Platform-specific error mapping; return null to use the default. */
  mapError?: (res: HttpResponse) => DriverError | null;
  /** Content length for streamed bodies. */
  contentLength?: number;
  redirect?: RequestRedirect;
}

export function withQuery(url: string, query?: CallOptions["query"]): string {
  if (!query) return url;
  const u = new URL(url);
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    u.searchParams.set(k, String(v));
  }
  return u.toString();
}

function formBody(form: NonNullable<CallOptions["form"]>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(form)) if (v !== undefined && v !== null) p.set(k, String(v));
  return p.toString();
}

/** Calls a platform API through ctx.fetch and maps failures to DriverError. Parses JSON when it can. */
export async function call<T = Record<string, unknown>>(ctx: DriverContext, platform: Platform, url: string, options: CallOptions = {}): Promise<HttpResponse<T>> {
  const headers: Record<string, string> = { Accept: "application/json", ...(options.headers ?? {}) };
  let body: BodyInit | null | undefined = options.body;
  if (options.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.json);
  } else if (options.form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = formBody(options.form);
  }
  if (options.contentLength !== undefined) headers["Content-Length"] = String(options.contentLength);
  const init: RequestInit & { duplex?: "half" } = { method: options.method ?? (body ? "POST" : "GET"), headers, body: body ?? undefined, redirect: options.redirect ?? "follow" };
  if (body && typeof (body as ReadableStream).getReader === "function") init.duplex = "half";
  let res: Response;
  try {
    res = await ctx.fetch(withQuery(url, options.query), init);
  } catch (error) {
    if (error instanceof DriverError) throw error;
    const msg = error instanceof Error ? error.message : String(error);
    throw new DriverError(`Network error: ${msg}`, "network", { platform, cause: error });
  }
  const text = await res.text().catch(() => "");
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  const out: HttpResponse<T> = { status: res.status, headers: res.headers, data: data as T, text };
  const ok = (res.status >= 200 && res.status < 300) || (options.okStatuses ?? []).includes(res.status);
  if (ok) return out;
  throw options.mapError?.(out as HttpResponse) ?? httpError(ctx, platform, out as HttpResponse);
}

/** Best human message from a platform error body. */
export function errorMessage(data: unknown, fallback: string): string {
  if (typeof data === "string") return data.slice(0, 300) || fallback;
  if (!data || typeof data !== "object") return fallback;
  const d = data as Record<string, unknown>;
  const pick = (v: unknown): string => (typeof v === "string" && v.trim() ? v.trim() : "");
  const err = d.error;
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    const m = pick(e.error_user_msg) || pick(e.message) || pick(e.error_description);
    if (m) return m;
  }
  const errors = d.errors;
  if (Array.isArray(errors) && errors[0] && typeof errors[0] === "object") {
    const e = errors[0] as Record<string, unknown>;
    const m = pick(e.message) || pick(e.detail) || pick(e.title);
    if (m) return m;
  }
  return pick(d.error_description) || pick(d.detail) || pick(d.message) || pick(d.description) || pick(d.title) || pick(err) || fallback;
}

/** Retry-After (seconds or HTTP date), X-RateLimit-Reset (epoch s) or a body hint, in ms. */
export function retryAfterMs(headers: Headers, nowMs: number, bodySeconds?: unknown): number | null {
  const ra = headers.get("retry-after");
  if (ra) {
    const secs = Number(ra);
    if (Number.isFinite(secs)) return Math.max(0, Math.round(secs * 1000));
    const at = Date.parse(ra);
    if (Number.isFinite(at)) return Math.max(0, at - nowMs);
  }
  const reset = headers.get("x-rate-limit-reset") ?? headers.get("x-ratelimit-reset") ?? headers.get("ratelimit-reset");
  if (reset && /^\d+(\.\d+)?$/.test(reset)) {
    const n = Number(reset);
    // Epoch seconds (X, Bluesky) or a delta in seconds (IETF draft header).
    return n > 1_000_000_000 ? Math.max(0, n * 1000 - nowMs) : Math.round(n * 1000);
  }
  if (typeof bodySeconds === "number" && Number.isFinite(bodySeconds)) return Math.max(0, Math.round(bodySeconds * 1000));
  return null;
}

/** Default status → kind mapping. */
export function httpError(ctx: DriverContext, platform: Platform, res: HttpResponse): DriverError {
  const message = errorMessage(res.data, `HTTP ${res.status}`);
  const code = errorCode(res.data);
  const base = { status: res.status, code, platform };
  if (res.status === 429) return new DriverError(message, "rate_limit", { ...base, retryAfterMs: retryAfterMs(res.headers, ctx.now()) });
  if (res.status === 401) return new DriverError(message, "auth", base);
  if (res.status === 413 || res.status === 415) return new DriverError(message, "media", base);
  if (res.status === 408 || res.status >= 500) return new DriverError(message, "network", { ...base, retryAfterMs: retryAfterMs(res.headers, ctx.now()) });
  if (res.status >= 400) return new DriverError(message, "validation", base);
  return new DriverError(message, "unknown", base);
}

export function errorCode(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const d = data as Record<string, unknown>;
  const err = d.error && typeof d.error === "object" ? (d.error as Record<string, unknown>) : null;
  const c = err?.code ?? d.error_code ?? d.code ?? (typeof d.error === "string" ? d.error : undefined);
  const sub = err?.error_subcode;
  return c === undefined || c === null ? "" : `${String(c)}${sub ? `/${String(sub)}` : ""}`;
}

export function ensureOk(condition: unknown, platform: Platform, message: string): asserts condition {
  if (!condition) throw new DriverError(message, "unknown", { platform });
}

export function requireApp(ctx: DriverContext, platform: Platform): { clientId: string; clientSecret: string; extra: Record<string, string> } {
  if (!ctx.app || !ctx.app.clientId) throw new DriverError(`The ${platform} app isn't configured (Admin → Platforms).`, "auth", { platform, code: "not_configured" });
  return ctx.app;
}

export function authError(platform: Platform, message: string, code = ""): DriverError {
  return new DriverError(message, "auth", { platform, code });
}

export function validationError(platform: Platform, message: string, code = ""): DriverError {
  return new DriverError(message, "validation", { platform, code });
}

export const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
export const asString = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
export const asNumber = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : undefined);

export function isoIn(ctx: DriverContext, seconds: number | undefined | null): string | null {
  return seconds && Number.isFinite(seconds) ? new Date(ctx.now() + seconds * 1000).toISOString() : null;
}

/** Payload of a JWT (no signature check: used for expiry of tokens we were just given). */
export function jwtPayload(token: string): Record<string, unknown> {
  try {
    const part = token.split(".")[1] ?? "";
    const json = atob(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "="));
    return asRecord(JSON.parse(json));
  } catch {
    return {};
  }
}

// ── Media ──

/** Reads bytes [start, end) of an asset (works whether open() treats `end` as inclusive or exclusive). */
export async function readRange(asset: MediaAsset, start: number, end: number): Promise<Uint8Array> {
  const want = Math.max(0, end - start);
  const stream = await asset.open({ start, end });
  return collect(stream, want);
}

/** Reads the whole asset; refuses files bigger than `max` bytes (use chunked uploads for those). */
export async function readAll(asset: MediaAsset, max: number, platform: Platform): Promise<Uint8Array> {
  if (asset.size > max) throw new DriverError(`The file is too big for a single upload (${Math.ceil(asset.size / 1048576)} MB).`, "media", { platform });
  return collect(await asset.open(), max);
}

async function collect(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      const take = Math.min(value.length, limit - total);
      chunks.push(take === value.length ? value : value.subarray(0, take));
      total += take;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** A stream of an asset limited to its declared size (for streamed uploads). */
export async function assetStream(asset: MediaAsset): Promise<ReadableStream<Uint8Array>> {
  return asset.open();
}

export function bytesBody(bytes: Uint8Array): BodyInit {
  return bytes as unknown as BodyInit;
}

const enc = new TextEncoder();

export type MultipartPart =
  | { name: string; value: string }
  | { name: string; filename: string; contentType: string; size: number; open: () => Promise<ReadableStream<Uint8Array>> }
  | { name: string; filename: string; contentType: string; bytes: Uint8Array };

/**
 * multipart/form-data body streamed part by part (file parts are piped from their streams, never
 * buffered whole). Returns the exact length so Content-Length can be sent.
 */
export function multipart(parts: MultipartPart[], boundary = `----queuezen${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`): { body: ReadableStream<Uint8Array>; contentType: string; length: number } {
  const esc = (s: string) => s.replace(/"/g, "%22").replace(/\r|\n/g, " ");
  const heads = parts.map((p) =>
    enc.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="${esc(p.name)}"${"filename" in p ? `; filename="${esc(p.filename)}"\r\nContent-Type: ${p.contentType}` : ""}\r\n\r\n`,
    ),
  );
  const crlf = enc.encode("\r\n");
  const tail = enc.encode(`--${boundary}--\r\n`);
  let length = tail.length;
  parts.forEach((p, i) => {
    length += heads[i].length + crlf.length;
    if ("value" in p) length += enc.encode(p.value).length;
    else if ("bytes" in p) length += p.bytes.length;
    else length += p.size;
  });
  let index = 0;
  let current: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let remaining = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (current) {
        const { done, value } = await current.read();
        if (!done && value && remaining > 0) {
          const take = value.length > remaining ? value.subarray(0, remaining) : value;
          remaining -= take.length;
          controller.enqueue(take);
          if (remaining > 0) return;
        }
        await current.cancel().catch(() => undefined);
        current = null;
        controller.enqueue(crlf);
        index += 1;
        return;
      }
      if (index >= parts.length) {
        controller.enqueue(tail);
        controller.close();
        return;
      }
      const p = parts[index];
      controller.enqueue(heads[index]);
      if ("value" in p) {
        controller.enqueue(enc.encode(p.value));
        controller.enqueue(crlf);
        index += 1;
      } else if ("bytes" in p) {
        controller.enqueue(p.bytes);
        controller.enqueue(crlf);
        index += 1;
      } else {
        current = (await p.open()).getReader();
        remaining = p.size;
      }
    },
  });
  return { body, contentType: `multipart/form-data; boundary=${boundary}`, length };
}

export function fileName(asset: MediaAsset): string {
  const ext = asset.mime.split("/")[1]?.replace("quicktime", "mov").replace("jpeg", "jpg").replace(/[^a-z0-9]/g, "") || "bin";
  return `media-${asset.id}.${ext}`;
}

// ── Text ──

/** The post text with the link appended when the platform previews links from the text and the link isn't in it yet. */
export function textWithLink(content: Pick<PostContent, "text" | "link">): string {
  const text = content.text.trim();
  const link = content.link.trim();
  if (!link || text.includes(link)) return text;
  return text ? `${text}\n\n${link}` : link;
}

/** Normalised text for matching a post we may have created already (findExisting). */
export function matchKey(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 80).toLowerCase();
}

export function sameText(a: string, b: string): boolean {
  const ka = matchKey(a);
  const kb = matchKey(b);
  if (!ka || !kb) return false;
  return ka === kb || ka.startsWith(kb.slice(0, 60)) || kb.startsWith(ka.slice(0, 60));
}

export function sinceMs(since: string): number {
  const t = Date.parse(since);
  return Number.isFinite(t) ? t : 0;
}
