"use client";

import { useState, type ReactNode, type RefObject } from "react";
import { ArrowLeft, ArrowRight, ImagePlus, Link2, Plus, RotateCcw, Scissors, Tag, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox, Input, Select, Textarea } from "@/components/ui/field";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import { platformShortName } from "@/social/format";
import { getCapabilities } from "@/social/platforms";
import { buildUtmUrl, countChars, normalizePlatformOptions } from "@/social/normalize";
import { FB_POST_TYPES, IG_POST_TYPES, MASTODON_VISIBILITY, YOUTUBE_PRIVACY, type LinkMeta, type MediaInfo, type Platform, type PlatformOptions } from "@/social/types";
import { formatDuration } from "./media-library";

/** Building blocks of the composer form (text with counters, media strip, thread, link, options, labels). */

export function FieldShell({ label, children, action, overridden, onReset, hint }: { label: ReactNode; children: ReactNode; action?: ReactNode; overridden?: boolean; onReset?: () => void; hint?: ReactNode }) {
  const t = useT();
  return (
    <div>
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm font-medium">
          {label}
          {overridden ? <span className="rounded-full bg-primary-soft px-1.5 py-0.5 text-[10px] font-semibold text-primary">{t("dash.compose.custom")}</span> : null}
        </span>
        <span className="flex items-center gap-1">
          {overridden && onReset ? (
            <button type="button" onClick={onReset} className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted hover:text-ink">
              <RotateCcw className="size-3" aria-hidden />
              {t("dash.compose.reset")}
            </button>
          ) : null}
          {action}
        </span>
      </div>
      {children}
      {hint ? <p className="mt-1 text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

/** Character counter chip: used / limit as the network counts it. */
export function Counter({ platform, text, hasMedia, compact = false }: { platform: Platform; text: string; hasMedia: boolean; compact?: boolean }) {
  const caps = getCapabilities(platform).text;
  const used = countChars(text, platform);
  const limit = hasMedia && caps.maxWithMedia ? caps.maxWithMedia : caps.max;
  const over = used > caps.max;
  const warn = !over && used > limit;
  const near = !over && !warn && used > limit * 0.9;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums",
        over ? "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300" : warn || near ? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300" : "bg-line/70 text-muted",
      )}
      title={platformShortName(platform)}
    >
      {compact ? null : <span>{platformShortName(platform)}</span>}
      <bdi>
        {used.toLocaleString()}/{caps.max.toLocaleString()}
      </bdi>
    </span>
  );
}

export function TextArea({
  id,
  value,
  onChange,
  placeholder,
  rows = 6,
  textareaRef,
  invalid,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  invalid?: boolean;
}) {
  return (
    <Textarea
      id={id}
      ref={textareaRef}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      rows={rows}
      dir="auto"
      placeholder={placeholder}
      aria-invalid={invalid || undefined}
      className={cn("min-h-0 resize-y text-[15px]", invalid && "border-red-400 focus:border-red-500 focus:ring-red-500/20")}
    />
  );
}

