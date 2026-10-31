import "server-only";
import { getDb } from "../db";
import { clicksByDay } from "../shortlinks";
import { localDay, mergeContent, normalizeOverride, normalizePostContent, parseJson, zonedTimeToUtc } from "@/social/normalize";
import { getCapabilities } from "@/social/platforms";
import type { MetricField, Platform, PostMetrics } from "@/social/types";
import { buildHeatmap, engagementOf, engagementRate, type Heatmap } from "./heatmap";

export { buildHeatmap, engagementOf, engagementRate, heatLevel, type Heatmap, type HeatmapCell } from "./heatmap";

/**
 * Analytics of a workspace from our own data: publications (post_targets "published") and their
 * latest metrics (post_metrics, filled by the metrics job). Days and the heatmap use the
 * workspace's time zone. Link clicks come from the tracked short links.
 */

export const ANALYTICS_PERIODS = [7, 30, 90] as const;
export type AnalyticsPeriod = (typeof ANALYTICS_PERIODS)[number];

export interface Publication {
  targetId: number;
  postId: number;
  channelId: number;
  platform: Platform;
  publishedAt: string;
  permalink: string | null;
  text: string;
  metrics: PostMetrics | null;
  fetchedAt: string | null;
  engagement: number;
  views: number;
}

export interface Totals {
  published: number;
  /** Publications with metrics (the rest: not fetched yet or no analytics on the network). */
  measured: number;
  engagements: number;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  linkClicks: number;
  /** engagements / views in %, null without views. */
  rate: number | null;
}

export interface Range {
  days: string[];
  fromIso: string;
  toIso: string;
}

function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** The last `days` local days (today included) of a time zone, with their UTC bounds; `offset` periods back. */
export function periodRangeTz(days: number, timezone: string, offset = 0, nowMs = Date.now()): Range {
  const today = localDay(nowMs, timezone);
  const last = addDays(today, -offset * days);
  const first = addDays(last, -(days - 1));
  const list: string[] = [];
  for (let i = 0; i < days; i++) list.push(addDays(first, i));
  const start = (day: string) => {
    const [year, month, d] = day.split("-").map(Number);
    return zonedTimeToUtc({ year, month, day: d, hour: 0, minute: 0 }, timezone);
  };
  return { days: list, fromIso: new Date(start(first)).toISOString(), toIso: new Date(start(addDays(last, 1))).toISOString() };
}

const viewsOf = (m: PostMetrics | null) => (m ? (m.views ?? m.impressions ?? 0) : 0);

/** Published publications of a workspace in [fromIso, toIso) with their latest metrics. */
export async function getPublications(workspaceId: number, range: { fromIso: string; toIso: string }, channelId?: number): Promise<Publication[]> {
  const db = await getDb();
  let q = db
    .selectFrom("post_targets as t")
    .innerJoin("posts as p", "p.id", "t.post_id")
    .leftJoin("post_metrics as m", "m.target_id", "t.id")
    .select([
      "t.id as target_id",
      "t.post_id",
      "t.channel_id",
      "t.platform",
      "t.published_at",
      "t.permalink",
      "t.override",
      "p.content",
      "m.fetched_at",
      "m.views",
      "m.impressions",
      "m.reach",
      "m.likes",
      "m.comments",
      "m.shares",
      "m.saves",
      "m.clicks",
      "m.quotes",
    ])
    .where("t.workspace_id", "=", workspaceId)
    .where("t.status", "=", "published")
    .where("t.published_at", ">=", range.fromIso)
    .where("t.published_at", "<", range.toIso);
  if (channelId) q = q.where("t.channel_id", "=", channelId);
  const rows = await q.orderBy("t.published_at").limit(20_000).execute();
  return rows.map((r) => {
    let metrics: PostMetrics | null = null;
    if (r.fetched_at) {
      metrics = {};
      for (const f of ["views", "impressions", "reach", "likes", "comments", "shares", "saves", "clicks", "quotes"] as MetricField[]) {
        const v = r[f];
        if (v !== null && v !== undefined) metrics[f] = Number(v);
      }
    }
    const content = mergeContent(normalizePostContent(parseJson(r.content)), normalizeOverride(parseJson(r.override)));
    return {
      targetId: r.target_id,
      postId: r.post_id,
      channelId: r.channel_id,
      platform: r.platform as Platform,
      publishedAt: r.published_at ?? "",
      permalink: r.permalink,
      text: content.text,
      metrics,
      fetchedAt: r.fetched_at ?? null,
      engagement: metrics ? engagementOf(metrics) : 0,
      views: viewsOf(metrics),
    };
  });
}

