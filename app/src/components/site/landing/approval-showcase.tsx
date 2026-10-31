import { ArrowRight, CheckCircle2, Clock3, Lock, MessageSquare, Undo2 } from "lucide-react";
import { PlatformIcon } from "@/components/social/platform-icon";
import type { Translator } from "@/lib/i18n/messages";
import { clock, EXAMPLE_AGENCY, EXAMPLE_BRAND, num, weekdayName } from "./format";
import { LoafArt, Tagged } from "./hero-mockup";
import { Avatar, WindowFrame } from "./mock-kit";
import { Showcase } from "./showcase";

/** The client approval page (/approve/<token>): branded, no login, approve or send back with a comment. */
function ApprovalMockup({ t, locale, host }: { t: Translator; locale: string; host: string }) {
  return (
    <div role="img" aria-label={t("home.appr.mockLabel")} className="relative mx-auto w-full max-w-[560px] select-none">
      <div aria-hidden className="absolute -inset-6 -z-10 rounded-[3rem] bg-gradient-to-tr from-amber-300/25 via-primary/20 to-transparent blur-3xl" />
      <WindowFrame
        title={
          <bdi dir="ltr" className="font-mono text-[12px] font-medium">
            {host}/approve/k3Pq…
          </bdi>
        }
        extra={
          <span className="inline-flex items-center gap-1 rounded-full border border-line bg-surface px-2 py-0.5 text-[10px] font-semibold text-muted">
            <Lock className="size-3" />
            {t("home.appr.protected")}
          </span>
        }
      >
        {/* Client branding */}
        <div className="flex items-center gap-2.5 border-b border-line bg-[#0f172a] px-4 py-3 text-white">
          <span className="grid size-7 place-items-center rounded-lg bg-gradient-to-br from-teal-300 to-emerald-500 font-display text-xs font-bold text-[#0f172a]">{EXAMPLE_AGENCY.initial}</span>
          <bdi className="text-sm font-semibold">{EXAMPLE_AGENCY.name}</bdi>
          <span className="ms-auto text-[10px] text-white/60">{t("home.appr.noLogin")}</span>
        </div>

        <div className="space-y-3 bg-paper/60 p-3 sm:p-4">
          <div>
            <p className="text-base font-bold">{t("home.appr.heading")}</p>
            <p className="text-[11px] text-muted">{t("home.appr.intro", { n: num(2, locale), workspace: EXAMPLE_AGENCY.name })}</p>
          </div>

          <div className="overflow-hidden rounded-xl border border-line bg-surface">
            <div className="p-3">
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                <Clock3 className="size-3" />
                {t("home.appr.waiting")}
              </span>
              <div className="mt-2.5 flex items-center gap-2">
                <Avatar initial={EXAMPLE_BRAND.initial} platform="linkedin" className="size-7 text-[11px]" />
                <span className="min-w-0 flex-1">
                  <bdi className="block truncate text-[12px] font-semibold">{EXAMPLE_BRAND.name}</bdi>
                  <span className="block text-[10px] text-muted">
                    <bdi>
                      {weekdayName(4, locale, "long")} {clock(11, 30, locale)}
                    </bdi>
                  </span>
                </span>
              </div>
              <p className="mt-2 text-[12px] leading-relaxed">
                <Tagged text={t("home.appr.postText")} />
              </p>
              <div className="mt-2 grid grid-cols-[1.4fr_1fr] gap-1 overflow-hidden rounded-lg">
                <LoafArt className="h-24" />
                <span className="h-24 bg-gradient-to-br from-stone-200 via-amber-200 to-amber-400 dark:from-stone-500 dark:via-amber-500 dark:to-amber-700" />
              </div>
              <div className="mt-3 flex gap-2 border-t border-line pt-3">
                <span className="grid size-6 shrink-0 place-items-center rounded-full bg-sky-500 text-[10px] font-bold text-white">M</span>
                <span className="min-w-0 flex-1 rounded-lg rounded-ss-sm bg-paper px-2.5 py-1.5">
                  <span className="block text-[10px] text-muted">
                    <bdi className="font-semibold text-ink">{t("home.appr.clientName")}</bdi> · {t("home.appr.client")}
                  </span>
                  <span className="block text-[11px] leading-snug">{t("home.appr.comment")}</span>
                </span>
              </div>
            </div>
            <div className="space-y-2 border-t border-line bg-paper/60 p-3">
              <span className="flex gap-2">
                <span className="w-28 shrink-0 truncate rounded-md border border-line bg-surface px-2 py-1.5 text-[11px]">
                  <bdi>{t("home.appr.clientName")}</bdi>
                </span>
                <span className="min-w-0 flex-1 truncate rounded-md border border-line bg-surface px-2 py-1.5 text-[11px] text-muted">{t("home.appr.commentHint")}</span>
              </span>
              <span className="flex gap-2">
                <span className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-[12px] font-semibold text-white shadow-sm shadow-emerald-600/30">
                  <CheckCircle2 className="size-3.5" />
                  {t("home.appr.approve")}
                </span>
                <span className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-2 text-[12px] font-semibold">
                  <Undo2 className="size-3.5" />
                  {t("home.appr.reject")}
                </span>
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2.5">
            <PlatformIcon platform="instagram" className="size-5 rounded-[25%] dark:outline dark:outline-white/20" />
            <span dir="auto" className="min-w-0 flex-1 truncate text-[11px]">
              {t("home.cal.post7")}
            </span>
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
              <CheckCircle2 className="size-3" />
              {t("home.appr.approvedScheduled")}
            </span>
          </div>
        </div>
      </WindowFrame>

      {/* What the team sees in Slack, Teams or email. */}
      <div
        aria-hidden
        className="absolute -end-6 -bottom-16 z-10 hidden w-[260px] animate-[qz-toast_0.7s_cubic-bezier(0.2,0.9,0.3,1.2)_0.6s_both] items-start gap-2.5 rounded-xl border border-line bg-surface/95 p-3 shadow-[0_18px_40px_-16px_rgba(30,27,75,0.35)] backdrop-blur motion-reduce:animate-none sm:flex xl:-end-14 dark:shadow-[0_18px_40px_-12px_rgba(0,0,0,0.8)]"
      >
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary text-white">
          <MessageSquare className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[12px] leading-snug font-semibold">{t("home.appr.toastTitle")}</span>
          <span className="mt-0.5 block text-[11px] leading-snug text-muted">{t("home.appr.toastText", { name: t("home.appr.clientName") })}</span>
        </span>
      </div>
    </div>
  );
}

/** `demoHref`: a live client approval page to open (the seeded demo's showcase link), when there is one. */
export function ApprovalShowcase({ t, locale, host, demoHref }: { t: Translator; locale: string; host: string; demoHref?: string }) {
  return (
    <Showcase
      id="approvals"
      reverse
      eyebrow={t("home.appr.eyebrow")}
      title={t("home.appr.title")}
      text={t("home.appr.text")}
      points={[t("home.appr.point1"), t("home.appr.point2"), t("home.appr.point3"), t("home.appr.point4")]}
      visual={<ApprovalMockup t={t} locale={locale} host={host} />}
      footer={
        demoHref ? (
          <a href={demoHref} className="group mt-7 inline-flex items-center gap-1.5 font-semibold text-primary-text hover:underline">
            {t("home.appr.seeLive")}
            <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5 rtl:rotate-180 rtl:group-hover:-translate-x-0.5" aria-hidden />
          </a>
        ) : null
      }
    />
  );
}
