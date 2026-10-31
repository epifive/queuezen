import "server-only";
import { isDemoMode } from "./config";
import { fetchFollow, parsePublicUrl, ToolInputError } from "./net/ssrf";
import { getEntitlementsForUserId } from "./plans";
import { getSettings, type Settings } from "./settings";
import { getUsage, incrementUsage } from "./usage";
import { platformName } from "@/social/format";
import { getCapabilities } from "@/social/platforms";
import type { Platform } from "@/social/types";

/**
 * AI assistant of the composer (bring your own key, configured in Admin → Settings → AI):
 * - OpenAI-compatible chat completions (OpenAI, Groq, OpenRouter, Together, local Ollama…)
 * - Anthropic Messages API
 * The key never leaves the server. Each successful request counts once against the workspace
 * owner's monthly AI quota (plan: allow_ai + max_ai_monthly, 0 = unlimited).
 *
 * Test-only: AI_ANTHROPIC_BASE_URL overrides https://api.anthropic.com (mock servers).
 */

export const AI_ACTIONS = ["rewrite", "shorten", "hashtags", "translate", "generate", "first_comment"] as const;
export type AiAction = (typeof AI_ACTIONS)[number];

export const AI_TONES = ["neutral", "friendly", "professional", "witty", "bold", "casual", "inspiring"] as const;
export type AiTone = (typeof AI_TONES)[number];

export const AI_LANGUAGES = ["English", "Spanish", "Portuguese", "French", "German", "Italian", "Dutch", "Polish", "Turkish", "Russian", "Ukrainian", "Arabic", "Hebrew", "Persian", "Hindi", "Bengali", "Urdu", "Indonesian", "Malay", "Vietnamese", "Thai", "Japanese", "Korean", "Chinese (Simplified)", "Chinese (Traditional)"] as const;

export interface AiRequest {
  action: AiAction;
  /** Current post text. */
  text: string;
  platform: Platform | null;
  tone?: AiTone;
  /** Target language name (translate). */
  language?: string;
  /** Topic or link (generate). */
  topic?: string;
}

export interface AiResult {
  /** One or more suggestions to apply (first comment ideas: 3). */
  results: string[];
}

export class AiError extends Error {
  constructor(
    message: string,
    readonly code: "not_configured" | "provider" | "auth" | "rate_limit" | "input" | "refusal" = "provider",
  ) {
    super(message);
  }
}

export function aiProvider(settings: Settings): "openai" | "anthropic" | null {
  if (settings.ai_provider === "openai" && settings.ai_base_url && settings.ai_model) return "openai";
  if (settings.ai_provider === "anthropic" && settings.ai_anthropic_key && settings.ai_anthropic_model) return "anthropic";
  return null;
}

/** True when the assistant can answer (a provider is configured, or demo mode's canned answers). */
export async function aiAvailable(): Promise<boolean> {
  return isDemoMode() || aiProvider(await getSettings()) !== null;
}

export type AiQuota = { ok: true; used: number; limit: number } | { ok: false; reason: "plan" | "quota"; used: number; limit: number };

/** The owner's AI allowance this month (0 limit = unlimited). */
export async function aiQuota(ownerId: number): Promise<AiQuota> {
  const [entitlements, usage] = await Promise.all([getEntitlementsForUserId(ownerId), getUsage(ownerId)]);
  const limit = entitlements.maxAiMonthly;
  if (!entitlements.allowAi) return { ok: false, reason: "plan", used: usage.aiRequests, limit: 0 };
  if (limit > 0 && usage.aiRequests >= limit) return { ok: false, reason: "quota", used: usage.aiRequests, limit };
  return { ok: true, used: usage.aiRequests, limit };
}

export async function countAiRequest(ownerId: number): Promise<void> {
  await incrementUsage(ownerId, { aiRequests: 1 });
}

// ── Prompts ──

const SYSTEM =
  "You are a social media copywriter inside a scheduling app. You only output the requested post text (or list), with no preamble, no explanations, no quotes around it and no markdown formatting. Keep the author's facts, links, @mentions and meaning; never invent facts, prices or links. Write in the language of the original text unless asked to translate.";

