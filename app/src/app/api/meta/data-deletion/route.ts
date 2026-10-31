import { NextResponse, type NextRequest } from "next/server";
import { getDeletionRequest, handleDeletion, metaSecrets, parseSignedRequest } from "@/lib/platforms/data-deletion";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { getSettings } from "@/lib/settings";
import { absoluteUrl } from "@/lib/site";

/**
 * Meta data deletion callback.
 *   POST (from Meta, form field signed_request) → { url, confirmation_code }
 *   GET ?code=<confirmation code>               → a status page for the person
 * Paste https://<your site>/api/meta/data-deletion in the Meta app (Admin → Platforms shows it).
 */

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (!rateLimit(`meta-deletion:${await clientIp()}`, 60, 60_000)) return NextResponse.json({ error: "Too many requests." }, { status: 429 });
  let signed = "";
  try {
    const type = request.headers.get("content-type") ?? "";
    if (type.includes("application/json")) signed = String(((await request.json()) as { signed_request?: unknown }).signed_request ?? "");
    else signed = String((await request.formData()).get("signed_request") ?? "");
  } catch {
    signed = "";
  }
  const settings = await getSettings();
  for (const app of metaSecrets(settings)) {
    const parsed = parseSignedRequest(signed, app.secret);
    if (!parsed) continue;
    const { code } = await handleDeletion(parsed, app.platforms, app.label);
    return NextResponse.json({ url: absoluteUrl(settings, `/api/meta/data-deletion?code=${code}`), confirmation_code: code });
  }
  return NextResponse.json({ error: "Invalid signed_request." }, { status: 400 });
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code") ?? "";
  const settings = await getSettings();
  const row = await getDeletionRequest(code);
  const body = row
    ? `<p>Request <code>${esc(row.code)}</code> was received on ${esc(row.created_at.slice(0, 10))}.</p><p><strong>Status: ${row.status === "completed" ? "completed" : "in progress"}.</strong> ${row.status === "completed" ? `The access tokens and profile data of ${row.channels_deleted} connected account${row.channels_deleted === 1 ? "" : "s"} were deleted${row.completed_at ? ` on ${esc(row.completed_at.slice(0, 10))}` : ""}.` : ""}</p>`
    : `<p>No deletion request was found for this confirmation code.</p>`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Data deletion - ${esc(settings.site_name)}</title>
<style>:root{color-scheme:light dark}body{font:16px/1.6 system-ui,sans-serif;max-width:560px;margin:10vh auto;padding:0 20px}code{font-size:14px}</style></head>
<body><h1>Data deletion request</h1>${body}<p>Questions? Contact <a href="mailto:${esc(settings.site_email)}">${esc(settings.site_email)}</a>.</p><p><a href="${esc(absoluteUrl(settings, "/"))}">${esc(settings.site_name)}</a></p></body></html>`;
  return new Response(html, { status: row ? 200 : 404, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
