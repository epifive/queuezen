import { apiError, apiJson } from "@/lib/api-guard";
import { pathId, readApiJson, toApiPost } from "@/lib/api-v1";
import { decidePost } from "@/lib/approvals";
import { getPost } from "@/lib/posts";
import { v1Guard } from "../../../_shared";

/**
 * POST /api/v1/posts/{id}/approve  { comment? } — approves a post waiting for approval (the key's
 * member must be an approver, admin or owner). It becomes "scheduled" when it has a future date,
 * else "approved".
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await v1Guard(request, { capability: "approve", write: true });
  if (!guard.ok) return guard.response;
  const body = request.headers.get("content-length") === "0" ? {} : await readApiJson(request).then((b) => (b instanceof Response ? {} : b));
  const id = pathId((await params).id);
  const result = await decidePost(guard.workspace, id, "approved", { userId: guard.user.id, name: guard.user.name, role: guard.role }, typeof body.comment === "string" ? body.comment : "");
  if (!result.ok) {
    if (result.error === "not_found") return apiError(404, "Post not found.");
    if (result.error === "forbidden") return apiError(403, "The API key's member role can't approve posts.");
    if (result.error === "quota") return apiError(403, "The plan's monthly post limit is reached.");
    const post = await getPost(guard.workspace.id, id);
    return Response.json({ error: "Only posts waiting for approval can be approved.", status: post?.status ?? null }, { status: 409, headers: { "Cache-Control": "no-store" } });
  }
  return apiJson({ post: toApiPost((await getPost(guard.workspace.id, id))!) });
}
