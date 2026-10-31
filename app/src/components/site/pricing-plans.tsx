"use client";

import { useState, type ReactNode } from "react";
import { Check, Minus } from "lucide-react";
import { Segmented } from "@/components/ui/segmented";
import { ButtonLink } from "@/components/ui/button";
import { useT } from "@/lib/i18n/client";
import { cn, formatMoney } from "@/lib/utils";
import { formatLimit } from "@/social/format";

/** Feature texts about the "Powered by" branding (older plan seeds listed it as a feature too). */
const BRANDING_FEATURE = /powered by|(?:remove|no|without)\s+(?:the\s+)?branding/i;
/** Feature texts that only restate a limit the card already shows ("15 social channels", "500 scheduled posts per month", "3 team members", "100 posts to X per month"). */
const LIMIT_FEATURE = /^(?:[\d.,\s]+|unlimited)\s+(?:(?:social\s+)?(?:channels?|accounts?|profiles?)|(?:scheduled\s+)?posts?\s+(?:per|a)\s+month|(?:team\s+)?(?:members?|seats?|users?)|posts?\s+to\s+x(?:\s+(?:per|a)\s+month)?)$/i;

export interface PricingPlan {
  id: number;
  name: string;
  description: string | null;
  priceMonthly: number;
  priceYearly: number;
  features: string[];
  /** 0 = unlimited. */
  maxChannels: number;
  maxScheduledMonthly: number;
  maxMembers: number;
  /** 0 = no X, -1 = unlimited. */
  maxXPostsMonthly: number;
  removeBranding: boolean;
  isFree: boolean;
  isFeatured: boolean;
}

