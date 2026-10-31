import { NextResponse, type NextRequest } from "next/server";
import { countClick, findLinkByCode, isBotUserAgent } from "@/lib/shortlinks";

/**
 * Short link redirect: /l/<code> → the destination (302). Counts the click (daily counter only,
 * no personal data) unless the request comes from a bot or a link-preview fetcher, or is a HEAD /
 * prefetch request.
 */

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer-when-downgrade" };

async function handle(request: NextRequest, { params }: { params: Promise<{ code: string }> }, count: boolean): Promise<Response> {
  const { code } = await params;
  const link = await findLinkByCode(code);
  if (!link) {
    return new NextResponse("This short link doesn't exist.", { status: 404, headers: { ...NO_STORE, "Content-Type": "text/plain; charset=utf-8" } });
  }
  const purpose = `${request.headers.get("purpose") ?? ""} ${request.headers.get("sec-purpose") ?? ""} ${request.headers.get("x-moz") ?? ""}`;
  if (count && !/prefetch|preview/i.test(purpose) && !isBotUserAgent(request.headers.get("user-agent"))) {
    await countClick(link.id);
  }
  return NextResponse.redirect(link.url, { status: 302, headers: NO_STORE });
}

export function GET(request: NextRequest, context: { params: Promise<{ code: string }> }) {
  return handle(request, context, true);
}

export function HEAD(request: NextRequest, context: { params: Promise<{ code: string }> }) {
  return handle(request, context, false);
}
