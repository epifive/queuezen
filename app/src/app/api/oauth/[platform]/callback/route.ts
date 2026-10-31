import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { OAUTH_COOKIE, openOAuthCookie, verifyOAuthState } from "@/lib/oauth-state";
import { getDriver } from "@/lib/platforms";
import { channelManager, channelsPath, connectablePlatform, connectFailure, errorQuery, OAUTH_COOKIE_PATH, saveOrPick, savedQuery } from "@/lib/platforms/connect";
import { ensureDrivers, getDriverContext } from "@/lib/platforms/runtime";

/**
 * Where the network sends the user back after the consent screen. Checks the signed state against
 * the sealed cookie (nonce, user, expiry), exchanges the code through the driver and adds the
 * account, or sends several accounts (Facebook Pages, Instagram accounts) to the picker.
 */

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: { params: Promise<{ platform: string }> }) {
  const { platform: raw } = await params;
  const query = Object.fromEntries(request.nextUrl.searchParams.entries());
  const user = await getCurrentUser();
  if (!user) return NextResponse.redirect(new URL("/login?next=/dashboard", request.url));
  const cookie = await openOAuthCookie(request.cookies.get(OAUTH_COOKIE)?.value);
  const state = await verifyOAuthState(query.state ?? "", cookie?.nonce, user.id);
  const platform = connectablePlatform(raw);
  const workspace = state ? await channelManager(user.id, state.workspaceId) : null;
  const done = (path: string) => {
    const res = NextResponse.redirect(new URL(path, request.url));
    res.cookies.set(OAUTH_COOKIE, "", { path: OAUTH_COOKIE_PATH, maxAge: 0 });
    res.headers.set("Cache-Control", "no-store");
    return res;
  };
  if (!state || !cookie || !workspace || !platform || state.platform !== platform) {
    // Unverified state: only use its workspace id to show the error where the user can act on it.
    const claimed = workspace ?? (await channelManager(user.id, Number((query.state ?? "").split(".")[1] ?? NaN)));
    return done(claimed ? channelsPath(claimed.id, errorQuery("state")) : "/dashboard");
  }
  if (query.error) return done(channelsPath(workspace.id, errorQuery("denied")));

  await ensureDrivers();
  const driver = getDriver(platform);
  if (!driver) return done(channelsPath(workspace.id, errorQuery("platform")));
  try {
    const accounts = await driver.connectFinish(await getDriverContext(platform), {
      workspaceId: workspace.id,
      userId: user.id,
      query,
      codeVerifier: cookie.codeVerifier,
      form: {},
      carry: cookie.carry,
    });
    const result = await saveOrPick({ userId: user.id, workspace, platform, accounts });
    if (result.kind === "pick") return done(`${channelsPath(workspace.id).replace(/\/channels$/, "/channels/pick")}?s=${encodeURIComponent(result.token)}`);
    if (result.kind === "error") return done(channelsPath(workspace.id, errorQuery(result.code, result.message)));
    return done(channelsPath(workspace.id, savedQuery(platform, result)));
  } catch (error) {
    const f = connectFailure(error);
    console.error(`[queuezen] ${platform} connect failed:`, f.message ?? f.code);
    return done(channelsPath(workspace.id, errorQuery(f.code, f.message)));
  }
}
