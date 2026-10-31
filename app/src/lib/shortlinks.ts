import "server-only";
import crypto from "node:crypto";
import { sql } from "kysely";
import { getDb, now } from "./db";
import type { ShortLinkRow } from "./db/schema";
import { getSettings } from "./settings";
import { absoluteUrl } from "./site";
import { buildUtmUrl, extractUrls, parseJson } from "@/social/normalize";
import type { Platform } from "@/social/types";

/**
 * Tracked short links: /l/<code> redirects (302) to the target URL with its UTM parameters and
 * counts clicks per day (link_clicks_daily). No personal data is stored: no IP, no cookie, no
 * user agent, only a daily counter. Obvious bots and link-preview fetchers are not counted.
 *
 * Used by the Links page, the composer (shortenUrl / shortenLinksInText) and RSS.
 */

export interface LinkUtm {
  source: string;
  medium: string;
  campaign: string;
  term: string;
  content: string;
}

export const EMPTY_LINK_UTM: LinkUtm = { source: "", medium: "", campaign: "", term: "", content: "" };

export interface ShortLinkRecord {
  id: number;
  workspaceId: number;
  code: string;
  title: string;
  /** Destination without the UTM parameters (what the user typed). */
  baseUrl: string;
  /** Destination with the UTM parameters (where /l/<code> redirects). */
  url: string;
  utm: LinkUtm;
  postId: number | null;
  channelId: number | null;
  clicks: number;
  lastClickedAt: string | null;
  createdAt: string;
}

export const MAX_LINKS_PER_WORKSPACE = 5000;
const CODE_ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 7;

export function isLinkCode(v: string): boolean {
  return /^[A-Za-z0-9]{4,32}$/.test(v);
}

function randomCode(): string {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let out = "";
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

const clean = (v: unknown, max = 100) =>
  typeof v === "string"
    ? v
        .trim()
        .replace(/[^\p{L}\p{N}_{}.~+ -]/gu, "_")
        .slice(0, max)
    : "";

export function normalizeLinkUtm(v: unknown): LinkUtm {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  return { source: clean(o.source), medium: clean(o.medium), campaign: clean(o.campaign), term: clean(o.term), content: clean(o.content) };
}

/** A public http(s) destination (no credentials, max 2,000 characters), or "" when invalid. */
export function normalizeDestination(v: unknown): string {
  if (typeof v !== "string") return "";
  const raw = v.trim();
  if (!raw || raw.length > 2000) return "";
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    if (u.username || u.password || !u.hostname.includes(".")) return "";
    return u.toString();
  } catch {
    return "";
  }
}

function toRecord(row: ShortLinkRow): ShortLinkRecord {
  const stored = parseJson(row.utm);
  const o = stored && typeof stored === "object" ? (stored as Record<string, unknown>) : {};
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    code: row.code,
    title: row.title ?? "",
    baseUrl: typeof o.base === "string" && o.base ? o.base : row.url,
    url: row.url,
    utm: normalizeLinkUtm(o),
    postId: row.post_id,
    channelId: row.channel_id,
    clicks: Number(row.clicks),
    lastClickedAt: row.last_clicked_at,
    createdAt: row.created_at,
  };
}

/** The public short URL of a code (Site URL + /l/<code>). */
export async function shortLinkUrl(code: string): Promise<string> {
  return absoluteUrl(await getSettings(), `/l/${code}`);
}

export async function getShortLinks(workspaceId: number, options: { limit?: number; offset?: number; search?: string } = {}): Promise<ShortLinkRecord[]> {
  const db = await getDb();
  let q = db.selectFrom("short_links").selectAll().where("workspace_id", "=", workspaceId);
  const search = options.search?.trim().replace(/[%_]/g, "");
  if (search) q = q.where((eb) => eb.or([eb("url", "like", `%${search}%`), eb("title", "like", `%${search}%`), eb("code", "=", search)]));
  const rows = await q
    .orderBy("created_at", "desc")
    .orderBy("id", "desc")
    .limit(Math.min(options.limit ?? 50, 500))
    .offset(options.offset ?? 0)
    .execute();
  return rows.map(toRecord);
}

export async function countShortLinks(workspaceId: number): Promise<number> {
  const db = await getDb();
  const row = await db.selectFrom("short_links").select((eb) => eb.fn.countAll<number>().as("n")).where("workspace_id", "=", workspaceId).executeTakeFirst();
  return Number(row?.n ?? 0);
}

export async function getShortLink(workspaceId: number, id: number): Promise<ShortLinkRecord | undefined> {
  if (!Number.isInteger(id) || id < 1) return undefined;
  const db = await getDb();
  const row = await db.selectFrom("short_links").selectAll().where("id", "=", id).where("workspace_id", "=", workspaceId).executeTakeFirst();
  return row ? toRecord(row) : undefined;
}

