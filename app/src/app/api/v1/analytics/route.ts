import { apiError, apiJson } from "@/lib/api-guard";
import { buildHeatmap, getPublications, perChannelOf, seriesOf, topPostsOf, totalsOf } from "@/lib/analytics";
import { clicksByDay } from "@/lib/shortlinks";
import { localDay, zonedTimeToUtc } from "@/social/normalize";
import { v1Guard } from "../_shared";

/**
 * GET /api/v1/analytics ?from=YYYY-MM-DD &to=YYYY-MM-DD (workspace time zone, inclusive; default the
 * last 30 days, at most 366 days) &channel_id=
 * → { from, to, timezone, totals, daily[], channels[], top_posts[], best_times[] }
 */
export const dynamic = "force-dynamic";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export async function GET(request: Request) {
  const guard = await v1Guard(request);
  if (!guard.ok) return guard.response;
  const url = new URL(request.url);
  const tz = guard.workspace.timezone;
  const today = localDay(Date.now(), tz);
  const to = url.searchParams.get("to") ?? today;
  const from = url.searchParams.get("from") ?? addDays(to, -29);
  if (!DAY.test(from) || !DAY.test(to) || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) return apiError(422, "from and to must be days (YYYY-MM-DD).");
  if (from > to) return apiError(422, "from must be on or before to.");
  const span = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
  if (span > 366) return apiError(422, "The range can cover at most 366 days.");
  const channelId = Number(url.searchParams.get("channel_id")) || undefined;
  const start = (day: string) => {
    const [year, month, d] = day.split("-").map(Number);
    return new Date(zonedTimeToUtc({ year, month, day: d, hour: 0, minute: 0 }, tz)).toISOString();
  };
  const days: string[] = [];
  for (let i = 0; i < span; i++) days.push(addDays(from, i));
  const rows = await getPublications(guard.workspace.id, { fromIso: start(from), toIso: start(addDays(to, 1)) }, channelId);
  const clicks = channelId ? [] : await clicksByDay(guard.workspace.id, days);
  const totals = totalsOf(rows, clicks.reduce((n, c) => n + c.clicks, 0));
  const heatmap = buildHeatmap(rows.filter((r) => r.metrics), tz);
  return apiJson({
    from,
    to,
    timezone: tz,
    totals: { published: totals.published, measured: totals.measured, engagements: totals.engagements, views: totals.views, likes: totals.likes, comments: totals.comments, shares: totals.shares, link_clicks: totals.linkClicks, engagement_rate: totals.rate === null ? null : Math.round(totals.rate * 100) / 100 },
    daily: seriesOf(rows, days, tz),
    channels: perChannelOf(rows).map((c) => ({ channel_id: c.channelId, platform: c.platform, published: c.published, measured: c.measured, engagements: c.engagements, views: c.views, analytics_available: c.supported })),
    top_posts: topPostsOf(rows, 10).map((p) => ({ post_id: p.postId, target_id: p.targetId, channel_id: p.channelId, platform: p.platform, published_at: p.publishedAt, permalink: p.permalink, text: p.text.slice(0, 280), metrics: p.metrics, engagements: p.engagement })),
    best_times: heatmap.best.map((c) => ({ weekday: c.day, hour: c.hour, posts: c.posts, avg_engagement: Math.round(c.avg * 10) / 10 })),
  });
}
