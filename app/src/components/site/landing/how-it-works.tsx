import { BadgeCheck, CalendarClock, Check, Eye, Heart, Lock, MessageCircle } from "lucide-react";
import { PlatformIcon } from "@/components/social/platform-icon";
import type { Translator } from "@/lib/i18n/messages";
import { cn } from "@/lib/utils";
import { platformShortName } from "@/social/format";
import type { Platform } from "@/social/types";
import { clock, compact, num, weekdayName } from "./format";
import { PlatformStack } from "./mock-kit";
import { SectionHeading } from "./section-heading";

const CONNECTED: Platform[] = ["instagram", "linkedin", "x", "telegram"];

/** Three steps from connecting accounts to the first results, each with a small illustration. */
export function HowItWorks({ t, locale }: { t: Translator; locale: string }) {
  const slots: Array<[number, number, number]> = [
    [1, 9, 0],
    [3, 12, 30],
    [5, 17, 0],
  ];
  const steps = [
    {
      title: t("home.step1Title"),
      text: t("home.step1Text"),
      visual: (
        <div aria-hidden className="space-y-1.5 rounded-xl border border-line bg-surface px-3 py-3">
          {CONNECTED.map((p, i) => (
            <span key={p} className="flex items-center gap-2.5 text-xs">
              <PlatformIcon platform={p} className="size-5 rounded-[25%] dark:outline dark:outline-white/20" />
              <span className="min-w-0 flex-1 truncate font-semibold">{platformShortName(p)}</span>
              {i < 3 ? (
                <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                  <Check className="size-3" strokeWidth={3} />
                  {t("home.step1Connected")}
                </span>
              ) : (
                <span className="rounded-md bg-primary px-2 py-0.5 text-[11px] font-semibold text-white">{t("home.step1Connect")}</span>
              )}
            </span>
          ))}
          <span className="flex items-center gap-1.5 border-t border-line pt-2 text-[11px] text-muted">
            <Lock className="size-3" />
            {t("home.step1Encrypted")}
          </span>
        </div>
      ),
    },
    {
      title: t("home.step2Title"),
      text: t("home.step2Text"),
      visual: (
        <div aria-hidden className="space-y-2 rounded-xl border border-line bg-surface px-3 py-3">
          <span className="flex items-center gap-2 text-xs font-semibold">
            <CalendarClock className="size-4 text-primary-text" />
            {t("home.step2Slots")}
          </span>
          <span className="flex flex-wrap gap-1.5">
            {slots.map(([d, h, m], i) => (
              <span
                key={d}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
                  i === 0 ? "bg-line/60 text-muted line-through" : i === 1 ? "bg-primary text-white" : "bg-primary-soft text-primary-text",
                )}
              >
                <bdi>
                  {weekdayName(d, locale)} {clock(h, m, locale)}
                </bdi>
              </span>
            ))}
          </span>
          <span className="block h-1.5 overflow-hidden rounded-full bg-line/70">
            <span className="block h-full w-2/3 origin-left animate-[qz-fill_1.4s_ease-out_0.3s_both] rounded-full bg-gradient-to-r from-primary to-violet-400 motion-reduce:animate-none rtl:origin-right rtl:bg-gradient-to-l" />
          </span>
          <span className="block text-[11px] text-muted">{t("home.step2Queue", { n: num(12, locale) })}</span>
        </div>
      ),
    },
    {
      title: t("home.step3Title"),
      text: t("home.step3Text"),
      visual: (
        <div aria-hidden className="space-y-2 rounded-xl border border-line bg-surface px-3 py-3">
          <span className="flex flex-wrap items-center gap-1.5 text-[11px] font-semibold">
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/12 px-2 py-0.5 text-emerald-700 dark:text-emerald-400">
              <BadgeCheck className="size-3" />
              {t("home.step3Approved")}
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-primary-soft px-2 py-0.5 text-primary-text">
              <PlatformStack platforms={["instagram", "linkedin", "x"]} className="size-3" />
              {t("home.step3Published")}
            </span>
          </span>
          <span className="grid grid-cols-3 gap-1.5 text-center">
            {(
              [
                [Eye, compact(8_640, locale)],
                [Heart, num(412, locale)],
                [MessageCircle, num(37, locale)],
              ] as const
            ).map(([Icon, value], i) => (
              <span key={i} className="rounded-lg bg-paper px-1 py-1.5">
                <Icon className="mx-auto size-3.5 text-muted" />
                <bdi className="mt-0.5 block font-display text-sm font-bold tabular-nums">{value}</bdi>
              </span>
            ))}
          </span>
        </div>
      ),
    },
  ];

  return (
    <section id="how-it-works" aria-labelledby="how-title" className="scroll-mt-16 border-b border-line bg-surface py-24 sm:py-28">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <SectionHeading id="how-title" align="center" eyebrow={t("home.howEyebrow")} title={t("home.howTitle")} text={t("home.howText")} />
        <ol className="relative mt-16 grid grid-cols-1 gap-6 md:grid-cols-3">
          <span aria-hidden className="absolute inset-x-[16%] top-14 hidden border-t-2 border-dashed border-primary-line md:block" />
          {steps.map((step, i) => (
            <li key={step.title} className="relative flex flex-col rounded-2xl border border-line bg-paper p-6 sm:p-7">
              <span className="relative grid size-14 shrink-0 place-items-center rounded-2xl bg-primary font-display text-2xl font-bold text-white shadow-lg shadow-primary/30">
                <span className="sr-only">{t("home.howStep", { n: i + 1 })}</span>
                <span aria-hidden>{num(i + 1, locale)}</span>
              </span>
              <h3 className="mt-6 text-xl font-bold tall-script:leading-snug">{step.title}</h3>
              <p className="mt-2 flex-1 leading-relaxed text-muted">{step.text}</p>
              <div className="mt-6">{step.visual}</div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
