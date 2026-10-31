import { apiError, apiJson } from "@/lib/api-guard";
import { pathId, readApiJson, toApiPost } from "@/lib/api-v1";
import { notifyApprovalRequested } from "@/lib/approvals";
import { getWorkspaceChannels } from "@/lib/channels";
import { deletePost, getPost, savePost, type SaveIntent } from "@/lib/posts";
import { commonQueueSlot } from "@/lib/recycle";
import { bool } from "@/social/normalize";
import { channelIdsFrom, contentFrom, intentOf, labelsFrom, overridesFrom, POST_MODES, saveErrorResponse, scheduledFrom, v1Guard, type PostMode } from "../../_shared";

/**
 * GET    /api/v1/posts/{id}
 * PATCH  /api/v1/posts/{id}  any of: text | content{…}, overrides, channel_ids, labels, scheduled_at,
 *                            mode, is_evergreen (missing fields keep their values)
 * DELETE /api/v1/posts/{id}  removes the post from Queuezen (409 while it is publishing)
 */
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Ctx) {
  const guard = await v1Guard(request);
  if (!guard.ok) return guard.response;
  const post = await getPost(guard.workspace.id, pathId((await params).id));
  if (!post) return apiError(404, "Post not found.");
  return apiJson({ post: toApiPost(post) });
}

/** The save intent that keeps a post in its current state. */
function currentIntent(status: string): SaveIntent | null {
  if (status === "draft" || status === "failed") return "draft";
  if (status === "pending_approval") return "submit";
  if (status === "scheduled") return "schedule";
  return null;
}

export async function PATCH(request: Request, { params }: Ctx) {
  const guard = await v1Guard(request, { capability: "post.create", write: true });
  if (!guard.ok) return guard.response;
  const post = await getPost(guard.workspace.id, pathId((await params).id));
  if (!post) return apiError(404, "Post not found.");
  const body = await readApiJson(request);
  if (body instanceof Response) return body;
  let intent: SaveIntent | null;
  if (body.mode !== undefined) {
    if (!(POST_MODES as readonly string[]).includes(String(body.mode))) return apiError(422, `mode must be one of: ${POST_MODES.join(", ")}.`);
    intent = intentOf(body.mode as PostMode);
  } else intent = currentIntent(post.status);
  if (!intent) return Response.json({ error: `The post can't be changed while it is "${post.status}".`, status: post.status }, { status: 409, headers: { "Cache-Control": "no-store" } });
  const channelIds = channelIdsFrom(body) ?? post.targets.map((t) => t.channelId);
  let scheduledAt = scheduledFrom(body);
  if (scheduledAt === "invalid") return apiError(422, "scheduled_at must be ISO-8601 with a time zone or epoch seconds.");
  if (body.mode === "queue") {
    const channels = (await getWorkspaceChannels(guard.workspace.id)).filter((c) => channelIds.includes(c.id));
    scheduledAt = channels.length ? await commonQueueSlot(channels, guard.workspace.timezone) : null;
    if (!scheduledAt) return apiError(422, "None of the channels has queue times.");
  }
  const overrides = overridesFrom(body);
  const result = await savePost({
    workspace: guard.workspace,
    actor: { userId: guard.user.id, role: guard.role },
    postId: post.id,
    content: contentFrom(body, post.content),
    overrides: overrides ?? Object.fromEntries(post.targets.map((t) => [t.channelId, t.override])),
    channelIds,
    labels: labelsFrom(body),
    scheduledAt: scheduledAt === undefined ? post.scheduledAt : scheduledAt,
    intent,
    isEvergreen: body.is_evergreen === undefined && body.isEvergreen === undefined ? undefined : bool(body.is_evergreen ?? body.isEvergreen, false),
  });
  if (!result.ok) return saveErrorResponse(result);
  if (result.post.status === "pending_approval" && post.status !== "pending_approval") await notifyApprovalRequested(guard.workspace, result.post, { userId: guard.user.id, name: guard.user.name });
  return apiJson({ post: toApiPost(result.post) });
}

export async function DELETE(request: Request, { params }: Ctx) {
  const guard = await v1Guard(request, { capability: "post.create", write: true });
  if (!guard.ok) return guard.response;
  const post = await getPost(guard.workspace.id, pathId((await params).id));
  if (!post) return apiError(404, "Post not found.");
  if (post.status === "publishing") return Response.json({ error: "The post is being published right now. Try again in a minute.", status: post.status }, { status: 409, headers: { "Cache-Control": "no-store" } });
  if (!(await deletePost(guard.workspace, post.id))) return Response.json({ error: "The post couldn't be deleted right now.", status: post.status }, { status: 409, headers: { "Cache-Control": "no-store" } });
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}
