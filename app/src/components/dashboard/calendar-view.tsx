"use client";

import { useMemo, useState, useSyncExternalStore, useTransition, type DragEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarDays, ChevronLeft, ChevronRight, List, Plus, Rows3 } from "lucide-react";
import { reschedulePostAction } from "@/app/actions/dashboard/posts";
import { PlatformIcon } from "@/components/social/platform-icon";
import { Button, ButtonLink } from "@/components/ui/button";
import { Select } from "@/components/ui/field";
import { Segmented } from "@/components/ui/segmented";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import { postStatusTone } from "@/social/format";
import { localDay, localTime, zonedParts, zonedTimeToUtc } from "@/social/normalize";
import { POST_STATUSES, type Platform, type PostStatus } from "@/social/types";
import { addDaysStr, rangeOf, weekdayOf, type CalendarView } from "./calendar-range";

export type { CalendarView };

/**
 * The calendar: month, week and list views in the workspace's time zone. Posts are chips with
 * their networks and a status colour; editable ones can be dragged to another day (same time of
 * day). Clicking a chip opens the composer (or the post page when it can't be edited any more);
 * clicking an empty day starts a post on that day. Small screens get the list view by default.
 */


export interface CalendarPost {
  id: number;
  status: PostStatus;
  scheduledAt: string;
  text: string;
  thumb: string | null;
  labels: string[];
  targets: Array<{ platform: Platform; channel: string }>;
  editable: boolean;
}

const DRAGGABLE: PostStatus[] = ["draft", "pending_approval", "approved", "scheduled"];

