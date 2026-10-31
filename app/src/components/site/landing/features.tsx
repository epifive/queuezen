import {
  Braces,
  Building2,
  CalendarDays,
  ChartColumn,
  CreditCard,
  FileSpreadsheet,
  Images,
  Languages,
  LayoutDashboard,
  Link2,
  ListOrdered,
  Recycle,
  ShieldCheck,
  Sparkles,
  SquarePen,
  Users,
} from "lucide-react";
import type { MessageKey, Translator } from "@/lib/i18n/messages";
import { cn } from "@/lib/utils";
import { SectionHeading } from "./section-heading";

const FEATURES: Array<{ icon: typeof CalendarDays; key: string; accent?: string }> = [
  { icon: SquarePen, key: "composer" },
  { icon: ListOrdered, key: "threads", accent: "bg-sky-500/12 text-sky-700 dark:text-sky-300" },
  { icon: CalendarDays, key: "calendar" },
  { icon: FileSpreadsheet, key: "csv", accent: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-400" },
  { icon: ShieldCheck, key: "approvals", accent: "bg-amber-500/12 text-amber-700 dark:text-amber-300" },
  { icon: Users, key: "team" },
  { icon: Recycle, key: "automation", accent: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-400" },
  { icon: Link2, key: "links" },
  { icon: ChartColumn, key: "analytics", accent: "bg-violet-500/12 text-violet-700 dark:text-violet-300" },
  { icon: Sparkles, key: "ai", accent: "bg-fuchsia-500/12 text-fuchsia-700 dark:text-fuchsia-300" },
  { icon: Images, key: "media" },
  { icon: Braces, key: "api", accent: "bg-slate-500/12 text-slate-700 dark:text-slate-300" },
];

export function Features({ t }: { t: Translator }) {
  const saas: Array<[typeof CalendarDays, string]> = [
    [Building2, t("home.saas.brand")],
    [CreditCard, t("home.saas.payments")],
    [LayoutDashboard, t("home.saas.admin")],
    [Languages, t("home.saas.lang")],
  ];
  return (
    <section id="features" aria-labelledby="features-title" className="scroll-mt-16 py-24 sm:py-28">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <SectionHeading id="features-title" eyebrow={t("home.featuresEyebrow")} title={t("home.featuresTitle")} text={t("home.featuresText")} />
        <ul className="mt-14 grid grid-cols-1 gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map((f) => (
            <li key={f.key} className="group relative bg-surface p-6 transition-colors hover:bg-paper/60 sm:p-7">
              <span
                className={cn(
                  "grid size-11 place-items-center rounded-xl ring-1 ring-current/10 transition-transform ring-inset group-hover:-translate-y-0.5 motion-reduce:group-hover:translate-y-0",
                  f.accent ?? "bg-primary-soft text-primary-text",
                )}
              >
                <f.icon className="size-5" aria-hidden />
              </span>
              <h3 className="mt-5 text-[17px] font-bold tall-script:leading-snug">{t(`home.f.${f.key}Title` as MessageKey)}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">{t(`home.f.${f.key}Text` as MessageKey)}</p>
            </li>
          ))}
        </ul>

        {/* Built to resell: the SaaS side of the product. */}
        <div className="relative mt-6 overflow-hidden rounded-2xl bg-[#1e1b4b] px-6 py-7 text-white sm:px-8 dark:bg-[#17153a]">
          <div aria-hidden className="absolute -end-20 -top-24 size-72 rounded-full bg-primary/60 blur-[90px]" />
          <div aria-hidden className="absolute -start-10 -bottom-28 size-60 rounded-full bg-violet-500/30 blur-[90px]" />
          <div className="relative grid grid-cols-1 items-center gap-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.6fr)]">
            <div>
              <h3 className="text-xl font-bold tall-script:leading-snug">{t("home.saas.title")}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-white/70">{t("home.saas.text")}</p>
            </div>
            <ul className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              {saas.map(([Icon, label]) => (
                <li key={label} className="flex items-center gap-3 rounded-xl bg-white/[0.06] px-3.5 py-2.5 text-sm font-medium ring-1 ring-white/10 ring-inset">
                  <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-white/10 text-indigo-200">
                    <Icon className="size-4" aria-hidden />
                  </span>
                  {label}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}
