import "server-only";
import { apiError } from "./api-guard";
import type { ChannelRecord } from "./channels";
import type { PostRecord } from "./posts";
import { BodyTooLargeError, isRecord, parseJsonText, readBodyText } from "./public-api";
import type { ApiChannel, ApiPost, ApiPostContent, PostContent } from "@/social/types";

/**
 * Shared helpers of the REST API (/api/v1, Authorization: Bearer <API key of a workspace>).
 * The endpoints themselves (posts CRUD / schedule, channels, media upload URLs) are built on
 * these helpers. Errors are JSON { error } with: 401 missing / invalid key, 403 plan
 * without API access, a role that doesn't allow it or a plan limit, 404 unknown id (or another
 * workspace's), 409 conflict (post already publishing), 413 body too large, 422 invalid input,
 * 429 rate limit.
 */

export const MAX_API_BODY = 256 * 1024;

/** The JSON object body of a request, or an error response. */
export async function readApiJson(request: Request): Promise<Record<string, unknown> | Response> {
  let text: string;
  try {
    text = await readBodyText(request, MAX_API_BODY);
  } catch (error) {
    if (error instanceof BodyTooLargeError) return apiError(413, "Request body too large (max 256 KB).");
    return apiError(422, "Could not read the request body.");
  }
  const body = parseJsonText(text);
  if (!isRecord(body)) return apiError(422, "Send a JSON object (Content-Type: application/json).");
  return body;
}

/** An API channel (no credentials). */
export function toApiChannel(c: ChannelRecord): ApiChannel {
  return { id: c.id, platform: c.platform, name: c.name, handle: c.handle, status: c.status, avatar_url: c.avatarUrl };
}

/** Object keys camelCase → snake_case, recursively (API output). */
export function snakeKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snakeKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`), snakeKeys(v)]));
}

/** Object keys snake_case → camelCase, recursively (API input; camelCase keys pass unchanged). */
export function camelKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase()), camelKeys(v)]));
}

/** A post's content in the API's snake_case. */
export function toApiContent(c: PostContent): ApiPostContent {
  return {
    text: c.text,
    media_ids: c.mediaIds,
    link: c.link,
    link_meta: c.linkMeta ? { title: c.linkMeta.title, description: c.linkMeta.description, image_url: c.linkMeta.imageUrl } : null,
    first_comment: c.firstComment,
    thread: c.thread,
    options: snakeKeys(c.options) as Record<string, unknown>,
  };
}

/** An API post with its publications. */
export function toApiPost(p: PostRecord): ApiPost {
  return {
    id: p.id,
    status: p.status,
    scheduled_at: p.scheduledAt,
    content: toApiContent(p.content),
    labels: p.labels,
    targets: p.targets.map((t) => ({ id: t.id, channel_id: t.channelId, platform: t.platform, status: t.status, permalink: t.permalink, published_at: t.publishedAt, error: t.error })),
    created_at: p.createdAt,
  };
}

/** limit / offset query parameters (default 50, max 500). */
export function pageParams(url: URL): { limit: number; offset: number } {
  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 50));
  const offset = Math.max(0, Math.floor(Number(url.searchParams.get("offset")) || 0));
  return { limit, offset };
}

/** A positive integer id from a path segment, or NaN. */
export function pathId(value: string): number {
  return /^\d{1,10}$/.test(value) ? Number(value) : NaN;
}

/** Integer query parameter clamped to [min, max] (fallback when missing or invalid). */
export function intQuery(url: URL, name: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(name);
  const n = raw === null || raw.trim() === "" ? NaN : Number(raw);
  return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** 201 Created with a JSON body. */
export function apiCreated(data: unknown, status = 201) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}
