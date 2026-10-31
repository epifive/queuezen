import { CalendarDays, ChevronLeft, ChevronRight, FileSpreadsheet, GripVertical, List, Plus, Rows3 } from "lucide-react";
import { PlatformIcon } from "@/components/social/platform-icon";
import type { MessageKey, Translator } from "@/lib/i18n/messages";
import { cn } from "@/lib/utils";
import { clock, dateLabel, dayOfMonth, EXAMPLE_WEEK, weekdayName } from "./format";
import { CalendarChip, MockLabel, WindowFrame } from "./mock-kit";
import { Showcase } from "./showcase";

const postText = (t: Translator, n?: number) => (n ? t(`home.cal.post${n}` as MessageKey) : undefined);

/** Queue slots of the example Instagram channel: [weekday, hour, minute, post text number or 0 = free]. */
const QUEUE: Array<[number, number, number, number]> = [
  [3, 9, 0, 4],
  [5, 17, 0, 7],
  [6, 8, 0, 8],
  [1, 9, 0, 0],
  [3, 9, 0, 0],
];

function CalendarMockup({ t, locale }: { t: Translator; locale: string }) {
  const range = `${dateLabel(1, locale, { day: "numeric", month: "short" })} – ${dateLabel(7, locale, { day: "numeric", month: "short" })}`;
  return (
    <div role="img" aria-label={t("home.cal.mockLabel")} className="relative mx-auto w-full max-w-[640px] select-none">
      <div aria-hidden className="absolute -inset-6 -z-10 rounded-[3rem] bg-gradient-to-tr from-primary/25 via-sky-400/15 to-transparent blur-3xl" />
      <WindowFrame
        title={t("home.cal.title")}
        extra={
          <span className="flex rounded-lg border border-line bg-paper p-0.5 text-[10px] font-medium text-muted">
            <span className="flex items-center gap-1 rounded-md px-1.5 py-0.5 max-[420px]:hidden">
              <CalendarDays className="size-3" />
              {t("home.cal.month")}
            </span>
            <span className="flex items-center gap-1 rounded-md bg-surface px-1.5 py-0.5 text-ink shadow-sm">
              <Rows3 className="size-3" />
              {t("home.cal.week")}
            </span>
            <span className="flex items-center gap-1 rounded-md px-1.5 py-0.5 max-[420px]:hidden">
              <List className="size-3" />
              {t("home.cal.list")}
            </span>
          </span>
        }
      >
        <div className="p-3 sm:p-4">
          <div className="mb-3 flex items-center gap-2">
            <span className="flex gap-0.5 text-muted">
              <ChevronLeft className="size-4 rtl:rotate-180" />
              <ChevronRight className="size-4 rtl:rotate-180" />
            </span>
            <bdi className="min-w-0 truncate text-sm font-semibold">{range}</bdi>
            <span className="ms-auto shrink-0 text-[10px] text-muted">{t("home.cal.tz")}</span>
          </div>

          {/* Week grid (wide) */}
          <div className="grid grid-cols-7 gap-1.5 max-sm:hidden">
            {[1, 2, 3, 4, 5, 6, 7].map((day) => {
              const posts = EXAMPLE_WEEK.filter((s) => s.day === day);
              return (
                <div key={day} className={cn("min-h-44 min-w-0 rounded-xl border border-line bg-surface p-1.5", day === 3 && "border-primary-line bg-primary-soft/40")}>
                  <span className="mb-1.5 flex items-baseline justify-between gap-1 px-0.5 text-[10px]">
                    <span className="truncate text-muted">{weekdayName(day, locale)}</span>
                    <span className={cn("font-semibold tabular-nums", day === 3 && "text-primary-text")}>{dayOfMonth(day, locale)}</span>
                  </span>
                  <span className="block space-y-1">
                    {posts.map((s) => (
                      <span key={`${s.hour}${s.minute}`} className={cn("block", s.day === 4 && "relative rotate-[-2deg] shadow-lg shadow-primary/20")}>
                        <CalendarChip slot={s} text={postText(t, s.text)} locale={locale} lines={3} />
                      </span>
                    ))}
                  </span>
                </div>
              );
            })}
          </div>

          {/* List (small screens) */}
          <ul className="space-y-1.5 sm:hidden">
            {EXAMPLE_WEEK.slice(2, 8).map((s) => (
              <li key={`${s.day}${s.hour}`} className="flex items-start gap-2">
                <span className="w-9 shrink-0 pt-1 text-[10px] text-muted">{weekdayName(s.day, locale)}</span>
                <span className="min-w-0 flex-1">
                  <CalendarChip slot={s} text={postText(t, s.text)} locale={locale} />
                </span>
              </li>
            ))}
          </ul>

          <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted">
            {(
              [
                ["bg-emerald-500", "home.cal.published"],
                ["bg-primary", "home.cal.scheduled"],
                ["bg-amber-500", "home.cal.pending"],
                ["bg-line", "home.cal.draft"],
              ] as const
            ).map(([dot, key]) => (
              <span key={key} className="inline-flex items-center gap-1">
                <span className={cn("size-2 rounded-full", dot)} />
                {t(key)}
              </span>
            ))}
          </p>
        </div>
      </WindowFrame>

      {/* The Instagram queue: weekly slots, the next free one highlighted. */}
      <div className="relative z-10 mx-auto -mt-6 w-[calc(100%-2rem)] max-w-xs rounded-2xl border border-line bg-surface/95 p-3 shadow-[0_24px_50px_-18px_rgba(30,27,75,0.4)] backdrop-blur sm:ms-auto sm:me-[-1rem] lg:-mt-24 lg:me-[-2.5rem] dark:shadow-[0_24px_50px_-12px_rgba(0,0,0,0.85)]">
        <span className="flex items-center gap-2">
          <PlatformIcon platform="instagram" className="size-5 rounded-[25%] dark:outline dark:outline-white/20" />
          <span className="min-w-0 flex-1 truncate text-xs font-semibold">{t("home.cal.queueTitle")}</span>
          <MockLabel>{t("home.cal.slots", { n: 5 })}</MockLabel>
        </span>
        <ul className="mt-2.5 space-y-1">
          {QUEUE.map(([day, h, m, post], i) => (
            <li
              key={i}
              className={cn(
                "flex items-center gap-2 rounded-lg px-2 py-1.5 text-[11px]",
                post ? "bg-paper/80" : i === 3 ? "bg-primary-soft ring-1 ring-primary-line ring-inset" : "border border-dashed border-line",
              )}
            >
              <GripVertical className="size-3 shrink-0 text-muted" />
              <bdi className="w-[4.5rem] shrink-0 font-semibold tabular-nums">
                {weekdayName(day, locale)} {clock(h, m, locale)}
              </bdi>
              {post ? (
                <span dir="auto" className="min-w-0 flex-1 truncate text-muted">
                  {postText(t, post)}
                </span>
              ) : (
                <span className={cn("flex-1 text-start font-medium", i === 3 ? "text-primary-text" : "text-muted")}>{i === 3 ? t("home.cal.next") : t("home.cal.free")}</span>
              )}
            </li>
          ))}
        </ul>
        <span className="mt-2.5 flex gap-1.5">
          <span className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg bg-primary px-2 py-1.5 text-[11px] font-semibold text-white">
            <Plus className="size-3" />
            {t("home.cal.addToQueue")}
          </span>
          <span className="inline-flex items-center gap-1 rounded-lg border border-line px-2 py-1.5 text-[11px] font-semibold">
            <FileSpreadsheet className="size-3 text-emerald-600 dark:text-emerald-400" />
            {t("home.cal.csv")}
          </span>
        </span>
      </div>
    </div>
  );
}

export function CalendarShowcase({ t, locale }: { t: Translator; locale: string }) {
  return (
    <Showcase
      id="calendar"
      tinted
      eyebrow={t("home.cal.eyebrow")}
      title={t("home.cal.titleSection")}
      text={t("home.cal.text")}
      points={[t("home.cal.point1"), t("home.cal.point2"), t("home.cal.point3"), t("home.cal.point4")]}
      visual={<CalendarMockup t={t} locale={locale} />}
    />
  );
}
