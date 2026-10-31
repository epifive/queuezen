import { ChartColumn, ShieldCheck } from "lucide-react";
import { PlatformIcon } from "@/components/social/platform-icon";
import type { MessageKey, Translator } from "@/lib/i18n/messages";
import { cn } from "@/lib/utils";
import { PLATFORM_CAPABILITIES } from "@/social/platforms";
import { platformShortName } from "@/social/format";
import type { Platform } from "@/social/types";
import { SectionHeading } from "./section-heading";

type Chip = "text" | "links" | "photos" | "carousels" | "video" | "reels" | "stories" | "threads" | "firstComment" | "linkCards" | "shorts" | "albums" | "files" | "cw" | "forum" | "gifs";

/**
 * What each network supports, matching the platform registry (src/social/platforms.ts): post
 * types, threads (threads.supported), first comment (firstComment !== "none") and analytics
 * (analytics.supported, read from the registry below).
 */
const NETWORKS: Array<{ platform: Platform; chips: Chip[] }> = [
  { platform: "facebook", chips: ["text", "links", "photos", "video", "reels", "stories", "firstComment"] },
  { platform: "instagram", chips: ["photos", "carousels", "reels", "stories", "firstComment"] },
  { platform: "threads", chips: ["text", "links", "carousels", "video", "threads", "firstComment"] },
  { platform: "x", chips: ["text", "photos", "gifs", "video", "threads", "firstComment"] },
  { platform: "linkedin", chips: ["text", "linkCards", "photos", "video", "firstComment"] },
  { platform: "youtube", chips: ["video", "shorts"] },
  { platform: "bluesky", chips: ["text", "linkCards", "photos", "video", "threads", "firstComment"] },
  { platform: "mastodon", chips: ["text", "photos", "video", "threads", "cw", "firstComment"] },
  { platform: "telegram", chips: ["text", "links", "albums", "video"] },
  { platform: "discord", chips: ["text", "files", "forum"] },
];

export function Networks({ t, site }: { t: Translator; site: string }) {
  return (
    <section id="networks" aria-labelledby="networks-title" className="scroll-mt-16 py-24 sm:py-28">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <div className="mat-grid relative overflow-hidden rounded-[2rem] border border-line px-3 py-16 sm:px-10 sm:py-20">
          <div aria-hidden className="pointer-events-none absolute inset-x-0 -top-40 mx-auto h-80 max-w-3xl rounded-full bg-primary/15 blur-[100px]" />
          <SectionHeading id="networks-title" align="center" eyebrow={t("home.net.eyebrow")} title={t("home.net.title")} text={t("home.net.text", { site })} className="relative" />

          <ul className="relative mt-14 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            {NETWORKS.map(({ platform, chips }) => {
              const caps = PLATFORM_CAPABILITIES[platform];
              return (
                <li key={platform} className="group flex flex-col rounded-2xl border border-line bg-surface p-4 shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary-line hover:shadow-md motion-reduce:hover:translate-y-0">
                  <span className="flex items-center gap-3">
                    <PlatformIcon platform={platform} className="size-9 rounded-xl dark:outline dark:outline-white/15" />
                    <span className="min-w-0">
                      <span className="block truncate font-display text-[15px] font-bold">{platformShortName(platform)}</span>
                      <span className="block truncate text-[11px] text-muted">{t(`home.net.${platform}Kind` as MessageKey)}</span>
                    </span>
                  </span>
                  <p className="mt-3 flex-1 text-[13px] leading-relaxed text-muted">{t(`home.net.${platform}Note` as MessageKey)}</p>
                  <ul className="mt-3 flex flex-wrap gap-1">
                    {chips.map((c) => (
                      <li key={c} className="rounded-md bg-paper px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-line ring-inset">
                        {t(`home.net.chip.${c}` as MessageKey)}
                      </li>
                    ))}
                  </ul>
                  <span
                    className={cn(
                      "mt-3 flex items-center gap-1.5 border-t border-line pt-2.5 text-[11px] font-medium",
                      caps.analytics.supported ? "text-emerald-700 dark:text-emerald-400" : "text-muted",
                    )}
                  >
                    <ChartColumn className="size-3.5" aria-hidden />
                    {caps.analytics.supported ? t("home.net.analytics") : t("home.net.noAnalytics")}
                  </span>
                </li>
              );
            })}
          </ul>

          <p className="relative mx-auto mt-10 flex max-w-2xl items-start justify-center gap-2 text-center text-sm text-muted">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary-text" aria-hidden />
            <span>{t("home.net.official")}</span>
          </p>
        </div>
      </div>
    </section>
  );
}
