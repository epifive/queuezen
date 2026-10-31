import type { Metadata } from "next";
import Link from "next/link";
import { ArrowDown, ArrowUp, ListOrdered, Pause, Play, Shuffle } from "lucide-react";
import { shuffleQueueAction, swapQueueAction, toggleQueuePauseAction } from "@/app/actions/dashboard/queue";
import { ActionButton } from "@/components/dashboard/actions";
import { QueueSlotsEditor } from "@/components/dashboard/queue-slots";
import { DashHeader, Empty, Panel } from "@/components/dashboard/ui";
import { PlatformIcon } from "@/components/social/platform-icon";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { getWorkspaceChannels } from "@/lib/channels";
import { requireWorkspace } from "@/lib/dashboard";
import { channelQueue, nextFreeSlot, pausedChannels } from "@/lib/engine/targets";
import { getLocale, getT } from "@/lib/i18n/server";
import { getPost } from "@/lib/posts";
import { platformShortName } from "@/social/format";
import { canPublishDirectly } from "@/social/normalize";
import { cn } from "@/lib/utils";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("dash.nav.queue") };
}

/** Queue: a channel's weekly posting times, its upcoming queue (reorder, shuffle) and pause. */
export default async function QueuePage({ params, searchParams }: { params: Promise<{ wid: string }>; searchParams: Promise<{ channel?: string }> }) {
  const { workspace, role } = await requireWorkspace((await params).wid, "viewer");
  const query = await searchParams;
  const [t, locale, channels, paused] = await Promise.all([getT(), getLocale(), getWorkspaceChannels(workspace.id), pausedChannels(workspace.id)]);
  const base = `/dashboard/w/${workspace.id}`;
  const tz = workspace.timezone;
  const canEdit = canPublishDirectly(role, workspace.settings);

  if (!channels.length) {
    return (
      <>
        <DashHeader title={t("dash.nav.queue")} description={t("dash.queue.subtitle")} />
        <Panel>
          <Empty icon={<ListOrdered />} title={t("dash.queue.noChannels")} action={<ButtonLink href={`${base}/channels`}>{t("dash.home.connect")}</ButtonLink>}>
            {t("dash.queue.noChannelsText")}
          </Empty>
        </Panel>
      </>
    );
  }

  const channel = channels.find((c) => c.id === Number(query.channel)) ?? channels[0];
  const isPaused = paused.has(channel.id);
  const [queue, next] = await Promise.all([channelQueue(workspace.id, channel.id, 50), nextFreeSlot([channel], tz)]);
  const posts = await Promise.all([...new Set(queue.map((q) => q.postId))].map((id) => getPost(workspace.id, id)));
  const postById = new Map(posts.filter(Boolean).map((p) => [p!.id, p!]));
  const fmt = (iso: string) => new Date(iso).toLocaleString(locale.code, { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

  return (
    <>
      <DashHeader title={t("dash.nav.queue")} description={t("dash.queue.subtitleTz", { tz: tz.replaceAll("_", " ") })} />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[240px_minmax(0,1fr)]">
        <nav aria-label={t("dash.queue.channels")} className="min-w-0">
          <ul className="flex gap-1 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible">
            {channels.map((c) => (
              <li key={c.id} className="shrink-0">
                <Link
                  href={`${base}/queue?channel=${c.id}`}
                  aria-current={c.id === channel.id ? "page" : undefined}
                  className={cn("flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium", c.id === channel.id ? "bg-surface text-primary ring-1 ring-line" : "text-muted hover:text-ink")}
                >
                  <PlatformIcon platform={c.platform} className="size-5" />
                  <bdi className="max-w-40 truncate">{c.name}</bdi>
                  {paused.has(c.id) ? <Pause className="size-3.5 text-amber-600" aria-label={t("dash.queue.paused")} /> : null}
                  <span className="ms-auto rounded-full bg-line/70 px-1.5 text-[11px] tabular-nums">{c.queueSlots.length}</span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <div className="min-w-0 space-y-6">
          {isPaused ? <Alert tone="warning">{t("dash.queue.pausedHint")}</Alert> : null}
          <Panel
            title={
              <span className="flex items-center gap-2">
                <PlatformIcon platform={channel.platform} className="size-5" />
                <bdi>{channel.name}</bdi>
                <span className="text-xs font-normal text-muted">{platformShortName(channel.platform)}</span>
                {isPaused ? <Badge tone="warning">{t("dash.queue.paused")}</Badge> : null}
              </span>
            }
            description={next ? t("dash.queue.next", { when: fmt(next) }) : t("dash.queue.noNext")}
            actions={
              canEdit ? (
                <>
                  <ActionButton action={toggleQueuePauseAction} fields={{ wid: workspace.id, channel: channel.id, paused: isPaused ? "0" : "1" }} variant="outline">
                    {isPaused ? <Play aria-hidden /> : <Pause aria-hidden />}
                    {isPaused ? t("dash.queue.resume") : t("dash.queue.pause")}
                  </ActionButton>
                  <ActionButton action={shuffleQueueAction} fields={{ wid: workspace.id, channel: channel.id }} variant="outline" confirmText={t("dash.queue.shuffleConfirm")}>
                    <Shuffle aria-hidden />
                    {t("dash.queue.shuffle")}
                  </ActionButton>
                </>
              ) : null
            }
            padded={false}
          >
            {queue.length ? (
              <ol className="divide-y divide-line">
                {queue.map((entry, i) => {
                  const post = postById.get(entry.postId);
                  const prev = queue[i - 1];
                  const nextEntry = queue[i + 1];
                  return (
                    <li key={entry.targetId} className="flex items-start gap-3 px-5 py-3">
                      <span className="w-6 shrink-0 pt-0.5 text-xs text-muted tabular-nums">{i + 1}</span>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-semibold text-primary">{fmt(entry.scheduledAt)}</p>
                        <Link href={`${base}/compose?post=${entry.postId}`} dir="auto" className="mt-0.5 line-clamp-2 text-sm hover:text-primary">
                          {post?.content.text || t("dash.home.noText")}
                        </Link>
                        {entry.multiChannel ? <p className="mt-1 text-xs text-muted">{t("dash.queue.multi")}</p> : null}
                      </div>
                      {canEdit ? (
                        <div className="flex shrink-0 gap-1">
                          {prev ? (
                            <ActionButton action={swapQueueAction} fields={{ wid: workspace.id, a: entry.postId, b: prev.postId }} variant="ghost" label={t("dash.queue.moveUp")}>
                              <ArrowUp aria-hidden />
                            </ActionButton>
                          ) : null}
                          {nextEntry ? (
                            <ActionButton action={swapQueueAction} fields={{ wid: workspace.id, a: entry.postId, b: nextEntry.postId }} variant="ghost" label={t("dash.queue.moveDown")}>
                              <ArrowDown aria-hidden />
                            </ActionButton>
                          ) : null}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ol>
            ) : (
              <Empty icon={<ListOrdered />} title={t("dash.queue.empty")}>
                {t("dash.queue.emptyText")}
              </Empty>
            )}
          </Panel>

          <Panel title={t("dash.queue.slotsTitle")} description={t("dash.queue.slotsHint", { tz: tz.replaceAll("_", " ") })}>
            {canEdit ? (
              <QueueSlotsEditor key={channel.id} workspaceId={workspace.id} channelId={channel.id} slots={channel.queueSlots} weekStart={workspace.settings.weekStart} locale={locale.code} />
            ) : (
              <p className="text-sm text-muted">{t("dash.queue.readOnly")}</p>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}
