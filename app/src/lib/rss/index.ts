import "server-only";
import crypto from "node:crypto";
import { sql } from "kysely";
import net from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import { notifyApprovalRequested } from "../approvals";
import { getWorkspaceChannels, type ChannelRecord } from "../channels";
import { isDemoMode } from "../config";
import { getDb, now } from "../db";
import type { RssFeedRow } from "../db/schema";
import { guardedLookup, isPrivateAddress, parsePublicUrl, ToolInputError } from "../net/ssrf";
import { buildNotifyPayload, notifyWorkspace, workspaceDashboardPath } from "../notify";
import { getEntitlementsForUserId } from "../plans";
import { savePost, type SaveIntent } from "../posts";
import { commonQueueSlot } from "../recycle";
import { getSettings } from "../settings";
import { shortenUrl } from "../shortlinks";
import { bannedOwnerWorkspaceIds, getMembership, getWorkspace, type WorkspaceRecord } from "../workspaces";
import { bool, buildUtmUrl, canPublishDirectly, countChars, idList, int, normalizeUtm, parseJson, str } from "@/social/normalize";
import { getCapabilities } from "@/social/platforms";
import type { ContentOverride, Platform, UtmSettings } from "@/social/types";
import { feedCharset, FeedParseError, parseFeed, type FeedItem, type ParsedFeed } from "./parse";

export { parseFeed, FeedParseError, type FeedItem, type ParsedFeed } from "./parse";

/**
 * RSS / Atom auto-posting. Each feed polls on its own interval (conditional GET with ETag /
 * Last-Modified), dedupes items by guid hash (rss_items, unique per feed) and turns new items into
 * posts for its channels via savePost (source "rss"): a draft, the next common queue slot, or
 * published right away. The first check only remembers the existing items (no backfill) unless
 * the feed asks for it. Requests are SSRF-guarded (public addresses only; ALLOW_PRIVATE_FEEDS=1
 * lifts that for intranet feeds and tests).
 */

export const RSS_MODES = ["draft", "queue", "publish"] as const;
export type RssMode = (typeof RSS_MODES)[number];

export interface RssFeedOptions {
  /** New items turned into posts per check (the rest wait for the next check). */
  maxItems: number;
  /** First check: post the newest `maxItems` items instead of only remembering them. */
  backfill: boolean;
  utm: UtmSettings;
  /** Replace the item link with a tracked short link. */
  shortenLinks: boolean;
  /** Hashtags appended to every post ("#news #blog"). */
  hashtags: string;
}

export interface RssFeedRecord {
  id: number;
  workspaceId: number;
  url: string;
  title: string;
  channelIds: number[];
  template: string;
  mode: RssMode;
  intervalMinutes: number;
  status: "active" | "paused" | "error";
  lastCheckedAt: string | null;
  nextCheckAt: string;
  lastError: string | null;
  etag: string | null;
  lastModified: string | null;
  itemsPosted: number;
  options: RssFeedOptions;
  createdBy: number | null;
  createdAt: string;
}

export const DEFAULT_TEMPLATE = "{title}\n\n{link}";
export const TEMPLATE_TAGS = ["{title}", "{link}", "{summary}", "{author}", "{feed}"] as const;
export const RSS_INTERVALS = [15, 30, 60, 120, 360, 720, 1440] as const;

