import type { Metadata } from "next";
import Link from "next/link";
import { CheckCheck, ExternalLink, Link2, Lock, Trash2 } from "lucide-react";
import { decideApprovalAction, revokeApprovalLinkAction } from "@/app/actions/dashboard/approvals";
import { ActionButton } from "@/components/dashboard/actions";
import { ApprovalComments } from "@/components/dashboard/approval-comments";
import { ApprovalLinkForm, DecisionForm } from "@/components/dashboard/approval-forms";
import { formatInZone, PostPreview } from "@/components/dashboard/approval-preview";
import { Initial } from "@/components/dashboard/kit";
import { TeamTabs } from "@/components/dashboard/team-tabs";
import { DashHeader, Empty, Panel } from "@/components/dashboard/ui";
import { Badge } from "@/components/ui/badge";
import { buttonClass } from "@/components/ui/button";
import { getApprovalLinks, getPendingApprovals, getShowcaseApprovalLink, isLinkActive } from "@/lib/approvals";
import { getWorkspaceChannels } from "@/lib/channels";
import { isDemoMode } from "@/lib/config";
import { formatDateTime, formatRelative } from "@/lib/dash-format";
import { requireWorkspace } from "@/lib/dashboard";
import { plural } from "@/lib/i18n/messages";
import { getLocale, getT } from "@/lib/i18n/server";
import { getMediaInfo } from "@/lib/posts";
import { getMembers, getWorkspaceEntitlements } from "@/lib/workspaces";
import { roleCan } from "@/social/normalize";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("dash.approvals.title") };
}

