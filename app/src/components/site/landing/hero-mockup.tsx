import { Fragment } from "react";
import { Bookmark, CalendarClock, CheckCheck, Eye, Hash, Heart, ImagePlus, MessageCircle, Repeat2, Send, Smile, Sparkles, TrendingUp } from "lucide-react";
import { PlatformIcon } from "@/components/social/platform-icon";
import type { Translator } from "@/lib/i18n/messages";
import { cn } from "@/lib/utils";
import { PLATFORM_CAPABILITIES } from "@/social/platforms";
import { platformShortName } from "@/social/format";
import { clock, compact, dayOfMonth, EXAMPLE_BRAND, EXAMPLE_CHANNELS, EXAMPLE_WEEK, exampleSeries, num, weekdayName } from "./format";
import { Avatar, CalendarChip, MockLabel, PlatformStack, Sparkline, WindowFrame } from "./mock-kit";

const TAG = /(#[\p{L}\p{N}_]+)/u;

/** Text with hashtags in a colour (like the composer's previews). */
export function Tagged({ text, className, tagClass = "text-primary-text" }: { text: string; className?: string; tagClass?: string }) {
  return (
    <span dir="auto" className={className}>
      {text.split(TAG).map((part, i) =>
        i % 2 === 1 ? (
          <span key={i} className={tagClass}>
            {part}
          </span>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </span>
  );
}

/** The photo of the example post: a loaf on a warm background, drawn in SVG. */
export function LoafArt({ className }: { className?: string }) {
  return (
    <span className={cn("relative block overflow-hidden bg-gradient-to-br from-amber-100 via-orange-200 to-rose-300 dark:from-amber-200 dark:via-orange-300 dark:to-rose-400", className)}>
      <svg aria-hidden viewBox="0 0 200 200" className="absolute inset-0 size-full">
        <circle cx="160" cy="38" r="54" fill="white" opacity="0.35" />
        <ellipse cx="100" cy="150" rx="78" ry="14" fill="#7c2d12" opacity="0.18" />
        <path d="M30 128c0-38 32-62 70-62s70 24 70 62c0 10-8 16-18 16H48c-10 0-18-6-18-16z" fill="#b45309" />
        <path d="M38 124c0-32 28-52 62-52s62 20 62 52" fill="none" stroke="#fcd34d" strokeWidth="3" opacity="0.55" />
        <path d="M66 96l14 14M92 88l14 16M118 92l14 14" stroke="#fde68a" strokeWidth="6" strokeLinecap="round" />
        <circle cx="46" cy="58" r="3" fill="white" opacity="0.8" />
        <circle cx="62" cy="40" r="2" fill="white" opacity="0.7" />
      </svg>
    </span>
  );
}

/**
 * The hero illustration: the composer (channel picker, per-network tabs, text with counters,
 * media and the first comment) with Instagram and X previews, this week's calendar, a
 * "Published to 4 networks" notification and an engagement sparkline. Plain HTML/SVG.
 */
export function HeroMockup({ t, locale }: { t: Translator; locale: string }) {
  const caption = t("home.mock.caption");
  const captionX = t("home.mock.captionX");
  const length = [...caption].length;
  const selected = EXAMPLE_CHANNELS.filter((c) => c.on).map((c) => c.platform);
  const saturday = `${weekdayName(6, locale, "short")} ${clock(8, 0, locale)}`;

  return (
    <div role="img" aria-label={t("home.mock.label")} className="relative mx-auto w-full max-w-[640px] select-none">
      <div aria-hidden className="absolute -inset-8 -z-10 rounded-[3rem] bg-gradient-to-br from-primary/30 via-violet-400/15 to-transparent blur-3xl" />

      <WindowFrame
        title={t("home.mock.title")}
        className="animate-tz-pop motion-reduce:animate-none"
        extra={
          <>
            <span className="text-[11px] text-muted max-[420px]:hidden">{t("home.mock.draft")}</span>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface py-0.5 ps-0.5 pe-2 text-[11px] font-semibold">
              <span className="grid size-4 place-items-center rounded-full bg-gradient-to-br from-amber-300 to-orange-500 text-[9px] font-bold text-white">{EXAMPLE_BRAND.initial}</span>
              <bdi>{EXAMPLE_BRAND.name}</bdi>
            </span>
          </>
        }
      >
        <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_14.5rem]">
          {/* Editor */}
          <div className="min-w-0 space-y-3 p-3 sm:p-4">
            <div className="flex items-center gap-1">
              {EXAMPLE_CHANNELS.map((c) => (
                <Avatar key={c.platform} initial={EXAMPLE_BRAND.initial} platform={c.platform} className="size-8" ring={c.on} dim={!c.on} />
              ))}
              <span className="ms-auto shrink-0 rounded-full bg-primary-soft px-2 py-0.5 text-[10px] font-semibold text-primary-text">{t("home.mock.selected", { n: num(selected.length, locale) })}</span>
            </div>

            <div className="rounded-xl border border-line">
              <div className="flex items-end gap-0.5 overflow-hidden border-b border-line px-2 pt-1.5 text-[11px] font-medium">
                <span className="shrink-0 border-b-2 border-transparent px-2 pb-1.5 text-muted">{t("home.mock.allChannels")}</span>
                {selected.map((p, i) => (
                  <span
                    key={p}
                    className={cn("flex shrink-0 items-center gap-1 border-b-2 px-1.5 pb-1.5", i === 0 ? "border-primary text-ink" : "border-transparent text-muted")}
                  >
                    <PlatformIcon platform={p} className="size-3.5 rounded-[25%] dark:outline dark:outline-white/20" />
                    {i === 0 ? platformShortName(p) : null}
                    {i === 1 ? <span className="size-1.5 rounded-full bg-primary" /> : null}
                  </span>
                ))}
              </div>
              <div className="px-3 pt-2.5 pb-2">
                <p className="min-h-[4.5rem] text-[12.5px] leading-relaxed">
                  <Tagged text={caption} />
                  <span aria-hidden className="ms-px inline-block h-3.5 w-px translate-y-0.5 animate-[qz-caret_1s_steps(1)_infinite] bg-primary motion-reduce:animate-none" />
                </p>
                <span className="mt-1.5 flex items-center gap-2 text-muted">
                  <Smile className="size-3.5" />
                  <Hash className="size-3.5" />
                  <span className="inline-flex items-center gap-1 rounded-full bg-gradient-to-r from-primary to-violet-500 px-2 py-0.5 text-[10px] font-semibold text-white rtl:bg-gradient-to-l">
                    <Sparkles className="size-3" />
                    {t("home.mock.ai")}
                  </span>
                </span>
              </div>
            </div>

            <div className="flex flex-wrap gap-1 max-sm:hidden">
              {selected.map((p) => {
                const max = PLATFORM_CAPABILITIES[p].text.max;
                return (
                  <span key={p} className="inline-flex items-center gap-1 rounded-md bg-paper px-1.5 py-0.5 text-[10px] font-medium text-muted ring-1 ring-line ring-inset">
                    <PlatformIcon platform={p} className="size-3 rounded-[25%] dark:outline dark:outline-white/20" />
                    <bdi className="tabular-nums">
                      {num(length, locale)} / {num(max, locale)}
                    </bdi>
                  </span>
                );
              })}
            </div>

            <div className="flex items-center gap-2 max-sm:hidden">
              <LoafArt className="size-11 rounded-lg ring-2 ring-primary ring-offset-1 ring-offset-surface" />
              <span className="size-11 rounded-lg bg-gradient-to-br from-stone-200 to-amber-300 dark:from-stone-500 dark:to-amber-600" />
              <span className="size-11 rounded-lg bg-gradient-to-br from-rose-200 to-orange-300 dark:from-rose-400 dark:to-orange-500" />
              <span className="grid size-11 place-items-center rounded-lg border border-dashed border-line text-muted">
                <ImagePlus className="size-4" />
              </span>
            </div>

            <div className="flex items-center gap-2 rounded-lg bg-paper px-2.5 py-2 text-[11px] max-sm:hidden">
              <MessageCircle className="size-3.5 shrink-0 text-primary-text" />
              <span className="shrink-0 font-semibold">{t("home.mock.firstComment")}</span>
              <Tagged text={t("home.mock.firstCommentText")} className="min-w-0 truncate text-muted" />
            </div>

            <div className="flex items-center gap-2 border-t border-line pt-3">
              <span className="inline-flex min-w-0 items-center gap-1.5 truncate rounded-lg border border-line px-2 py-1.5 text-[11px] font-medium">
                <CalendarClock className="size-3.5 shrink-0 text-primary-text" />
                <bdi className="truncate">{saturday}</bdi>
              </span>
              <span className="ms-auto shrink-0 rounded-lg border border-line px-2.5 py-1.5 text-[11px] font-semibold max-[380px]:hidden">{t("home.mock.addToQueue")}</span>
              <span className="shrink-0 rounded-lg bg-primary px-3 py-1.5 text-[11px] font-semibold text-white shadow-sm shadow-primary/30">{t("home.mock.schedule")}</span>
            </div>
          </div>

          {/* Previews */}
          <div className="min-w-0 space-y-2.5 border-t border-line bg-paper/60 p-3 sm:border-t-0 sm:border-s">
            <div className="flex items-center justify-between gap-2">
              <MockLabel>{t("home.mock.preview")}</MockLabel>
              <span className="flex gap-0.5">
                {selected.map((p, i) => (
                  <span key={p} className={cn("rounded-md p-0.5", i === 0 ? "ring-2 ring-primary" : "opacity-55")}>
                    <PlatformIcon platform={p} className="size-4 rounded-[25%] dark:outline dark:outline-white/20" />
                  </span>
                ))}
              </span>
            </div>

            {/* Instagram-style preview (an original mockup, not the network's UI). */}
            <div className="overflow-hidden rounded-xl border border-line bg-surface">
              <div className="flex items-center gap-2 px-2.5 py-2">
                <span className="grid size-6 shrink-0 place-items-center rounded-full bg-gradient-to-br from-amber-300 to-orange-500 p-[1.5px]">
                  <span className="grid size-full place-items-center rounded-full bg-surface text-[9px] font-bold">{EXAMPLE_BRAND.initial}</span>
                </span>
                <bdi dir="ltr" className="min-w-0 truncate text-[11px] font-semibold">
                  {EXAMPLE_BRAND.handle}
                </bdi>
                <span className="ms-auto text-muted">···</span>
              </div>
              <LoafArt className="aspect-[4/3] w-full sm:aspect-[5/4]" />
              <div className="space-y-1 px-2.5 py-2">
                <span className="flex items-center gap-2.5 text-ink [&_svg]:size-3.5">
                  <Heart className="fill-rose-500 text-rose-500" />
                  <MessageCircle />
                  <Send />
                  <Bookmark className="ms-auto" />
                </span>
                <span className="block text-[10.5px] font-semibold">{t("home.mock.likes", { n: num(1284, locale) })}</span>
                <span className="line-clamp-2 text-[10.5px] leading-snug">
                  <bdi dir="ltr" className="me-1 font-semibold">
                    {EXAMPLE_BRAND.handle}
                  </bdi>
                  <Tagged text={caption} tagClass="text-[#00376b] dark:text-[#e0f1ff]" />
                </span>
              </div>
            </div>

            {/* X-style preview: shorter text for 280 characters, the first comment as a reply. */}
            <div className="rounded-xl border border-line bg-surface p-2.5 max-sm:hidden">
              <div className="flex gap-2">
                <Avatar initial={EXAMPLE_BRAND.initial} className="size-6 text-[10px]" />
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1 text-[10.5px]">
                    <bdi className="truncate font-semibold">{EXAMPLE_BRAND.name}</bdi>
                    <PlatformIcon platform="x" className="size-3 shrink-0 rounded-[25%] dark:outline dark:outline-white/20" />
                  </p>
                  <p className="mt-0.5 text-[10.5px] leading-snug">
                    <Tagged text={captionX} tagClass="text-[#1d9bf0]" />
                  </p>
                  <span className="mt-1.5 flex items-center justify-between text-muted [&_svg]:size-3">
                    <MessageCircle />
                    <Repeat2 />
                    <Heart />
                    <Eye />
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </WindowFrame>

      {/* "Published" notification. Anchored by its bottom edge: a wrapped translation grows upwards. */}
      <div
        aria-hidden
        className="absolute -end-4 bottom-[calc(100%+0.75rem)] z-10 hidden w-[320px] animate-[qz-toast_0.7s_cubic-bezier(0.2,0.9,0.3,1.2)_1.2s_both] items-start gap-3 rounded-xl border border-line bg-surface/95 p-3 shadow-[0_18px_40px_-16px_rgba(30,27,75,0.35)] backdrop-blur motion-reduce:animate-none lg:flex xl:-end-10 dark:shadow-[0_18px_40px_-12px_rgba(0,0,0,0.8)]"
      >
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-emerald-500 text-white">
          <CheckCheck className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-start justify-between gap-2">
            <span className="min-w-0 text-start text-[13px] leading-snug font-semibold">{t("home.mock.toastTitle", { n: num(4, locale) })}</span>
            <span className="shrink-0 pt-0.5 text-[10px] text-muted">{t("home.mock.now")}</span>
          </span>
          <span className="mt-1 flex items-start gap-2 text-[11px] leading-snug text-muted">
            <span className="shrink-0 pt-px">
              <PlatformStack platforms={selected} className="size-4" />
            </span>
            <span className="min-w-0">{t("home.mock.toastText")}</span>
          </span>
        </span>
      </div>

      {/* Engagement card. */}
      <div
        aria-hidden
        className="absolute -start-14 -bottom-24 z-10 hidden w-[230px] animate-[qz-toast_0.7s_cubic-bezier(0.2,0.9,0.3,1.2)_0.8s_both] rounded-2xl border border-line bg-surface/95 p-4 shadow-[0_24px_50px_-18px_rgba(30,27,75,0.4)] backdrop-blur motion-reduce:animate-none lg:block xl:-start-20 dark:shadow-[0_24px_50px_-12px_rgba(0,0,0,0.85)]"
      >
        <span className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-semibold text-muted">{t("home.mock.engagement")}</span>
          <span className="text-[10px] text-muted">{t("home.mock.last30")}</span>
        </span>
        <span className="mt-1 flex items-baseline gap-2">
          <bdi className="font-display text-2xl font-bold tracking-tight">{compact(12_480, locale)}</bdi>
          <span className="inline-flex items-center gap-0.5 text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">
            <TrendingUp className="size-3" />
            <bdi dir="ltr">+{num(18, locale)}%</bdi>
          </span>
        </span>
        <Sparkline id="qz-hero-spark" values={exampleSeries(30, 380, 2)} width={200} height={46} className="mt-2 h-12 w-full" />
      </div>

      {/* This week on the calendar: beside the window on wide screens, under it on small ones. */}
      <div
        aria-hidden
        className="relative z-10 mx-auto mt-5 w-full max-w-[380px] animate-[qz-toast_0.7s_cubic-bezier(0.2,0.9,0.3,1.2)_1s_both] rounded-2xl border border-line bg-surface/95 p-3 shadow-[0_24px_50px_-18px_rgba(30,27,75,0.4)] backdrop-blur motion-reduce:animate-none lg:absolute lg:-end-8 lg:-bottom-36 lg:mt-0 lg:w-[350px] xl:-end-14 dark:shadow-[0_24px_50px_-12px_rgba(0,0,0,0.85)]"
      >
        <span className="flex items-center justify-between gap-2 px-0.5">
          <span className="text-[11px] font-semibold">{t("home.mock.thisWeek")}</span>
          <span className="text-[10px] text-muted">{t("home.mock.weekPosts", { n: num(EXAMPLE_WEEK.length, locale) })}</span>
        </span>
        <span className="mt-2 grid grid-cols-7 gap-1">
          {[1, 2, 3, 4, 5, 6, 7].map((day) => (
            <span key={day} className={cn("min-w-0 rounded-lg p-1", day === 6 ? "bg-primary-soft ring-1 ring-primary-line" : "bg-paper/70")}>
              <span className="block text-center text-[9px] leading-tight text-muted">{weekdayName(day, locale, "narrow")}</span>
              <span className={cn("block text-center text-[11px] font-semibold tabular-nums", day === 6 && "text-primary-text")}>{dayOfMonth(day, locale)}</span>
              <span className="mt-1 block space-y-1">
                {EXAMPLE_WEEK.filter((s) => s.day === day)
                  .slice(0, 2)
                  .map((s) => (
                    <CalendarChip key={`${s.hour}${s.minute}`} slot={s} locale={locale} compact />
                  ))}
              </span>
            </span>
          ))}
        </span>
      </div>
    </div>
  );
}
