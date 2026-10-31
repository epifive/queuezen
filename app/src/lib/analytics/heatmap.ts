/**
 * Best-time heatmap math (dependency-free, used by the analytics page and the tests).
 *
 * Every published post contributes its engagement to the cell of its local weekday × hour (in the
 * workspace's time zone). A cell's value is the AVERAGE engagement per post published in that
 * hour, so posting often at 9:00 doesn't make 9:00 look better by itself. Cells with fewer than
 * `minPosts` posts are not ranked as "best times" (too little data).
 */

export interface HeatmapInput {
  /** ISO publication time. */
  publishedAt: string;
  /** Engagement of the publication (likes + comments + shares + saves + quotes). */
  engagement: number;
}

export interface HeatmapCell {
  /** ISO weekday: 1 = Monday … 7 = Sunday. */
  day: number;
  /** Local hour 0-23. */
  hour: number;
  posts: number;
  total: number;
  /** total / posts (0 when no posts). */
  avg: number;
}

export interface Heatmap {
  /** 7 × 24 cells: cells[(day - 1) * 24 + hour]. */
  cells: HeatmapCell[];
  /** Highest cell average (scale of the colours). */
  max: number;
  posts: number;
  /** Up to 3 best cells by average (with at least minPosts posts), best first. */
  best: HeatmapCell[];
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function fmt(timeZone: string): Intl.DateTimeFormat {
  let f = fmtCache.get(timeZone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", hour: "2-digit", hourCycle: "h23" });
    } catch {
      f = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", hour: "2-digit", hourCycle: "h23" });
    }
    fmtCache.set(timeZone, f);
  }
  return f;
}

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** Local ISO weekday and hour of an instant in a time zone. */
export function zonedWeekdayHour(ms: number, timeZone: string): { day: number; hour: number } {
  let day = 1;
  let hour = 0;
  for (const p of fmt(timeZone).formatToParts(new Date(ms))) {
    if (p.type === "weekday") day = WEEKDAYS[p.value] ?? 1;
    if (p.type === "hour") hour = Number(p.value) % 24;
  }
  return { day, hour };
}

export function buildHeatmap(rows: HeatmapInput[], timeZone: string, minPosts = 2): Heatmap {
  const cells: HeatmapCell[] = [];
  for (let day = 1; day <= 7; day++) for (let hour = 0; hour < 24; hour++) cells.push({ day, hour, posts: 0, total: 0, avg: 0 });
  let posts = 0;
  for (const row of rows) {
    const ms = Date.parse(row.publishedAt);
    if (!Number.isFinite(ms)) continue;
    const engagement = Number.isFinite(row.engagement) && row.engagement > 0 ? row.engagement : 0;
    const { day, hour } = zonedWeekdayHour(ms, timeZone);
    const cell = cells[(day - 1) * 24 + hour];
    cell.posts += 1;
    cell.total += engagement;
    posts += 1;
  }
  let max = 0;
  for (const cell of cells) {
    cell.avg = cell.posts ? cell.total / cell.posts : 0;
    if (cell.avg > max) max = cell.avg;
  }
  const best = cells
    .filter((c) => c.posts >= minPosts && c.avg > 0)
    .sort((a, b) => b.avg - a.avg || b.posts - a.posts || a.day - b.day || a.hour - b.hour)
    .slice(0, 3);
  return { cells, max, posts, best };
}

/** Colour step 0-5 of a cell for the heatmap (0 = no posts). */
export function heatLevel(cell: Pick<HeatmapCell, "posts" | "avg">, max: number): number {
  if (!cell.posts) return 0;
  if (max <= 0) return 1;
  return Math.min(5, Math.max(1, Math.ceil((cell.avg / max) * 5)));
}

/** Engagement of one publication from its metrics (missing fields count 0). */
export function engagementOf(m: { likes?: number | null; comments?: number | null; shares?: number | null; saves?: number | null; quotes?: number | null }): number {
  return (m.likes ?? 0) + (m.comments ?? 0) + (m.shares ?? 0) + (m.saves ?? 0) + (m.quotes ?? 0);
}

/** Engagement rate in percent (engagements / views), null when there are no views. */
export function engagementRate(engagements: number, views: number): number | null {
  return views > 0 ? (engagements / views) * 100 : null;
}