function limitNote(platform: Platform | null): string {
  if (!platform) return "";
  const caps = getCapabilities(platform);
  const parts = [`The post is for ${platformName(platform)}; keep it within ${caps.text.max.toLocaleString("en-US")} characters.`];
  if (caps.text.maxHashtags !== null) parts.push(`Use at most ${caps.text.maxHashtags} hashtags.`);
  if (platform === "linkedin") parts.push("A professional, readable style with short paragraphs works best.");
  if (platform === "x" || platform === "threads" || platform === "bluesky" || platform === "mastodon") parts.push("Short and punchy works best.");
  if (platform === "instagram" || platform === "instagram_login") parts.push("Links in captions aren't clickable; a clear call to action and relevant hashtags work best.");
  return parts.join(" ");
}

/** System and user messages for an action. Exported for tests. */
export function buildPrompt(req: AiRequest, pageInfo?: { title: string; description: string; url: string } | null): { system: string; user: string } {
  const text = req.text.trim();
  const platform = limitNote(req.platform);
  const tone = req.tone && req.tone !== "neutral" ? `Use a ${req.tone} tone.` : "";
  let user: string;
  switch (req.action) {
    case "rewrite":
      user = `Rewrite this social media post so it performs well. ${platform} ${tone}\n\nPost:\n${text}`;
      break;
    case "shorten": {
      const max = req.platform ? getCapabilities(req.platform).text.max : 280;
      const target = Math.min(max, Math.max(60, Math.round(text.length * 0.6)));
      user = `Shorten this post to at most ${target} characters while keeping its message, links and call to action. ${platform}\n\nPost:\n${text}`;
      break;
    }
    case "hashtags":
      user = `Suggest relevant hashtags for this post. ${platform} Answer with the hashtags only, separated by spaces, each starting with #, at most ${req.platform === "instagram" || req.platform === "instagram_login" ? 15 : 5}.\n\nPost:\n${text}`;
      break;
    case "translate":
      user = `Translate this social media post into ${req.language || "English"}. Keep hashtags, @mentions, links and emojis as they are; adapt idioms naturally.\n\nPost:\n${text}`;
      break;
    case "generate": {
      const source = pageInfo
        ? `Page title: ${pageInfo.title}\nPage description: ${pageInfo.description}\nLink: ${pageInfo.url}\nInclude the link.`
        : `Topic: ${req.topic || text}`;
      user = `Write one engaging social media post. ${platform} ${tone}\n\n${source}${text && pageInfo ? `\n\nNotes from the author:\n${text}` : ""}`;
      break;
    }
    case "first_comment":
      user = `Suggest 3 different first comments the author could post under this post to start the conversation (a question, extra context, or a call to action). Answer with exactly 3 lines, one comment per line, no numbering. ${req.platform ? `The network is ${platformName(req.platform)}.` : ""}\n\nPost:\n${text}`;
      break;
  }
  return { system: SYSTEM, user: user.replace(/[ \t]+\n/g, "\n").trim() };
}

/** Cleans a model answer: code fences, wrapping quotes, "Here is…" preambles. */
export function cleanAnswer(raw: string): string {
  let s = raw.replace(/^```[a-z]*\n?|```$/gim, "").trim();
  s = s.replace(/^(here(?:'s| is| are)[^:\n]*:|sure[!,.][^\n]*\n)\s*/i, "").trim();
  if (/^["“][\s\S]*["”]$/.test(s) && !s.slice(1, -1).includes('"')) s = s.slice(1, -1).trim();
  return s;
}

function toResults(action: AiAction, answer: string): string[] {
  const text = cleanAnswer(answer);
  if (action === "first_comment") {
    const lines = text
      .split(/\n+/)
      .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").replace(/^["“]|["”]$/g, "").trim())
      .filter(Boolean);
    return lines.slice(0, 3);
  }
  if (action === "hashtags") {
    const tags = [...text.matchAll(/#[\p{L}\p{N}_]+/gu)].map((m) => m[0]);
    return tags.length ? [[...new Set(tags)].join(" ")] : [];
  }
  return text ? [text] : [];
}

// ── Providers ──

const TIMEOUT_MS = 45_000;

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } | string; message?: string };
    const msg = typeof body.error === "string" ? body.error : (body.error?.message ?? body.message ?? "");
    return msg.slice(0, 300);
  } catch {
    return "";
  }
}

function statusError(status: number, detail: string): AiError {
  if (status === 401 || status === 403) return new AiError("The AI provider rejected the API key. Check Admin → Settings → AI.", "auth");
  if (status === 429) return new AiError("The AI provider is rate limiting requests. Try again in a minute.", "rate_limit");
  if (status === 529 || status === 503) return new AiError("The AI provider is overloaded. Try again in a minute.", "rate_limit");
  return new AiError(`The AI provider returned an error (HTTP ${status})${detail ? `: ${detail}` : ""}.`, "provider");
}

async function callOpenAi(settings: Settings, system: string, user: string): Promise<string> {
  const base = settings.ai_base_url.replace(/\/+$/, "");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (settings.ai_api_key) headers.Authorization = `Bearer ${settings.ai_api_key}`;
  let res: Response;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: settings.ai_model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        max_tokens: Math.min(8000, Math.max(64, settings.ai_max_tokens || 1024)),
        temperature: 0.7,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new AiError("Could not reach the AI provider.", "provider");
  }
  if (!res.ok) throw statusError(res.status, await readError(res));
  const body = (await res.json().catch(() => null)) as { choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }> } | null;
  const content = body?.choices?.[0]?.message?.content;
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => c.text ?? "").join("") : "";
  if (!text.trim()) throw new AiError("The AI provider returned an empty answer.", "provider");
  return text;
}

