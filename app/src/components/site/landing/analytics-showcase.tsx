import { Download, Flame } from "lucide-react";
import { PlatformIcon } from "@/components/social/platform-icon";
import type { Translator } from "@/lib/i18n/messages";
import { cn } from "@/lib/utils";
import { platformShortName } from "@/social/format";
import type { Platform } from "@/social/types";
import { clock, compact, exampleBest, exampleHeat, hourLabel, num, weekdayName } from "./format";
import { MockLabel, WindowFrame } from "./mock-kit";
import { Showcase } from "./showcase";

/** Heat levels: the dashboard's scale (brand colour at increasing strength, own steps in dark mode). */
const LEVEL_CLASS = [
  "bg-line/40",
  "bg-primary/15 dark:bg-indigo-400/25",
  "bg-primary/30 dark:bg-indigo-400/40",
  "bg-primary/50 dark:bg-indigo-400/60",
  "bg-primary/75 dark:bg-indigo-300/80",
  "bg-primary dark:bg-indigo-200",
];

const NETWORKS: Array<[Platform, number]> = [
  ["instagram", 46],
  ["linkedin", 22],
  ["x", 14],
  ["threads", 10],
  ["facebook", 8],
];

function AnalyticsMockup({ t, locale }: { t: Translator; locale: string }) {
  let max = 0;
  for (let d = 1; d <= 7; d++) for (let h = 0; h < 24; h++) max = Math.max(max, exampleHeat(d, h));
  const best = exampleBest();
  const isBest = (d: number, h: number) => best.some(([bd, bh]) => bd === d && bh === h);
  const level = (v: number) => (v <= 0.02 ? 0 : Math.min(5, Math.max(1, Math.ceil((v / max) * 5))));
  const kpis: Array<[string, string, string]> = [
    [t("home.an.posts"), num(48, locale), "+12%"],
    [t("home.an.views"), compact(86_400, locale), "+24%"],
    [t("home.an.engagement"), compact(12_480, locale), "+18%"],
  ];

  return (
    <div role="img" aria-label={t("home.an.mockLabel")} className="relative mx-auto w-full max-w-[640px] select-none">
      <div aria-hidden className="absolute -inset-6 -z-10 rounded-[3rem] bg-gradient-to-br from-violet-400/25 via-primary/20 to-transparent blur-3xl" />
      <WindowFrame
        title={t("home.an.title")}
        extra={
          <>
            <span className="rounded-md border border-line bg-surface px-2 py-0.5 text-[11px] font-medium text-muted">{t("home.mock.last30")}</span>
            <Download className="size-3.5 text-muted max-[420px]:hidden" />
          </>
        }
      >
        <div className="space-y-3 p-3 sm:p-4">
          <dl className="grid grid-cols-3 gap-2">
            {kpis.map(([label, value, change], i) => (
              <div key={label} className={cn("relative flex min-w-0 flex-col-reverse justify-end rounded-xl border px-3 py-2.5", i === 2 ? "border-primary-line bg-primary-soft" : "border-line bg-paper/60")}>
                <dd className="mt-0.5 flex flex-wrap items-baseline gap-x-1.5">
                  <bdi className="font-display text-lg font-bold tracking-tight tabular-nums sm:text-xl">{value}</bdi>
                  <bdi dir="ltr" className="text-[10px] font-semibold text-emerald-600 sm:text-[11px] dark:text-emerald-400">
                    {change}
                  </bdi>
                </dd>
                <dt className="truncate text-[10px] font-medium text-muted sm:text-[11px]">{label}</dt>
              </div>
            ))}
          </dl>

          <div className="rounded-xl border border-line p-3">
            <div className="mb-2.5 flex items-start justify-between gap-3">
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 text-[12px] font-semibold">
                  <Flame className="size-3.5 text-amber-500" />
                  {t("home.an.heatTitle")}
                </span>
                <span className="block text-[10px] text-muted">{t("home.an.heatHint")}</span>
              </span>
              <span className="flex shrink-0 items-center gap-1 text-[9px] text-muted max-[420px]:hidden">
                {t("home.an.less")}
                {LEVEL_CLASS.map((c, i) => (
                  <span key={i} className={cn("size-2.5 rounded-[2px]", c)} />
                ))}
                {t("home.an.more")}
              </span>
            </div>
            <div className="grid grid-cols-[2.25rem_minmax(0,1fr)] gap-x-1.5">
              <span />
              <span className="grid grid-cols-24 text-[9px] text-muted">
                {[0, 6, 12, 18].map((h) => (
                  <span key={h} className="col-span-6 truncate text-start">
                    {hourLabel(h, locale)}
                  </span>
                ))}
              </span>
              {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                <span key={d} className="contents">
                  <span className="truncate py-[1px] text-[10px] leading-[14px] text-muted">{weekdayName(d, locale)}</span>
                  <span className="grid grid-cols-24 gap-[2px] py-[1px]">
                    {Array.from({ length: 24 }, (_, h) => (
                      <span
                        key={h}
                        className={cn("h-3.5 rounded-[2px]", LEVEL_CLASS[level(exampleHeat(d, h))], isBest(d, h) && "ring-2 ring-amber-400 ring-offset-1 ring-offset-surface")}
                      />
                    ))}
                  </span>
                </span>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-line p-3">
              <MockLabel>{t("home.an.bestTimes")}</MockLabel>
              <ol className="mt-2 space-y-1.5">
                {best.map(([d, h], i) => (
                  <li key={`${d}${h}`} className="flex items-center gap-2 text-[11px]">
                    <span className={cn("grid size-5 shrink-0 place-items-center rounded-full text-[10px] font-bold", i === 0 ? "bg-amber-400 text-amber-950" : "bg-line/70 text-muted")}>{num(i + 1, locale)}</span>
                    <bdi className="font-semibold">
                      {weekdayName(d, locale, "long")} {clock(h, 0, locale)}
                    </bdi>
                  </li>
                ))}
              </ol>
            </div>
            <div className="rounded-xl border border-line p-3 max-sm:hidden">
              <MockLabel>{t("home.an.byNetwork")}</MockLabel>
              <ul className="mt-2 space-y-1.5">
                {NETWORKS.slice(0, 4).map(([p, share]) => (
                  <li key={p} className="flex items-center gap-2 text-[11px]">
                    <PlatformIcon platform={p} className="size-3.5 rounded-[25%] dark:outline dark:outline-white/20" />
                    <span className="w-14 shrink-0 truncate">{platformShortName(p)}</span>
                    <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-line/60">
                      <span className="block h-full origin-left animate-[qz-fill_1.2s_ease-out_0.3s_both] rounded-full bg-primary motion-reduce:animate-none rtl:origin-right" style={{ width: `${(share / 46) * 100}%` }} />
                    </span>
                    <bdi className="w-8 shrink-0 text-end text-muted tabular-nums">{num(share / 100, locale, { style: "percent" })}</bdi>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </WindowFrame>

    </div>
  );
}

export function AnalyticsShowcase({ t, locale }: { t: Translator; locale: string }) {
  return (
    <Showcase
      id="analytics"
      tinted
      eyebrow={t("home.an.eyebrow")}
      title={t("home.an.titleSection")}
      text={t("home.an.text")}
      points={[t("home.an.point1"), t("home.an.point2"), t("home.an.point3"), t("home.an.point4")]}
      visual={<AnalyticsMockup t={t} locale={locale} />}
    />
  );
}
