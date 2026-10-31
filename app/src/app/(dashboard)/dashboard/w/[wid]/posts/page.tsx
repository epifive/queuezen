import type { Metadata } from "next";
import Link from "next/link";
import { FileUp, PenSquare, StickyNote } from "lucide-react";
import { SelectAll } from "@/components/dashboard/client-kit";
import { PostBulkBar } from "@/components/dashboard/post-list";
import { DashHeader, DTable, DTd, DTh, Empty, LinkTabs, Pager, Panel } from "@/components/dashboard/ui";
import { PlatformIcon } from "@/components/social/platform-icon";
import { ButtonLink } from "@/components/ui/button";
import { getWorkspaceChannels } from "@/lib/channels";
import { intParam } from "@/lib/dash-format";
import { requireWorkspace } from "@/lib/dashboard";
import { getLocale, getT } from "@/lib/i18n/server";
import { countPostsByStatus, listPosts } from "@/lib/posts";
import { postStatusTone } from "@/social/format";
import { canPublishDirectly, roleCan } from "@/social/normalize";
import type { PostStatus, TargetStatus } from "@/social/types";
import { cn } from "@/lib/utils";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("dash.nav.posts") };
}

const TABS = {
  scheduled: { statuses: ["scheduled", "publishing"] as PostStatus[], order: "scheduled_asc" as const },
  drafts: { statuses: ["draft"] as PostStatus[], order: "updated_desc" as const },
  pending: { statuses: ["pending_approval", "approved"] as PostStatus[], order: "scheduled_asc" as const },
  published: { statuses: ["published", "partially_failed"] as PostStatus[], order: "scheduled_desc" as const },
  failed: { statuses: ["failed", "partially_failed"] as PostStatus[], order: "updated_desc" as const },
};
type Tab = keyof typeof TABS;
const PER_PAGE = 50;

/** Solid status dot of a publication. */
function targetDot(status: TargetStatus): string {
  if (status === "published") return "bg-emerald-500";
  if (status === "failed" || status === "needs_reauth") return "bg-red-500";
  if (status === "scheduled") return "bg-primary";
  if (status === "pending" || status === "cancelled") return "bg-slate-400";
  return "bg-amber-500";
}

