import type { NotifyEvent, NotifyPayload } from "@/social/types";

/**
 * Turns a NotifyPayload into the title, summary and fields every notification channel shows.
 * Notifications are written in English (like the webhook payload), whatever the dashboard language.
 */

/** "2026-10-16 14:05 UTC" */
export function humanTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return `${new Date(t).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function humanNumber(value: number | string | undefined): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return String(value ?? "");
  return Number.isInteger(n) ? n.toLocaleString("en-US") : n.toLocaleString("en-US", { maximumFractionDigits: 1 });
}

export const EVENT_COLORS: Record<NotifyEvent, string> = {
  post_failed: "#dc2626",
  post_published: "#16a34a",
  approval_requested: "#4338ca",
  approval_decided: "#4338ca",
  channel_expiring: "#d97706",
  channel_disconnected: "#dc2626",
  rss_failed: "#d97706",
  quota_warning: "#d97706",
  quota_reached: "#dc2626",
  test: "#1d5bd8",
};

const SUBJECT_PREFIX: Record<NotifyEvent, string> = {
  post_failed: "Post failed",
  post_published: "Published",
  approval_requested: "Approval needed",
  approval_decided: "Approval",
  channel_expiring: "Reconnect soon",
  channel_disconnected: "Reconnect needed",
  rss_failed: "RSS feed",
  quota_warning: "Usage 80%",
  quota_reached: "Usage limit reached",
  test: "Test",
};

/** True for events that need attention (red / "Attention" styling). */
export function isProblem(event: NotifyEvent): boolean {
  return event === "post_failed" || event === "channel_disconnected" || event === "quota_reached";
}

export interface NotificationText {
  /** One-line headline, e.g. "A post failed in Acme". */
  title: string;
  /** Email subject, e.g. "[Post failed] Acme". */
  subject: string;
  /** One or two sentences with the essentials. */
  summary: string;
  /** Label/value pairs shown as fields. */
  facts: Array<[string, string]>;
  color: string;
  /** Label of the link button ("Open dashboard"). */
  linkLabel: string;
}

/** Fact labels for well-known `data` keys (other keys are shown as they are). */
const FACT_LABELS: Record<string, string> = {
  post: "Post",
  channel: "Channel",
  platform: "Network",
  scheduled: "Scheduled for",
  permalink: "Link",
  decision: "Decision",
  by: "By",
  expires: "Expires",
  expires_at: "Expires",
  days: "Days left",
  reason: "Reason",
  comment: "Comment",
  feed: "Feed",
  error: "Error",
  used: "Used",
  limit: "Plan limit",
  quota: "Limit",
};

export function describeNotification(p: NotifyPayload, siteName: string): NotificationText {
  const ws = p.workspace?.name || "your workspace";
  const facts: Array<[string, string]> = [];
  if (p.workspace) facts.push(["Workspace", p.workspace.name]);
  for (const [key, value] of Object.entries(p.data)) {
    if (key === "example") continue;
    facts.push([FACT_LABELS[key] ?? key, typeof value === "number" ? humanNumber(value) : String(value)]);
  }
  let title: string;
  switch (p.event) {
    case "post_failed":
      title = `A post failed to publish in ${ws}`;
      break;
    case "post_published":
      title = `A post was published in ${ws}`;
      break;
    case "approval_requested":
      title = `A post is waiting for approval in ${ws}`;
      break;
    case "approval_decided":
      title = `A post was ${p.data.decision === "rejected" ? "sent back" : "approved"} in ${ws}`;
      break;
    case "channel_expiring":
      title = `A channel needs to be reconnected soon in ${ws}`;
      break;
    case "channel_disconnected":
      title = `A channel lost its connection in ${ws}`;
      break;
    case "rss_failed":
      title = `An RSS feed can't be read in ${ws}`;
      break;
    case "quota_warning":
      title = "You have used 80% of your plan's limit";
      break;
    case "quota_reached":
      title = "You have reached your plan's limit";
      break;
    case "test":
      title = `Test notification from ${siteName}`;
      break;
  }
  return {
    title,
    subject: `[${SUBJECT_PREFIX[p.event]}] ${p.event === "test" || !p.workspace ? siteName : p.workspace.name}`,
    summary: p.message,
    facts,
    color: EVENT_COLORS[p.event],
    linkLabel: "Open dashboard",
  };
}

/** Plain-text body used by email (and as a fallback elsewhere). */
export function notificationPlainText(p: NotifyPayload, siteName: string): string {
  const t = describeNotification(p, siteName);
  return [t.title, "", t.summary, "", ...t.facts.map(([k, v]) => `${k}: ${v}`), "", `${t.linkLabel}: ${p.url}`, "", `— ${siteName}`].join("\n");
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export interface SendContext {
  siteName: string;
  /** Webhooks may point at private/internal addresses (env ALLOW_PRIVATE_WEBHOOKS=1). */
  allowPrivate: boolean;
  timeoutMs: number;
}

export interface SendResult {
  ok: boolean;
  error?: string;
}