export type SaveLinkResult = { ok: true; link: ShortLinkRecord } | { ok: false; error: "url" | "limit" | "not_found" };

/**
 * Creates a short link. `utm` values may contain "{platform}" (replaced with `platform`).
 * With `reuse`, an existing link of the workspace to the same final URL (and post / channel) is
 * returned instead of creating a duplicate.
 */
export async function createShortLink(
  workspaceId: number,
  input: { url: string; utm?: Partial<LinkUtm>; title?: string; postId?: number | null; channelId?: number | null; platform?: Platform | string; reuse?: boolean },
): Promise<SaveLinkResult> {
  const base = normalizeDestination(input.url);
  if (!base) return { ok: false, error: "url" };
  const utm = normalizeLinkUtm({ ...EMPTY_LINK_UTM, ...input.utm });
  const url = buildUtmUrl(base, utm, { platform: input.platform ?? "" });
  const db = await getDb();
  if (input.reuse) {
    let q = db.selectFrom("short_links").selectAll().where("workspace_id", "=", workspaceId).where("url", "=", url);
    q = input.postId ? q.where("post_id", "=", input.postId) : q.where("post_id", "is", null);
    q = input.channelId ? q.where("channel_id", "=", input.channelId) : q.where("channel_id", "is", null);
    const found = await q.orderBy("id").executeTakeFirst();
    if (found) return { ok: true, link: toRecord(found) };
  }
  if ((await countShortLinks(workspaceId)) >= MAX_LINKS_PER_WORKSPACE) return { ok: false, error: "limit" };
  for (let attempt = 0; attempt < 6; attempt++) {
    const code = randomCode();
    try {
      const res = await db
        .insertInto("short_links")
        .values({
          workspace_id: workspaceId,
          code,
          title: (input.title ?? "").trim().slice(0, 255),
          url,
          utm: JSON.stringify({ ...utm, base }),
          post_id: input.postId ?? null,
          channel_id: input.channelId ?? null,
          clicks: 0,
          last_clicked_at: null,
          created_at: now(),
        })
        .executeTakeFirstOrThrow();
      const link = await getShortLink(workspaceId, Number(res.insertId));
      if (link) return { ok: true, link };
    } catch {
      // Code collision (unique index): try another one.
    }
  }
  throw new Error("Could not create a unique short link code.");
}

export async function updateShortLink(workspaceId: number, id: number, input: { url: string; utm?: Partial<LinkUtm>; title?: string }): Promise<SaveLinkResult> {
  const existing = await getShortLink(workspaceId, id);
  if (!existing) return { ok: false, error: "not_found" };
  const base = normalizeDestination(input.url);
  if (!base) return { ok: false, error: "url" };
  const utm = normalizeLinkUtm({ ...EMPTY_LINK_UTM, ...input.utm });
  const db = await getDb();
  await db
    .updateTable("short_links")
    .set({ url: buildUtmUrl(base, utm), utm: JSON.stringify({ ...utm, base }), title: (input.title ?? existing.title).trim().slice(0, 255) })
    .where("id", "=", id)
    .where("workspace_id", "=", workspaceId)
    .execute();
  return { ok: true, link: (await getShortLink(workspaceId, id))! };
}

export async function deleteShortLink(workspaceId: number, id: number): Promise<boolean> {
  const db = await getDb();
  const link = await getShortLink(workspaceId, id);
  if (!link) return false;
  await db.deleteFrom("link_clicks_daily").where("link_id", "=", id).execute();
  await db.deleteFrom("short_links").where("id", "=", id).where("workspace_id", "=", workspaceId).execute();
  return true;
}

/**
 * For the composer and RSS: a tracked short URL for `url` (UTM applied first). Reuses the
 * workspace's existing link to the same destination for the same post / channel. Returns the
 * original URL unchanged when it can't be shortened (invalid URL, link limit reached).
 */
export async function shortenUrl(
  workspaceId: number,
  url: string,
  utm?: Partial<LinkUtm> | null,
  options: { postId?: number | null; channelId?: number | null; platform?: Platform | string; title?: string } = {},
): Promise<{ shortUrl: string; url: string; code: string | null }> {
  const result = await createShortLink(workspaceId, { url, utm: utm ?? undefined, ...options, reuse: true }).catch(() => null);
  if (!result?.ok) return { shortUrl: url, url, code: null };
  return { shortUrl: await shortLinkUrl(result.link.code), url: result.link.url, code: result.link.code };
}