async function callAnthropic(settings: Settings, system: string, user: string): Promise<string> {
  const base = (process.env.AI_ANTHROPIC_BASE_URL?.trim() || "https://api.anthropic.com").replace(/\/+$/, "");
  let res: Response;
  try {
    res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": settings.ai_anthropic_key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: settings.ai_anthropic_model,
        max_tokens: Math.min(16000, Math.max(64, settings.ai_max_tokens || 1024)),
        system,
        messages: [{ role: "user", content: user }],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new AiError("Could not reach the AI provider.", "provider");
  }
  if (!res.ok) throw statusError(res.status, await readError(res));
  const body = (await res.json().catch(() => null)) as { content?: Array<{ type?: string; text?: string }>; stop_reason?: string } | null;
  if (body?.stop_reason === "refusal") throw new AiError("The AI declined this request. Rephrase the post and try again.", "refusal");
  const text = (body?.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
  if (!text.trim()) throw new AiError("The AI provider returned an empty answer.", "provider");
  return text;
}

const CANNED_CLOSE: Record<AiTone, string> = {
  neutral: "What do you think? Let us know in the comments.",
  friendly: "We'd love to hear what you think 💬",
  professional: "Learn more and share your thoughts in the comments.",
  witty: "Your move. 😉",
  bold: "Don't miss it. 🔥",
  casual: "Thoughts? Drop them below 👇",
  inspiring: "Here's to doing more of what matters. ✨",
};
const CANNED_OPEN: Partial<Record<AiTone, string>> = { friendly: "Hey friends! 👋 ", witty: "Plot twist: ", bold: "Big news: " };
const STOP_WORDS = new Set(
  "about after again also back been before being both could does each even every first from have here into just know like made make many more most much next only other over really same should some still such than that their them then there these they this those through today very want were what when where which while will with without would your yours ours".split(" "),
);

/** Canned answers for the public demo (no provider, no costs): built from the post's own words. */
function cannedAnswer(req: AiRequest): string {
  const text = req.text.trim() || req.topic?.trim() || "Our new feature is live";
  const tone = req.tone ?? "neutral";
  const close = CANNED_CLOSE[tone] ?? CANNED_CLOSE.neutral;
  const withoutLinks = text.replace(/https?:\/\/\S+/g, " ");
  switch (req.action) {
    case "hashtags": {
      const used = new Set([...text.matchAll(/#([\p{L}\p{N}_]+)/gu)].map((m) => m[1].toLowerCase()));
      const words = [...withoutLinks.replace(/[#@][\p{L}\p{N}_]+/gu, " ").matchAll(/\p{L}[\p{L}\p{N}]{3,}/gu)].map((m) => m[0].toLowerCase());
      const picked = [...new Set(words)].filter((w) => !STOP_WORDS.has(w) && !used.has(w)).sort((a, b) => b.length - a.length).slice(0, 3);
      const max = req.platform === "instagram" || req.platform === "instagram_login" ? 6 : 4;
      return [...picked, "smallbusiness", "socialmedia", "marketing"].filter((w, i, all) => all.indexOf(w) === i && !used.has(w)).slice(0, max).map((w) => `#${w}`).join(" ");
    }
    case "first_comment":
      return "What do you think? Tell us in the comments 👇\nWant the full story? The link is in our bio.\nSave this post for later and share it with someone who needs it.";
    case "shorten": {
      const target = Math.max(60, Math.round(text.length * 0.6));
      if (text.length <= target) return text;
      const sentences = text.split(/(?<=[.!?…])\s+/);
      let out = "";
      for (const s of sentences) {
        if (out && `${out} ${s}`.length > target) break;
        out = out ? `${out} ${s}` : s;
      }
      if (out.length > target) out = `${out.slice(0, target).replace(/\s+\S*$/, "").replace(/[,;:\s]+$/, "")}…`;
      const link = /https?:\/\/\S+/.exec(text)?.[0];
      return link && !out.includes(link) ? `${out} ${link}` : out;
    }
    case "translate":
      return `${text}\n\n(Demo: on a live site the AI provider translates this post into ${req.language || "English"}.)`;
    case "generate": {
      const topic = (req.topic ?? "").trim();
      if (/^https?:\/\//i.test(topic)) {
        let title = "";
        try {
          const last = new URL(topic).pathname.split("/").filter(Boolean).pop() ?? "";
          title = decodeURIComponent(last).replace(/\.\w+$/, "").replace(/[-_]+/g, " ").trim();
        } catch {
          title = "";
        }
        const headline = title ? `${title.charAt(0).toUpperCase()}${title.slice(1)}` : "Something new";
        return `New on the blog: ${headline}.\n\nThe short version, the tips that matter and what to do next, all in one read.\n\nRead it here 👉 ${topic}`;
      }
      const subject = (topic || text).replace(/[.!?\s]+$/, "");
      return `${subject}: here's what you need to know.\n\n✅ What it is\n✅ Why it matters\n✅ How to get started today\n\n${close}`;
    }
    default: {
      // Text in another script (Arabic, Hindi…): no English opener or closing line, just a new layout.
      const latin = (withoutLinks.match(/\p{Script=Latin}/gu) ?? []).length;
      const letters = (withoutLinks.match(/\p{L}/gu) ?? []).length;
      if (letters && latin / letters < 0.5) {
        const parts = text.split(/(?<=[.!?…؟।])\s+/).filter(Boolean);
        return parts.map((part, i) => `${i === 0 ? "✨" : /^https?:\/\//.test(part) ? "🔗" : "👉"} ${part}`).join("\n\n");
      }
      return `${CANNED_OPEN[tone] ?? ""}${text}\n\n${close}`;
    }
  }
}

/** Title and description of a page for "generate from link" (SSRF-guarded, 1.5 MB). */
async function pageInfoOf(url: string): Promise<{ title: string; description: string; url: string }> {
  const target = parsePublicUrl(url);
  const { final } = await fetchFollow(target, { maxRedirects: 5, maxBytes: 1_500_000 });
  const html = final.body;
  const meta = (name: string) =>
    new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=["']([^"']*)["']`, "i").exec(html)?.[1] ??
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${name}["']`, "i").exec(html)?.[1] ??
    "";
  const title = meta("og:title") || /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] || "";
  const description = meta("og:description") || meta("description");
  const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim().slice(0, 500);
  return { title: decode(title), description: decode(description), url: target.toString() };
}

/** Runs one assistant action. Throws AiError (configuration, provider, input). Doesn't check quotas. */
export async function runAi(req: AiRequest): Promise<AiResult> {
  if (req.action !== "generate" && !req.text.trim()) throw new AiError("Write something first: the assistant works on your text.", "input");
  if (req.text.length > 10_000) throw new AiError("The text is too long for the assistant (10,000 characters).", "input");
  if (isDemoMode()) return { results: toResults(req.action, cannedAnswer(req)) };
  const settings = await getSettings();
  const provider = aiProvider(settings);
  if (!provider) throw new AiError("The AI assistant isn't set up on this site yet.", "not_configured");
  let page: { title: string; description: string; url: string } | null = null;
  const topic = (req.topic ?? "").trim();
  if (req.action === "generate") {
    if (!topic && !req.text.trim()) throw new AiError("Enter a topic or a link.", "input");
    if (/^https?:\/\//i.test(topic)) {
      try {
        page = await pageInfoOf(topic);
      } catch (error) {
        throw new AiError(error instanceof ToolInputError ? error.message : "Could not read that link.", "input");
      }
    }
  }
  const { system, user } = buildPrompt({ ...req, topic }, page);
  const answer = provider === "openai" ? await callOpenAi(settings, system, user) : await callAnthropic(settings, system, user);
  const results = toResults(req.action, answer);
  if (!results.length) throw new AiError("The AI provider returned an empty answer.", "provider");
  return { results };
}
