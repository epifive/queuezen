import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ExternalLink, History, PenSquare, RotateCcw, Trash2 } from "lucide-react";
import { deletePostAction, deleteRemoteAction, retryTargetAction } from "@/app/actions/dashboard/posts";
import { ActionButton } from "@/components/dashboard/actions";
import { ApprovalComments } from "@/components/dashboard/approval-comments";
import { DuplicateButton, PostAutoRefresh } from "@/components/dashboard/post-live";
import { DashHeader, Panel } from "@/components/dashboard/ui";
import { PlatformIcon } from "@/components/social/platform-icon";
import { Alert } from "@/components/ui/alert";
import { ButtonLink } from "@/components/ui/button";
import { getWorkspaceChannels } from "@/lib/channels";
import { formatNumber } from "@/lib/dash-format";
import { requireWorkspace } from "@/lib/dashboard";
import { getAttempts } from "@/lib/engine/targets";
import { getLocale, getT } from "@/lib/i18n/server";
import type { MessageKey } from "@/lib/i18n/messages";
import { getMediaItems } from "@/lib/media/service";
import { getPost } from "@/lib/posts";
import { platformShortName, postStatusTone, targetStatusTone } from "@/social/format";
import { isEditable, mergeContent, roleCan } from "@/social/normalize";
import { cn } from "@/lib/utils";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("dash.post.title") };
}

const DONE: Record<string, MessageKey> = {
  schedule: "dash.post.done.schedule",
  queue: "dash.post.done.queue",
  publish_now: "dash.post.done.publish_now",
  submit: "dash.post.done.submit",
};