export function normalizeFeedOptions(v: unknown, maxItemsCap = 10): RssFeedOptions {
  const o = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  return {
    maxItems: int(o.maxItems, 3, 1, Math.max(1, maxItemsCap)),
    backfill: bool(o.backfill, false),
    utm: normalizeUtm(o.utm),
    shortenLinks: bool(o.shortenLinks, false),
    hashtags: str(o.hashtags, "", 500)
      .split(/\s+/)
      .map((t) => t.replace(/^#*/, ""))
      .filter((t) => /^[\p{L}\p{N}_]+$/u.test(t))
      .slice(0, 15)
      .map((t) => `#${t}`)
      .join(" "),
  };
}

function toRecord(row: RssFeedRow): RssFeedRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    url: row.url,
    title: row.title,
    channelIds: idList(parseJson(row.channel_ids), 100),
    template: row.template,
    mode: (RSS_MODES as readonly string[]).includes(row.mode) ? (row.mode as RssMode) : "draft",
    intervalMinutes: row.interval_minutes,
    status: row.status,
    lastCheckedAt: row.last_checked_at,
    nextCheckAt: row.next_check_at,
    lastError: row.last_error,
    etag: row.etag,
    lastModified: row.last_modified,
    itemsPosted: Number(row.items_posted ?? 0),
    options: normalizeFeedOptions(parseJson(row.options ?? null), 50),
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

export async function getFeeds(workspaceId: number): Promise<RssFeedRecord[]> {
  const db = await getDb();
  const rows = await db.selectFrom("rss_feeds").selectAll().where("workspace_id", "=", workspaceId).orderBy("id").execute();
  return rows.map(toRecord);
}

export async function getFeed(workspaceId: number, id: number): Promise<RssFeedRecord | undefined> {
  if (!Number.isInteger(id) || id < 1) return undefined;
  const db = await getDb();
  const row = await db.selectFrom("rss_feeds").selectAll().where("id", "=", id).where("workspace_id", "=", workspaceId).executeTakeFirst();
  return row ? toRecord(row) : undefined;
}

export interface FeedInput {
  url: string;
  title: string;
  channelIds: number[];
  template: string;
  mode: RssMode;
  intervalMinutes: number;
  options: RssFeedOptions;
}

export async function createFeed(workspaceId: number, input: FeedInput, createdBy: number): Promise<number> {
  const db = await getDb();
  const ts = now();
  const res = await db
    .insertInto("rss_feeds")
    .values({
      workspace_id: workspaceId,
      url: input.url,
      title: input.title.slice(0, 255),
      channel_ids: JSON.stringify(input.channelIds),
      template: input.template,
      mode: input.mode,
      ai_rewrite: 0,
      interval_minutes: input.intervalMinutes,
      status: "active",
      last_checked_at: null,
      next_check_at: ts,
      etag: null,
      last_modified: null,
      last_error: null,
      options: JSON.stringify(input.options),
      items_posted: 0,
      created_by: createdBy,
      created_at: ts,
      updated_at: ts,
    })
    .executeTakeFirstOrThrow();
  return Number(res.insertId);
}

export async function updateFeed(workspaceId: number, id: number, input: FeedInput): Promise<boolean> {
  const db = await getDb();
  const existing = await getFeed(workspaceId, id);
  if (!existing) return false;
  const urlChanged = existing.url !== input.url;
  await db
    .updateTable("rss_feeds")
    .set({
      url: input.url,
      title: input.title.slice(0, 255),
      channel_ids: JSON.stringify(input.channelIds),
      template: input.template,
      mode: input.mode,
      interval_minutes: input.intervalMinutes,
      options: JSON.stringify(input.options),
      // A new address starts over: no conditional headers, check now.
      ...(urlChanged ? { etag: null, last_modified: null, next_check_at: now(), last_error: null } : {}),
      updated_at: now(),
    })
    .where("id", "=", id)
    .where("workspace_id", "=", workspaceId)
    .execute();
  return true;
}

export async function setFeedPaused(workspaceId: number, id: number, paused: boolean): Promise<boolean> {
  const db = await getDb();
  const res = await db
    .updateTable("rss_feeds")
    .set({ status: paused ? "paused" : "active", ...(paused ? {} : { next_check_at: now(), last_error: null }), updated_at: now() })
    .where("id", "=", id)
    .where("workspace_id", "=", workspaceId)
    .executeTakeFirst();
  return Number(res.numUpdatedRows) > 0;
}

export async function deleteFeed(workspaceId: number, id: number): Promise<boolean> {
  const db = await getDb();
  const feed = await getFeed(workspaceId, id);
  if (!feed) return false;
  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom("rss_items").where("feed_id", "=", id).execute();
    await trx.deleteFrom("rss_feeds").where("id", "=", id).execute();
  });
  return true;
}

/** Recent items seen in a feed (newest first) with the post made from each. */
export async function getFeedItems(feedId: number, limit = 20): Promise<Array<{ id: number; title: string | null; url: string | null; postId: number | null; publishedAt: string | null; createdAt: string }>> {
  const db = await getDb();
  const rows = await db.selectFrom("rss_items").selectAll().where("feed_id", "=", feedId).orderBy("id", "desc").limit(limit).execute();
  return rows.map((r) => ({ id: r.id, title: r.title, url: r.url, postId: r.post_id, publishedAt: r.published_at, createdAt: r.created_at }));
}

