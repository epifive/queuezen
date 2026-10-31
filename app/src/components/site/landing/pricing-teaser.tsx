import Link from "next/link";
import { ArrowRight, Check, Minus } from "lucide-react";
import type { Translator } from "@/lib/i18n/messages";
import { cn, formatMoney } from "@/lib/utils";
import { formatLimit } from "@/social/format";
import { SectionHeading } from "./section-heading";

export interface TeaserPlan {
  id: number;
  name: string;
  description: string | null;
  /** Minor units. */
  priceMonthly: number;
  isFree: boolean;
  isFeatured: boolean;
  /** 0 = unlimited. */
  maxChannels: number;
  /** 0 = unlimited. */
  maxScheduledMonthly: number;
  /** 0 = unlimited. */
  maxMembers: number;
  /** 0 = none, -1 = unlimited. */
  maxXPostsMonthly: number;
  allowWhiteLabel: boolean;
  allowAi: boolean;
}

/** A compact overview of the active plans; the full comparison lives on /pricing. */
export function PricingTeaser({ t, plans, currency, locale }: { t: Translator; plans: TeaserPlan[]; currency: string; locale: string }) {
  const shown = plans.slice(0, 3);
  if (!shown.length) return null;
  return (
    <section aria-labelledby="pricing-title" className="border-y border-line bg-surface py-24 sm:py-28">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-6">
          <SectionHeading id="pricing-title" eyebrow={t("home.pricingEyebrow")} title={t("home.pricingTitle")} text={t("home.pricingText")} />
          <Link href="/pricing" className="group inline-flex items-center gap-1.5 font-semibold text-primary-text hover:underline">
            {t("home.pricingAll")}
            <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5 rtl:rotate-180 rtl:group-hover:-translate-x-0.5" aria-hidden />
          </Link>
        </div>

        <ul className={cn("mt-12 grid grid-cols-1 gap-5", shown.length >= 3 ? "md:grid-cols-3" : shown.length === 2 ? "md:grid-cols-2" : "max-w-md")}>
          {shown.map((plan) => {
            const x = plan.maxXPostsMonthly > 0 ? formatLimit(plan.maxXPostsMonthly, t, locale) : plan.maxXPostsMonthly < 0 ? t("pricing.unlimited") : null;
            return (
              <li key={plan.id}>
                <Link
                  href="/pricing"
                  className={cn(
                    "relative flex h-full flex-col rounded-2xl border bg-paper p-6 transition-all hover:-translate-y-0.5 motion-reduce:hover:translate-y-0",
                    plan.isFeatured ? "border-primary shadow-[0_24px_48px_-28px_var(--primary)]" : "border-line hover:border-primary-line",
                  )}
                >
                  {plan.isFeatured ? <span className="absolute -top-3 start-6 rounded-md bg-primary px-2.5 py-1 text-xs font-semibold text-white">{t("pricing.recommended")}</span> : null}
                  <span dir="auto" className="text-lg font-bold">
                    {plan.name}
                  </span>
                  <span className="mt-4 flex items-baseline gap-2">
                    <bdi className="font-display text-4xl font-bold tracking-tight">{formatMoney(plan.isFree ? 0 : plan.priceMonthly, currency, locale)}</bdi>
                    <span className="text-sm text-muted">{plan.isFree ? t("pricing.forever") : t("pricing.perMonth")}</span>
                  </span>
                  {plan.description ? (
                    <span dir="auto" className="mt-2 text-sm text-muted">
                      {plan.description}
                    </span>
                  ) : null}
                  <span className="mt-6 block space-y-2.5 border-t border-line pt-5 text-sm">
                    {(
                      [
                        [t("pricing.channels"), formatLimit(plan.maxChannels, t, locale)],
                        [t("pricing.posts"), formatLimit(plan.maxScheduledMonthly, t, locale)],
                        [t("pricing.members"), formatLimit(plan.maxMembers, t, locale)],
                      ] as const
                    ).map(([label, value]) => (
                      <span key={label} className="flex items-baseline justify-between gap-3">
                        <span className="text-muted">{label}</span>
                        <bdi className="font-semibold tabular-nums">{value}</bdi>
                      </span>
                    ))}
                  </span>
                  <span className="mt-4 block space-y-2 text-sm">
                    {(
                      [
                        [x !== null, x !== null ? t("home.pricingX", { n: x }) : t("home.pricingNoX")],
                        [plan.allowWhiteLabel, t("home.pricingApprovals")],
                        [plan.allowAi, t("home.pricingAi")],
                      ] as const
                    ).map(([on, label]) => (
                      <span key={label} className={cn("flex items-start gap-2", !on && "text-muted")}>
                        {on ? <Check className="mt-0.5 size-4 shrink-0 text-primary-text" aria-label={t("pricing.included")} /> : <Minus className="mt-0.5 size-4 shrink-0" aria-label={t("pricing.notIncluded")} />}
                        <bdi>{label}</bdi>
                      </span>
                    ))}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