/** Replaces every http(s) link in `text` with a tracked short link (own short links are left alone). */
export async function shortenLinksInText(
  workspaceId: number,
  text: string,
  utm?: Partial<LinkUtm> | null,
  options: { postId?: number | null; channelId?: number | null; platform?: Platform | string } = {},
): Promise<string> {
  const urls = [...new Set(extractUrls(text))];
  if (!urls.length) return text;
  const own = await shortLinkUrl("");
  let out = text;
  for (const url of urls) {
    if (url.startsWith(own)) continue;
    const { shortUrl } = await shortenUrl(workspaceId, url, utm, options);
    if (shortUrl !== url) out = out.split(url).join(shortUrl);
  }
  return out;
}

// ── Redirects and clicks ──

const BOT_UA =
  /bot\b|bot\/|crawl|spider|slurp|preview|facebookexternalhit|facebookcatalog|meta-externalagent|embedly|quora link|pinterest|vkshare|w3c_validator|whatsapp|telegram|discord|slack|skype|bitlybot|tumblr|nuzzel|outbrain|flipboard|feedfetcher|feedly|newsblur|inoreader|validator|headless|phantomjs|puppeteer|playwright|lighthouse|pingdom|uptime|monitor|scan|curl\/|wget\/|python-|python\/|httpclient|http-client|okhttp|go-http|java\/|libwww|axios\/|node-fetch|undici|ruby|perl|php\//i;

/** Simple bot / link-preview filter (no fingerprinting): empty or known automated user agents. */
export function isBotUserAgent(ua: string | null | undefined): boolean {
  const v = (ua ?? "").trim();
  if (v.length < 12) return true;
  return BOT_UA.test(v);
}

/** The destination of a code (undefined when unknown). */
export async function findLinkByCode(code: string): Promise<{ id: number; url: string } | undefined> {
  if (!isLinkCode(code)) return undefined;
  const db = await getDb();
  const row = await db.selectFrom("short_links").select(["id", "url"]).where("code", "=", code).executeTakeFirst();
  return row ?? undefined;
}

/** Counts one click on a link (total + today's UTC counter). Never throws. */
export async function countClick(linkId: number, at = new Date()): Promise<void> {
  try {
    const db = await getDb();
    const day = at.toISOString().slice(0, 10);
    await db
      .updateTable("short_links")
      .set({ clicks: sql`clicks + 1`, last_clicked_at: at.toISOString() })
      .where("id", "=", linkId)
      .execute();
    const res = await db
      .updateTable("link_clicks_daily")
      .set({ clicks: sql`clicks + 1` })
      .where("link_id", "=", linkId)
      .where("day", "=", day)
      .executeTakeFirst();
    if (Number(res.numUpdatedRows) > 0) return;
    try {
      await db.insertInto("link_clicks_daily").values({ link_id: linkId, day, clicks: 1 }).execute();
    } catch {
      // Inserted by a concurrent click.
      await db
        .updateTable("link_clicks_daily")
        .set({ clicks: sql`clicks + 1` })
        .where("link_id", "=", linkId)
        .where("day", "=", day)
        .execute();
    }
  } catch (error) {
    console.error("[queuezen] short link click not counted:", error);
  }
}

/** Clicks per UTC day (oldest first, missing days = 0) of one link or the whole workspace. */
export async function clicksByDay(workspaceId: number, days: string[], linkId?: number): Promise<Array<{ day: string; clicks: number }>> {
  if (!days.length) return [];
  const db = await getDb();
  let q = db
    .selectFrom("link_clicks_daily as d")
    .innerJoin("short_links as l", "l.id", "d.link_id")
    .select(["d.day", (eb) => eb.fn.sum<number>("d.clicks").as("clicks")])
    .where("l.workspace_id", "=", workspaceId)
    .where("d.day", ">=", days[0])
    .where("d.day", "<=", days[days.length - 1]);
  if (linkId) q = q.where("d.link_id", "=", linkId);
  const rows = await q.groupBy("d.day").execute();
  const map = new Map(rows.map((r) => [r.day, Number(r.clicks)]));
  return days.map((day) => ({ day, clicks: map.get(day) ?? 0 }));
}

/** Clicks per link in a day range (for the links table "last 30 days" column). */
export async function clicksPerLink(workspaceId: number, fromDay: string, toDay: string): Promise<Map<number, number>> {
  const db = await getDb();
  const rows = await db
    .selectFrom("link_clicks_daily as d")
    .innerJoin("short_links as l", "l.id", "d.link_id")
    .select(["d.link_id", (eb) => eb.fn.sum<number>("d.clicks").as("clicks")])
    .where("l.workspace_id", "=", workspaceId)
    .where("d.day", ">=", fromDay)
    .where("d.day", "<=", toDay)
    .groupBy("d.link_id")
    .execute();
  return new Map(rows.map((r) => [r.link_id, Number(r.clicks)]));
}