export function PricingPlans({
  plans,
  currency,
  currentPlanId,
  signedIn,
  locale,
}: {
  plans: PricingPlan[];
  currency: string;
  currentPlanId: number | null;
  signedIn: boolean;
  /** The page's language, so numbers render the same on the server and in the browser. */
  locale: string;
}) {
  const t = useT();
  const hasYearly = plans.some((p) => !p.isFree && p.priceYearly > 0);
  const [cycle, setCycle] = useState<"monthly" | "yearly">("monthly");
  const bestSaving = Math.max(
    0,
    ...plans.filter((p) => p.priceMonthly > 0 && p.priceYearly > 0).map((p) => 1 - p.priceYearly / (p.priceMonthly * 12)),
  );

  return (
    <div>
      {hasYearly ? (
        <div className="flex justify-center">
          <Segmented
            label={t("pricing.billingPeriod")}
            value={cycle}
            onChange={setCycle}
            options={[
              { value: "monthly", label: t("pricing.monthly") },
              {
                value: "yearly",
                label: (
                  <>
                    {t("pricing.yearly")}
                    {bestSaving > 0.01 ? (
                      <span className="ms-1.5 rounded bg-marker px-1.5 py-0.5 text-[11px] font-semibold text-[#3d2e00]">
                        {t("pricing.save", { percent: Math.round(bestSaving * 100) })}
                      </span>
                    ) : null}
                  </>
                ),
              },
            ]}
          />
        </div>
      ) : null}

      <ul
        className={cn(
          "mx-auto mt-10 grid gap-5",
          plans.length === 1 ? "max-w-md" : plans.length === 2 ? "max-w-4xl md:grid-cols-2" : "max-w-6xl md:grid-cols-2 lg:grid-cols-3",
        )}
      >
        {plans.map((plan) => {
          const price = plan.isFree ? 0 : cycle === "yearly" && plan.priceYearly > 0 ? plan.priceYearly : plan.priceMonthly;
          const period = plan.isFree
            ? t("pricing.forever")
            : cycle === "yearly" && plan.priceYearly > 0
              ? t("pricing.perYear")
              : t("pricing.perMonth");
          const effectiveCycle = cycle === "yearly" && plan.priceYearly > 0 ? "yearly" : "monthly";
          const isCurrent = currentPlanId === plan.id;
          return (
            <li
              key={plan.id}
              className={cn(
                "relative flex flex-col rounded-2xl border bg-surface p-7",
                plan.isFeatured ? "border-primary shadow-[0_24px_48px_-28px_var(--primary)]" : "border-line",
              )}
            >
              {plan.isFeatured ? (
                <span className="absolute -top-3 start-7 rounded-md bg-primary px-2.5 py-1 text-xs font-semibold text-white">
                  {t("pricing.recommended")}
                </span>
              ) : null}
              <h2 className="text-xl font-bold">{plan.name}</h2>
              {/* Room for two lines, so the prices line up when one description wraps. */}
              {plan.description || plans.length > 1 ? (
                <p className={cn("mt-1 text-sm text-muted", plans.length > 1 && "md:min-h-10")}>
                  <bdi>{plan.description}</bdi>
                </p>
              ) : null}
              <p className="mt-6 flex items-baseline gap-2">
                <span className="font-display text-5xl font-bold tracking-tight">{formatMoney(price, currency)}</span>
                <span className="text-sm text-muted">{period}</span>
              </p>
              {!plan.isFree && effectiveCycle === "yearly" ? (
                <p className="mt-1 text-sm text-muted">
                  {t("pricing.billedYearly", { price: formatMoney(Math.round(plan.priceYearly / 12), currency) })}
                </p>
              ) : null}

              <dl className="mt-6 grid grid-cols-3 gap-3 rounded-xl bg-paper p-4 text-sm">
                {(
                  [
                    ["pricing.channels", formatLimit(plan.maxChannels, t, locale)],
                    ["pricing.posts", formatLimit(plan.maxScheduledMonthly, t, locale)],
                    ["pricing.members", formatLimit(plan.maxMembers, t, locale)],
                  ] as const
                ).map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-xs text-muted">{t(label)}</dt>
                    <dd className="font-semibold">{value}</dd>
                  </div>
                ))}
              </dl>

              <ul className="mt-6 flex-1 space-y-2.5 text-sm">
                {/* Admin-written texts; skip lines that repeat the limits above or the X / branding lines below (they come from the plan's settings). */}
                {plan.features
                  .filter((f) => !BRANDING_FEATURE.test(f) && !LIMIT_FEATURE.test(f))
                  .map((f) => (
                    <Feature key={f} included isolate>
                      {f}
                    </Feature>
                  ))}
                <Feature included={plan.maxXPostsMonthly !== 0}>
                  {plan.maxXPostsMonthly > 0 ? t("pricing.xPosts", { n: plan.maxXPostsMonthly.toLocaleString(locale) }) : plan.maxXPostsMonthly < 0 ? t("pricing.xUnlimited") : t("pricing.xNone")}
                </Feature>
                <Feature included={plan.removeBranding}>{t("pricing.removeBranding")}</Feature>
              </ul>

              <div className="mt-8">
                {isCurrent ? (
                  <p className="rounded-lg border border-line py-2.5 text-center text-sm font-medium text-muted">{t("pricing.current")}</p>
                ) : plan.isFree ? (
                  <ButtonLink href={signedIn ? "/dashboard" : "/register"} variant="outline" className="w-full" size="lg">
                    {signedIn ? t("pricing.useFree") : t("pricing.createFree")}
                  </ButtonLink>
                ) : (
                  <ButtonLink
                    href={`/checkout?plan=${plan.id}&cycle=${effectiveCycle}`}
                    variant={plan.isFeatured ? "primary" : "outline"}
                    className="w-full"
                    size="lg"
                  >
                    {t("pricing.get", { plan: plan.name })}
                  </ButtonLink>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Feature({ included, children, isolate = false }: { included: boolean; children: ReactNode; isolate?: boolean }) {
  const t = useT();
  return (
    <li className={cn("flex gap-2.5", !included && "text-muted")}>
      {included ? (
        <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-label={t("pricing.included")} />
      ) : (
        <Minus className="mt-0.5 size-4 shrink-0" aria-label={t("pricing.notIncluded")} />
      )}
      <span>{isolate ? <bdi>{children}</bdi> : children}</span>
    </li>
  );
}
