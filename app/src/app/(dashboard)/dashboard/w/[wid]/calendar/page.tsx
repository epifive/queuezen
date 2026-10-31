import type { Metadata } from "next";
import { PenSquare } from "lucide-react";
import { addDaysStr, rangeOf, type CalendarView } from "@/components/dashboard/calendar-range";
import { CalendarBoard, type CalendarPost } from "@/components/dashboard/calendar-view";
import { DashHeader } from "@/components/dashboard/ui";
import { ButtonLink } from "@/components/ui/button";
import { getWorkspaceChannels } from "@/lib/channels";
import { getDb } from "@/lib/db";
import { requireWorkspace } from "@/lib/dashboard";
import { getLocale, getT } from "@/lib/i18n/server";
import { getMediaItems } from "@/lib/media/service";
import { listPosts } from "@/lib/posts";
import { isEditable, isPostStatus, localDay, parseJsonList, roleCan, zonedTimeToUtc } from "@/social/normalize";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("dash.nav.calendar") };
}

const VIEWS: CalendarView[] = ["month", "week", "list"];

/** Calendar of the workspace's posts (month / week / list) in its time zone. */
export default async function CalendarPage({ params, searchParams }: { params: Promise<{ wid: string }>; searchParams: Promise<{ view?: string; date?: string; channel?: string; label?: string; status?: string }> }) {
  const { workspace, role } = await requireWorkspace((await params).wid, "viewer");
  const query = await searchParams;
  const [t, locale, channels] = await Promise.all([getT(), getLocale(), getWorkspaceChannels(workspace.id, { includeDisconnected: true })]);
  const tz = workspace.timezone;
  const today = localDay(new Date().getTime(), tz);
  const view: CalendarView = VIEWS.includes(query.view as CalendarView) ? (query.view as CalendarView) : "month";
  const anchor = query.date && /^\d{4}-\d{2}-\d{2}$/.test(query.date) && Number.isFinite(Date.parse(query.date)) ? query.date : today;
  const weekStart = workspace.settings.weekStart;
  // The month grid covers the month view; the list shows that month; the week its 7 days.
  const range = rangeOf(view, anchor, weekStart);
  const startDay = view === "list" ? rangeOf("month", anchor, weekStart).start : range.start;
  const endDay = addDaysStr(startDay, view === "list" ? rangeOf("month", anchor, weekStart).days : range.days);
  const toUtc = (day: string) => {
    const [y, m, d] = day.split("-").map(Number);
    return new Date(zonedTimeToUtc({ year: y, month: m, day: d, hour: 0, minute: 0 }, tz)).toISOString();
  };
  const channelId = Number(query.channel) || undefined;
  const status = isPostStatus(query.status) ? [query.status] : undefined;
  const posts = await listPosts(workspace.id, { from: toUtc(startDay), to: toUtc(endDay), channelId, label: query.label || undefined, status, limit: 1000 });

  const db = await getDb();
  const labelRows = await db.selectFrom("posts").select("labels").where("workspace_id", "=", workspace.id).where("labels", "!=", "[]").limit(500).execute();
  const labels = [...new Set(labelRows.flatMap((r) => parseJsonList(r.labels)))].sort().slice(0, 100);
  const firstMedia = posts.map((p) => p.content.mediaIds[0]).filter((id): id is number => Boolean(id));
  const thumbs = new Map((await getMediaItems(workspace.id, firstMedia)).filter((m) => m.kind !== "video").map((m) => [m.id, m.url]));
  const channelById = new Map(channels.map((c) => [c.id, c]));
  const calendarPosts: CalendarPost[] = posts
    .filter((p) => p.scheduledAt)
    .map((p) => ({
      id: p.id,
      status: p.status,
      scheduledAt: p.scheduledAt!,
      text: p.content.text.replace(/\s+/g, " ").slice(0, 160),
      thumb: p.content.mediaIds[0] ? (thumbs.get(p.content.mediaIds[0]) ?? null) : null,
      labels: p.labels,
      editable: isEditable(p.status),
      targets: p.targets
        .filter((tg) => tg.status !== "cancelled")
        .map((tg) => ({ platform: tg.platform, channel: channelById.get(tg.channelId)?.name ?? tg.platform })),
    }));
  const canEdit = roleCan(role, "post.create");

  return (
    <>
      <DashHeader
        title={t("dash.nav.calendar")}
        description={t("dash.calendar.subtitle")}
        actions={
          canEdit ? (
            <ButtonLink href={`/dashboard/w/${workspace.id}/compose`}>
              <PenSquare aria-hidden />
              {t("dash.home.compose")}
            </ButtonLink>
          ) : null
        }
      />
      <CalendarBoard
        workspaceId={workspace.id}
        timezone={tz}
        locale={locale.code}
        weekStart={weekStart}
        view={view}
        anchor={anchor}
        today={today}
        posts={calendarPosts}
        channels={channels.filter((c) => c.status !== "disconnected").map((c) => ({ id: c.id, name: c.name, platform: c.platform }))}
        labels={labels}
        filters={{ channel: query.channel ?? "", label: query.label ?? "", status: query.status ?? "" }}
        canEdit={canEdit}
        explicitView={Boolean(query.view)}
      />
    </>
  );
}
