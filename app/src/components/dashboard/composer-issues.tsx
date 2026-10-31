"use client";

import { CircleAlert, TriangleAlert } from "lucide-react";
import { MESSAGES, type MessageKey, type Translator } from "@/lib/i18n/messages";
import { platformShortName } from "@/social/format";
import type { Platform, ValidationIssue } from "@/social/types";
import { cn } from "@/lib/utils";

/**
 * Translated validation messages: the composer, the CSV import report and the post page show
 * the codes of validatePostForChannel() (src/social/normalize.ts) as "dash.val.<code>" messages
 * with their numbers formatted (MB, seconds, ratios); unknown codes fall back to the English text.
 */

const MB = 1024 * 1024;

function fmtBytes(bytes: number, locale: string): string {
  return bytes >= 1024 * MB ? `${(bytes / (1024 * MB)).toLocaleString(locale, { maximumFractionDigits: 1 })} GB` : `${(bytes / MB).toLocaleString(locale, { maximumFractionDigits: 1 })} MB`;
}

function fmtSeconds(s: number, locale: string): string {
  if (s >= 3600) return `${(s / 3600).toLocaleString(locale, { maximumFractionDigits: 1 })} h`;
  if (s >= 120) return `${(s / 60).toLocaleString(locale, { maximumFractionDigits: 1 })} min`;
  return `${s.toLocaleString(locale, { maximumFractionDigits: 1 })} s`;
}

function fmtRatio(r: number): string {
  const known: Array<[number, string]> = [
    [4 / 5, "4:5"],
    [9 / 16, "9:16"],
    [1, "1:1"],
    [16 / 9, "16:9"],
    [1.91, "1.91:1"],
    [1 / 3, "1:3"],
    [3, "3:1"],
  ];
  const hit = known.find(([v]) => Math.abs(v - r) < 0.006);
  return hit ? hit[1] : `${Math.round(r * 100) / 100}:1`;
}

const BYTES = new Set(["media_too_large", "media_too_small"]);
const SECONDS = new Set(["media_too_short", "media_too_long"]);
const RATIOS = new Set(["media_ratio"]);

export function issueText(t: Translator, issue: Pick<ValidationIssue, "code" | "message" | "params">, platform: Platform | null, locale: string): string {
  const p = issue.params ?? {};
  const vars: Record<string, string | number> = { network: platform ? platformShortName(platform) : "" };
  for (const [k, v] of Object.entries(p)) {
    if (typeof v !== "number") vars[k] = v;
    else if (BYTES.has(issue.code) && k !== "count") vars[k] = fmtBytes(v, locale);
    else if (SECONDS.has(issue.code)) vars[k] = fmtSeconds(v, locale);
    else if (RATIOS.has(issue.code)) vars[k] = fmtRatio(v);
    else if (k === "cost") vars[k] = `$${v.toFixed(2)}`;
    else vars[k] = v.toLocaleString(locale);
  }
  let code = issue.code;
  if (code === "text_too_long" && p.part !== undefined) code = "text_too_long_part";
  if (code === "media_type" && p.mime === undefined) code = "media_type_here";
  if (code === "media_ratio") code = p.min !== undefined ? "media_ratio_tall" : p.max !== undefined ? "media_ratio_wide" : "media_ratio";
  const key = `dash.val.${code}`;
  if (key in MESSAGES) return t(key as MessageKey, vars);
  return issue.message ?? issue.code;
}

/** A list of errors and warnings, optionally per channel. */
export function IssueList({
  items,
  locale,
  t,
  onSelect,
  className,
}: {
  items: Array<{ issue: ValidationIssue; severity: "error" | "warning"; platform: Platform | null; channel?: string; channelId?: number }>;
  locale: string;
  t: Translator;
  onSelect?: (channelId: number | undefined, field: string | undefined) => void;
  className?: string;
}) {
  if (!items.length) return null;
  return (
    <ul className={cn("space-y-1.5 text-sm", className)}>
      {items.map((it, i) => {
        const Icon = it.severity === "error" ? CircleAlert : TriangleAlert;
        const body = (
          <>
            <Icon className={cn("mt-0.5 size-4 shrink-0", it.severity === "error" ? "text-red-600 dark:text-red-400" : "text-amber-600 dark:text-amber-400")} aria-hidden />
            <span className="min-w-0">
              {it.channel ? (
                <span className="font-medium">
                  <bdi>{it.channel}</bdi>:{" "}
                </span>
              ) : null}
              {issueText(t, it.issue, it.platform, locale)}
            </span>
          </>
        );
        return (
          <li key={`${it.channelId ?? "x"}-${it.issue.code}-${it.issue.field ?? ""}-${i}`}>
            {onSelect ? (
              <button type="button" onClick={() => onSelect(it.channelId, it.issue.field)} className="flex w-full gap-2 rounded-md px-1 py-0.5 text-start hover:bg-paper">
                {body}
              </button>
            ) : (
              <span className="flex gap-2">{body}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
