import { DriverError, type DriverContext, type Platform } from "@/social/types";
import { asRecord, asString, call } from "./http";
import { testMetaApp } from "./meta";
import { checkThreadsApp } from "./threads";

/**
 * Admin → Platforms → Test: checks the operator's app credentials where the network has an
 * endpoint that tells a wrong client id / secret apart from a merely unusable request.
 *   Facebook / Instagram (Meta app): app access token (client_credentials)
 *   X, LinkedIn, Google: the token endpoint with a dummy code: "invalid_client" means the
 *                        credentials are wrong, "invalid_grant"/"invalid_request" means they're fine
 *   Threads, Instagram Login: format checks (no app-token endpoint)
 */
export async function testPlatformApp(ctx: DriverContext, platform: Platform): Promise<{ ok: boolean; message: string }> {
  const app = ctx.app;
  if (!app?.clientId || !app.clientSecret) return { ok: false, message: "Enter the client id and secret first." };
  try {
    switch (platform) {
      case "facebook":
      case "instagram":
        return { ok: true, message: await testMetaApp(ctx, platform) };
      case "instagram_login": {
        if (!/^\d{6,25}$/.test(app.clientId)) return { ok: false, message: "The Instagram app ID should be a number (Meta app → Instagram → API setup with Instagram login)." };
        if (!/^[a-f0-9]{32}$/i.test(app.clientSecret)) return { ok: false, message: "The Instagram app secret should be 32 hexadecimal characters." };
        return { ok: true, message: "The Instagram app ID and secret look right. Connect an account to finish the check." };
      }
      case "threads": {
        const problem = checkThreadsApp(app.clientId, app.clientSecret);
        return problem ? { ok: false, message: problem } : { ok: true, message: "The Threads app ID and secret look right. Connect a tester account to finish the check." };
      }
      case "x":
        return tokenProbe(ctx, platform, "https://api.x.com/2/oauth2/token", { grant_type: "authorization_code", code: "queuezen-test", redirect_uri: ctx.redirectUri, code_verifier: "queuezen-test-verifier-0123456789-0123456789", client_id: app.clientId }, true);
      case "linkedin":
        return tokenProbe(ctx, platform, "https://www.linkedin.com/oauth/v2/accessToken", { grant_type: "authorization_code", code: "queuezen-test", redirect_uri: ctx.redirectUri, client_id: app.clientId, client_secret: app.clientSecret }, false);
      case "youtube":
        return tokenProbe(ctx, platform, "https://oauth2.googleapis.com/token", { grant_type: "authorization_code", code: "queuezen-test", redirect_uri: ctx.redirectUri, client_id: app.clientId, client_secret: app.clientSecret }, false);
      default:
        return { ok: true, message: "This network doesn't need a developer app." };
    }
  } catch (error) {
    return { ok: false, message: error instanceof DriverError ? error.message : error instanceof Error ? error.message : String(error) };
  }
}

async function tokenProbe(ctx: DriverContext, platform: Platform, url: string, form: Record<string, string>, basic: boolean): Promise<{ ok: boolean; message: string }> {
  const app = ctx.app!;
  const headers: Record<string, string> = basic ? { Authorization: `Basic ${btoa(`${encodeURIComponent(app.clientId)}:${encodeURIComponent(app.clientSecret)}`)}` } : {};
  let data: Record<string, unknown> = {};
  let status = 0;
  try {
    const res = await call(ctx, platform, url, { method: "POST", headers, form });
    data = asRecord(res.data);
    status = res.status;
  } catch (error) {
    if (!(error instanceof DriverError)) throw error;
    status = error.status;
    data = { error: error.code, error_description: error.message };
  }
  const code = asString(data.error).toLowerCase();
  const text = `${code} ${asString(data.error_description)}`.toLowerCase();
  if (/invalid_client|unauthorized_client|client authentication failed/.test(text)) {
    return { ok: false, message: `The network rejected the client id or secret (${asString(data.error_description) || code || `HTTP ${status}`}).` };
  }
  if (status === 0) return { ok: false, message: "No answer from the network." };
  return { ok: true, message: "The client id and secret were accepted (a test code was refused, as expected)." };
}
