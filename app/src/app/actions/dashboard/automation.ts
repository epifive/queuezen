"use server";

import { workspaceChannelIds } from "@/lib/channels";
import { guardWorkspace } from "@/lib/dashboard";
import { getDb, now } from "@/lib/db";
import { plural } from "@/lib/i18n/messages";
import { getT } from "@/lib/i18n/server";
import { FeedParseError } from "@/lib/rss/parse";
import { createFeed, deleteFeed, DEFAULT_TEMPLATE, fetchFeed, getFeed, getFeeds, normalizeFeedOptions, processFeed, RSS_MODES, setFeedPaused, updateFeed, type FeedInput, type RssMode } from "@/lib/rss";
import { normalizeRecycleSettings, saveRecycleSettings } from "@/lib/recycle";
import { ToolInputError } from "@/lib/net/ssrf";
import { rateLimit } from "@/lib/rate-limit";
import { getSettings } from "@/lib/settings";
import { canPublishDirectly } from "@/social/normalize";
import type { FormState } from "../types";
import { idOf, ids, intOf, str } from "./helpers";

async function feedInput(formData: FormData, workspaceId: number): Promise<FeedInput | { error: string }> {
  const t = await getT();
  const settings = await getSettings();
  const url = str(formData.get("url")).trim();
  if (!url || url.length > 1000) return { error: t("dash.rss.err.url") };
  const channelIds = await workspaceChannelIds(workspaceId, ids(formData.getAll("channel_ids")));
  if (!channelIds.length) return { error: t("dash.rss.err.channels") };
  const mode = str(formData.get("mode")) as RssMode;
  if (!(RSS_MODES as readonly string[]).includes(mode)) return { error: t("dash.rss.err.mode") };
  const interval = intOf(formData.get("interval"), 5, 10_080);
  if (!Number.isFinite(interval)) return { error: t("dash.rss.err.interval") };
  const template = str(formData.get("template")).replace(/\r\n/g, "\n").trim().slice(0, 2000) || DEFAULT_TEMPLATE;
  const options = normalizeFeedOptions(
    {
      maxItems: str(formData.get("max_items")),
      backfill: formData.get("backfill") === "on",
      hashtags: str(formData.get("hashtags")),
      shortenLinks: formData.get("shorten_links") === "on",
      utm: { enabled: formData.get("utm_enabled") === "on", source: str(formData.get("utm_source")) || "{platform}", medium: str(formData.get("utm_medium")) || "social", campaign: str(formData.get("utm_campaign")) },
    },
    settings.rss_max_items_per_run || 10,
  );
  return { url, title: str(formData.get("title")).trim().slice(0, 255), channelIds, template, mode, intervalMinutes: Math.max(settings.rss_min_interval_minutes || 15, interval), options };
}

/** Add or edit an RSS feed (editors and up; the plan must include RSS). */
export async function saveFeedAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const guard = await guardWorkspace(formData.get("wid"), { capability: "post.create" });
  if (!guard.ok) return { error: guard.error };
  const t = await getT();
  if (!guard.entitlements.allowRss) return { error: t("dash.rss.err.plan") };
  const input = await feedInput(formData, guard.workspace.id);
  if ("error" in input) return input;
  // Editors in a workspace that requires approval: feed posts wait for approval instead.
  if (input.mode !== "draft" && !canPublishDirectly(guard.role, guard.workspace.settings)) input.mode = "draft";
  const feedId = idOf(formData.get("feed_id"));
  if (Number.isInteger(feedId) && feedId > 0) {
    if (!(await updateFeed(guard.workspace.id, feedId, input))) return { error: t("dash.rss.err.notFound") };
    return { success: t("dash.rss.saved") };
  }
  const settings = await getSettings();
  if ((await getFeeds(guard.workspace.id)).length >= Math.max(1, settings.rss_max_feeds || 20)) return { error: t("dash.rss.err.limit", { n: settings.rss_max_feeds || 20 }) };
  if (!rateLimit(`rss-add:${guard.user.id}`, 30, 60 * 60_000)) return { error: t("dash.rss.err.rate") };
  // Check the address once before saving so typos show up right away.
  try {
    const result = await fetchFeed(input.url);
    if (result.status === "ok" && !input.title) input.title = result.feed.title.slice(0, 255);
  } catch (error) {
    if (error instanceof ToolInputError || error instanceof FeedParseError) return { error: t("dash.rss.err.fetch", { error: error.message }) };
    return { error: t("dash.rss.err.fetch", { error: "—" }) };
  }
  await createFeed(guard.workspace.id, input, guard.user.id);
  return { success: input.options.backfill ? t("dash.rss.addedBackfill") : t("dash.rss.added") };
}