export function totalsOf(rows: Publication[], linkClicks = 0): Totals {
  const t = { published: rows.length, measured: 0, engagements: 0, views: 0, likes: 0, comments: 0, shares: 0, linkClicks, rate: null as number | null };
  for (const r of rows) {
    if (!r.metrics) continue;
    t.measured += 1;
    t.engagements += r.engagement;
    t.views += r.views;
    t.likes += r.metrics.likes ?? 0;
    t.comments += r.metrics.comments ?? 0;
    t.shares += (r.metrics.shares ?? 0) + (r.metrics.quotes ?? 0);
  }
  // The rate only counts publications that report views (else engagement-only networks inflate it).
  let e = 0;
  let v = 0;
  for (const r of rows) {
    if (r.views > 0) {
      e += r.engagement;
      v += r.views;
    }
  }
  t.rate = engagementRate(e, v);
  return t;
}

export interface DayPoint {
  day: string;
  published: number;
  engagements: number;
  views: number;
}

/** Publications, engagement and views per local day (engagement is attributed to the publication day). */
export function seriesOf(rows: Publication[], days: string[], timezone: string): DayPoint[] {
  const map = new Map(days.map((day) => [day, { day, published: 0, engagements: 0, views: 0 }]));
  for (const r of rows) {
    const point = map.get(localDay(Date.parse(r.publishedAt), timezone));
    if (!point) continue;
    point.published += 1;
    point.engagements += r.engagement;
    point.views += r.views;
  }
  return [...map.values()];
}

export interface ChannelStats {
  channelId: number;
  platform: Platform;
  published: number;
  measured: number;
  engagements: number;
  views: number;
  avgEngagement: number;
  rate: number | null;
  /** The network has an analytics API. */
  supported: boolean;
}

export function perChannelOf(rows: Publication[]): ChannelStats[] {
  const map = new Map<number, Publication[]>();
  for (const r of rows) map.set(r.channelId, [...(map.get(r.channelId) ?? []), r]);
  return [...map.entries()]
    .map(([channelId, list]) => {
      const t = totalsOf(list);
      const platform = list[0].platform;
      return {
        channelId,
        platform,
        published: t.published,
        measured: t.measured,
        engagements: t.engagements,
        views: t.views,
        avgEngagement: t.measured ? t.engagements / t.measured : 0,
        rate: t.rate,
        supported: getCapabilities(platform).analytics.supported,
      };
    })
    .sort((a, b) => b.engagements - a.engagements || b.published - a.published);
}

export function topPostsOf(rows: Publication[], limit = 10): Publication[] {
  return rows
    .filter((r) => r.metrics)
    .sort((a, b) => b.engagement - a.engagement || b.views - a.views)
    .slice(0, limit);
}

export interface WorkspaceAnalytics {
  range: Range;
  totals: Totals;
  previous: Totals;
  series: DayPoint[];
  clicks: Array<{ day: string; clicks: number }>;
  perChannel: ChannelStats[];
  top: Publication[];
  heatmap: Heatmap;
  /** Publications used for the heatmap (at least the last 90 days). */
  heatmapPosts: number;
}

