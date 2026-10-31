import { type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { OAUTH_COOKIE, openOAuthCookie, verifyOAuthState } from "@/lib/oauth-state";
import { connectablePlatform } from "@/lib/platforms/connect";
import { ensureDrivers } from "@/lib/platforms/runtime";
import { simulatedAccounts } from "@/lib/platforms/simulated";
import { getSettings } from "@/lib/settings";
import { platformIconSvg, platformName, PLATFORM_STYLES } from "@/social/format";
import { PLATFORM_CAPABILITIES } from "@/social/platforms";

/**
 * The fake consent screen of the Simulated driver (demo mode, or "Simulated platforms" for
 * testing): shows the accounts the "network" would share and returns to the callback like a real
 * consent screen would. Only reachable with a valid connect state while simulation is on.
 */

export const dynamic = "force-dynamic";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

export async function GET(request: NextRequest, { params }: { params: Promise<{ platform: string }> }) {
  const { platform: raw } = await params;
  const platform = connectablePlatform(raw);
  const user = await getCurrentUser();
  const stateValue = request.nextUrl.searchParams.get("state") ?? "";
  const cookie = await openOAuthCookie(request.cookies.get(OAUTH_COOKIE)?.value);
  const state = user ? await verifyOAuthState(stateValue, cookie?.nonce, user.id) : null;
  if (!platform || !state || state.platform !== platform || !(await ensureDrivers())) {
    return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  const settings = await getSettings();
  const accounts = simulatedAccounts(platform, state.workspaceId, Date.now());
  const style = PLATFORM_STYLES[platform];
  const name = platformName(platform);
  const scopes = PLATFORM_CAPABILITIES[platform].auth.scopes;
  const callback = `/api/oauth/${platform}/callback`;
  const rows = accounts
    .map(
      (a) => `<li><img src="${esc(a.avatarUrl)}" alt="" width="40" height="40"><span><strong>${esc(a.name)}</strong><small>${esc(a.handle || a.externalId)}</small></span></li>`,
    )
    .join("");
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(name)} (simulated) - Authorize ${esc(settings.site_name)}</title>
<style>
:root{color-scheme:light dark;--bg:#f4f5f7;--card:#fff;--ink:#14161a;--muted:#5d6470;--line:#e2e5ea}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#181b21;--ink:#eef0f3;--muted:#9aa1ad;--line:#2a2f37}}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--ink);display:grid;place-items:center;min-height:100vh;padding:16px}
.card{width:100%;max-width:440px;background:var(--card);border:1px solid var(--line);border-radius:16px;overflow:hidden;box-shadow:0 10px 30px rgba(0,0,0,.08)}
header{background:${style.color};color:${style.onColor};padding:18px 22px;display:flex;align-items:center;gap:12px}
header svg{width:36px;height:36px;border-radius:9px;box-shadow:0 0 0 2px rgba(255,255,255,.35)}
header h1{font-size:17px;margin:0}header p{margin:0;font-size:12px;opacity:.85}
main{padding:20px 22px}.badge{display:inline-block;font-size:11px;font-weight:600;background:#fef3c7;color:#92400e;border-radius:999px;padding:2px 8px;margin-bottom:10px}
ul{list-style:none;margin:12px 0;padding:0;border:1px solid var(--line);border-radius:12px}
li{display:flex;align-items:center;gap:12px;padding:10px 12px}li+li{border-top:1px solid var(--line)}
li img{border-radius:50%}li span{display:flex;flex-direction:column;min-width:0}li small{color:var(--muted);font-size:12px;overflow:hidden;text-overflow:ellipsis}
.scopes{font-size:12px;color:var(--muted);margin:0 0 16px}.scopes code{font-size:11px}
.actions{display:flex;gap:10px;justify-content:flex-end}
button{font:inherit;font-weight:600;border-radius:10px;padding:9px 16px;cursor:pointer;border:1px solid var(--line);background:transparent;color:var(--ink)}
button.primary{background:${style.color};color:${style.onColor};border-color:${style.color}}
</style></head>
<body><div class="card">
<header>${platformIconSvg(platform, 36)}<div><h1>${esc(name)}</h1><p>Simulated network - nothing is sent anywhere</p></div></header>
<main>
<span class="badge">Testing only</span>
<p><strong>${esc(settings.site_name)}</strong> wants to publish on your behalf. These accounts will be shared:</p>
<ul>${rows}</ul>
${scopes.length ? `<p class="scopes">Permissions: ${scopes.map((s) => `<code>${esc(s)}</code>`).join(", ")}</p>` : ""}
<div class="actions">
<form method="get" action="${callback}"><input type="hidden" name="state" value="${esc(stateValue)}"><input type="hidden" name="error" value="access_denied"><button type="submit">Cancel</button></form>
<form method="get" action="${callback}"><input type="hidden" name="state" value="${esc(stateValue)}"><input type="hidden" name="code" value="sim.all"><button class="primary" type="submit" id="allow">Allow</button></form>
</div>
</main></div></body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY" } });
}
