"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock, Check, CircleAlert, ListPlus, Loader2, Save, Send, Zap } from "lucide-react";
import { composerMedia, previewQueueSlot, saveComposerPost, shortenLinkAction, type ComposerIntent } from "@/app/actions/dashboard/posts";
import { PlatformIcon } from "@/components/social/platform-icon";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import { platformShortName } from "@/social/format";
import { getCapabilities } from "@/social/platforms";
import { extractHashtags, linkRewriteIssue, localTime, mergeContent, validatePostForChannel, zonedParts, type LinkRewrite } from "@/social/normalize";
import type { ContentOverride, MediaInfo, Platform, PlatformOptions, PostContent, PostStatus, UtmSettings, ValidationIssue, ValidationResult } from "@/social/types";
import { ComposerAiSlot } from "./composer-ai-slot";
import { EmojiButton, HashtagButton } from "./composer-emoji";
import { Counter, FieldShell, LabelsInput, LinkBuilder, MediaStrip, OptionsPanel, TextArea, ThreadBuilder } from "./composer-fields";
import { IssueList } from "./composer-issues";
import { PostPreview } from "./composer-preview";
import { MediaLibrary, type LibraryItem } from "./media-library";

/**
 * The composer (new posts and editing): channels, the base text with per-channel tabs that
 * override it, media, link + UTM, first comment, thread, network options, labels, live previews,
 * validation from the capabilities registry, and save draft / submit / schedule / add to queue /
 * post now, with autosave of drafts.
 */

export interface ComposerChannel {
  id: number;
  platform: Platform;
  name: string;
  handle: string;
  avatarUrl: string;
  status: string;
  paused: boolean;
  slots: number;
  hashtags: string;
  defaultFirstComment: string;
  defaults: PlatformOptions;
  /** The channel's own UTM setting (null = the workspace's). */
  utm: UtmSettings | null;
}

export interface ComposerInitial {
  postId: number | null;
  status: PostStatus | null;
  content: PostContent;
  overrides: Record<number, ContentOverride>;
  channelIds: number[];
  labels: string[];
  /** "YYYY-MM-DDTHH:MM" in the workspace's time zone, "" = none. */
  scheduledLocal: string;
}

type MediaEntry = MediaInfo & { filename?: string };
type OverrideField = "text" | "mediaIds" | "link" | "linkMeta" | "firstComment" | "thread";

const AUTOSAVE_MS = 15_000;