export type PreviewState = FormState & { preview?: { title: string; items: Array<{ title: string; link: string; date: string }> } };

/** "Test feed": fetches the address and shows the newest items (nothing is saved). */
export async function previewFeedAction(_prev: PreviewState, formData: FormData): Promise<PreviewState> {
  const guard = await guardWorkspace(formData.get("wid"), { capability: "post.create", allowInDemo: true });
  if (!guard.ok) return { error: guard.error };
  const t = await getT();
  if (!rateLimit(`rss-preview:${guard.user.id}`, 30, 10 * 60_000)) return { error: t("dash.rss.err.rate") };
  try {
    const result = await fetchFeed(str(formData.get("url")));
    if (result.status !== "ok") return { error: t("dash.rss.err.fetch", { error: "304" }) };
    return { preview: { title: result.feed.title, items: result.feed.items.slice(0, 5).map((i) => ({ title: i.title, link: i.link, date: i.publishedAt })) }, success: t("dash.rss.previewOk", { n: result.feed.items.length }) };
  } catch (error) {
    return { error: t("dash.rss.err.fetch", { error: error instanceof ToolInputError || error instanceof FeedParseError ? error.message : "—" }) };
  }
}

export async function feedCommandAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const guard = await guardWorkspace(formData.get("wid"), { capability: "post.create" });
  if (!guard.ok) return { error: guard.error };
  const t = await getT();
  const id = idOf(formData.get("feed_id"));
  const command = str(formData.get("command"));
  if (command === "delete") return (await deleteFeed(guard.workspace.id, id)) ? { success: t("dash.rss.deleted") } : { error: t("dash.rss.err.notFound") };
  if (command === "pause" || command === "resume") return (await setFeedPaused(guard.workspace.id, id, command === "pause")) ? { success: t(command === "pause" ? "dash.rss.paused" : "dash.rss.resumed") } : { error: t("dash.rss.err.notFound") };
  if (command === "check") {
    if (!guard.entitlements.allowRss) return { error: t("dash.rss.err.plan") };
    if (!rateLimit(`rss-check:${guard.user.id}`, 20, 10 * 60_000)) return { error: t("dash.rss.err.rate") };
    const feed = await getFeed(guard.workspace.id, id);
    if (!feed) return { error: t("dash.rss.err.notFound") };
    const result = await processFeed(feed);
    if (result.status === "error") return { error: t("dash.rss.err.fetch", { error: result.error ?? "—" }) };
    return { success: result.status === "not_modified" ? t("dash.rss.checkedNone") : plural(t, "dash.rss.checked", result.created) };
  }
  return { error: t("dash.rss.err.notFound") };
}

/** Evergreen recycling settings (admins and owner). */
export async function saveRecycleAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const guard = await guardWorkspace(formData.get("wid"), { capability: "settings.manage" });
  if (!guard.ok) return { error: guard.error };
  const t = await getT();
  const settings = normalizeRecycleSettings({
    enabled: formData.get("enabled") === "on",
    intervalDays: str(formData.get("interval_days")),
    maxRecycles: str(formData.get("max_recycles")),
    perRun: str(formData.get("per_run")),
    randomize: formData.get("randomize") === "on",
    channelIds: await workspaceChannelIds(guard.workspace.id, ids(formData.getAll("channel_ids"))),
  });
  await saveRecycleSettings(guard.workspace.id, settings);
  return { success: t("dash.recycle.saved") };
}

/** Marks a post evergreen (or not). Editors and up. */
export async function setEvergreenAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const guard = await guardWorkspace(formData.get("wid"), { capability: "post.create" });
  if (!guard.ok) return { error: guard.error };
  const t = await getT();
  const on = str(formData.get("on")) === "1";
  const db = await getDb();
  const res = await db
    .updateTable("posts")
    .set({ is_evergreen: on ? 1 : 0, updated_at: now() })
    .where("id", "=", idOf(formData.get("post_id")))
    .where("workspace_id", "=", guard.workspace.id)
    .where("source", "!=", "recycle")
    .executeTakeFirst();
  if (!Number(res.numUpdatedRows)) return { error: t("dash.approvals.err.notFound") };
  return { success: t(on ? "dash.recycle.marked" : "dash.recycle.unmarked") };
}