/** Posts: scheduled, drafts, waiting for approval, published and failed, with bulk actions. */
export default async function PostsPage({ params, searchParams }: { params: Promise<{ wid: string }>; searchParams: Promise<{ tab?: string; page?: string; channel?: string; label?: string }> }) {
  const { workspace, role } = await requireWorkspace((await params).wid, "viewer");
  const query = await searchParams;
  const tab: Tab = query.tab && query.tab in TABS ? (query.tab as Tab) : "scheduled";
  const page = intParam(query.page, 1, 1000);
  const [t, locale, channels, counts] = await Promise.all([getT(), getLocale(), getWorkspaceChannels(workspace.id, { includeDisconnected: true }), countPostsByStatus(workspace.id)]);
  const channelId = Number(query.channel) || undefined;
  const posts = await listPosts(workspace.id, { status: TABS[tab].statuses, order: TABS[tab].order, channelId, label: query.label || undefined, limit: PER_PAGE + 1, offset: (page - 1) * PER_PAGE });
  const hasMore = posts.length > PER_PAGE;
  const shown = posts.slice(0, PER_PAGE);
  const base = `/dashboard/w/${workspace.id}`;
  const channelById = new Map(channels.map((c) => [c.id, c]));
  const canEdit = roleCan(role, "post.create");
  const count = (key: Tab) => TABS[key].statuses.reduce((n, s) => n + counts[s], 0);
  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString(locale.code, { timeZone: workspace.timezone, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
  const href = (patch: Record<string, string | number>) => {
    const p = new URLSearchParams({ tab, ...(query.channel ? { channel: query.channel } : {}), ...(query.label ? { label: query.label } : {}) });
    for (const [k, v] of Object.entries(patch)) p.set(k, String(v));
    return `${base}/posts?${p.toString()}`;
  };

  return (
    <>
      <DashHeader
        title={t("dash.nav.posts")}
        description={t("dash.posts.subtitle")}
        actions={
          canEdit ? (
            <>
              <ButtonLink href={`${base}/posts/import`} variant="outline">
                <FileUp aria-hidden />
                {t("dash.posts.import")}
              </ButtonLink>
              <ButtonLink href={`${base}/compose`}>
                <PenSquare aria-hidden />
                {t("dash.home.compose")}
              </ButtonLink>
            </>
          ) : null
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <LinkTabs
          label={t("dash.posts.tabs")}
          items={(Object.keys(TABS) as Tab[]).map((key) => ({ href: `${base}/posts?tab=${key}`, label: t(`dash.posts.tab.${key}`), active: key === tab, count: count(key) }))}
        />
        {channels.length > 1 ? (
          <form className="ms-auto flex gap-2" action={`${base}/posts`}>
            <input type="hidden" name="tab" value={tab} />
            <select name="channel" defaultValue={query.channel ?? ""} aria-label={t("dash.calendar.channel")} className="h-9 rounded-lg border border-line bg-surface px-2 text-sm">
              <option value="">{t("dash.calendar.allChannels")}</option>
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <button type="submit" className="h-9 rounded-lg border border-line bg-surface px-3 text-sm font-medium hover:border-primary-line">
              {t("dash.posts.filter")}
            </button>
          </form>
        ) : null}
      </div>

      <Panel padded={false}>
        {shown.length ? (
          <>
            {canEdit ? (
              <div className="border-b border-line p-3">
                <PostBulkBar workspaceId={workspace.id} canRetry={tab === "failed" && roleCan(role, "post.publish")} canReschedule={tab !== "published" && tab !== "failed" && canPublishDirectly(role, workspace.settings)} />
              </div>
            ) : null}
            <DTable minWidth={720} label={t("dash.nav.posts")}>
              <thead>
                <tr>
                  {canEdit ? (
                    <DTh className="w-8">
                      <SelectAll form="posts-bulk" label={t("dash.posts.selectAll")} />
                    </DTh>
                  ) : null}
                  <DTh>{t("dash.posts.post")}</DTh>
                  <DTh>{t("dash.posts.channels")}</DTh>
                  <DTh>{tab === "published" ? t("dash.posts.publishedAt") : t("dash.posts.when")}</DTh>
                  <DTh>{t("dash.posts.status")}</DTh>
                </tr>
              </thead>
              <tbody>
                {shown.map((post) => (
                  <tr key={post.id} className="hover:bg-paper/60">
                    {canEdit ? (
                      <DTd>
                        <input type="checkbox" name="post" value={post.id} form="posts-bulk" aria-label={t("dash.posts.select", { id: post.id })} className="size-4 accent-[var(--primary)]" />
                      </DTd>
                    ) : null}
                    <DTd className="max-w-md">
                      <Link href={`${base}/posts/${post.id}`} className="block hover:text-primary">
                        <span dir="auto" className="line-clamp-2">
                          {post.content.text || t("dash.home.noText")}
                        </span>
                      </Link>
                      {post.labels.length ? (
                        <span className="mt-1 flex flex-wrap gap-1">
                          {post.labels.map((l) => (
                            <bdi key={l} className="rounded-full bg-line/70 px-1.5 text-[11px] text-muted">
                              {l}
                            </bdi>
                          ))}
                        </span>
                      ) : null}
                    </DTd>
                    <DTd>
                      <span className="flex flex-wrap gap-1">
                        {post.targets
                          .filter((tg) => tg.status !== "cancelled")
                          .map((tg) => (
                            <span key={tg.id} className="relative" title={`${channelById.get(tg.channelId)?.name ?? ""} · ${t(`dash.targetStatus.${tg.status}`)}`}>
                              <PlatformIcon platform={tg.platform} className="size-6" title={channelById.get(tg.channelId)?.name} />
                              <span className={cn("absolute -end-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-surface", targetDot(tg.status))} aria-hidden />
                            </span>
                          ))}
                      </span>
                    </DTd>
                    <DTd className="whitespace-nowrap text-muted tabular-nums">{fmt(tab === "published" ? post.publishedAt : post.scheduledAt)}</DTd>
                    <DTd>
                      <span className={cn("inline-flex rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap", postStatusTone(post.status))}>{t(`dash.postStatus.${post.status}`)}</span>
                    </DTd>
                  </tr>
                ))}
              </tbody>
            </DTable>
            <Pager
              page={page}
              pages={hasMore ? page + 1 : page}
              href={(p) => href({ page: p })}
              labels={{ summary: t("dash.posts.page", { n: page }), previous: t("dash.posts.previous"), next: t("dash.posts.next"), nav: t("dash.posts.pages") }}
            />
          </>
        ) : (
          <Empty icon={<StickyNote />} title={t(`dash.posts.empty.${tab}`)} action={canEdit ? <ButtonLink href={`${base}/compose`}>{t("dash.home.compose")}</ButtonLink> : null}>
            {t("dash.posts.emptyText")}
          </Empty>
        )}
      </Panel>
    </>
  );
}