/** The attached media in order, with reorder / remove, and the "add" tile. */
export function MediaStrip({ ids, media, onChange, onAdd, invalidIds }: { ids: number[]; media: Map<number, MediaInfo & { filename?: string }>; onChange: (ids: number[]) => void; onAdd: () => void; invalidIds: Set<number> }) {
  const t = useT();
  const move = (i: number, d: -1 | 1) => {
    const next = [...ids];
    const j = i + d;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  return (
    <ul className="flex flex-wrap gap-2">
      {ids.map((id, i) => {
        const m = media.get(id);
        return (
          <li key={id} className={cn("group relative size-24 overflow-hidden rounded-lg border bg-paper", invalidIds.has(id) ? "border-red-400 ring-2 ring-red-400/40" : "border-line")}>
            {m ? (
              m.kind === "video" ? (
                <video src={`${m.url}#t=0.1`} preload="metadata" muted playsInline className="size-full object-cover" />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={m.url} alt={m.altText} className="size-full object-cover" />
              )
            ) : (
              <span className="grid size-full place-items-center p-1 text-center text-[11px] text-red-600">{t("dash.compose.mediaMissing")}</span>
            )}
            {m?.kind === "video" && m.duration ? <span className="absolute start-1 bottom-1 rounded bg-black/70 px-1 text-[10px] text-white tabular-nums">{formatDuration(m.duration)}</span> : null}
            <span className="absolute inset-x-0 top-0 flex justify-between bg-gradient-to-b from-black/60 to-transparent p-1 opacity-100 sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100">
              <span className="flex gap-0.5">
                <button type="button" onClick={() => move(i, -1)} disabled={i === 0} className="grid size-6 place-items-center rounded bg-black/50 text-white disabled:opacity-30" aria-label={t("dash.compose.moveEarlier")}>
                  <ArrowLeft className="size-3.5 rtl:rotate-180" aria-hidden />
                </button>
                <button type="button" onClick={() => move(i, 1)} disabled={i === ids.length - 1} className="grid size-6 place-items-center rounded bg-black/50 text-white disabled:opacity-30" aria-label={t("dash.compose.moveLater")}>
                  <ArrowRight className="size-3.5 rtl:rotate-180" aria-hidden />
                </button>
              </span>
              <button type="button" onClick={() => onChange(ids.filter((x) => x !== id))} className="grid size-6 place-items-center rounded bg-black/50 text-white" aria-label={t("dash.compose.removeMedia")}>
                <X className="size-3.5" aria-hidden />
              </button>
            </span>
          </li>
        );
      })}
      <li>
        <button type="button" onClick={onAdd} className="flex size-24 flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-line text-xs text-muted hover:border-primary-line hover:text-primary">
          <ImagePlus className="size-5" aria-hidden />
          {t("dash.compose.addMedia")}
        </button>
      </li>
    </ul>
  );
}

/** Extra parts of a thread (posted as replies). */
export function ThreadBuilder({ parts, onChange, platforms }: { parts: string[]; onChange: (parts: string[]) => void; platforms: Platform[] }) {
  const t = useT();
  return (
    <div className="space-y-2">
      {parts.map((part, i) => (
        <div key={i} className="rounded-lg border border-line bg-paper p-2">
          <div className="mb-1 flex items-center justify-between gap-2 text-xs text-muted">
            <span>{t("dash.compose.part", { n: i + 2 })}</span>
            <span className="flex flex-wrap items-center gap-1">
              {platforms.map((p) => (
                <Counter key={p} platform={p} text={part} hasMedia={false} />
              ))}
              <button type="button" onClick={() => onChange(parts.filter((_, j) => j !== i))} className="rounded p-1 hover:text-red-600" aria-label={t("dash.compose.removePart", { n: i + 2 })}>
                <Trash2 className="size-3.5" aria-hidden />
              </button>
            </span>
          </div>
          <Textarea value={part} onChange={(e) => onChange(parts.map((p, j) => (j === i ? e.target.value : p)))} rows={3} dir="auto" className="min-h-0 bg-surface" aria-label={t("dash.compose.part", { n: i + 2 })} />
        </div>
      ))}
      <Button variant="outline" size="sm" onClick={() => onChange([...parts, ""])} disabled={parts.length >= 24}>
        <Plus aria-hidden />
        {t("dash.compose.addPart")}
      </Button>
    </div>
  );
}

/** Link, UTM builder, tracked short link and the link card details. */
export function LinkBuilder({
  link,
  meta,
  onLink,
  onMeta,
  platform,
  defaultUtm,
  onShorten,
  shortening,
}: {
  link: string;
  meta: LinkMeta | null;
  onLink: (v: string) => void;
  onMeta: (v: LinkMeta | null) => void;
  /** The active channel tab's network ("" on the "All channels" tab). */
  platform: Platform | null;
  defaultUtm: { source: string; medium: string; campaign: string };
  onShorten: (() => void) | null;
  shortening: boolean;
}) {
  const t = useT();
  const [utmOpen, setUtmOpen] = useState(false);
  const [cardOpen, setCardOpen] = useState(Boolean(meta));
  const [utm, setUtm] = useState({ source: defaultUtm.source.replaceAll("{platform}", platform ?? "") || (platform ?? "social"), medium: defaultUtm.medium || "social", campaign: defaultUtm.campaign, content: "" });
  const valid = /^https?:\/\/\S+$/i.test(link.trim());
  const tagged = valid ? buildUtmUrl(link.trim(), utm, { platform: platform ?? "", overwrite: true }) : "";
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <div className="relative min-w-0 flex-1 basis-56">
          <Link2 className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
          <Input value={link} onChange={(e) => onLink(e.target.value)} placeholder="https://" dir="ltr" inputMode="url" className="ps-9" aria-label={t("dash.compose.link")} />
        </div>
        <Button variant="outline" size="md" onClick={() => setUtmOpen((v) => !v)} aria-expanded={utmOpen} disabled={!valid}>
          <Tag aria-hidden />
          UTM
        </Button>
        {onShorten ? (
          <Button variant="outline" size="md" onClick={onShorten} disabled={!valid || shortening} aria-busy={shortening}>
            <Scissors aria-hidden />
            {t("dash.compose.shorten")}
          </Button>
        ) : null}
      </div>
      {utmOpen && valid ? (
        <div className="space-y-2 rounded-lg border border-line bg-paper p-3">
          <div className="grid gap-2 sm:grid-cols-2">
            {(["source", "medium", "campaign", "content"] as const).map((k) => (
              <label key={k} className="text-xs">
                <span className="mb-1 block font-medium text-muted">utm_{k}</span>
                <Input value={utm[k]} onChange={(e) => setUtm({ ...utm, [k]: e.target.value })} dir="ltr" className="h-8! text-xs" />
              </label>
            ))}
          </div>
          <p dir="ltr" className="truncate rounded bg-surface px-2 py-1 font-mono text-[11px] text-muted" title={tagged}>
            {tagged}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              onClick={() => {
                onLink(tagged);
                setUtmOpen(false);
              }}
            >
              {t("dash.compose.applyUtm")}
            </Button>
            <span className="text-xs text-muted">{platform ? t("dash.compose.utmChannel", { network: platformShortName(platform) }) : t("dash.compose.utmAll")}</span>
          </div>
        </div>
      ) : null}
      <button type="button" onClick={() => setCardOpen((v) => !v)} className="text-xs font-medium text-primary hover:underline" aria-expanded={cardOpen}>
        {cardOpen ? t("dash.compose.cardHide") : t("dash.compose.cardShow")}
      </button>
      {cardOpen ? (
        <div className="grid gap-2 rounded-lg border border-line bg-paper p-3 sm:grid-cols-2">
          <Input value={meta?.title ?? ""} onChange={(e) => onMeta({ title: e.target.value, description: meta?.description ?? "", imageUrl: meta?.imageUrl ?? "" })} placeholder={t("dash.compose.cardTitle")} aria-label={t("dash.compose.cardTitle")} dir="auto" />
          <Input value={meta?.imageUrl ?? ""} onChange={(e) => onMeta({ title: meta?.title ?? "", description: meta?.description ?? "", imageUrl: e.target.value })} placeholder={t("dash.compose.cardImage")} aria-label={t("dash.compose.cardImage")} dir="ltr" />
          <Textarea value={meta?.description ?? ""} onChange={(e) => onMeta({ title: meta?.title ?? "", description: e.target.value, imageUrl: meta?.imageUrl ?? "" })} placeholder={t("dash.compose.cardDescription")} aria-label={t("dash.compose.cardDescription")} rows={2} dir="auto" className="min-h-0 sm:col-span-2" />
          <p className="text-xs text-muted sm:col-span-2">{t("dash.compose.cardHint")}</p>
        </div>
      ) : null}
    </div>
  );
}

