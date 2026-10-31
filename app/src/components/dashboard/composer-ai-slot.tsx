"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Check, ClipboardCopy, Loader2, MessageCircle, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/field";
import { useT } from "@/lib/i18n/client";
import type { MessageKey } from "@/lib/i18n/messages";
import { cn } from "@/lib/utils";
import { platformName } from "@/social/format";
import type { Platform } from "@/social/types";

/**
 * AI assist of the composer. The composer renders it in the editor toolbar of every tab.
 * Contract:
 * - render a button / popover; return null when AI is off for this workspace (`enabled` false)
 * - read the active tab's text, write back with `onApply` (replace) or `onInsert` (at the cursor);
 *   first comment ideas go to `onFirstComment` (absent when no selected network has a first comment)
 * - `platform` is the active channel tab's network (null on the "All channels" tab); `platforms`
 *   lists the networks of every selected channel
 * - self-contained: calls POST /api/ai; the composer passes no secrets
 */
export interface ComposerAiSlotProps {
  workspaceId: number;
  /** The plan allows AI and the operator configured a provider (decided on the server). */
  enabled: boolean;
  /** Text of the active tab (the base text or the channel's override). */
  text: string;
  platform: Platform | null;
  platforms: Platform[];
  /** Replace the active tab's text. */
  onApply: (text: string) => void;
  /** Insert at the cursor of the active tab's text (e.g. hashtags). */
  onInsert: (text: string) => void;
  /** Fill the active tab's first comment field (undefined: no first comment on these networks). */
  onFirstComment?: (text: string) => void;
  locale: string;
}

const ACTIONS = ["rewrite", "shorten", "hashtags", "translate", "generate", "first_comment"] as const;
type Action = (typeof ACTIONS)[number];
const TONES = ["neutral", "friendly", "professional", "witty", "bold", "casual", "inspiring"] as const;
const LANGUAGES = ["English", "Spanish", "Portuguese", "French", "German", "Italian", "Dutch", "Polish", "Turkish", "Russian", "Ukrainian", "Arabic", "Hebrew", "Persian", "Hindi", "Bengali", "Urdu", "Indonesian", "Malay", "Vietnamese", "Thai", "Japanese", "Korean", "Chinese (Simplified)", "Chinese (Traditional)"];

