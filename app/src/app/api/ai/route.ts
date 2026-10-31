import { NextResponse, type NextRequest } from "next/server";
import { AI_ACTIONS, AI_TONES, AiError, aiQuota, countAiRequest, runAi, type AiAction, type AiTone } from "@/lib/ai";
import { getCurrentUser } from "@/lib/auth/session";
import { workspaceIdOf } from "@/lib/dashboard";
import { isRecord, parseJsonText, readBodyText } from "@/lib/public-api";
import { rateLimit } from "@/lib/rate-limit";
import { getSettings } from "@/lib/settings";
import { getMembership } from "@/lib/workspaces";
import { isPlatform, roleCan } from "@/social/normalize";

/**
 * The composer's AI assistant: POST JSON { wid, action, text, platform?, tone?, language?, topic? }
 * → { results: string[], usage: { used, limit } }. Signed-in members who can create posts
 * (editor+), the owner's plan must include AI (monthly cap max_ai_monthly), and a per-member rate
 * limit applies. The provider key stays on the server. JSON only (no form posts → no CSRF).
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const json = (status: number, body: unknown, headers?: Record<string, string>) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });

export async function POST(request: NextRequest) {
  if (!(request.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) return json(415, { error: "Send JSON." });
  const origin = request.headers.get("origin");
  if (origin && origin !== request.nextUrl.origin && request.headers.get("sec-fetch-site") === "cross-site") return json(403, { error: "Cross-site request refused." });
  const user = await getCurrentUser();
  if (!user || user.status !== "active") return json(401, { error: "Your session has expired. Sign in again." });

  let body: unknown;
  try {
    body = parseJsonText(await readBodyText(request, 64 * 1024));
  } catch {
    return json(413, { error: "Request too large." });
  }
  if (!isRecord(body)) return json(422, { error: "Send a JSON object." });
  const membership = await getMembership(workspaceIdOf(typeof body.wid === "number" || typeof body.wid === "string" ? body.wid : null), user.id);
  if (!membership) return json(404, { error: "Workspace not found." });
  if (!roleCan(membership.role, "post.create")) return json(403, { error: "Your role in this workspace doesn't allow this." });

  const action = body.action as AiAction;
  if (!(AI_ACTIONS as readonly string[]).includes(action)) return json(422, { error: "Unknown action." });
  const tone = (AI_TONES as readonly string[]).includes(String(body.tone)) ? (body.tone as AiTone) : "neutral";
  const platform = isPlatform(body.platform) ? body.platform : null;
  const text = typeof body.text === "string" ? body.text : "";
  const language = typeof body.language === "string" ? body.language.replace(/[^\p{L} ()-]/gu, "").slice(0, 40) : "";
  const topic = typeof body.topic === "string" ? body.topic.slice(0, 1000) : "";

  const quota = await aiQuota(membership.workspace.ownerId);
  if (!quota.ok) {
    return json(quota.reason === "plan" ? 403 : 429, { error: quota.reason === "plan" ? "The workspace's plan doesn't include the AI assistant." : "The AI requests included in the plan this month are used up.", code: quota.reason, usage: { used: quota.used, limit: quota.limit } });
  }
  const settings = await getSettings();
  const perMinute = Math.max(1, settings.ai_rate_per_minute || 10);
  if (!rateLimit(`ai:${user.id}`, perMinute, 60_000)) return json(429, { error: "Too many AI requests. Wait a minute.", code: "rate" }, { "Retry-After": "60" });

  try {
    const result = await runAi({ action, text, platform, tone, language, topic });
    await countAiRequest(membership.workspace.ownerId);
    return json(200, { results: result.results, usage: { used: quota.used + 1, limit: quota.limit } });
  } catch (error) {
    if (error instanceof AiError) {
      const status = error.code === "input" ? 422 : error.code === "not_configured" ? 503 : error.code === "rate_limit" ? 429 : 502;
      return json(status, { error: error.message, code: error.code });
    }
    console.error("[queuezen] AI request failed:", error);
    return json(500, { error: "The AI request failed." });
  }
}