/** Network options of one channel tab (post type, YouTube title, Mastodon visibility…). */
export function OptionsPanel({ platform, options, onChange, mediaOptions }: { platform: Platform; options: PlatformOptions; onChange: (patch: PlatformOptions) => void; mediaOptions: Array<{ id: number; label: string }> }) {
  const t = useT();
  const key = platform === "instagram_login" ? "instagram" : platform;
  const current = normalizePlatformOptions({ [key]: (options as Record<string, unknown>)[key] ?? {} }) as Required<PlatformOptions>;
  const set = <K extends keyof PlatformOptions>(k: K, patch: Partial<NonNullable<PlatformOptions[K]>>) => onChange({ [k]: { ...current[k], ...patch } } as PlatformOptions);
  const row = "grid gap-3 sm:grid-cols-2";
  const label = (text: string, control: ReactNode, full = false) => (
    <label className={cn("block text-sm", full && "sm:col-span-2")}>
      <span className="mb-1.5 block font-medium">{text}</span>
      {control}
    </label>
  );
  switch (key) {
    case "instagram": {
      const ig = current.instagram;
      return (
        <div className={row}>
          {label(
            t("dash.compose.opt.postType"),
            <Select value={ig.postType} onChange={(e) => set("instagram", { postType: e.target.value as (typeof IG_POST_TYPES)[number] })}>
              {IG_POST_TYPES.map((v) => (
                <option key={v} value={v}>
                  {t(`dash.preview.ig.${v}`)}
                </option>
              ))}
            </Select>,
          )}
          {ig.postType === "reel" ? (
            <div className="flex items-end pb-2">
              <Checkbox label={t("dash.compose.opt.shareToFeed")} checked={ig.shareToFeed} onChange={(e) => set("instagram", { shareToFeed: e.target.checked })} />
            </div>
          ) : null}
          {label(t("dash.compose.opt.collaborators"), <Input value={ig.collaborators.join(", ")} onChange={(e) => set("instagram", { collaborators: e.target.value.split(/[\s,]+/).filter(Boolean).slice(0, 3) })} dir="ltr" placeholder="@username" />, true)}
          {ig.postType === "reel" && mediaOptions.length
            ? label(
                t("dash.compose.opt.cover"),
                <Select value={ig.coverMediaId || ""} onChange={(e) => set("instagram", { coverMediaId: Number(e.target.value) || 0 })}>
                  <option value="">{t("dash.compose.opt.coverAuto")}</option>
                  {mediaOptions.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </Select>,
              )
            : null}
        </div>
      );
    }
    case "facebook":
      return (
        <div className={row}>
          {label(
            t("dash.compose.opt.postType"),
            <Select value={current.facebook.postType} onChange={(e) => set("facebook", { postType: e.target.value as (typeof FB_POST_TYPES)[number] })}>
              {FB_POST_TYPES.map((v) => (
                <option key={v} value={v}>
                  {t(`dash.preview.fb.${v}`)}
                </option>
              ))}
            </Select>,
          )}
        </div>
      );
    case "youtube": {
      const yt = current.youtube;
      return (
        <div className={row}>
          {label(t("dash.compose.opt.ytTitle"), <Input value={yt.title} maxLength={100} onChange={(e) => set("youtube", { title: e.target.value })} dir="auto" />, true)}
          {label(
            t("dash.compose.opt.privacy"),
            <Select value={yt.privacy} onChange={(e) => set("youtube", { privacy: e.target.value as (typeof YOUTUBE_PRIVACY)[number] })}>
              {YOUTUBE_PRIVACY.map((v) => (
                <option key={v} value={v}>
                  {t(`dash.preview.yt.${v}`)}
                </option>
              ))}
            </Select>,
          )}
          {label(t("dash.compose.opt.tags"), <Input value={yt.tags.join(", ")} onChange={(e) => set("youtube", { tags: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} dir="auto" />)}
          <div className="flex flex-col gap-2 sm:col-span-2">
            <Checkbox label={t("dash.compose.opt.madeForKids")} checked={yt.madeForKids} onChange={(e) => set("youtube", { madeForKids: e.target.checked })} />
            <Checkbox label={t("dash.compose.opt.notify")} checked={yt.notifySubscribers} onChange={(e) => set("youtube", { notifySubscribers: e.target.checked })} />
          </div>
        </div>
      );
    }
    case "threads":
      return (
        <div className={row}>
          {label(
            t("dash.compose.opt.replies"),
            <Select value={current.threads.replyControl} onChange={(e) => set("threads", { replyControl: e.target.value as "everyone" })}>
              <option value="everyone">{t("dash.compose.opt.everyone")}</option>
              <option value="accounts_you_follow">{t("dash.compose.opt.following")}</option>
              <option value="mentioned_only">{t("dash.compose.opt.mentioned")}</option>
            </Select>,
          )}
          {label(t("dash.compose.opt.topic"), <Input value={current.threads.topicTag} maxLength={50} onChange={(e) => set("threads", { topicTag: e.target.value })} dir="auto" />)}
        </div>
      );
    case "x":
      return (
        <div className={row}>
          {label(
            t("dash.compose.opt.replies"),
            <Select value={current.x.replySettings} onChange={(e) => set("x", { replySettings: e.target.value as "everyone" })}>
              <option value="everyone">{t("dash.compose.opt.everyone")}</option>
              <option value="following">{t("dash.compose.opt.following")}</option>
              <option value="mentionedUsers">{t("dash.compose.opt.mentioned")}</option>
            </Select>,
          )}
        </div>
      );
    case "linkedin":
      return (
        <div className={row}>
          {label(
            t("dash.compose.opt.visibility"),
            <Select value={current.linkedin.visibility} onChange={(e) => set("linkedin", { visibility: e.target.value as "PUBLIC" })}>
              <option value="PUBLIC">{t("dash.compose.opt.public")}</option>
              <option value="CONNECTIONS">{t("dash.compose.opt.connections")}</option>
            </Select>,
          )}
        </div>
      );
    case "mastodon": {
      const m = current.mastodon;
      return (
        <div className={row}>
          {label(
            t("dash.compose.opt.visibility"),
            <Select value={m.visibility} onChange={(e) => set("mastodon", { visibility: e.target.value as (typeof MASTODON_VISIBILITY)[number] })}>
              {MASTODON_VISIBILITY.map((v) => (
                <option key={v} value={v}>
                  {t(`dash.compose.opt.masto.${v}`)}
                </option>
              ))}
            </Select>,
          )}
          {label(t("dash.compose.opt.language"), <Input value={m.language} maxLength={2} onChange={(e) => set("mastodon", { language: e.target.value.toLowerCase() })} dir="ltr" placeholder="en" />)}
          {label(t("dash.compose.opt.cw"), <Input value={m.spoilerText} maxLength={500} onChange={(e) => set("mastodon", { spoilerText: e.target.value })} dir="auto" />, true)}
        </div>
      );
    }
    case "bluesky":
      return (
        <div className={row}>
          {label(t("dash.compose.opt.languages"), <Input value={current.bluesky.langs.join(", ")} onChange={(e) => set("bluesky", { langs: e.target.value.split(/[\s,]+/).filter(Boolean).slice(0, 3) })} dir="ltr" placeholder="en, de" />)}
        </div>
      );
    case "telegram":
      return (
        <div className="flex flex-col gap-2">
          <Checkbox label={t("dash.compose.opt.silent")} checked={current.telegram.silent} onChange={(e) => set("telegram", { silent: e.target.checked })} />
          <Checkbox label={t("dash.compose.opt.noPreview")} checked={current.telegram.disablePreview} onChange={(e) => set("telegram", { disablePreview: e.target.checked })} />
        </div>
      );
    case "discord":
      return (
        <div className={row}>
          {label(t("dash.compose.opt.username"), <Input value={current.discord.username} maxLength={80} onChange={(e) => set("discord", { username: e.target.value })} dir="auto" />)}
          {label(t("dash.compose.opt.threadName"), <Input value={current.discord.threadName} maxLength={100} onChange={(e) => set("discord", { threadName: e.target.value })} dir="auto" />)}
        </div>
      );
    default:
      return <p className="text-sm text-muted">{t("dash.compose.opt.none")}</p>;
  }
}

/** Labels as chips with suggestions from the workspace's other posts. */
export function LabelsInput({ labels, onChange, suggestions }: { labels: string[]; onChange: (v: string[]) => void; suggestions: string[] }) {
  const t = useT();
  const [draft, setDraft] = useState("");
  const add = (raw: string) => {
    const v = raw.trim().replace(/\s+/g, " ").slice(0, 40);
    if (!v || labels.some((l) => l.toLowerCase() === v.toLowerCase()) || labels.length >= 20) return;
    onChange([...labels, v]);
  };
  const listId = "qz-label-suggestions";
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-line bg-surface p-1.5">
      {labels.map((l) => (
        <span key={l} className="inline-flex items-center gap-1 rounded-full bg-primary-soft px-2 py-0.5 text-xs font-medium text-primary">
          <bdi>{l}</bdi>
          <button type="button" onClick={() => onChange(labels.filter((x) => x !== l))} aria-label={t("dash.compose.removeLabel", { label: l })} className="rounded-full hover:text-ink">
            <X className="size-3" aria-hidden />
          </button>
        </span>
      ))}
      <input
        value={draft}
        list={listId}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            add(draft);
            setDraft("");
          } else if (e.key === "Backspace" && !draft && labels.length) onChange(labels.slice(0, -1));
        }}
        onBlur={() => {
          if (draft) {
            add(draft);
            setDraft("");
          }
        }}
        dir="auto"
        placeholder={labels.length ? "" : t("dash.compose.labelsPlaceholder")}
        aria-label={t("dash.compose.labels")}
        className="h-7 min-w-24 flex-1 bg-transparent px-1 text-sm outline-none"
      />
      <datalist id={listId}>
        {suggestions.filter((s) => !labels.includes(s)).map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
    </div>
  );
}
