import "server-only";
import { apiError, apiGuard } from "@/lib/api-guard";
import { camelKeys } from "@/lib/api-v1";
import type { SavePostError, SaveIntent } from "@/lib/posts";
import { rateLimit } from "@/lib/rate-limit";
import { getWorkspaceEntitlements } from "@/lib/workspaces";
import { idList, normalizeLabels, normalizePostContent, roleCan } from "@/social/normalize";
import type { PostContent, WorkspaceCapability } from "@/social/types";

/**
 * Helpers of the REST API v1 routes (src/app/api/v1/**). Authentication, the plan's API access
 * and the per-key rate limit come from apiGuard (src/lib/api-guard.ts); writes get a second,
 * tighter limit. Errors are JSON { error } (+ details) with 401/403/404/409/422/429.
 */

/** Writes (POST / PATCH / DELETE) per API key and minute, on top of the general limit. */
export const API_WRITE_LIMIT = 120;

export async function v1Guard(request: Request, options: { capability?: WorkspaceCapability; write?: boolean } = {}) {
  const guard = await apiGuard(request);
  if (!guard.ok) return guard;
  if (options.capability && !roleCan(guard.role, options.capability)) {
    return { ok: false as const, response: apiError(403, "The API key's member role doesn't allow this.") };
  }
  if (options.write && !rateLimit(`api-write:${guard.workspace.id}:${guard.user.id}`, API_WRITE_LIMIT, 60_000)) {
    return { ok: false as const, response: apiError(429, "Too many write requests. Slow down and try again in a minute.", { "Retry-After": "60" }) };
  }
  return { ...guard, entitlements: await getWorkspaceEntitlements(guard.workspace) };
}

export const POST_MODES = ["draft", "submit", "schedule", "queue", "now"] as const;
export type PostMode = (typeof POST_MODES)[number];

export function intentOf(mode: PostMode): SaveIntent {
  return mode === "now" ? "publish_now" : mode === "queue" ? "schedule" : mode;
}

/** The post content from an API body: `content: {...}` or the same fields at the top level. */
export function contentFrom(body: Record<string, unknown>, base?: PostContent): PostContent {
  const src = body.content && typeof body.content === "object" && !Array.isArray(body.content) ? (body.content as Record<string, unknown>) : body;
  const pick = (snake: string, camel: string) => (snake in src ? src[snake] : src[camel]);
  return normalizePostContent({
    text: "text" in src ? src.text : base?.text,
    mediaIds: pick("media_ids", "mediaIds") ?? base?.mediaIds,
    link: "link" in src ? src.link : base?.link,
    linkMeta: "link_meta" in src || "linkMeta" in src ? camelKeys(pick("link_meta", "linkMeta")) : base?.linkMeta,
    firstComment: pick("first_comment", "firstComment") ?? base?.firstComment,
    thread: "thread" in src ? src.thread : base?.thread,
    options: "options" in src ? camelKeys(src.options) : base?.options,
  });
}

/** channel id → override, from { overrides: { "12": { text, media_ids, … } } }. */
export function overridesFrom(body: Record<string, unknown>): Record<number, unknown> | undefined {
  const raw = body.overrides;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<number, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const id = Number(key);
    if (!Number.isInteger(id) || id < 1 || !value || typeof value !== "object") continue;
    const v = value as Record<string, unknown>;
    out[id] = {
      ...("text" in v ? { text: v.text } : {}),
      ...("media_ids" in v || "mediaIds" in v ? { mediaIds: v.media_ids ?? v.mediaIds } : {}),
      ...("link" in v ? { link: v.link } : {}),
      ...("first_comment" in v || "firstComment" in v ? { firstComment: v.first_comment ?? v.firstComment } : {}),
      ...("thread" in v ? { thread: v.thread } : {}),
      ...("options" in v ? { options: camelKeys(v.options) } : {}),
    };
  }
  return out;
}

export function channelIdsFrom(body: Record<string, unknown>): number[] | undefined {
  const raw = body.channel_ids ?? body.channelIds;
  return raw === undefined ? undefined : idList(raw, 100);
}

export function labelsFrom(body: Record<string, unknown>): string[] | undefined {
  return body.labels === undefined ? undefined : normalizeLabels(body.labels);
}

/** A timestamp from the body: ISO-8601 with a zone ("2026-10-21T09:30:00Z") or epoch seconds. */
export function scheduledFrom(body: Record<string, unknown>): string | null | undefined | "invalid" {
  const raw = body.scheduled_at ?? body.scheduledAt;
  if (raw === undefined) return undefined;
  if (raw === null || raw === "") return null;
  if (typeof raw === "number" && Number.isFinite(raw)) return new Date(raw * 1000).toISOString();
  if (typeof raw === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(raw.trim())) {
    const ms = Date.parse(raw.trim());
    return Number.isFinite(ms) ? new Date(ms).toISOString() : "invalid";
  }
  return "invalid";
}

/** HTTP answer for a savePost / approval error. */
export function saveErrorResponse(error: SavePostError): Response {
  switch (error.code) {
    case "not_found":
      return apiError(404, "Post not found.");
    case "forbidden":
      return apiError(403, "The API key's member role doesn't allow this.");
    case "approval_required":
      return apiError(403, "This workspace requires approval: use mode \"submit\" (the key's member is an editor).");
    case "not_editable":
      return Response.json({ error: `The post can't be changed while it is "${error.status}".`, status: error.status }, { status: 409, headers: { "Cache-Control": "no-store" } });
    case "no_channels":
      return apiError(422, "Choose at least one active channel (channel_ids).");
    case "date_required":
      return apiError(422, "scheduled_at is required (ISO-8601 with a time zone, at most 2 years ahead).");
    case "date_past":
      return apiError(422, "scheduled_at is in the past.");
    case "quota":
      return Response.json(
        { error: error.reason === "x" ? "The plan's monthly limit of posts to X is reached (or X isn't included)." : "The plan's monthly post limit is reached.", used: error.used, limit: error.limit },
        { status: 403, headers: { "Cache-Control": "no-store" } },
      );
    case "invalid": {
      const issues = Object.fromEntries([...error.issues.entries()].filter(([, r]) => r.errors.length).map(([channelId, r]) => [channelId, r.errors.map((e) => ({ code: e.code, message: e.message, field: e.field ?? null }))]));
      return Response.json({ error: "The post doesn't meet the networks' rules.", issues }, { status: 422, headers: { "Cache-Control": "no-store" } });
    }
  }
}