/** One post: its content, every channel's publication (status, link, error, retry), attempts and notes. */
export default async function PostPage({ params, searchParams }: { params: Promise<{ wid: string; id: string }>; searchParams: Promise<{ done?: string }> }) {
  const { wid, id } = await params;
  const { workspace, role } = await requireWorkspace(wid, "viewer");
  const post = await getPost(workspace.id, Number(id));
  if (!post) notFound();
  const query = await searchParams;
  const [t, locale, channels, attempts] = await Promise.all([getT(), getLocale(), getWorkspaceChannels(workspace.id, { includeDisconnected: true }), getAttempts(workspace.id, post.id)]);
  const media = await getMediaItems(workspace.id, post.content.mediaIds);
  const channelById = new Map(channels.map((c) => [c.id, c]));
  const base = `/dashboard/w/${workspace.id}`;
  const tz = workspace.timezone;
  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString(locale.code, { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
  const canEdit = roleCan(role, "post.create");
  const canPublish = roleCan(role, "post.publish");
  const live = post.status === "publishing" || (post.status === "scheduled" && Boolean(post.scheduledAt) && Date.parse(post.scheduledAt!) < new Date().getTime() + 60_000);
  const done = query.done ? DONE[query.done] : undefined;
  const targetById = new Map(post.targets.map((tg) => [tg.id, tg]));

  return (
    <>
      <PostAutoRefresh active={live} />
      <DashHeader
        title={t("dash.post.title")}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", postStatusTone(post.status))}>{t(`dash.postStatus.${post.status}`)}</span>
            <span>{post.status === "published" || post.status === "partially_failed" ? t("dash.post.publishedOn", { when: fmt(post.publishedAt) }) : post.scheduledAt ? t("dash.post.scheduledFor", { when: fmt(post.scheduledAt) }) : t("dash.post.noDate")}</span>
          </span>
        }
        actions={
          canEdit ? (
            <>
              {isEditable(post.status) ? (
                <ButtonLink href={`${base}/compose?post=${post.id}`}>
                  <PenSquare aria-hidden />
                  {t("dash.post.edit")}
                </ButtonLink>
              ) : null}
              <DuplicateButton workspaceId={workspace.id} postId={post.id} />
              {post.status !== "publishing" ? (
                <ActionButton action={deletePostAction} fields={{ wid: workspace.id, post: post.id }} variant="outline" size="md" confirmText={t("dash.post.deleteConfirm")}>
                  <Trash2 aria-hidden />
                  {t("dash.post.delete")}
                </ActionButton>
              ) : null}
            </>
          ) : null
        }
      />
      {done ? (
        <Alert tone="success" className="mb-5">
          {t(done)}
        </Alert>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-6">
          <Panel title={t("dash.post.channels")} padded={false}>
            {/* One row per channel; the error gets its own full-width line under it, so long API
                messages stay readable and the actions stay visible on small screens. */}
            <div className="text-sm sm:grid sm:grid-cols-[minmax(8rem,1fr)_auto_minmax(6.5rem,auto)_auto] sm:gap-x-4">
              <div aria-hidden className="hidden border-b border-line bg-paper px-5 py-2.5 text-xs font-medium whitespace-nowrap text-muted sm:col-span-full sm:grid sm:grid-cols-subgrid">
                <span>{t("dash.post.channel")}</span>
                <span>{t("dash.posts.status")}</span>
                <span>{t("dash.post.result")}</span>
                <span />
              </div>
              <ul className="divide-y divide-line sm:col-span-full sm:grid sm:grid-cols-subgrid">
                {post.targets.map((tg) => {
                  const channel = channelById.get(tg.channelId);
                  const retry = canPublish && (tg.status === "failed" || tg.status === "needs_reauth");
                  const removable = canPublish && tg.status === "published" && Boolean(tg.externalId);
                  return (
                    <li key={tg.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 px-5 py-3.5 sm:col-span-full sm:grid-cols-subgrid sm:gap-x-4">
                      <span className="flex min-w-0 items-center gap-2">
                        <PlatformIcon platform={tg.platform} className="size-6" />
                        <span className="min-w-0">
                          <bdi className="block truncate font-medium">{channel?.name ?? platformShortName(tg.platform)}</bdi>
                          <span className="text-xs text-muted">{platformShortName(tg.platform)}</span>
                        </span>
                      </span>
                      <span className="justify-self-end text-end sm:justify-self-start sm:text-start">
                        <span className={cn("inline-flex rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap", targetStatusTone(tg.status))}>{t(`dash.targetStatus.${tg.status}`)}</span>
                        {tg.attempts > 1 || (tg.attempts > 0 && tg.status !== "published") ? (
                          <span className="mt-1 block text-xs whitespace-nowrap text-muted tabular-nums">
                            {t("dash.post.attempts")}: {formatNumber(tg.attempts, locale.code)}
                          </span>
                        ) : null}
                      </span>
                      <span className="col-span-full flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 empty:hidden sm:col-span-1 sm:block sm:empty:block">
                        {tg.permalink ? (
                          <a href={tg.permalink} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm font-medium whitespace-nowrap text-primary hover:underline">
                            {t("dash.post.view")}
                            <ExternalLink className="size-3.5" aria-hidden />
                          </a>
                        ) : null}
                        {tg.publishedAt ? <span className="block text-xs text-muted">{fmt(tg.publishedAt)}</span> : null}
                      </span>
                      <span className="col-span-full flex flex-wrap gap-1 empty:hidden sm:col-span-1 sm:justify-end sm:empty:flex">
                        {retry ? (
                          <ActionButton action={retryTargetAction} fields={{ wid: workspace.id, target: tg.id }} variant="outline">
                            <RotateCcw aria-hidden />
                            {t("dash.post.retryNow")}
                          </ActionButton>
                        ) : null}
                        {removable ? (
                          <ActionButton action={deleteRemoteAction} fields={{ wid: workspace.id, target: tg.id }} variant="ghost" confirmText={t("dash.post.deleteRemoteConfirm", { network: platformShortName(tg.platform) })} showSuccess>
                            <Trash2 aria-hidden />
                            {t("dash.post.deleteRemote")}
                          </ActionButton>
                        ) : null}
                      </span>
                      {tg.error || tg.status === "needs_reauth" || (tg.status === "scheduled" && tg.attempts > 0 && tg.nextAttemptAt) ? (
                        <div className="col-span-full min-w-0 space-y-1">
                          {tg.status === "scheduled" && tg.attempts > 0 && tg.nextAttemptAt ? <p className="text-xs text-muted">{t("dash.post.retryAt", { when: fmt(tg.nextAttemptAt) })}</p> : null}
                          {tg.error ? (
                            <p dir="auto" className={cn("rounded-lg px-3 py-2 text-xs leading-relaxed break-words", tg.status === "published" || tg.status === "cancelled" ? "bg-paper text-muted" : "bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-300")}>
                              {tg.error}
                            </p>
                          ) : null}
                          {tg.status === "needs_reauth" ? (
                            <Link href={`${base}/channels`} className="inline-block text-xs font-medium text-primary hover:underline">
                              {t("dash.post.reconnect")}
                            </Link>
                          ) : null}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          </Panel>

          <Panel title={t("dash.post.history")} padded={false}>
            {attempts.length ? (
              <ol className="divide-y divide-line">
                {attempts.map((a) => {
                  const tg = targetById.get(a.targetId);
                  return (
                    <li key={a.id} className="flex items-start gap-3 px-5 py-3 text-sm">
                      <History className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
                      <div className="min-w-0 flex-1">
                        <p className="flex flex-wrap items-center gap-x-2">
                          {tg ? <PlatformIcon platform={tg.platform} className="size-4" /> : null}
                          <span className="font-medium">{t(`dash.attempt.${a.outcome}` as MessageKey)}</span>
                          <span className="text-xs text-muted">
                            {t("dash.post.attemptN", { n: a.attempt })} · {fmt(a.startedAt)} · {formatNumber(Math.round(a.durationMs / 100) / 10, locale.code)} s
                          </span>
                        </p>
                        {a.error ? (
                          <p dir="auto" className="mt-0.5 text-xs text-muted">
                            {a.error}
                          </p>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ol>
            ) : (
              <p className="px-5 py-6 text-sm text-muted">{t("dash.post.noAttempts")}</p>
            )}
          </Panel>
        </div>

        <div className="min-w-0 space-y-6">
          <Panel title={t("dash.post.content")}>
            <p dir="auto" className="text-sm break-words whitespace-pre-wrap">
              {post.content.text || <span className="text-muted">{t("dash.home.noText")}</span>}
            </p>
            {media.length ? (
              <div className="mt-3 grid grid-cols-3 gap-1.5">
                {media.map((m) =>
                  m.kind === "video" ? (
                    <video key={m.id} src={`${m.url}#t=0.1`} preload="metadata" muted className="aspect-square w-full rounded-md bg-black object-cover" />
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img key={m.id} src={m.url} alt={m.altText} className="aspect-square w-full rounded-md object-cover" />
                  ),
                )}
              </div>
            ) : null}
            {post.content.link ? (
              <p dir="ltr" className="mt-3 truncate text-xs">
                <a href={post.content.link} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                  {post.content.link}
                </a>
              </p>
            ) : null}
            {post.content.firstComment ? (
              <div className="mt-3 rounded-lg bg-paper p-2.5 text-xs">
                <p className="font-medium text-muted">{t("dash.compose.firstComment")}</p>
                <p dir="auto" className="mt-0.5 whitespace-pre-wrap">
                  {post.content.firstComment}
                </p>
              </div>
            ) : null}
            {post.content.thread.length ? (
              <ol className="mt-3 space-y-1.5 text-xs">
                {post.content.thread.map((part, i) => (
                  <li key={i} className="rounded-lg bg-paper p-2.5">
                    <p className="font-medium text-muted">{t("dash.compose.part", { n: i + 2 })}</p>
                    <p dir="auto" className="mt-0.5 whitespace-pre-wrap">
                      {part}
                    </p>
                  </li>
                ))}
              </ol>
            ) : null}
            {post.targets.some((tg) => Object.keys(tg.override).some((k) => k !== "options")) ? (
              <div className="mt-4 space-y-2 border-t border-line pt-3">
                <p className="text-xs font-medium text-muted">{t("dash.post.customised")}</p>
                {post.targets
                  .filter((tg) => tg.override.text !== undefined)
                  .map((tg) => (
                    <div key={tg.id} className="rounded-lg border border-line p-2.5 text-xs">
                      <p className="mb-1 flex items-center gap-1.5 font-medium">
                        <PlatformIcon platform={tg.platform} className="size-4" />
                        <bdi>{channelById.get(tg.channelId)?.name}</bdi>
                      </p>
                      <p dir="auto" className="line-clamp-4 whitespace-pre-wrap">
                        {mergeContent(post.content, tg.override).text}
                      </p>
                    </div>
                  ))}
              </div>
            ) : null}
            {post.labels.length ? (
              <p className="mt-3 flex flex-wrap gap-1">
                {post.labels.map((l) => (
                  <bdi key={l} className="rounded-full bg-primary-soft px-2 py-0.5 text-xs text-primary">
                    {l}
                  </bdi>
                ))}
              </p>
            ) : null}
          </Panel>

          <Panel title={t("dash.post.notes")}>
            <ApprovalComments workspaceId={workspace.id} postId={post.id} canComment={roleCan(role, "comment")} compact />
          </Panel>
        </div>
      </div>
    </>
  );
}
