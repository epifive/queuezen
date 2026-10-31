import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { heatLevel, type Heatmap } from "@/lib/analytics/heatmap";

/**
 * Server-rendered charts of the analytics pages (pure HTML/CSS, no client JS): one-series bar
 * charts with a hover tooltip per bar, horizontal comparison bars and the weekday × hour heatmap
 * (one hue, light → dark; in dark mode the strongest cells are the brightest). Each chart has a
 * screen-reader description and the pages render a data table next to them.
 */

function fmt(n: number, locale: string, digits = 0): string {
  try {
    return n.toLocaleString(locale, { maximumFractionDigits: digits });
  } catch {
    return n.toLocaleString("en", { maximumFractionDigits: digits });
  }
}

function niceMax(max: number): number {
  if (max <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(max));
  const step = [1, 2, 2.5, 5, 10].find((s) => s * magnitude >= max) ?? 10;
  return step * magnitude;
}

export interface BarPoint {
  key: string;
  /** Axis / tooltip label (e.g. "Oct 12"). */
  label: string;
  value: number;
}

/** Vertical bars of one series with a baseline, two grid lines and a tooltip per bar. */
export function BarChart({ data, locale, label, valueLabel, height = "h-48" }: { data: BarPoint[]; locale: string; label: string; valueLabel: string; height?: string }) {
  const top = niceMax(Math.max(0, ...data.map((d) => d.value)));
  const edge = Math.max(2, Math.round(data.length * 0.15));
  const ticks = data.length > 1 ? [0, Math.floor((data.length - 1) / 2), data.length - 1] : [0];
  return (
    <figure aria-label={label} className="min-w-0">
      <div className="flex gap-2">
        <div className={cn("flex flex-col justify-between text-end text-[11px] text-muted tabular-nums", height)} aria-hidden>
          <span className="-translate-y-1/2">{fmt(top, locale)}</span>
          <span>{fmt(top / 2, locale)}</span>
          <span className="translate-y-1/2">0</span>
        </div>
        <div className="relative min-w-0 flex-1">
          <div className="pointer-events-none absolute inset-0 flex flex-col justify-between" aria-hidden>
            <div className="border-t border-dashed border-line" />
            <div className="border-t border-dashed border-line" />
            <div className="border-t border-line" />
          </div>
          <ul className={cn("relative flex items-end", height, data.length > 45 ? "gap-px" : "gap-0.5")}>
            {data.map((d, i) => {
              const h = (d.value / top) * 100;
              const align = i < edge ? "start-0" : i >= data.length - edge ? "end-0" : "left-1/2 -translate-x-1/2 rtl:translate-x-1/2";
              return (
                <li key={d.key} className="group relative flex h-full flex-1 items-end">
                  <span className="sr-only">
                    {d.label}: {valueLabel} {fmt(d.value, locale)}
                  </span>
                  <div className="absolute inset-0 rounded-sm group-hover:bg-primary-soft" aria-hidden />
                  <div className="relative w-full rounded-t-[4px] bg-primary/80 transition-colors group-hover:bg-primary" style={{ height: `${h}%`, minHeight: d.value > 0 ? 2 : 0 }} aria-hidden />
                  <div className={cn("pointer-events-none absolute bottom-full z-10 mb-2 hidden w-max rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-lg group-hover:block", align)} aria-hidden>
                    <p className="font-medium">{d.label}</p>
                    <p className="mt-0.5 text-muted">
                      {valueLabel}: <span className="font-medium text-ink tabular-nums">{fmt(d.value, locale)}</span>
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="mt-2 flex justify-between text-[11px] text-muted" aria-hidden>
            {ticks.map((i) => (
              <span key={i}>{data[i]?.label}</span>
            ))}
          </div>
        </div>
      </div>
    </figure>
  );
}

export interface HBarRow {
  key: string | number;
  label: ReactNode;
  icon?: ReactNode;
  value: number;
  /** Text shown at the end of the bar (defaults to the value). */
  display?: string;
  /** Muted row (e.g. "no analytics on this network"). */
  muted?: boolean;
  note?: ReactNode;
}

/** Horizontal comparison bars (one per channel), value labels at the end. */
export function HBars({ rows, locale, label }: { rows: HBarRow[]; locale: string; label: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul aria-label={label} className="space-y-3">
      {rows.map((r) => (
        <li key={r.key} className="min-w-0">
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="flex min-w-0 items-center gap-2">
              {r.icon}
              <span className="min-w-0 truncate">{r.label}</span>
            </span>
            <span className={cn("shrink-0 tabular-nums", r.muted ? "text-muted" : "font-medium")}>{r.display ?? fmt(r.value, locale)}</span>
          </div>
          <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-line/60" aria-hidden>
            <div className={cn("h-full rounded-full", r.muted ? "bg-line" : "bg-primary")} style={{ width: `${r.muted ? 0 : Math.max(r.value > 0 ? 2 : 0, (r.value / max) * 100)}%` }} />
          </div>
          {r.note ? <p className="mt-1 text-xs text-muted">{r.note}</p> : null}
        </li>
      ))}
    </ul>
  );
}

/** Background of a heatmap level (0 = no posts). One hue: the brand colour at increasing strength. */
// Dark mode has its own steps (brighter indigo on the dark surface), not an automatic flip.
const LEVEL_CLASS = [
  "bg-line/40",
  "bg-primary/15 dark:bg-indigo-400/25",
  "bg-primary/30 dark:bg-indigo-400/40",
  "bg-primary/50 dark:bg-indigo-400/60",
  "bg-primary/75 dark:bg-indigo-300/80",
  "bg-primary dark:bg-indigo-200",
];

/** Weekday × hour heatmap of the average engagement per post. `dayOrder` follows the week start. */
export function HeatmapGrid({
  heatmap,
  locale,
  dayLabels,
  dayOrder,
  labels,
}: {
  heatmap: Heatmap;
  locale: string;
  /** Short weekday names, index 1 = Monday … 7 = Sunday (index 0 unused). */
  dayLabels: string[];
  dayOrder: number[];
  labels: { chart: string; less: string; more: string; noPosts: string; avg: string; posts: string };
}) {
  const hourName = (h: number) => {
    try {
      return new Date(Date.UTC(2026, 0, 5, h)).toLocaleTimeString(locale, { hour: "numeric", timeZone: "UTC" });
    } catch {
      return `${h}:00`;
    }
  };
  return (
    <figure aria-label={labels.chart} className="min-w-0">
      <div className="relative overflow-x-auto pb-1" role="region" aria-label={labels.chart} tabIndex={0}>
        <table className="w-full min-w-[520px] table-fixed border-separate border-spacing-[2px] text-[11px]">
          <thead>
            <tr>
              <th scope="col" className="w-10" />
              {Array.from({ length: 24 }, (_, h) => (
                <th key={h} scope="col" className="overflow-visible text-start font-normal text-muted">
                  {h % 3 === 0 ? <span className="block w-0 whitespace-nowrap">{hourName(h)}</span> : <span className="sr-only">{hourName(h)}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {dayOrder.map((day) => (
              <tr key={day}>
                <th scope="row" className="pe-1 text-start font-normal whitespace-nowrap text-muted">
                  {dayLabels[day]}
                </th>
                {Array.from({ length: 24 }, (_, hour) => {
                  const cell = heatmap.cells[(day - 1) * 24 + hour];
                  const level = heatLevel(cell, heatmap.max);
                  const text = cell.posts ? `${dayLabels[day]} ${hourName(hour)}: ${labels.avg} ${fmt(cell.avg, locale, 1)} · ${labels.posts} ${fmt(cell.posts, locale)}` : `${dayLabels[day]} ${hourName(hour)}: ${labels.noPosts}`;
                  return (
                    <td key={hour} className="p-0">
                      <div title={text} className={cn("h-5 rounded-[3px] sm:h-6", LEVEL_CLASS[level], heatmap.best.includes(cell) && "ring-2 ring-amber-400 ring-offset-1 ring-offset-surface")}>
                        <span className="sr-only">{text}</span>
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex items-center justify-end gap-1.5 text-[11px] text-muted" aria-hidden>
        {labels.less}
        {LEVEL_CLASS.map((c, i) => (
          <span key={i} className={cn("size-3 rounded-[3px]", c)} />
        ))}
        {labels.more}
      </div>
    </figure>
  );
}
