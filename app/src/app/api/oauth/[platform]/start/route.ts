import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { getChannel } from "@/lib/channels";
import { channelManager, channelsPath, connectablePlatform, errorQuery, oauthCookieOptions, startConnect } from "@/lib/platforms/connect";
import { rateLimit } from "@/lib/rate-limit";

/**
 * Starts connecting a social account: GET /api/oauth/<platform>/start?wid=<workspace>[&reconnect=<channel>]
 * (signed-in member who may manage channels). Sets the sealed OAuth cookie (state nonce, PKCE
 * verifier, carried values) and redirects to the network's consent screen, or to the local fake
 * consent page when platforms are simulated. The network returns to /api/oauth/<platform>/callback.
 */

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: { params: Promise<{ platform: string }> }) {
  const { platform: raw } = await params;
  const wid = Number(request.nextUrl.searchParams.get("wid") ?? NaN);
  const user = await getCurrentUser();
  if (!user) return NextResponse.redirect(new URL(`/login?next=${encodeURIComponent(Number.isInteger(wid) ? channelsPath(wid) : "/dashboard")}`, request.url));
  const workspace = await channelManager(user.id, wid);
  if (!workspace) return NextResponse.redirect(new URL("/dashboard", request.url));
  const back = (query: string) => {
    const res = NextResponse.redirect(new URL(channelsPath(workspace.id, query), request.url));
    res.headers.set("Cache-Control", "no-store");
    return res;
  };
  const platform = connectablePlatform(raw);
  if (!platform) return back(errorQuery("platform"));
  if (!rateLimit(`oauth-start:${user.id}`, 30, 60 * 60_000)) return back(errorQuery("rate"));
  const reconnectId = Number(request.nextUrl.searchParams.get("reconnect") ?? NaN);
  const reconnect = Number.isInteger(reconnectId) ? await getChannel(workspace.id, reconnectId) : undefined;

  const result = await startConnect({ userId: user.id, workspace, platform, reconnect: Boolean(reconnect && reconnect.platform === platform) });
  if (result.kind === "error") return back(errorQuery(result.code, result.message));
  if (result.kind === "form") return back(`connect=${platform}`);
  const res = NextResponse.redirect(result.url);
  const secure = request.nextUrl.protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
  res.cookies.set(result.cookie.name, result.cookie.value, oauthCookieOptions(secure));
  res.headers.set("Cache-Control", "no-store");
  return res;
}
