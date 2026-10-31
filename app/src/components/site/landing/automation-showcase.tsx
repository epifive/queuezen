import type { ReactNode } from "react";
import { ArrowDown, Link2, MousePointerClick, Recycle, Rss } from "lucide-react";
import type { Translator } from "@/lib/i18n/messages";
import { cn } from "@/lib/utils";
import { clock, EXAMPLE_BRAND, num, weekdayName } from "./format";
import { MockLabel, PlatformStack } from "./mock-kit";
import { Showcase } from "./showcase";

/** Daily clicks of the example short link (14 days). */
const CLICKS = [12, 18, 15, 22, 31, 26, 19, 24, 28, 35, 30, 27, 33, 42];

function Card({ icon, tile, title, meta, children, className }: { icon: ReactNode; tile: string; title: string; meta?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn("rounded-2xl border border-line bg-surface p-4 shadow-[0_20px_40px_-24px_rgba(30,27,75,0.35)] dark:shadow-[0_20px_40px_-20px_rgba(0,0,0,0.8)]", className)}>
      <div className="flex items-center gap-2.5">
        <span className={cn("grid size-8 shrink-0 place-items-center rounded-lg text-white", tile)}>{icon}</span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{title}</span>
        {meta}
      </div>
      <div className="mt-3">{children}</div>
    </div>
  );
}

function Connector() {
  return (
    <span aria-hidden className="flex justify-center py-1.5">
      <span className="grid size-6 place-items-center rounded-full border border-primary-line bg-primary-soft text-primary-text">
        <ArrowDown className="size-3.5" />
      </span>
    </span>
  );
}

/** RSS → queue, evergreen recycling and a tracked short link. */
function AutomationMockup({ t, locale, host }: { t: Translator; locale: string; host: string }) {
  const maxClicks = Math.max(...CLICKS);
  return (
    <div role="img" aria-label={t("home.auto.mockLabel")} className="relative mx-auto w-full max-w-[560px] select-none">
      <div aria-hidden className="absolute -inset-6 -z-10 rounded-[3rem] bg-gradient-to-br from-orange-300/20 via-primary/20 to-transparent blur-3xl" />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="min-w-0">
          <Card
            icon={<Rss className="size-4" />}
            tile="bg-orange-500"
            title={t("home.auto.rssTitle")}
            meta={<span className="shrink-0 rounded-full bg-emerald-500/12 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-400">{t("home.auto.active")}</span>}
          >
            <bdi dir="ltr" className="block truncate rounded-lg bg-paper px-2.5 py-1.5 text-start font-mono text-[11px]">
              {EXAMPLE_BRAND.domain}/blog/feed.xml
            </bdi>
            <span className="mt-2 block text-[11px] text-muted">{t("home.auto.rssEvery", { n: num(30, locale) })}</span>
          </Card>
          <Connector />
          <Card icon={<span className="text-[11px] font-bold">+1</span>} tile="bg-primary" title={t("home.auto.rssNew")}>
            <span dir="auto" className="block text-[12px] leading-snug font-medium">
              {t("home.auto.rssItem")}
            </span>
            <span className="mt-2.5 flex items-center gap-2 rounded-lg bg-primary-soft px-2.5 py-1.5 text-[11px]">
              <PlatformStack platforms={["linkedin", "facebook", "bluesky"]} />
              <span className="min-w-0 flex-1 truncate font-medium text-primary-text">{t("home.auto.queued")}</span>
              <bdi className="shrink-0 font-semibold tabular-nums">
                {weekdayName(4, locale)} {clock(11, 30, locale)}
              </bdi>
            </span>
          </Card>
        </div>

        <div className="min-w-0 space-y-4 sm:pt-10">
          <Card
            icon={<Recycle className="size-4" />}
            tile="bg-emerald-600"
            title={t("home.auto.recycleTitle")}
            meta={<MockLabel className="shrink-0">{t("home.auto.recycleEvery", { n: num(30, locale) })}</MockLabel>}
          >
            <span dir="auto" className="block text-[12px] leading-snug font-medium">
              {t("home.auto.recyclePost")}
            </span>
            <span className="mt-2.5 flex items-center gap-1">
              {[1, 2, 3].map((i) => (
                <span key={i} className={cn("h-1.5 flex-1 rounded-full", i <= 2 ? "bg-emerald-500" : "bg-line")} />
              ))}
            </span>
            <span className="mt-1.5 flex items-center justify-between gap-2 text-[10px] text-muted">
              <span>{t("home.auto.recycleCount", { n: num(2, locale), max: num(3, locale) })}</span>
              <bdi>
                {t("home.auto.next")} {weekdayName(2, locale)} {clock(12, 0, locale)}
              </bdi>
            </span>
            <span className="mt-2 block rounded-lg bg-paper px-2.5 py-1.5 text-[10px] text-muted">{t("home.auto.recycleX")}</span>
          </Card>

          <Card icon={<Link2 className="size-4" />} tile="bg-sky-600" title={t("home.auto.linkTitle")}>
            <bdi dir="ltr" className="block truncate text-start font-mono text-[11px] font-semibold text-primary-text">
              {host}/l/fq7Kp2
            </bdi>
            <bdi dir="ltr" className="mt-0.5 block truncate text-start font-mono text-[10px] text-muted">
              {EXAMPLE_BRAND.domain}/blog/starter?utm_source=linkedin&amp;utm_medium=social
            </bdi>
            <span className="mt-2.5 flex items-end gap-[3px]">
              {CLICKS.map((c, i) => (
                <span key={i} className={cn("flex-1 rounded-t-[2px]", i === CLICKS.length - 1 ? "bg-primary" : "bg-primary/30")} style={{ height: `${Math.round((c / maxClicks) * 34) + 4}px` }} />
              ))}
            </span>
            <span className="mt-2 flex items-center gap-1.5 text-[11px]">
              <MousePointerClick className="size-3.5 text-primary-text" />
              <span className="font-semibold">{t("home.auto.clicks", { n: num(362, locale) })}</span>
              <span className="text-muted">· {t("home.auto.noPersonal")}</span>
            </span>
          </Card>
        </div>
      </div>
    </div>
  );
}

export function AutomationShowcase({ t, locale, host }: { t: Translator; locale: string; host: string }) {
  return (
    <Showcase
      id="automation"
      reverse
      eyebrow={t("home.auto.eyebrow")}
      title={t("home.auto.title")}
      text={t("home.auto.text")}
      points={[t("home.auto.point1"), t("home.auto.point2"), t("home.auto.point3"), t("home.auto.point4")]}
      visual={<AutomationMockup t={t} locale={locale} host={host} />}
    />
  );
}
