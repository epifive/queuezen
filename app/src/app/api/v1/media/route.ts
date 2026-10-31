import { apiError, apiJson } from "@/lib/api-guard";
import { apiCreated, pageParams, readApiJson } from "@/lib/api-v1";
import { mediaApiJson } from "@/lib/media/http";
import { importMediaFromUrl, initUpload, listMedia, MediaServiceError } from "@/lib/media/service";
import { getSettings } from "@/lib/settings";
import { absoluteUrl } from "@/lib/site";
import { v1Guard } from "../_shared";

/**
 * GET  /api/v1/media                      the library (?limit &offset)
 * POST /api/v1/media { media_url }        imports a public image / video URL → 201 { media }
 * POST /api/v1/media { filename, mime, size }
 *   → 201 { upload: { method, url, headers }, token, complete_url }: PUT the file's bytes to
 *   upload.url with upload.headers, then POST { token, alt_text? } to complete_url → { media }.
 * Use the returned media id in a post's media_ids.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 120;

function mediaError(error: unknown): Response {
  if (error instanceof MediaServiceError) {
    const status = error.code === "quota" ? 403 : error.code === "storage" ? 503 : error.code === "not_found" ? 404 : 422;
    return Response.json({ error: error.message, code: error.code, ...error.params }, { status, headers: { "Cache-Control": "no-store" } });
  }
  console.error("[queuezen] API media error:", error);
  return apiError(500, "The media request failed.");
}

export async function GET(request: Request) {
  const guard = await v1Guard(request);
  if (!guard.ok) return guard.response;
  const { limit, offset } = pageParams(new URL(request.url));
  const { items, total } = await listMedia(guard.workspace.id, { limit, offset });
  return apiJson({ media: items.map(mediaApiJson), total, limit, offset });
}

export async function POST(request: Request) {
  const guard = await v1Guard(request, { capability: "media.manage", write: true });
  if (!guard.ok) return guard.response;
  const body = await readApiJson(request);
  if (body instanceof Response) return body;
  const workspace = { id: guard.workspace.id, ownerId: guard.workspace.ownerId };
  try {
    const mediaUrl = body.media_url ?? body.url;
    if (typeof mediaUrl === "string" && mediaUrl.trim()) {
      const item = await importMediaFromUrl({ workspace, userId: guard.user.id, url: mediaUrl.trim() });
      return apiCreated({ media: mediaApiJson(item) });
    }
    const filename = typeof body.filename === "string" ? body.filename.slice(0, 200) : "";
    const mime = typeof body.mime === "string" ? body.mime : "";
    const size = Number(body.size);
    if (!filename || !mime || !Number.isFinite(size) || size <= 0) return apiError(422, "Send media_url to import a file, or filename, mime and size (bytes) to get an upload URL.");
    const init = await initUpload({ workspace, userId: guard.user.id, filename, mime, size });
    const settings = await getSettings();
    const url = /^https?:\/\//i.test(init.upload.url) ? init.upload.url : absoluteUrl(settings, init.upload.url);
    return apiCreated({
      upload: { method: init.upload.method, url, headers: init.upload.headers, returns_url: init.upload.returnsUrl },
      token: init.token,
      complete_url: absoluteUrl(settings, "/api/v1/media/complete"),
      expires_in: 7200,
    });
  } catch (error) {
    return mediaError(error);
  }
}
