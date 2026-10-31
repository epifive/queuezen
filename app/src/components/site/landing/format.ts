import type { Platform } from "@/social/types";

/** Formatting helpers and the example data of the landing page illustrations. */

/** A grouped number in the visitor's locale. */
export function num(n: number, locale: string, options?: Intl.NumberFormatOptions): string {
  try {
    return n.toLocaleString(locale, options);
  } catch {
    return n.toLocaleString("en", options);
  }
}

/** 12400 → "12K" in the visitor's locale. */
export function compact(n: number, locale: string): string {
  return num(n, locale, { notation: "compact", maximumFractionDigits: 1 });
}

/** Monday 19 October 2026 (UTC): the reference week of every illustration. */
const MONDAY = Date.UTC(2026, 9, 19);

/** Weekday name of an ISO weekday (1 = Monday … 7 = Sunday). */
export function weekdayName(day: number, locale: string, style: "narrow" | "short" | "long" = "short"): string {
  const at = new Date(MONDAY + (day - 1) * 86_400_000);
  try {
    return at.toLocaleDateString(locale, { weekday: style, timeZone: "UTC" });
  } catch {
    return at.toLocaleDateString("en", { weekday: style, timeZone: "UTC" });
  }
}

/** Day of the month of an ISO weekday in the reference week. */
export function dayOfMonth(day: number, locale: string): string {
  return num(19 + day - 1, locale);
}

/** A wall-clock time, 24 h ("09:00"), in the visitor's digits. */
export function clock(hour: number, minute: number, locale: string): string {
  const at = new Date(Date.UTC(2026, 9, 19, hour, minute));
  try {
    return at.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" });
  } catch {
    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  }
}

/** An hour label for chart axes ("9 AM" / "09"), in the visitor's locale. */
export function hourLabel(hour: number, locale: string): string {
  const at = new Date(Date.UTC(2026, 9, 19, hour));
  try {
    return at.toLocaleTimeString(locale, { hour: "numeric", timeZone: "UTC" });
  } catch {
    return `${hour}:00`;
  }
}

/** The fictional brand of every illustration (a bakery) and the agency that runs its social media. */
export const EXAMPLE_BRAND = { name: "Lumen & Loaf", handle: "lumenandloaf", domain: "lumenloaf.example", initial: "L" } as const;
export const EXAMPLE_AGENCY = { name: "Northpeak Studio", initial: "N" } as const;

/** Channels of the example workspace; `on` = selected in the hero composer. */
export const EXAMPLE_CHANNELS: Array<{ platform: Platform; on: boolean }> = [
  { platform: "instagram", on: true },
  { platform: "x", on: true },
  { platform: "linkedin", on: true },
  { platform: "threads", on: true },
  { platform: "facebook", on: false },
  { platform: "bluesky", on: false },
];

export type ChipTone = "published" | "scheduled" | "pending" | "draft";

/** Calendar chip colours: the same tones as the dashboard (src/social/format.ts postStatusTone). */
export const CHIP_TONE: Record<ChipTone, string> = {
  published: "border-emerald-500 bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  scheduled: "border-primary bg-primary-soft text-ink",
  pending: "border-amber-500 bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  draft: "border-line bg-line/50 text-muted",
};

export interface ExampleSlot {
  /** ISO weekday, 1 = Monday. */
  day: number;
  hour: number;
  minute: number;
  platforms: Platform[];
  tone: ChipTone;
  /** home.cal.post<N> */
  text?: number;
}