/** The approvers' inbox (posts waiting for approval) and the client approval links. */
export default async function ApprovalsPage({ params }: { params: Promise<{ wid: string }> }) {
  const { user, workspace, role } = await requireWorkspace((await params).wid);
  const [t, locale, pending, channels, members, links, entitlements, showcase] = await Promise.all([
    getT(),
    getLocale(),
    getPendingApprovals(workspace.id),
    getWorkspaceChannels(workspace.id, { includeDisconnected: true }),
    getMembers(workspace.id),
    getApprovalLinks(workspace.id),
    getWorkspaceEntitlements(workspace),
    // Demo: real links keep only a hash, so the seeded showcase link gets an "Open" button.
    isDemoMode() ? getShowcaseApprovalLink() : Promise.resolve(undefined),
  ]);
  const lc = locale.code;
  const canApprove = roleCan(role, "approve");
  const canComment = roleCan(role, "comment");
  const visible = canApprove ? pending : pending.filter((p) => p.authorId === user.id);
  const media = new Map((await getMediaInfo(workspace.id, visible.flatMap((p) => [...p.content.mediaIds, ...p.targets.flatMap((tg) => tg.override.mediaIds ?? [])]))).map((m) => [m.id, m]));
  const channelMap = new Map(channels.map((c) => [c.id, { name: c.name, platform: c.platform }]));
  const names = new Map(members.map((m) => [m.userId, m.name]));
  const previewLabels = { noText: t("dash.home.noText"), noDate: t("dash.approvals.noDate"), versionFor: t("dash.approvals.versionFor"), firstComment: t("dash.approvals.firstComment"), thread: t("dash.approvals.thread") };
  const now = new Date().toISOString();
  // Range ends are stored as the start of the next day: show the last included day.
  const dayInZone = (iso: string | null, shiftMs: number) => (iso ? new Date(Date.parse(iso) + shiftMs).toLocaleDateString(lc, { year: "numeric", month: "short", day: "numeric", timeZone: workspace.timezone }) : "");

  return (
    <div className="space-y-6">
      <DashHeader title={t("dash.approvals.title")} description={canApprove ? t("dash.approvals.subtitle") : t("dash.approvals.subtitleOwn")} />
      <TeamTabs workspaceId={workspace.id} active="approvals" pending={pending.length} labels={{ members: t("dash.team.tabMembers"), approvals: t("dash.team.tabApprovals"), nav: t("dash.nav.team") }} />

      {visible.length ? (
        <ul className="space-y-4">
          {visible.map((post) => (
            <li key={post.id}>
              <Panel padded={false}>
                <div className="grid gap-0 lg:grid-cols-[minmax(0,1fr)_320px]">
                  <div className="min-w-0 p-5">
                    <p className="mb-3 flex flex-wrap items-center gap-2 text-xs text-muted">
                      <Initial name={names.get(post.authorId ?? 0) ?? "?"} className="size-6" />
                      <bdi dir="auto" className="font-medium text-ink">
                        {names.get(post.authorId ?? 0) ?? t("dash.approvals.unknownAuthor")}
                      </bdi>
                      <span>· {t("dash.approvals.submitted", { when: formatRelative(post.updatedAt, lc) })}</span>
                      {post.source !== "manual" ? <Badge>{t(`dash.approvals.source.${post.source}`)}</Badge> : null}
                      <Link href={`/dashboard/w/${workspace.id}/posts/${post.id}`} className="ms-auto font-medium text-primary hover:underline">
                        {t("dash.approvals.open")}
                      </Link>
                    </p>
                    <PostPreview post={post} channels={channelMap} media={media} locale={lc} timeZone={workspace.timezone} labels={previewLabels} />
                    <details className="group mt-5 border-t border-line pt-4">
                      <summary className="cursor-pointer text-sm font-medium text-primary">{t("dash.comments.title")}</summary>
                      <div className="mt-3">
                        <ApprovalComments workspaceId={workspace.id} postId={post.id} canComment={canComment} compact />
                      </div>
                    </details>
                  </div>
                  <div className="border-t border-line bg-paper/60 p-5 lg:border-s lg:border-t-0">
                    {canApprove ? (
                      <DecisionForm
                        action={decideApprovalAction}
                        fields={{ wid: workspace.id, post_id: post.id }}
                        labels={{ comment: t("dash.approvals.comment"), commentHint: t("dash.approvals.commentHint"), approve: t("dash.approvals.approve"), reject: t("dash.approvals.reject") }}
                      />
                    ) : (
                      <p className="text-sm text-muted">{t("dash.approvals.waiting")}</p>
                    )}
                  </div>
                </div>
              </Panel>
            </li>
          ))}
        </ul>
      ) : (
        <Panel>
          <Empty icon={<CheckCheck />} title={t("dash.approvals.emptyTitle")}>
            {t("dash.approvals.emptyText")}
          </Empty>
        </Panel>
      )}

      {canApprove ? (
        <Panel title={t("dash.approvals.linksTitle")} description={t("dash.approvals.linksText")}>
          {!entitlements.allowWhiteLabel ? <p className="mb-4 rounded-lg bg-primary-soft px-3 py-2 text-xs text-primary">{t("dash.approvals.brandingUpsell")}</p> : <p className="mb-4 text-xs text-muted">{t("dash.approvals.brandingOn")}</p>}
          <ApprovalLinkForm
            workspaceId={workspace.id}
            posts={pending.map((p) => ({ id: p.id, label: `${p.scheduledAt ? `${formatInZone(p.scheduledAt, lc, workspace.timezone)} · ` : ""}${p.content.text.slice(0, 90) || t("dash.home.noText")}` }))}
          />
          {links.length ? (
            <ul className="mt-6 divide-y divide-line border-t border-line">
              {links.map((l) => {
                const active = isLinkActive(l, now);
                return (
                  <li key={l.id} className="flex flex-wrap items-center gap-3 py-3">
                    <Link2 className="size-5 shrink-0 text-muted" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <p dir="auto" className="flex flex-wrap items-center gap-2 text-sm font-medium">
                        {l.label || t("dash.approvals.untitled")}
                        {l.hasPassword ? <Lock className="size-3.5 text-muted" aria-label={t("dash.approvals.protected")} /> : null}
                        <Badge tone={active ? "success" : "neutral"}>{active ? t("dash.approvals.active") : l.revokedAt ? t("dash.approvals.revokedBadge") : t("dash.approvals.expired")}</Badge>
                      </p>
                      <p className="text-xs text-muted">
                        {l.postIds ? plural(t, "dash.approvals.scopeCount", l.postIds.length) : l.rangeFrom || l.rangeTo ? t("dash.approvals.scopeDates", { from: dayInZone(l.rangeFrom, 0) || "…", to: dayInZone(l.rangeTo, -60_000) || "…" }) : t("dash.approvals.scopeAll")}
                        {" · "}
                        {t("dash.approvals.expiresOn", { date: formatDateTime(l.expiresAt, lc, false) })}
                        {" · "}
                        {l.lastViewedAt ? t("dash.approvals.viewed", { when: formatRelative(l.lastViewedAt, lc) }) : t("dash.approvals.notViewed")}
                      </p>
                    </div>
                    {active && showcase?.id === l.id && showcase.workspaceId === workspace.id ? (
                      <a href={`/approve/${showcase.token}`} target="_blank" rel="noopener" className={buttonClass("outline", "sm")}>
                        <ExternalLink aria-hidden />
                        {t("dash.approvals.openLink")}
                      </a>
                    ) : null}
                    {active ? (
                      <ActionButton action={revokeApprovalLinkAction} fields={{ wid: workspace.id, link_id: l.id }} variant="ghost" confirmText={t("dash.approvals.revokeConfirm")}>
                        {t("dash.approvals.revoke")}
                      </ActionButton>
                    ) : (
                      <ActionButton action={revokeApprovalLinkAction} fields={{ wid: workspace.id, link_id: l.id, delete: 1 }} variant="ghost" label={t("dash.approvals.delete")}>
                        <Trash2 aria-hidden />
                      </ActionButton>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : null}
        </Panel>
      ) : null}
    </div>
  );
}
