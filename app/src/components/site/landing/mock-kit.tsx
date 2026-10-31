import type { ReactNode } from "react";
import { PlatformIcon } from "@/components/social/platform-icon";
import { cn } from "@/lib/utils";
import type { Platform } from "@/social/types";
import { areaPaths, CHIP_TONE, clock, type ExampleSlot } from "./format";

/** Building blocks of the landing page illustrations: plain HTML/SVG, no JavaScript. */

/**
 * Keyframes of the landing page (qz-*): kept here so the page carries its own motion. Every user
 * pairs them with motion-reduce:animate-none.
 */
const KEYFRAMES = `
@keyframes qz-toast{from{opacity:0;transform:translateY(12px) scale(.96)}}
@keyframes qz-draw{from{stroke-dashoffset:1}to{stroke-dashoffset:0}}
@keyframes qz-flow{from{stroke-dashoffset:1}to{stroke-dashoffset:0}}
@keyframes qz-caret{50%{opacity:0}}
@keyframes qz-fill{from{transform:scaleX(0)}}
@keyframes qz-glow{50%{opacity:.55}}
`;

export function LandingStyles() {
  return <style href="qz-landing-keyframes" precedence="default">{KEYFRAMES}</style>;
}

/** Window chrome around an app illustration: traffic lights, a title and extras on the end side. */
export function WindowFrame({ title, extra, children, className }: { title: ReactNode; extra?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-2xl border border-line bg-surface shadow-[0_40px_100px_-40px_rgba(49,46,129,0.55)] ring-1 ring-black/[0.02] dark:shadow-[0_40px_100px_-30px_rgba(0,0,0,0.9)]",
        className,
      )}
    >
      <div className="flex items-center gap-3 border-b border-line bg-paper/70 px-4 py-2.5">
        <span aria-hidden className="flex shrink-0 gap-1.5">
          <span className="size-2.5 rounded-full bg-[#ff5f57]" />
          <span className="size-2.5 rounded-full bg-[#febc2e]" />
          <span className="size-2.5 rounded-full bg-[#28c840]" />
        </span>
        <span className="min-w-0 truncate font-display text-sm font-semibold">{title}</span>
        {extra ? <span className="ms-auto flex shrink-0 items-center gap-2">{extra}</span> : null}
      </div>
      {children}
    </div>
  );
}

/** A round avatar with an initial, optionally with the network's tile in the corner (like the composer's channel picker). */
export function Avatar({
  initial,
  platform,
  className = "size-9",
  tone = "bg-gradient-to-br from-amber-300 to-orange-500",
  dim = false,
  ring = false,
}: {
  initial: string;
  platform?: Platform;
  className?: string;
  tone?: string;
  dim?: boolean;
  ring?: boolean;
}) {
  return (
    <span className={cn("relative inline-grid shrink-0 rounded-full p-0.5", ring && "ring-2 ring-primary", dim && "opacity-45 grayscale")}>
      <span className={cn("grid place-items-center rounded-full font-display text-[13px] font-bold text-white", tone, className)}>{initial}</span>
      {platform ? <PlatformIcon platform={platform} className="absolute -end-0.5 -bottom-0.5 size-4 rounded ring-2 ring-surface dark:ring-white/25" /> : null}
    </span>
  );
}

/** Outline that keeps the near-black tiles (X, Threads) visible on dark surfaces. */
export const TILE_EDGE = "rounded-[25%] dark:outline dark:outline-white/20";

/** Overlapping network tiles. */
export function PlatformStack({ platforms, className = "size-3.5" }: { platforms: Platform[]; className?: string }) {
  return (
    <span className="flex -space-x-1 rtl:space-x-reverse">
      {platforms.map((p) => (
        <PlatformIcon key={p} platform={p} className={cn("rounded-[3px] ring-1 ring-surface dark:ring-white/25", className)} />
      ))}
    </span>
  );
}

/** A post on the calendar: time, networks and the first line, with the status colour on the start edge. */
export function CalendarChip({ slot, text, locale, compact = false, lines = 2 }: { slot: ExampleSlot; text?: string; locale: string; compact?: boolean; lines?: 2 | 3 }) {
  return (
    <span className={cn("block min-w-0 rounded-md border-s-[3px] px-1.5 py-1 text-start text-[11px] leading-tight", CHIP_TONE[slot.tone])}>
      <span className={cn("flex items-center gap-1", compact && "flex-col items-start gap-0.5")}>
        <bdi className="font-semibold tabular-nums">{clock(slot.hour, slot.minute, locale)}</bdi>
        <PlatformStack platforms={compact ? slot.platforms.slice(0, 3) : slot.platforms} className={compact ? "size-3" : "size-3.5"} />
      </span>
      {text ? (
        <span dir="auto" className={cn("mt-0.5 text-ink/85", lines === 3 ? "line-clamp-3" : "line-clamp-2")}>
          {text}
        </span>
      ) : null}
    </span>
  );
}

/** A small area chart that draws in once. */
export function Sparkline({ values, width = 200, height = 48, id, className }: { values: number[]; width?: number; height?: number; id: string; className?: string }) {
  const { line, area, last } = areaPaths(values, width, height);
  return (
    <svg aria-hidden viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className={cn("overflow-visible rtl:-scale-x-100", className)}>
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="var(--primary)" stopOpacity="0.28" />
          <stop offset="1" stopColor="var(--primary)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${id})`} />
      <path
        d={line}
        pathLength={1}
        fill="none"
        stroke="var(--primary)"
        strokeWidth={2}
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
        className="animate-[qz-draw_1.6s_ease-out_0.5s_both] [stroke-dasharray:1] motion-reduce:animate-none"
      />
      <circle cx={last[0]} cy={last[1]} r={3} fill="var(--primary)" className="stroke-surface" strokeWidth={1.5} />
    </svg>
  );
}

/** An eyebrow-sized label used inside the illustrations. */
export function MockLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("block text-[10px] font-semibold tracking-wide text-muted uppercase tall-script:normal-case", className)}>{children}</span>;
}