function toLocalInput(ms: number, tz: string): string {
  const p = zonedParts(ms, tz);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

export function Composer({
  workspaceId,
  timezone,
  locale,
  channels,
  initial,
  initialMedia,
  canPublish,
  aiEnabled,
  canUpload,
  knownLabels,
  utm,
  linkRewrite,
  shortLinks,
}: {
  workspaceId: number;
  timezone: string;
  locale: string;
  channels: ComposerChannel[];
  initial: ComposerInitial;
  initialMedia: MediaEntry[];
  canPublish: boolean;
  aiEnabled: boolean;
  canUpload: boolean;
  knownLabels: string[];
  utm: { source: string; medium: string; campaign: string };
  /** The workspace's link settings applied when publishing (UTM tags, short links). */
  linkRewrite: LinkRewrite;
  shortLinks: boolean;
}) {
  const t = useT();
  const router = useRouter();
  const base = `/dashboard/w/${workspaceId}`;
  const [postId, setPostId] = useState<number | null>(initial.postId);
  const [status, setStatus] = useState<PostStatus | null>(initial.status);
  const [selected, setSelected] = useState<number[]>(initial.channelIds.filter((id) => channels.some((c) => c.id === id)));
  const [content, setContent] = useState<PostContent>(initial.content);
  const [overrides, setOverrides] = useState<Record<number, ContentOverride>>(initial.overrides);
  const [labels, setLabels] = useState<string[]>(initial.labels);
  const [when, setWhen] = useState(initial.scheduledLocal);
  const [tab, setTab] = useState<number | "all">("all");
  const [previewId, setPreviewId] = useState<number | null>(null);
  const [media, setMedia] = useState<Map<number, MediaEntry>>(() => new Map(initialMedia.map((m) => [m.id, m])));
  const [picker, setPicker] = useState(false);
  const [slot, setSlot] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [serverIssues, setServerIssues] = useState<Record<number, ValidationResult> | null>(null);
  const [dirty, setDirty] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [busy, setBusy] = useState<ComposerIntent | null>(null);
  const [shortening, startShorten] = useTransition();
  const textRef = useRef<HTMLTextAreaElement | null>(null);

  const channelById = useMemo(() => new Map(channels.map((c) => [c.id, c])), [channels]);
  const selectedChannels = useMemo(() => selected.map((id) => channelById.get(id)).filter((c): c is ComposerChannel => Boolean(c)), [selected, channelById]);
  const platforms = [...new Set(selectedChannels.map((c) => c.platform))];
  const activeChannel = tab === "all" ? null : (channelById.get(tab) ?? null);
  const activeOverride: ContentOverride = activeChannel ? (overrides[activeChannel.id] ?? {}) : {};
  const effective = activeChannel ? mergeContent(content, activeOverride) : content;
  const touch = () => {
    setDirty(true);
    setNotice(null);
  };

  // Media facts for items attached but not loaded yet (overrides, duplicates).
  const allIds = useMemo(() => [...new Set([content.mediaIds, ...Object.values(overrides).map((o) => o.mediaIds ?? [])].flat())], [content.mediaIds, overrides]);
  useEffect(() => {
    const missing = allIds.filter((id) => !media.has(id));
    if (!missing.length) return;
    let cancelled = false;
    void composerMedia(workspaceId, missing).then((items) => {
      if (!cancelled) setMedia((m) => new Map([...m, ...items.map((i) => [i.id, i] as const)]));
    });
    return () => {
      cancelled = true;
    };
  }, [allIds, media, workspaceId]);
  const mediaList = useMemo(() => [...media.values()], [media]);

  // ── Editing ──

  const setField = <K extends OverrideField>(field: K, value: PostContent[K]) => {
    touch();
    if (activeChannel) setOverrides((o) => ({ ...o, [activeChannel.id]: { ...(o[activeChannel.id] ?? {}), [field]: value } }));
    else setContent((c) => ({ ...c, [field]: value }));
  };
  const resetField = (field: OverrideField) => {
    if (!activeChannel) return;
    touch();
    setOverrides((o) => {
      const next = { ...(o[activeChannel.id] ?? {}) };
      delete next[field];
      return { ...o, [activeChannel.id]: next };
    });
  };
  const isOverridden = (field: OverrideField) => Boolean(activeChannel && field in activeOverride);
  const setOptions = (patch: PlatformOptions) => {
    touch();
    if (activeChannel) setOverrides((o) => ({ ...o, [activeChannel.id]: { ...(o[activeChannel.id] ?? {}), options: { ...(o[activeChannel.id]?.options ?? {}), ...patch } } }));
  };

  const insertText = (snippet: string) => {
    const el = textRef.current;
    const current = effective.text;
    if (!el) return setField("text", current ? `${current} ${snippet}` : snippet);
    const start = el.selectionStart ?? current.length;
    const end = el.selectionEnd ?? current.length;
    const before = current.slice(0, start);
    const pad = before && !/\s$/.test(before) && !/^\p{Extended_Pictographic}/u.test(snippet) ? " " : "";
    const next = `${before}${pad}${snippet}${current.slice(end)}`;
    setField("text", next);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + pad.length + snippet.length;
      el.setSelectionRange(pos, pos);
    });
  };
  // AI first comment ideas: fill the active tab's first comment field and bring it into view.
  const applyFirstComment = (value: string) => {
    setField("firstComment", value);
    requestAnimationFrame(() => {
      const el = document.getElementById("qz-first");
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
      el?.focus({ preventScroll: true });
    });
  };

  const toggleChannel = (c: ComposerChannel) => {
    touch();
    setSelected((s) => {
      if (s.includes(c.id)) {
        if (tab === c.id) setTab("all");
        return s.filter((x) => x !== c.id);
      }
      // A newly picked channel starts with its defaults (first comment, network options).
      setOverrides((o) => {
        if (o[c.id]) return o;
        const seed: ContentOverride = {};
        if (c.defaultFirstComment && !content.firstComment) seed.firstComment = c.defaultFirstComment;
        if (Object.keys(c.defaults).length) seed.options = c.defaults;
        return Object.keys(seed).length ? { ...o, [c.id]: seed } : o;
      });
      return [...s, c.id];
    });
  };

  // ── Validation ──

  const results = useMemo(() => {
    const out = new Map<number, ValidationResult>();
    for (const c of selectedChannels) out.set(c.id, validatePostForChannel(mergeContent(content, overrides[c.id]), mediaList, c.platform));
    return out;
  }, [selectedChannels, content, overrides, mediaList]);
  // UTM tags / short links added when publishing can push a text over the limit (links counted in their final form).
  const linkIssues = useMemo(() => {
    const out = new Map<number, ValidationIssue>();
    for (const c of selectedChannels) {
      const issue = linkRewriteIssue(mergeContent(content, overrides[c.id]), c.platform, { ...linkRewrite, utm: c.utm ?? linkRewrite.utm });
      if (issue) out.set(c.id, issue);
    }
    return out;
  }, [selectedChannels, content, overrides, linkRewrite]);
  const issues = useMemo(() => {
    const list: Array<{ issue: ValidationIssue; severity: "error" | "warning"; platform: Platform; channel: string; channelId: number }> = [];
    for (const c of selectedChannels) {
      const r = serverIssues?.[c.id] && !dirty ? serverIssues[c.id] : results.get(c.id);
      if (!r) continue;
      for (const e of r.errors) list.push({ issue: e, severity: "error", platform: c.platform, channel: c.name, channelId: c.id });
      for (const w of r.warnings) list.push({ issue: w, severity: "warning", platform: c.platform, channel: c.name, channelId: c.id });
      const li = linkIssues.get(c.id);
      if (li) list.push({ issue: li, severity: "warning", platform: c.platform, channel: c.name, channelId: c.id });
    }
    return list;
  }, [selectedChannels, results, serverIssues, dirty, linkIssues]);
  const errorCount = issues.filter((i) => i.severity === "error").length;
  const invalidMedia = new Set(
    issues
      .filter((i) => i.severity === "error" && i.issue.field?.startsWith("media:") && (!activeChannel || i.channelId === activeChannel.id))
      .map((i) => Number(i.issue.field!.slice(6))),
  );

  // ── Queue slot preview ──

  useEffect(() => {
    if (!selected.length || !canPublish) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void previewQueueSlot(workspaceId, selected).then((s) => {
        if (!cancelled) setSlot(s);
      });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [selected, workspaceId, canPublish]);

  // ── Saving ──

  const hasContent = Boolean(content.text.trim() || content.mediaIds.length || content.link || Object.values(overrides).some((o) => o.text?.trim()));
  const editableDraft = status === null || status === "draft";

  const save = useCallback(
    async (intent: ComposerIntent, autosave = false) => {
      if (!autosave) setBusy(intent);
      try {
        const result = await saveComposerPost({ workspaceId, postId, content, overrides, channelIds: selected, labels, scheduledLocal: when, intent, autosave });
        if (!result.ok) {
          if (!autosave) {
            setNotice({ tone: "error", text: result.error });
            setServerIssues(result.issues ?? null);
          }
          return;
        }
        setPostId(result.postId);
        setStatus(result.status);
        setDirty(false);
        setServerIssues(null);
        if (intent === "draft") {
          setSavedAt(localTime(Date.now(), timezone));
          if (!postId) router.replace(`${base}/compose?post=${result.postId}`, { scroll: false });
          if (!autosave) setNotice({ tone: "success", text: result.message });
          return;
        }
        router.push(`${base}/posts/${result.postId}?done=${intent}`);
      } finally {
        if (!autosave) setBusy(null);
      }
    },
    [workspaceId, postId, content, overrides, selected, labels, when, router, base, timezone],
  );

  // Autosave drafts (new posts and drafts only: a scheduled post must not fall back to draft).
  useEffect(() => {
    if (!dirty || !editableDraft || !hasContent || busy) return;
    const timer = setTimeout(() => void save("draft", true), AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [dirty, editableDraft, hasContent, busy, save]);

  useEffect(() => {
    if (!dirty) return;
    const onLeave = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, [dirty]);

  const [nowLocal] = useState(() => toLocalInput(Date.now() + 10 * 60_000, timezone));
  const blocked = errorCount > 0 || !selected.length;
  const scheduledLabel = when ? new Date(when).toLocaleString(locale, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : null;
  const shownSlot = selected.length && canPublish ? slot : null;
  const slotLabel = shownSlot ? new Date(shownSlot).toLocaleString(locale, { timeZone: timezone, weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : null;

  const previewChannel = selectedChannels.find((c) => c.id === (activeChannel?.id ?? previewId)) ?? selectedChannels[0] ?? null;
  const previewContent = previewChannel ? mergeContent(content, overrides[previewChannel.id]) : content;
  const previewMedia = previewContent.mediaIds.map((id) => media.get(id)).filter((m): m is MediaEntry => Boolean(m));

  const firstCommentPlatforms = (activeChannel ? [activeChannel.platform] : platforms).filter((p) => getCapabilities(p).firstComment !== "none");
  const threadPlatforms = (activeChannel ? [activeChannel.platform] : platforms).filter((p) => getCapabilities(p).threads.supported);
  const hashtagGroups = selectedChannels.filter((c) => c.hashtags).map((c) => ({ label: c.name, tags: c.hashtags }));
  const igLimit = platforms.some((p) => p === "instagram" || p === "instagram_login") ? 30 : null;
  const grouped = useMemo(() => {
    const map = new Map<Platform, ComposerChannel[]>();
    for (const c of channels) map.set(c.platform, [...(map.get(c.platform) ?? []), c]);
    return [...map.entries()];
  }, [channels]);

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6 xl:grid-cols-[minmax(0,1fr)_400px]">
      <div className="min-w-0 space-y-5">
        {/* Channels */}
        <section className="rounded-xl border border-line bg-surface p-4" aria-labelledby="qz-channels">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 id="qz-channels" className="font-sans text-sm font-semibold tracking-normal">
              {t("dash.compose.channels")}
            </h2>
            {channels.length ? (
              <button
                type="button"
                className="text-xs font-medium text-primary hover:underline"
                onClick={() => {
                  touch();
                  setSelected(selected.length === channels.length ? [] : channels.map((c) => c.id));
                }}
              >
                {selected.length === channels.length ? t("dash.compose.none") : t("dash.compose.all")}
              </button>
            ) : null}
          </div>
          {channels.length ? (
            <div className="flex flex-wrap gap-x-4 gap-y-3">
              {grouped.map(([platform, list]) => (
                <div key={platform} className="flex flex-wrap items-center gap-1.5">
                  {list.map((c) => {
                    const on = selected.includes(c.id);
                    return (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => toggleChannel(c)}
                        aria-pressed={on}
                        title={`${c.name} · ${platformShortName(c.platform)}`}
                        className={cn("relative rounded-full p-0.5 transition", on ? "ring-2 ring-primary" : "opacity-50 grayscale hover:opacity-100 hover:grayscale-0")}
                      >
                        {c.avatarUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={c.avatarUrl} alt={c.name} className="size-9 rounded-full object-cover" />
                        ) : (
                          <span className="grid size-9 place-items-center rounded-full bg-paper text-sm font-semibold" aria-label={c.name}>
                            {(c.name.trim() || "?").slice(0, 1).toUpperCase()}
                          </span>
                        )}
                        <PlatformIcon platform={c.platform} className="absolute -end-0.5 -bottom-0.5 size-4 rounded ring-2 ring-surface" />
                        {c.status !== "active" ? <span className="absolute -top-0.5 -end-0.5 size-2.5 rounded-full bg-red-500 ring-2 ring-surface" aria-hidden /> : null}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted">
              {t("dash.compose.noChannels")}{" "}
              <a href={`${base}/channels`} className="font-medium text-primary hover:underline">
                {t("dash.compose.connect")}
              </a>
            </p>
          )}
          {selectedChannels.some((c) => c.status !== "active") ? <p className="mt-3 text-xs text-red-600 dark:text-red-400">{t("dash.compose.channelProblem")}</p> : null}
        </section>

        {/* Tabs: all channels + one per selected channel */}
        <section className="rounded-xl border border-line bg-surface">
          <div role="tablist" aria-label={t("dash.compose.tabs")} className="flex gap-1 overflow-x-auto border-b border-line px-3 pt-3">
            <TabButton active={tab === "all"} onClick={() => setTab("all")}>
              {t("dash.compose.allChannels")}
            </TabButton>
            {selectedChannels.map((c) => {
              const r = results.get(c.id);
              const custom = Boolean(overrides[c.id] && Object.keys(overrides[c.id]).some((k) => k !== "options"));
              return (
                <TabButton key={c.id} active={tab === c.id} onClick={() => setTab(c.id)}>
                  <PlatformIcon platform={c.platform} className="size-4" />
                  <bdi className="max-w-32 truncate">{c.name}</bdi>
                  {r?.errors.length ? <CircleAlert className="size-3.5 text-red-600" aria-label={t("dash.compose.hasErrors")} /> : custom ? <span className="size-1.5 rounded-full bg-primary" aria-label={t("dash.compose.custom")} /> : null}
                </TabButton>
              );
            })}
          </div>

          <div className="space-y-5 p-4">
            {activeChannel ? (
              <p className="rounded-lg bg-primary-soft px-3 py-2 text-xs text-ink">
                {t("dash.compose.overrideHint", { network: platformShortName(activeChannel.platform) })}
              </p>
            ) : null}

            <FieldShell
              label={<label htmlFor="qz-text">{t("dash.compose.text")}</label>}
              overridden={isOverridden("text")}
              onReset={() => resetField("text")}
              action={
                <span className="flex items-center gap-0.5">
                  <EmojiButton onPick={insertText} />
                  <HashtagButton groups={hashtagGroups} used={extractHashtags(effective.text)} onInsert={insertText} limit={igLimit} />
                  <ComposerAiSlot workspaceId={workspaceId} enabled={aiEnabled} text={effective.text} platform={activeChannel?.platform ?? null} platforms={platforms} onApply={(v) => setField("text", v)} onInsert={insertText} onFirstComment={firstCommentPlatforms.length ? applyFirstComment : undefined} locale={locale} />
                </span>
              }
            >
              <TextArea id="qz-text" value={effective.text} onChange={(v) => setField("text", v)} placeholder={t("dash.compose.textPlaceholder")} rows={7} textareaRef={textRef} invalid={issues.some((i) => i.severity === "error" && i.issue.field === "text" && (!activeChannel || i.channelId === activeChannel.id))} />
              <div className="mt-2 flex flex-wrap gap-1.5">
                {(activeChannel ? [activeChannel.platform] : platforms).map((p) => (
                  <Counter key={p} platform={p} text={effective.text} hasMedia={effective.mediaIds.length > 0} />
                ))}
              </div>
            </FieldShell>

            <FieldShell label={t("dash.compose.media")} overridden={isOverridden("mediaIds")} onReset={() => resetField("mediaIds")}>
              <MediaStrip ids={effective.mediaIds} media={media} invalidIds={invalidMedia} onChange={(ids) => setField("mediaIds", ids)} onAdd={() => setPicker(true)} />
            </FieldShell>

            <FieldShell label={t("dash.compose.link")} overridden={isOverridden("link")} onReset={() => resetField("link")} hint={t("dash.compose.linkHint")}>
              <LinkBuilder
                key={`${tab}`}
                link={effective.link}
                meta={effective.linkMeta}
                onLink={(v) => setField("link", v.trim())}
                onMeta={(v) => setField("linkMeta", v)}
                platform={activeChannel?.platform ?? null}
                defaultUtm={utm}
                shortening={shortening}
                onShorten={
                  shortLinks
                    ? () =>
                        startShorten(async () => {
                          const r = await shortenLinkAction(workspaceId, effective.link);
                          if (r.ok) setField("link", r.url);
                          else setNotice({ tone: "error", text: r.error });
                        })
                    : null
                }
              />
            </FieldShell>

            {firstCommentPlatforms.length ? (
              <FieldShell label={<label htmlFor="qz-first">{t("dash.compose.firstComment")}</label>} overridden={isOverridden("firstComment")} onReset={() => resetField("firstComment")} hint={t("dash.compose.firstCommentHint", { networks: firstCommentPlatforms.map(platformShortName).join(", ") })}>
                <TextArea id="qz-first" value={effective.firstComment} onChange={(v) => setField("firstComment", v)} rows={2} />
              </FieldShell>
            ) : null}

            {threadPlatforms.length ? (
              <FieldShell label={t("dash.compose.thread")} overridden={isOverridden("thread")} onReset={() => resetField("thread")} hint={t("dash.compose.threadHint", { networks: threadPlatforms.map(platformShortName).join(", ") })}>
                <ThreadBuilder parts={effective.thread} onChange={(parts) => setField("thread", parts)} platforms={activeChannel ? [activeChannel.platform] : threadPlatforms} />
              </FieldShell>
            ) : null}

            {activeChannel ? (
              <FieldShell label={t("dash.compose.options", { network: platformShortName(activeChannel.platform) })}>
                <OptionsPanel
                  platform={activeChannel.platform}
                  options={effective.options}
                  onChange={setOptions}
                  mediaOptions={mediaList.filter((m) => m.kind !== "video").map((m) => ({ id: m.id, label: m.filename ?? `#${m.id}` }))}
                />
              </FieldShell>
            ) : (
              <FieldShell label={t("dash.compose.labels")}>
                <LabelsInput
                  labels={labels}
                  onChange={(v) => {
                    touch();
                    setLabels(v);
                  }}
                  suggestions={knownLabels}
                />
              </FieldShell>
            )}
          </div>
        </section>

        {/* Problems */}
        {issues.length ? (
          <section className="rounded-xl border border-line bg-surface p-4" aria-live="polite">
            <h2 className="mb-2 font-sans text-sm font-semibold tracking-normal">
              {errorCount ? t("dash.compose.problems", { n: errorCount }) : t("dash.compose.warnings")}
            </h2>
            <IssueList
              items={issues}
              locale={locale}
              t={t}
              onSelect={(channelId) => {
                if (channelId) setTab(channelId);
              }}
            />
          </section>
        ) : null}

        {/* When and actions */}
        <section className="rounded-xl border border-line bg-surface p-4">
          {notice ? (
            <Alert tone={notice.tone} className="mb-4">
              {notice.text}
            </Alert>
          ) : null}
          <div className="flex flex-wrap items-end gap-3">
            <label className="min-w-0 basis-60">
              <span className="mb-1.5 block text-sm font-medium">{t("dash.compose.when")}</span>
              <Input
                type="datetime-local"
                value={when}
                min={canPublish ? nowLocal.slice(0, 16) : undefined}
                onChange={(e) => {
                  touch();
                  setWhen(e.target.value);
                }}
                dir="ltr"
                className="w-full"
              />
              <span className="mt-1 block text-xs text-muted">{t("dash.compose.timezone", { tz: timezone.replaceAll("_", " ") })}</span>
            </label>
            <div className="flex flex-1 flex-wrap justify-end gap-2">
              <Button variant="outline" onClick={() => void save("draft")} disabled={Boolean(busy) || !hasContent || !editableDraft} title={editableDraft ? undefined : t("dash.compose.draftLocked")}>
                {busy === "draft" ? <Loader2 className="animate-spin" aria-hidden /> : <Save aria-hidden />}
                {t("dash.compose.saveDraft")}
              </Button>
              {canPublish ? (
                <>
                  <Button variant="secondary" onClick={() => void save("queue")} disabled={Boolean(busy) || blocked || !shownSlot} title={slotLabel ? t("dash.compose.queueAt", { when: slotLabel }) : t("dash.compose.err.noSlots")}>
                    {busy === "queue" ? <Loader2 className="animate-spin" aria-hidden /> : <ListPlus aria-hidden />}
                    {t("dash.compose.addToQueue")}
                  </Button>
                  <Button variant="secondary" onClick={() => void save("schedule")} disabled={Boolean(busy) || blocked || !when}>
                    {busy === "schedule" ? <Loader2 className="animate-spin" aria-hidden /> : <CalendarClock aria-hidden />}
                    {t("dash.compose.schedule")}
                  </Button>
                  <Button
                    onClick={() => {
                      if (window.confirm(t("dash.compose.postNowConfirm", { n: selected.length }))) void save("publish_now");
                    }}
                    disabled={Boolean(busy) || blocked}
                  >
                    {busy === "publish_now" ? <Loader2 className="animate-spin" aria-hidden /> : <Zap aria-hidden />}
                    {t("dash.compose.postNow")}
                  </Button>
                </>
              ) : (
                <Button onClick={() => void save("submit")} disabled={Boolean(busy) || blocked}>
                  {busy === "submit" ? <Loader2 className="animate-spin" aria-hidden /> : <Send aria-hidden />}
                  {t("dash.compose.submit")}
                </Button>
              )}
            </div>
          </div>
          <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
            {canPublish && slotLabel ? <span>{t("dash.compose.nextSlot", { when: slotLabel })}</span> : null}
            {!canPublish ? <span>{t("dash.compose.approvalHint")}</span> : null}
            {savedAt ? (
              <span className="inline-flex items-center gap-1">
                <Check className="size-3" aria-hidden />
                {t("dash.compose.savedAt", { time: savedAt })}
              </span>
            ) : dirty && editableDraft && hasContent ? (
              <span>{t("dash.compose.unsaved")}</span>
            ) : null}
          </p>
        </section>
      </div>

      {/* Preview */}
      <aside className="min-w-0 xl:sticky xl:top-4 xl:self-start" aria-label={t("dash.compose.preview")}>
        <div className="rounded-xl border border-line bg-surface p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="font-sans text-sm font-semibold tracking-normal">{t("dash.compose.preview")}</h2>
            {selectedChannels.length > 1 && !activeChannel ? (
              <div className="flex flex-wrap justify-end gap-1">
                {selectedChannels.map((c) => (
                  <button key={c.id} type="button" onClick={() => setPreviewId(c.id)} aria-pressed={previewChannel?.id === c.id} title={`${c.name} · ${platformShortName(c.platform)}`} className={cn("rounded-md p-0.5", previewChannel?.id === c.id ? "ring-2 ring-primary" : "opacity-60 hover:opacity-100")}>
                    <PlatformIcon platform={c.platform} className="size-5" title={`${c.name} · ${platformShortName(c.platform)}`} />
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          {previewChannel ? (
            <PostPreview
              channel={{ name: previewChannel.name, handle: previewChannel.handle, avatarUrl: previewChannel.avatarUrl, platform: previewChannel.platform }}
              content={previewContent}
              media={previewMedia}
              whenLabel={scheduledLabel ?? t("dash.preview.now")}
            />
          ) : (
            <p className="rounded-lg bg-paper px-4 py-10 text-center text-sm text-muted">{t("dash.compose.previewEmpty")}</p>
          )}
        </div>
      </aside>

      {picker ? (
        <PickerDialog
          onClose={() => setPicker(false)}
          title={t("dash.compose.pickMedia")}
          closeLabel={t("dash.media.close")}
        >
          <MediaLibrary
            workspaceId={workspaceId}
            canManage={false}
            canUpload={canUpload}
            mode="picker"
            locale={locale}
            onPick={(items: LibraryItem[]) => {
              setMedia((m) => new Map([...m, ...items.map((i) => [i.id, i] as const)]));
              setField("mediaIds", [...new Set([...effective.mediaIds, ...items.map((i) => i.id)])].slice(0, 35));
              setPicker(false);
            }}
          />
        </PickerDialog>
      ) : null}
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn("-mb-px inline-flex shrink-0 items-center gap-1.5 rounded-t-lg border-x border-t px-3 py-2 text-sm font-medium whitespace-nowrap", active ? "border-line bg-surface text-primary" : "border-transparent text-muted hover:text-ink")}
    >
      {children}
    </button>
  );
}

function PickerDialog({ children, onClose, title, closeLabel }: { children: React.ReactNode; onClose: () => void; title: string; closeLabel: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog ref={ref} onClose={onClose} className="m-auto w-[min(64rem,calc(100vw-1rem))] rounded-2xl border border-line bg-surface p-0 text-ink shadow-2xl backdrop:bg-black/50">
      <div className="flex items-center justify-between border-b border-line px-5 py-3">
        <h2 className="font-sans text-base font-semibold tracking-normal">{title}</h2>
        <button type="button" onClick={() => ref.current?.close()} className="rounded-md px-2 py-1 text-sm text-muted hover:text-ink">
          {closeLabel}
        </button>
      </div>
      <div className="max-h-[80vh] overflow-y-auto p-5">{children}</div>
    </dialog>
  );
}