// ── Fetching ──

function allowPrivateFeeds(): boolean {
  const v = process.env.ALLOW_PRIVATE_FEEDS?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

const guardedAgent = new Agent({ connect: { lookup: guardedLookup, timeout: 8_000 }, headersTimeout: 12_000, bodyTimeout: 15_000 });
const openAgent = new Agent({ connect: { timeout: 8_000 }, headersTimeout: 12_000, bodyTimeout: 15_000 });

const MAX_FEED_BYTES = 4 * 1024 * 1024;

/** Validates a feed address typed by a user (http/https, public unless ALLOW_PRIVATE_FEEDS). */
export function parseFeedUrl(input: string): URL {
  if (allowPrivateFeeds()) {
    let url: URL;
    try {
      url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`);
    } catch {
      throw new ToolInputError("That doesn't look like a valid URL.");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new ToolInputError("Only http:// and https:// URLs can be used.");
    if (url.username || url.password) throw new ToolInputError("URLs with a username or password are not allowed.");
    return url;
  }
  const url = parsePublicUrl(input);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) && isPrivateAddress(host)) throw new ToolInputError("Private and local addresses can't be used.");
  return url;
}

export type FetchFeedResult =
  | { status: "not_modified" }
  | { status: "ok"; feed: ParsedFeed; etag: string | null; lastModified: string | null; finalUrl: string };

/** Downloads and parses a feed (conditional GET, ≤ 5 redirects, 4 MB). Throws ToolInputError / FeedParseError. */
export async function fetchFeed(address: string, conditional: { etag?: string | null; lastModified?: string | null } = {}): Promise<FetchFeedResult> {
  let url = parseFeedUrl(address);
  const settings = await getSettings();
  const ua = `${settings.site_name || "Queuezen"}-RSS/1.0 (+${settings.site_url || "https://queuezen.app"})`;
  for (let hop = 0; hop <= 5; hop++) {
    let res: Awaited<ReturnType<typeof undiciFetch>>;
    try {
      res = await undiciFetch(url, {
        redirect: "manual",
        dispatcher: allowPrivateFeeds() ? openAgent : guardedAgent,
        headers: {
          "User-Agent": ua,
          Accept: "application/rss+xml, application/atom+xml, application/rdf+xml;q=0.9, application/xml;q=0.8, text/xml;q=0.8, */*;q=0.5",
          ...(hop === 0 && conditional.etag ? { "If-None-Match": conditional.etag } : {}),
          ...(hop === 0 && conditional.lastModified ? { "If-Modified-Since": conditional.lastModified } : {}),
        },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      const code = (e as { cause?: { code?: string } }).cause?.code;
      if (code === "EBLOCKED") throw new ToolInputError("Private and local addresses can't be used.");
      if (code === "ENOTFOUND") throw new ToolInputError(`The domain ${url.hostname} could not be found.`);
      throw new ToolInputError(`Could not connect to ${url.host}.`);
    }
    if (res.status === 304) {
      await res.body?.cancel().catch(() => undefined);
      return { status: "not_modified" };
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      await res.body?.cancel().catch(() => undefined);
      if (!location) throw new ToolInputError(`The feed redirects without a destination (HTTP ${res.status}).`);
      url = parseFeedUrl(new URL(location, url).toString());
      continue;
    }
    if (res.status === 404 || res.status === 410) {
      await res.body?.cancel().catch(() => undefined);
      throw new ToolInputError(`The feed was not found (HTTP ${res.status}).`);
    }
    if (res.status >= 400) {
      await res.body?.cancel().catch(() => undefined);
      throw new ToolInputError(`The feed answered with HTTP ${res.status}.`);
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (res.body) {
      for await (const chunk of res.body) {
        const piece = chunk as Uint8Array;
        size += piece.byteLength;
        if (size > MAX_FEED_BYTES) throw new ToolInputError("The feed is larger than 4 MB.");
        chunks.push(piece);
      }
    }
    const bytes = Buffer.concat(chunks);
    const head = bytes.subarray(0, 300).toString("latin1");
    let text: string;
    try {
      text = new TextDecoder(feedCharset(res.headers.get("content-type"), head)).decode(bytes);
    } catch {
      text = bytes.toString("utf8");
    }
    const feed = parseFeed(text, url.toString());
    return { status: "ok", feed, etag: res.headers.get("etag"), lastModified: res.headers.get("last-modified"), finalUrl: url.toString() };
  }
  throw new ToolInputError("The feed redirects too many times.");
}

/** A feed on a reserved ".example" domain (RFC 2606): the sample feeds of the demo data. */
export function isDemoFeedUrl(url: string): boolean {
  try {
    return /(^|\.)example$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

// ── Posts from items ──

export const guidHash = (guid: string) => crypto.createHash("sha256").update(guid).digest("hex");

function fillTemplate(template: string, item: FeedItem, feedTitle: string, link: string, summary: string): string {
  return template
    .replaceAll("{title}", item.title)
    .replaceAll("{link}", link)
    .replaceAll("{url}", link)
    .replaceAll("{summary}", summary)
    .replaceAll("{author}", item.author)
    .replaceAll("{feed}", feedTitle)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The post text of an item for one platform: the template filled in, hashtags appended, the
 * summary (then the title) shortened until it fits the platform's character limit.
 */
export function renderItemText(template: string, item: FeedItem, feedTitle: string, link: string, hashtags: string, platform: Platform | null): string {
  const limit = platform ? getCapabilities(platform).text.max : 63_206;
  const build = (summary: string, title: string) => {
    const body = fillTemplate(template || DEFAULT_TEMPLATE, { ...item, title }, feedTitle, link, summary);
    return hashtags ? `${body}\n\n${hashtags}` : body;
  };
  const fits = (t: string) => (platform ? countChars(t, platform) : t.length) <= limit;
  let summary = item.summary;
  let title = item.title;
  let text = build(summary, title);
  const cut = (s: string, n: number) => (n <= 0 ? "" : s.length > n ? `${s.slice(0, Math.max(0, n - 1)).trimEnd()}…` : s);
  while (!fits(text) && summary) {
    summary = cut(summary, Math.floor(summary.length * 0.7) - 1);
    if (summary.length < 20) summary = "";
    text = build(summary, title);
  }
  while (!fits(text) && title.length > 10) {
    title = cut(title, Math.floor(title.length * 0.7));
    text = build(summary, title);
  }
  return text;
}

export interface ProcessResult {
  status: "ok" | "not_modified" | "error" | "skipped";
  created: number;
  seen: number;
  error?: string;
}

async function feedOwnerOk(workspace: WorkspaceRecord): Promise<boolean> {
  return (await getEntitlementsForUserId(workspace.ownerId)).allowRss;
}

/** Media-required platforms (Instagram, YouTube…) can't take a text post from a feed item. */
function textCapable(channel: ChannelRecord): boolean {
  return getCapabilities(channel.platform).media.required === "none";
}

async function createPostForItem(feed: RssFeedRecord, workspace: WorkspaceRecord, feedTitle: string, item: FeedItem, channels: ChannelRecord[], itemId: number): Promise<{ ok: true; postId: number } | { ok: false; code: string }> {
  const opts = feed.options;
  const overrides: Record<number, ContentOverride> = {};
  let baseLink = item.link;
  for (const c of channels) {
    let link = item.link;
    if (link && opts.utm.enabled) link = buildUtmUrl(link, opts.utm, { platform: c.platform });
    if (link && opts.shortenLinks) link = (await shortenUrl(workspace.id, link, null, { channelId: c.id, title: item.title })).shortUrl;
    if (c === channels[0]) baseLink = link;
    overrides[c.id] = { text: renderItemText(feed.template, item, feedTitle, link, opts.hashtags, c.platform), link };
  }
  const baseText = renderItemText(feed.template, item, feedTitle, baseLink, opts.hashtags, null);

  // Who acts: the feed's creator when still allowed to publish directly; else the post waits for approval.
  const creator = feed.createdBy ? await getMembership(workspace.id, feed.createdBy) : undefined;
  const role = creator?.role ?? "owner";
  let intent: SaveIntent = feed.mode === "draft" ? "draft" : "schedule";
  let scheduledAt: string | null = null;
  if (intent === "schedule") {
    if (!canPublishDirectly(role, workspace.settings)) intent = "submit";
    scheduledAt = feed.mode === "publish" ? new Date(Date.now() + 60_000).toISOString() : ((await commonQueueSlot(channels, workspace.timezone)) ?? new Date(Date.now() + 60 * 60_000).toISOString());
  }
  const result = await savePost({
    workspace,
    actor: { userId: feed.createdBy, role: intent === "submit" ? "editor" : "owner" },
    content: { text: baseText, link: baseLink, mediaIds: [] },
    overrides,
    channelIds: channels.map((c) => c.id),
    scheduledAt,
    intent,
    source: "rss",
    sourceRef: String(itemId),
  });
  if (!result.ok) return { ok: false, code: result.code };
  if (intent === "submit") await notifyApprovalRequested(workspace, result.post, { userId: null, name: feedTitle || "RSS" });
  return { ok: true, postId: result.post.id };
}

async function markFeed(feedId: number, values: Partial<Pick<RssFeedRow, "status" | "last_checked_at" | "next_check_at" | "etag" | "last_modified" | "last_error" | "title">>): Promise<void> {
  const db = await getDb();
  await db.updateTable("rss_feeds").set({ ...values, updated_at: now() }).where("id", "=", feedId).execute();
}

/** Checks one feed now: fetch, dedupe, create posts. Updates the feed's state; never throws. */
export async function processFeed(feed: RssFeedRecord): Promise<ProcessResult> {
  const workspace = await getWorkspace(feed.workspaceId);
  if (!workspace) return { status: "skipped", created: 0, seen: 0 };
  const settings = await getSettings();
  const interval = Math.max(settings.rss_min_interval_minutes || 15, feed.intervalMinutes);
  const nextOk = new Date(Date.now() + interval * 60_000).toISOString();
  const ts = now();
  if (!(await feedOwnerOk(workspace))) {
    await markFeed(feed.id, { last_checked_at: ts, next_check_at: new Date(Date.now() + 24 * 3_600_000).toISOString(), last_error: "The workspace's plan doesn't include RSS auto-posting." });
    return { status: "skipped", created: 0, seen: 0, error: "plan" };
  }

  // Sample feeds of the public demo use reserved ".example" addresses that can never be fetched:
  // count them as checked (nothing new) instead of reporting an error on every run.
  if (isDemoMode() && isDemoFeedUrl(feed.url)) {
    await markFeed(feed.id, { status: "active", last_checked_at: ts, next_check_at: nextOk, last_error: null });
    return { status: "not_modified", created: 0, seen: 0 };
  }

  let fetched: FetchFeedResult;
  try {
    fetched = await fetchFeed(feed.url, { etag: feed.etag, lastModified: feed.lastModified });
  } catch (error) {
    const message = error instanceof ToolInputError || error instanceof FeedParseError ? error.message : "The feed could not be read.";
    if (!(error instanceof ToolInputError || error instanceof FeedParseError)) console.error("[queuezen] rss fetch failed:", error);
    // Back off on errors: at least an hour, never more often than the interval.
    const retry = new Date(Date.now() + Math.max(interval, 60) * 60_000).toISOString();
    await markFeed(feed.id, { status: "error", last_checked_at: ts, next_check_at: retry, last_error: message.slice(0, 1000) });
    if (feed.status !== "error") {
      const payload = await buildNotifyPayload(workspace, "rss_failed", `The RSS feed "${feed.title || feed.url}" can't be read: ${message}`, { feed: feed.url, error: message }, workspaceDashboardPath(workspace.id, "automation"));
      await notifyWorkspace(workspace.id, payload);
    }
    return { status: "error", created: 0, seen: 0, error: message };
  }
  if (fetched.status === "not_modified") {
    await markFeed(feed.id, { status: "active", last_checked_at: ts, next_check_at: nextOk, last_error: null });
    return { status: "not_modified", created: 0, seen: 0 };
  }

  const db = await getDb();
  const items = fetched.feed.items;
  const hashes = items.map((i) => guidHash(i.guid));
  const known = new Set<string>();
  for (let i = 0; i < hashes.length; i += 200) {
    const part = hashes.slice(i, i + 200);
    if (!part.length) break;
    const rows = await db.selectFrom("rss_items").select("guid_hash").where("feed_id", "=", feed.id).where("guid_hash", "in", part).execute();
    for (const r of rows) known.add(r.guid_hash);
  }
  // New items, oldest first (feeds list newest first; undated items keep the feed's order).
  const fresh = items
    .map((item, index) => ({ item, index, hash: hashes[index] }))
    .filter((x) => !known.has(x.hash))
    .sort((a, b) => (a.item.publishedAt && b.item.publishedAt ? a.item.publishedAt.localeCompare(b.item.publishedAt) : b.index - a.index));

  const firstRun = !feed.lastCheckedAt;
  const cap = Math.min(feed.options.maxItems, Math.max(1, settings.rss_max_items_per_run || 10));
  const channels = (await getWorkspaceChannels(workspace.id)).filter((c) => feed.channelIds.includes(c.id) && c.status === "active" && textCapable(c));
  const feedTitle = fetched.feed.title || feed.title;

  const remember = async (x: (typeof fresh)[number], postId: number | null): Promise<number | null> => {
    try {
      const res = await db
        .insertInto("rss_items")
        .values({ feed_id: feed.id, guid_hash: x.hash, guid: x.item.guid.slice(0, 1000), url: x.item.link.slice(0, 1000) || null, title: x.item.title.slice(0, 500) || null, published_at: x.item.publishedAt || null, post_id: postId, created_at: now() })
        .executeTakeFirstOrThrow();
      return Number(res.insertId);
    } catch {
      return null; // Already recorded by a concurrent run (unique feed + guid hash).
    }
  };

  let created = 0;
  let leftover = false;
  let lastError: string | null = null;
  let toPost = fresh;
  if (firstRun) {
    // Remember everything; post only the newest `cap` items when backfill is on.
    toPost = feed.options.backfill ? fresh.slice(-cap) : [];
    const skip = new Set(toPost.map((x) => x.hash));
    for (const x of fresh) if (!skip.has(x.hash)) await remember(x, null);
  } else if (fresh.length > cap) {
    toPost = fresh.slice(0, cap);
    leftover = true;
  }
  if (toPost.length && !channels.length) {
    lastError = "None of the feed's channels can take a text post (connect or choose an active channel).";
    for (const x of toPost) await remember(x, null);
  } else {
    for (const x of toPost) {
      const itemId = await remember(x, null);
      if (itemId === null) continue;
      const outcome = await createPostForItem(feed, workspace, feedTitle, x.item, channels, itemId);
      if (outcome.ok) {
        created += 1;
        await db.updateTable("rss_items").set({ post_id: outcome.postId }).where("id", "=", itemId).execute();
      } else if (outcome.code === "quota") {
        // Plan limit reached: forget the item so it is tried again later.
        await db.deleteFrom("rss_items").where("id", "=", itemId).execute();
        lastError = "The plan's monthly post limit is reached; new items wait until there is room.";
        leftover = true;
        break;
      } else {
        lastError = `An item couldn't be turned into a post (${outcome.code}).`;
      }
    }
  }
  if (created) await db.updateTable("rss_feeds").set({ items_posted: sql`items_posted + ${created}` }).where("id", "=", feed.id).execute();
  await markFeed(feed.id, {
    status: "active",
    last_checked_at: ts,
    next_check_at: nextOk,
    last_error: lastError,
    // Items left for the next check must be fetched again in full (no 304).
    etag: leftover ? null : fetched.etag,
    last_modified: leftover ? null : fetched.lastModified,
    ...(!feed.title && fetched.feed.title ? { title: fetched.feed.title.slice(0, 255) } : {}),
  });
  return { status: "ok", created, seen: fresh.length };
}

/** Feeds due for a check (active or in error), oldest due first. */
export async function dueFeeds(limit: number): Promise<RssFeedRecord[]> {
  const db = await getDb();
  const banned = await bannedOwnerWorkspaceIds();
  let q = db.selectFrom("rss_feeds").selectAll().where("status", "in", ["active", "error"]).where("next_check_at", "<=", now());
  if (banned.length) q = q.where("workspace_id", "not in", banned);
  const rows = await q.orderBy("next_check_at").limit(limit).execute();
  return rows.map(toRecord);
}

/** Records the next check right away so concurrent ticks don't process the same feed twice. */
export async function claimFeed(feed: RssFeedRecord, leaseMinutes = 5): Promise<boolean> {
  const db = await getDb();
  const res = await db
    .updateTable("rss_feeds")
    .set({ next_check_at: new Date(Date.now() + leaseMinutes * 60_000).toISOString() })
    .where("id", "=", feed.id)
    .where("next_check_at", "=", feed.nextCheckAt)
    .executeTakeFirst();
  return Number(res.numUpdatedRows) === 1;
}
