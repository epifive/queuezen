import { apiError } from "@/lib/api-guard";
import { apiCreated, readApiJson } from "@/lib/api-v1";
import { mediaApiJson } from "@/lib/media/http";
import { completeUpload, MediaServiceError } from "@/lib/media/service";
import { v1Guard } from "../../_shared";

/** POST /api/v1/media/complete { token, alt_text?, blob_url? } — after the upload: adds the file to the library → 201 { media }. */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  const guard = await v1Guard(request, { capability: "media.manage", write: true });
  if (!guard.ok) return guard.response;
  const body = await readApiJson(request);
  if (body instanceof Response) return body;
  if (typeof body.token !== "string" || !body.token) return apiError(422, "token is required (from POST /api/v1/media).");
  try {
    const item = await completeUpload({
      token: body.token,
      workspaceId: guard.workspace.id,
      userId: guard.user.id,
      altText: typeof body.alt_text === "string" ? body.alt_text : "",
      blobUrl: typeof body.blob_url === "string" ? body.blob_url : undefined,
    });
    return apiCreated({ media: mediaApiJson(item) });
  } catch (error) {
    if (error instanceof MediaServiceError) {
      const status = error.code === "token" ? 403 : error.code === "storage" ? 503 : 422;
      return Response.json({ error: error.message, code: error.code }, { status, headers: { "Cache-Control": "no-store" } });
    }
    console.error("[queuezen] API media complete error:", error);
    return apiError(500, "The upload couldn't be completed.");
  }
}
