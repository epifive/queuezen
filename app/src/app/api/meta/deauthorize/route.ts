import { NextResponse, type NextRequest } from "next/server";
import { handleDeauthorize, metaSecrets, parseSignedRequest } from "@/lib/platforms/data-deletion";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { getSettings } from "@/lib/settings";

/**
 * Meta deauthorize ("uninstall") callback: Meta POSTs a signed_request (form field) when a person
 * removes the app from their Facebook, Instagram or Threads account. After verifying the signature
 * with the app secret, the person's channels are disconnected (their tokens no longer work).
 * Paste https://<your site>/api/meta/deauthorize in the Meta app (Admin → Platforms shows it).
 */

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (!rateLimit(`meta-deauthorize:${await clientIp()}`, 60, 60_000)) return NextResponse.json({ error: "Too many requests." }, { status: 429 });
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
    const disconnected = await handleDeauthorize(parsed, app.platforms);
    return NextResponse.json({ success: true, disconnected });
  }
  return NextResponse.json({ error: "Invalid signed_request." }, { status: 400 });
}