export function ComposerAiSlot({ workspaceId, enabled, text, platform, platforms, onApply, onInsert, onFirstComment }: ComposerAiSlotProps) {
  const t = useT();
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState<Action>("rewrite");
  const [tone, setTone] = useState<(typeof TONES)[number]>("neutral");
  const [language, setLanguage] = useState("English");
  const [topic, setTopic] = useState("");
  // The network picked in the panel applies to the tab it was picked on; other tabs start with their own.
  const [choice, setChoice] = useState<{ tab: Platform | null; value: Platform | "" } | null>(null);
  const target = choice && choice.tab === platform ? choice.value : (platform ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [results, setResults] = useState<string[]>([]);
  const [usage, setUsage] = useState<{ used: number; limit: number } | null>(null);
  const [copied, setCopied] = useState(-1);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!enabled) return null;
  const networks = [...new Set([...(platform ? [platform] : []), ...platforms])];

  async function run() {
    setBusy(true);
    setError("");
    setResults([]);
    try {
      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wid: workspaceId, action, text, platform: target || null, tone, language, topic }),
      });
      const body = (await res.json().catch(() => ({}))) as { results?: string[]; error?: string; usage?: { used: number; limit: number } };
      if (body.usage) setUsage(body.usage);
      if (!res.ok || !body.results?.length) setError(body.error || t("ai.err.generic"));
      else setResults(body.results);
    } catch {
      setError(t("ai.err.network"));
    } finally {
      setBusy(false);
    }
  }

  const needsText = action !== "generate";
  const disabled = busy || (needsText && !text.trim()) || (action === "generate" && !topic.trim() && !text.trim());

  return (
    <div ref={box} className="relative inline-block">
      <Button type="button" variant="secondary" size="sm" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-controls={`${uid}-panel`}>
        <Sparkles aria-hidden />
        {t("ai.button")}
      </Button>
      {open ? (
        <div id={`${uid}-panel`} role="dialog" aria-label={t("ai.title")} className="absolute end-0 top-full z-40 mt-2 w-[min(24rem,calc(100vw-2rem))] rounded-xl border border-line bg-surface p-4 text-start shadow-xl">
          <div className="mb-3 flex items-center justify-between gap-2">
            <p className="flex items-center gap-1.5 text-sm font-semibold">
              <Sparkles className="size-4 text-primary" aria-hidden />
              {t("ai.title")}
            </p>
            <button type="button" onClick={() => setOpen(false)} aria-label={t("ai.close")} className="rounded p-1 text-muted hover:text-ink">
              <X className="size-4" aria-hidden />
            </button>
          </div>
          <div role="tablist" aria-label={t("ai.title")} className="flex flex-wrap gap-1">
            {ACTIONS.map((a) => (
              <button
                key={a}
                type="button"
                role="tab"
                aria-selected={a === action}
                onClick={() => {
                  setAction(a);
                  setResults([]);
                  setError("");
                }}
                className={cn("rounded-md px-2.5 py-1 text-xs font-medium", a === action ? "bg-primary text-white" : "bg-paper text-muted hover:text-ink")}
              >
                {t(`ai.action.${a}` as MessageKey)}
              </button>
            ))}
          </div>
          <div className="mt-3 space-y-2.5">
            <p className="text-xs text-muted">{t(`ai.help.${action}` as MessageKey)}</p>
            {action !== "translate" && networks.length ? (
              <label className="flex items-center gap-2 text-xs">
                <span className="w-20 shrink-0 text-muted">{t("ai.network")}</span>
                <Select value={target} onChange={(e) => setChoice({ tab: platform, value: e.target.value as Platform | "" })} className="h-8 py-0 text-xs">
                  <option value="">{t("ai.anyNetwork")}</option>
                  {networks.map((p) => (
                    <option key={p} value={p}>
                      {platformName(p)}
                    </option>
                  ))}
                </Select>
              </label>
            ) : null}
            {action === "rewrite" || action === "generate" ? (
              <label className="flex items-center gap-2 text-xs">
                <span className="w-20 shrink-0 text-muted">{t("ai.tone")}</span>
                <Select value={tone} onChange={(e) => setTone(e.target.value as (typeof TONES)[number])} className="h-8 py-0 text-xs">
                  {TONES.map((v) => (
                    <option key={v} value={v}>
                      {t(`ai.tone.${v}` as MessageKey)}
                    </option>
                  ))}
                </Select>
              </label>
            ) : null}
            {action === "translate" ? (
              <label className="flex items-center gap-2 text-xs">
                <span className="w-20 shrink-0 text-muted">{t("ai.language")}</span>
                <Select value={language} onChange={(e) => setLanguage(e.target.value)} className="h-8 py-0 text-xs">
                  {LANGUAGES.map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </Select>
              </label>
            ) : null}
            {action === "generate" ? <Input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder={t("ai.topicPlaceholder")} aria-label={t("ai.topic")} dir="auto" className="h-9 text-sm" maxLength={1000} /> : null}
            {needsText && !text.trim() ? <p className="text-xs text-amber-700 dark:text-amber-400">{t("ai.needText")}</p> : null}
            <Button type="button" size="sm" onClick={run} disabled={disabled} aria-busy={busy} className="w-full">
              {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Sparkles aria-hidden />}
              {busy ? t("ai.working") : t("ai.run")}
            </Button>
          </div>
          {error ? (
            <p role="alert" className="mt-3 text-xs text-red-600 dark:text-red-400">
              {error}
            </p>
          ) : null}
          {results.length ? (
            <ul className="mt-3 max-h-72 space-y-2 overflow-y-auto" aria-live="polite">
              {results.map((r, i) => (
                <li key={i} className="rounded-lg border border-line bg-paper p-2.5">
                  <p dir="auto" className="text-sm break-words whitespace-pre-wrap">
                    {r}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {action === "hashtags" ? (
                      <Button type="button" size="sm" variant="outline" onClick={() => onInsert(` ${r}`)}>
                        {t("ai.insert")}
                      </Button>
                    ) : action === "first_comment" ? (
                      onFirstComment ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="primary"
                          onClick={() => {
                            onFirstComment(r);
                            setOpen(false);
                          }}
                        >
                          <MessageCircle aria-hidden />
                          {t("ai.useFirstComment")}
                        </Button>
                      ) : null
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        variant="primary"
                        onClick={() => {
                          onApply(r);
                          setOpen(false);
                        }}
                      >
                        <Check aria-hidden />
                        {t("ai.apply")}
                      </Button>
                    )}
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(r);
                          setCopied(i);
                          setTimeout(() => setCopied(-1), 1500);
                        } catch {
                          // Clipboard blocked: the text can still be selected.
                        }
                      }}
                    >
                      <ClipboardCopy aria-hidden />
                      {copied === i ? t("ui.copied") : t("ui.copy")}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
          {usage ? <p className="mt-3 text-[11px] text-muted">{usage.limit > 0 ? t("ai.usage", { used: usage.used, limit: usage.limit }) : t("ai.usageUnlimited", { used: usage.used })}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