/** The example week: what the hero calendar and the calendar showcase show. */
export const EXAMPLE_WEEK: ExampleSlot[] = [
  { day: 1, hour: 9, minute: 0, platforms: ["instagram", "facebook"], tone: "published", text: 1 },
  { day: 1, hour: 17, minute: 30, platforms: ["linkedin"], tone: "published", text: 2 },
  { day: 2, hour: 12, minute: 0, platforms: ["x", "threads", "bluesky"], tone: "published", text: 3 },
  { day: 3, hour: 9, minute: 0, platforms: ["instagram"], tone: "scheduled", text: 4 },
  { day: 3, hour: 18, minute: 0, platforms: ["youtube"], tone: "pending", text: 5 },
  { day: 4, hour: 11, minute: 30, platforms: ["linkedin", "x"], tone: "scheduled", text: 6 },
  { day: 5, hour: 17, minute: 0, platforms: ["instagram", "threads"], tone: "scheduled", text: 7 },
  { day: 6, hour: 8, minute: 0, platforms: ["instagram", "x", "linkedin", "threads"], tone: "scheduled", text: 8 },
  { day: 7, hour: 10, minute: 0, platforms: ["telegram", "discord"], tone: "draft", text: 9 },
];

/**
 * Example best-time heatmap: average engagement per post by weekday (rows, Monday first) and
 * hour. Deterministic (no Math.random), so every render is the same.
 */
export function exampleHeat(day: number, hour: number): number {
  const morning = Math.exp(-((hour - 9) ** 2) / 3.2);
  const lunch = 0.7 * Math.exp(-((hour - 12.5) ** 2) / 2.2);
  const evening = 0.85 * Math.exp(-((hour - 19) ** 2) / 4);
  const weekend = day >= 6 ? 0.62 : 1;
  const midweek = day === 2 || day === 3 ? 1.18 : 1;
  const night = hour < 6 ? 0.08 : 1;
  const ripple = 0.08 * Math.sin(day * 1.7 + hour * 0.9);
  return Math.max(0, (morning + lunch + evening) * weekend * midweek * night + ripple);
}

/** The three best cells of exampleHeat ([day, hour]), best first. */
export function exampleBest(): Array<[number, number]> {
  const cells: Array<[number, number, number]> = [];
  for (let d = 1; d <= 7; d++) for (let h = 0; h < 24; h++) cells.push([d, h, exampleHeat(d, h)]);
  return cells
    .sort((a, b) => b[2] - a[2])
    .slice(0, 3)
    .map(([d, h]) => [d, h]);
}

/** Deterministic daily series for sparklines (gentle growth with a weekly rhythm). */
export function exampleSeries(length: number, base: number, seed = 1): number[] {
  return Array.from({ length }, (_, i) => {
    const weekly = (i + seed) % 7 === 5 || (i + seed) % 7 === 6 ? 0.8 : 1;
    const trend = 1 + i / (length * 2.2);
    const wave = 1 + 0.08 * Math.sin(i / 2.1 + seed) + 0.05 * Math.sin(i * 1.6 + seed * 2);
    return Math.round(base * weekly * trend * wave);
  });
}

/** Smooth SVG paths (line + filled area) for a series. */
export function areaPaths(values: number[], width: number, height: number, pad = 4) {
  const max = Math.max(1, ...values);
  const min = Math.min(...values) * 0.85;
  const span = Math.max(1, max - min);
  const pts: Array<[number, number]> = values.map((v, i) => [(i / Math.max(1, values.length - 1)) * width, height - pad - ((v - min) / span) * (height - pad * 2)]);
  let line = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    line += ` C${c1[0].toFixed(1)} ${c1[1].toFixed(1)} ${c2[0].toFixed(1)} ${c2[1].toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return { line, area: `${line} L${width} ${height} L0 ${height} Z`, last: pts[pts.length - 1] };
}

/** A date of the reference week ("19 October"), in the visitor's locale. */
export function dateLabel(day: number, locale: string, options: Intl.DateTimeFormatOptions = { day: "numeric", month: "long" }): string {
  const at = new Date(MONDAY + (day - 1) * 86_400_000);
  try {
    return at.toLocaleDateString(locale, { ...options, timeZone: "UTC" });
  } catch {
    return at.toLocaleDateString("en", { ...options, timeZone: "UTC" });
  }
}