/** Everything the analytics page shows for a period (days) and an optional channel. */
export async function getWorkspaceAnalytics(workspace: { id: number; timezone: string }, days: number, channelId?: number, nowMs = Date.now()): Promise<WorkspaceAnalytics> {
  const range = periodRangeTz(days, workspace.timezone, 0, nowMs);
  const prevRange = periodRangeTz(days, workspace.timezone, 1, nowMs);
  const heatRange = periodRangeTz(Math.max(days, 90), workspace.timezone, 0, nowMs);
  const [rows, prevRows, heatRows] = await Promise.all([
    getPublications(workspace.id, range, channelId),
    getPublications(workspace.id, prevRange, channelId),
    days >= 90 ? Promise.resolve(null) : getPublications(workspace.id, heatRange, channelId),
  ]);
  // Short-link clicks use UTC days (link_clicks_daily); close enough for the period totals.
  const utcDays = (r: Range) => {
    const out: string[] = [];
    for (let ms = Date.parse(r.fromIso.slice(0, 10)); ms < Date.parse(r.toIso); ms += 86_400_000) out.push(new Date(ms).toISOString().slice(0, 10));
    return out;
  };
  const [clicks, prevClicks] = channelId ? [[], []] : await Promise.all([clicksByDay(workspace.id, range.days), clicksByDay(workspace.id, utcDays(prevRange))]);
  const sum = (list: Array<{ clicks: number }>) => list.reduce((n, c) => n + c.clicks, 0);
  const heatSource = (heatRows ?? rows).filter((r) => r.metrics);
  return {
    range,
    totals: totalsOf(rows, sum(clicks)),
    previous: totalsOf(prevRows, sum(prevClicks)),
    series: seriesOf(rows, range.days, workspace.timezone),
    clicks,
    perChannel: perChannelOf(rows),
    top: topPostsOf(rows),
    heatmap: buildHeatmap(heatSource, workspace.timezone),
    heatmapPosts: heatSource.length,
  };
}

/** CSV of the publications in a period (one row per post and channel). */
export function publicationsCsv(rows: Publication[], channelNames: Map<number, string>, timezone: string): string {
  const head = ["published_at_utc", "local_day", "channel", "network", "post_id", "text", "permalink", "views", "impressions", "reach", "likes", "comments", "shares", "saves", "clicks", "quotes", "engagements", "metrics_updated_at"];
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    // Formula injection guard for spreadsheet apps.
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const lines = [head.join(",")];
  for (const r of rows) {
    const m = r.metrics ?? {};
    lines.push(
      [
        r.publishedAt,
        localDay(Date.parse(r.publishedAt), timezone),
        channelNames.get(r.channelId) ?? `#${r.channelId}`,
        r.platform,
        r.postId,
        r.text.replace(/\s+/g, " ").slice(0, 500),
        r.permalink ?? "",
        m.views,
        m.impressions,
        m.reach,
        m.likes,
        m.comments,
        m.shares,
        m.saves,
        m.clicks,
        m.quotes,
        r.metrics ? r.engagement : "",
        r.fetchedAt ?? "",
      ]
        .map(cell)
        .join(","),
    );
  }
  // Byte order mark: Excel then opens the UTF-8 file with the right encoding.
  return `${String.fromCharCode(0xfeff)}${lines.join("\r\n")}\r\n`;
}

/** This week's numbers for the home dashboard (last 7 local days). */
export async function weekStats(workspace: { id: number; timezone: string }): Promise<{ totals: Totals; previous: Totals }> {
  const range = periodRangeTz(7, workspace.timezone);
  const prev = periodRangeTz(7, workspace.timezone, 1);
  const [rows, prevRows, clicks] = await Promise.all([getPublications(workspace.id, range), getPublications(workspace.id, prev), clicksByDay(workspace.id, range.days)]);
  return { totals: totalsOf(rows, clicks.reduce((n, c) => n + c.clicks, 0)), previous: totalsOf(prevRows) };
}