/** Small screens get the list view unless the URL names a view. */
const SMALL = "(max-width: 639px)";
function subscribeSmall(onChange: () => void) {
  const mq = window.matchMedia(SMALL);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

export function CalendarBoard({
  workspaceId,
  timezone,
  locale,
  weekStart,
  view: initialView,
  anchor,
  today,
  posts: initialPosts,
  channels,
  labels,
  filters,
  canEdit,
  explicitView,
}: {
  workspaceId: number;
  timezone: string;
  locale: string;
  weekStart: 1 | 7;
  view: CalendarView;
  anchor: string;
  today: string;
  posts: CalendarPost[];
  channels: Array<{ id: number; name: string; platform: Platform }>;
  labels: string[];
  filters: { channel: string; label: string; status: string };
  canEdit: boolean;
  /** The view came from the URL (otherwise small screens switch to the list). */
  explicitView: boolean;
}) {
  const t = useT();
  const router = useRouter();
  const base = `/dashboard/w/${workspaceId}`;
  const [chosenView, setView] = useState<CalendarView | null>(null);
  const small = useSyncExternalStore(subscribeSmall, () => window.matchMedia(SMALL).matches, () => false);
  const view: CalendarView = chosenView ?? (!explicitView && small ? "list" : initialView);
  const [source, setSource] = useState(initialPosts);
  const [posts, setPosts] = useState(initialPosts);
  if (source !== initialPosts) {
    // New data from the server (navigation, refresh): drop optimistic moves.
    setSource(initialPosts);
    setPosts(initialPosts);
  }
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [, startTransition] = useTransition();


  const href = (patch: Record<string, string>) => {
    const p = new URLSearchParams({ view, date: anchor, ...filters, ...patch });
    for (const [k, v] of [...p.entries()]) if (!v) p.delete(k);
    return `${base}/calendar?${p.toString()}`;
  };
  const go = (patch: Record<string, string>) => router.push(href(patch), { scroll: false });

  const range = rangeOf(view, anchor, weekStart);
  const days = useMemo(() => Array.from({ length: range.days }, (_, i) => addDaysStr(range.start, i)), [range.start, range.days]);
  const byDay = useMemo(() => {
    const map = new Map<string, CalendarPost[]>();
    for (const p of posts) {
      const d = localDay(Date.parse(p.scheduledAt), timezone);
      map.set(d, [...(map.get(d) ?? []), p]);
    }
    for (const list of map.values()) list.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
    return map;
  }, [posts, timezone]);

  const step = (dir: -1 | 1) => {
    if (view === "week") return go({ date: addDaysStr(anchor, dir * 7) });
    const [y, m] = anchor.split("-").map(Number);
    const d = new Date(Date.UTC(y, m - 1 + dir, 1));
    go({ date: d.toISOString().slice(0, 10) });
  };

  const title = useMemo(() => {
    const d = new Date(`${anchor}T12:00:00Z`);
    if (view === "week") {
      const end = new Date(`${addDaysStr(range.start, 6)}T12:00:00Z`);
      const s = new Date(`${range.start}T12:00:00Z`);
      const fmt = (x: Date) => x.toLocaleDateString(locale, { month: "short", day: "numeric", timeZone: "UTC" });
      return `${fmt(s)} – ${fmt(end)}, ${end.getUTCFullYear()}`;
    }
    return d.toLocaleDateString(locale, { month: "long", year: "numeric", timeZone: "UTC" });
  }, [anchor, view, range.start, locale]);

  const onDrop = (e: DragEvent, day: string) => {
    e.preventDefault();
    setDragOver(null);
    const id = Number(e.dataTransfer.getData("text/x-qz-post"));
    const post = posts.find((p) => p.id === id);
    if (!post) return;
    const p = zonedParts(Date.parse(post.scheduledAt), timezone);
    const [y, m, d] = day.split("-").map(Number);
    const at = new Date(zonedTimeToUtc({ year: y, month: m, day: d, hour: p.hour, minute: p.minute }, timezone)).toISOString();
    if (localDay(Date.parse(post.scheduledAt), timezone) === day) return;
    const before = posts;
    setPosts((list) => list.map((x) => (x.id === id ? { ...x, scheduledAt: at } : x)));
    startTransition(async () => {
      const r = await reschedulePostAction(workspaceId, id, at);
      if (r.ok) {
        setMessage({ tone: "ok", text: t("dash.calendar.moved") });
        router.refresh();
      } else {
        setPosts(before);
        setMessage({ tone: "error", text: r.error ?? t("dash.calendar.err.locked") });
      }
    });
  };

  const chip = (p: CalendarPost, compact: boolean) => {
    const draggable = canEdit && p.editable && DRAGGABLE.includes(p.status);
    return (
      <Link
        key={p.id}
        href={p.editable ? `${base}/compose?post=${p.id}` : `${base}/posts/${p.id}`}
        draggable={draggable}
        onDragStart={(e) => {
          e.dataTransfer.setData("text/x-qz-post", String(p.id));
          e.dataTransfer.effectAllowed = "move";
        }}
        className={cn("group block rounded-md border-s-[3px] px-1.5 py-1 text-start text-xs hover:ring-1 hover:ring-primary-line", postStatusTone(p.status), draggable && "cursor-grab active:cursor-grabbing")}
        style={{ borderInlineStartColor: "currentColor" }}
        title={`${localTime(Date.parse(p.scheduledAt), timezone)} · ${t(`dash.postStatus.${p.status}`)} · ${p.text}`}
      >
        <span className="flex items-center gap-1">
          <span className="font-semibold tabular-nums">{localTime(Date.parse(p.scheduledAt), timezone)}</span>
          <span className="flex -space-x-1 rtl:space-x-reverse">
            {p.targets.slice(0, compact ? 3 : 5).map((tg, i) => (
              <PlatformIcon key={i} platform={tg.platform} className="size-3.5 rounded-[3px] ring-1 ring-surface" title={tg.channel} />
            ))}
          </span>
          {p.targets.length > (compact ? 3 : 5) ? <span className="text-[10px]">+{p.targets.length - (compact ? 3 : 5)}</span> : null}
        </span>
        <span dir="auto" className={cn("mt-0.5 text-ink/90", compact ? "line-clamp-1" : "line-clamp-2")}>
          {p.text || t("dash.home.noText")}
        </span>
      </Link>
    );
  };

  const weekdayNames = useMemo(() => {
    const names: string[] = [];
    for (let i = 0; i < 7; i++) {
      const day = addDaysStr("2024-01-01", (weekStart === 1 ? 0 : -1) + i); // 2024-01-01 is a Monday
      names.push(new Date(`${day}T12:00:00Z`).toLocaleDateString(locale, { weekday: "short", timeZone: "UTC" }));
    }
    return names;
  }, [weekStart, locale]);

  const dayLabel = (day: string, long = false) => new Date(`${day}T12:00:00Z`).toLocaleDateString(locale, long ? { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" } : { day: "numeric", timeZone: "UTC" });

  const dropProps = (day: string) =>
    canEdit
      ? {
          onDragOver: (e: DragEvent) => {
            e.preventDefault();
            setDragOver(day);
          },
          onDragLeave: () => setDragOver((d) => (d === day ? null : d)),
          onDrop: (e: DragEvent) => onDrop(e, day),
        }
      : {};

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <Button variant="outline" size="sm" onClick={() => step(-1)} aria-label={t("dash.calendar.previous")}>
            <ChevronLeft className="rtl:rotate-180" aria-hidden />
          </Button>
          <Button variant="outline" size="sm" onClick={() => go({ date: today })}>
            {t("dash.calendar.today")}
          </Button>
          <Button variant="outline" size="sm" onClick={() => step(1)} aria-label={t("dash.calendar.next")}>
            <ChevronRight className="rtl:rotate-180" aria-hidden />
          </Button>
        </div>
        <h2 className="min-w-0 flex-1 truncate font-sans text-lg font-semibold tracking-normal">{title}</h2>
        <Segmented<CalendarView>
          value={view}
          onChange={(v) => {
            setView(v);
            go({ view: v });
          }}
          label={t("dash.calendar.view")}
          options={[
            { value: "month", label: <span className="inline-flex items-center gap-1.5"><CalendarDays className="size-4" aria-hidden />{t("dash.calendar.month")}</span> },
            { value: "week", label: <span className="inline-flex items-center gap-1.5"><Rows3 className="size-4" aria-hidden />{t("dash.calendar.week")}</span> },
            { value: "list", label: <span className="inline-flex items-center gap-1.5"><List className="size-4" aria-hidden />{t("dash.calendar.list")}</span> },
          ]}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={filters.channel} onChange={(e) => go({ channel: e.target.value })} aria-label={t("dash.calendar.channel")} className="h-9! w-auto! max-w-full">
          <option value="">{t("dash.calendar.allChannels")}</option>
          {channels.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <Select value={filters.status} onChange={(e) => go({ status: e.target.value })} aria-label={t("dash.calendar.status")} className="h-9! w-auto!">
          <option value="">{t("dash.calendar.allStatuses")}</option>
          {POST_STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(`dash.postStatus.${s}`)}
            </option>
          ))}
        </Select>
        {labels.length ? (
          <Select value={filters.label} onChange={(e) => go({ label: e.target.value })} aria-label={t("dash.calendar.label")} className="h-9! w-auto! max-w-full">
            <option value="">{t("dash.calendar.allLabels")}</option>
            {labels.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </Select>
        ) : null}
        <span className="ms-auto text-xs text-muted">{t("dash.calendar.tz", { tz: timezone.replaceAll("_", " ") })}</span>
      </div>
      {message ? (
        <p role={message.tone === "error" ? "alert" : "status"} className={cn("text-sm", message.tone === "error" ? "text-red-600 dark:text-red-400" : "text-emerald-700 dark:text-emerald-400")}>
          {message.text}
        </p>
      ) : null}

      {view === "month" ? (
        <div className="overflow-hidden rounded-xl border border-line bg-surface">
          <div className="grid grid-cols-7 border-b border-line bg-paper text-center text-xs font-medium text-muted">
            {weekdayNames.map((n) => (
              <div key={n} className="py-2">
                {n}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {days.map((day) => {
              const list = byDay.get(day) ?? [];
              const inMonth = day.slice(0, 7) === anchor.slice(0, 7);
              return (
                <div
                  key={day}
                  {...dropProps(day)}
                  className={cn("group/day min-h-28 min-w-0 border-e border-b border-line p-1.5 [&:nth-child(7n)]:border-e-0", !inMonth && "bg-paper/60", dragOver === day && "bg-primary-soft")}
                >
                  <div className="mb-1 flex items-center justify-between">
                    <span className={cn("grid size-6 place-items-center rounded-full text-xs tabular-nums", day === today ? "bg-primary font-semibold text-white" : inMonth ? "text-ink" : "text-muted")}>{dayLabel(day)}</span>
                    {canEdit && day >= today ? (
                      <Link href={`${base}/compose?date=${day}`} className="rounded p-0.5 text-muted opacity-0 group-hover/day:opacity-100 focus:opacity-100 hover:text-primary" aria-label={t("dash.calendar.newOn", { day: dayLabel(day, true) })}>
                        <Plus className="size-3.5" aria-hidden />
                      </Link>
                    ) : null}
                  </div>
                  <div className="space-y-1">
                    {list.slice(0, 3).map((p) => chip(p, true))}
                    {list.length > 3 ? (
                      <button type="button" onClick={() => go({ view: "list", date: day })} className="w-full rounded px-1 text-start text-[11px] font-medium text-primary hover:underline">
                        {t("dash.calendar.more", { n: list.length - 3 })}
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : view === "week" ? (
        <div className="grid gap-2 sm:grid-cols-7">
          {days.map((day) => {
            const list = byDay.get(day) ?? [];
            return (
              <div key={day} {...dropProps(day)} className={cn("min-h-40 min-w-0 rounded-xl border border-line bg-surface p-2", dragOver === day && "bg-primary-soft", day === today && "border-primary-line")}>
                <div className="mb-2 flex items-center justify-between gap-1">
                  <span className="text-xs">
                    <span className="text-muted">{weekdayNames[(weekdayOf(day) - (weekStart === 1 ? 1 : 0) + 7) % 7]}</span>{" "}
                    <span className={cn("font-semibold tabular-nums", day === today && "text-primary")}>{dayLabel(day)}</span>
                  </span>
                  {canEdit && day >= today ? (
                    <Link href={`${base}/compose?date=${day}`} className="rounded p-0.5 text-muted hover:text-primary" aria-label={t("dash.calendar.newOn", { day: dayLabel(day, true) })}>
                      <Plus className="size-3.5" aria-hidden />
                    </Link>
                  ) : null}
                </div>
                <div className="space-y-1.5">{list.map((p) => chip(p, false))}</div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="space-y-4">
          {days.filter((d) => byDay.has(d)).length ? (
            days
              .filter((d) => byDay.has(d))
              .map((day) => (
                <section key={day} className="overflow-hidden rounded-xl border border-line bg-surface" {...dropProps(day)}>
                  <h3 className={cn("border-b border-line bg-paper px-4 py-2 font-sans text-sm font-semibold tracking-normal", day === today && "text-primary")}>{dayLabel(day, true)}</h3>
                  <ul className="divide-y divide-line">
                    {(byDay.get(day) ?? []).map((p) => (
                      <li key={p.id}>
                        <Link href={p.editable ? `${base}/compose?post=${p.id}` : `${base}/posts/${p.id}`} className="flex items-start gap-3 px-4 py-3 hover:bg-paper">
                          <span className="w-12 shrink-0 pt-0.5 text-sm font-semibold tabular-nums">{localTime(Date.parse(p.scheduledAt), timezone)}</span>
                          {p.thumb ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={p.thumb} alt="" className="size-11 shrink-0 rounded-md object-cover" />
                          ) : null}
                          <span className="min-w-0 flex-1">
                            <span dir="auto" className="line-clamp-2 text-sm">
                              {p.text || t("dash.home.noText")}
                            </span>
                            <span className="mt-1 flex flex-wrap items-center gap-1.5">
                              <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", postStatusTone(p.status))}>{t(`dash.postStatus.${p.status}`)}</span>
                              {p.targets.map((tg, i) => (
                                <PlatformIcon key={i} platform={tg.platform} className="size-4" title={tg.channel} />
                              ))}
                              {p.labels.map((l) => (
                                <bdi key={l} className="rounded-full bg-line/70 px-1.5 text-[11px] text-muted">
                                  {l}
                                </bdi>
                              ))}
                            </span>
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </section>
              ))
          ) : (
            <div className="rounded-xl border border-line bg-surface px-6 py-12 text-center">
              <CalendarDays className="mx-auto size-8 text-primary" aria-hidden />
              <p className="mt-3 font-medium">{t("dash.calendar.empty")}</p>
              {canEdit ? (
                <div className="mt-4 flex justify-center">
                  <ButtonLink href={`${base}/compose`}>{t("dash.home.compose")}</ButtonLink>
                </div>
              ) : null}
            </div>
          )}
        </div>
      )}
      {canEdit && view !== "list" ? <p className="text-xs text-muted">{t("dash.calendar.dragHint")}</p> : null}
    </div>
  );
}
