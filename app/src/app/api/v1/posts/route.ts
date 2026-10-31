import { apiError, apiJson } from "@/lib/api-guard";
import { apiCreated, pageParams, readApiJson, toApiPost } from "@/lib/api-v1";
import { notifyApprovalRequested } from "@/lib/approvals";
import { getWorkspaceChannels } from "@/lib/channels";
import { listPosts, savePost } from "@/lib/posts";
import { commonQueueSlot } from "@/lib/recycle";
import { bool, isPostStatus } from "@/social/normalize";
import type { PostStatus } from "@/social/types";
import { channelIdsFrom, contentFrom, intentOf, labelsFrom, overridesFrom, POST_MODES, saveErrorResponse, scheduledFrom, v1Guard, type PostMode } from "../_shared";

/**
 * GET  /api/v1/posts  ?status=scheduled,draft &from=ISO &to=ISO &channel_id= &limit= &offset=
 * POST /api/v1/posts  { channel_ids, text | content{…}, overrides?, labels?, mode, scheduled_at?, is_evergreen? }
 *   mode: "draft" | "submit" (for approval) | "schedule" (needs scheduled_at) | "queue" (next free
 *   queue slot of the channels) | "now".
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const guard = await v1Guard(request);
  if (!guard.ok) return guard.response;
  const url = new URL(request.url);
  const { limit, offset } = pageParams(url);
  const statusParam = url.searchParams.get("status");
  const status = statusParam ? statusParam.split(",").map((s) => s.trim()) : [];
  if (status.some((s) => !isPostStatus(s))) return apiError(422, "Unknown status. Use draft, pending_approval, approved, scheduled, publishing, published, partially_failed or failed.");
  const iso = (name: string) => {
    const v = url.searchParams.get(name);
    if (!v) return undefined;
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : "invalid";
  };
  const from = iso("from");
  const to = iso("to");
  if (from === "invalid" || to === "invalid") return apiError(422, "from / to must be ISO-8601 dates.");
  const channelId = Number(url.searchParams.get("channel_id")) || undefined;
  const posts = await listPosts(guard.workspace.id, { status: status as PostStatus[], from, to, channelId, limit: limit + 1, offset, order: from || to ? "scheduled_asc" : "updated_desc" });
  return apiJson({ posts: posts.slice(0, limit).map(toApiPost), limit, offset, has_more: posts.length > limit });
}

export async function POST(request: Request) {
  const guard = await v1Guard(request, { capability: "post.create", write: true });
  if (!guard.ok) return guard.response;
  const body = await readApiJson(request);
  if (body instanceof Response) return body;
  const mode = (body.mode ?? (body.scheduled_at || body.scheduledAt ? "schedule" : "draft")) as PostMode;
  if (!(POST_MODES as readonly string[]).includes(mode)) return apiError(422, `mode must be one of: ${POST_MODES.join(", ")}.`);
  const channelIds = channelIdsFrom(body) ?? [];
  let scheduledAt = scheduledFrom(body);
  if (scheduledAt === "invalid") return apiError(422, "scheduled_at must be ISO-8601 with a time zone (e.g. 2026-10-21T09:30:00Z) or epoch seconds.");
  if (mode === "queue") {
    const channels = (await getWorkspaceChannels(guard.workspace.id)).filter((c) => channelIds.includes(c.id));
    if (!channels.length) return apiError(422, "Choose at least one active channel (channel_ids).");
    scheduledAt = await commonQueueSlot(channels, guard.workspace.timezone);
    if (!scheduledAt) return apiError(422, "None of the channels has queue times. Set them in the dashboard or use mode \"schedule\".");
  }
  const result = await savePost({
    workspace: guard.workspace,
    actor: { userId: guard.user.id, role: guard.role },
    content: contentFrom(body),
    overrides: overridesFrom(body),
    channelIds,
    labels: labelsFrom(body),
    scheduledAt: scheduledAt ?? null,
    intent: intentOf(mode),
    source: "api",
    isEvergreen: bool(body.is_evergreen ?? body.isEvergreen, false),
  });
  if (!result.ok) return saveErrorResponse(result);
  if (result.post.status === "pending_approval") await notifyApprovalRequested(guard.workspace, result.post, { userId: guard.user.id, name: guard.user.name });
  return apiCreated({ post: toApiPost(result.post) });
}
