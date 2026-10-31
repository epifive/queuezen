import type { Metadata } from "next";
import Link from "next/link";
import { AlertTriangle, CalendarClock, CheckCheck, PenSquare, Radio, ShieldCheck, XCircle } from "lucide-react";
import { RefreshOnce } from "@/components/dashboard/actions";
import { formatInZone } from "@/components/dashboard/approval-preview";
import { CheckItem, Delta, Kpi, KpiGrid } from "@/components/dashboard/kit";
import { DashHeader, Empty, Meter, Panel } from "@/components/dashboard/ui";
import { PlatformIcon } from "@/components/social/platform-icon";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { weekStats } from "@/lib/analytics";
import { getPendingApprovals } from "@/lib/approvals";
import { channelQuota, getWorkspaceChannels } from "@/lib/channels";
import { formatNumber, formatRelative } from "@/lib/dash-format";
import { requireWorkspace } from "@/lib/dashboard";
import { plural, type MessageKey } from "@/lib/i18n/messages";
import { getLocale, getT } from "@/lib/i18n/server";
import { xLimit } from "@/lib/plans";
import { countPostsByStatus, listPosts } from "@/lib/posts";
import { getUsage } from "@/lib/usage";
import { countSeats, getMembers, getWorkspaceEntitlements } from "@/lib/workspaces";
import { roleCan } from "@/social/normalize";
import { PLATFORM_CAPABILITIES } from "@/social/platforms";
import type { Platform } from "@/social/types";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("dash.nav.home") };
}

/**
 * Channels that need attention: expired, in error, or with a token that can't be renewed
 * automatically (LinkedIn) ending within the reminder lead time. Tokens Queuezen refreshes in the
 * background (X, YouTube, Bluesky, Threads…) are no news.
 */
function channelProblems<C extends { status: string; platform: Platform; tokenExpiresAt: string | null }>(channels: C[], nowMs = Date.now()): Array<{ channel: C; state: "expired" | "error" | "soon" }> {
  const out: Array<{ channel: C; state: "expired" | "error" | "soon" }> = [];
  for (const c of channels) {
    const auth = PLATFORM_CAPABILITIES[c.platform].auth;
    if (c.status === "expired") out.push({ channel: c, state: "expired" });
    else if (c.status === "error") out.push({ channel: c, state: "error" });
    else if (c.status === "active" && auth.refresh === "reauth" && c.tokenExpiresAt && Date.parse(c.tokenExpiresAt) - nowMs < auth.refreshLeadDays * 86_400_000) out.push({ channel: c, state: "soon" });
  }
  return out;
}

/** Workspace home: what needs attention, the next posts, this week's results, plan usage and setup. */
export default async function WorkspaceHome({ params, searchParams }: { params: Promise<{ wid: string }>; searchParams: Promise<{ created?: string }> }) {
  const { user, workspace, role } = await requireWorkspace((await params).wid);
  const [query, t, locale, entitlements, channels, counts, usage, seats, members, upcoming, failed, pending, week] = await Promise.all([
    searchParams,
    getT(),
    getLocale(),
    getWorkspaceEntitlements(workspace),
    getWorkspaceChannels(workspace.id),
    countPostsByStatus(workspace.id),
    getUsage(workspace.ownerId),
    countSeats(workspace.ownerId),
    getMembers(workspace.id),
    listPosts(workspace.id, { status: ["scheduled"], from: new Date().toISOString(), limit: 6 }),
    listPosts(workspace.id, { status: ["failed", "partially_failed"], limit: 5, order: "updated_desc" }),
    getPendingApprovals(workspace.id, 5),
    weekStats(workspace),
  ]);
  const quota = await channelQuota(workspace.ownerId, entitlements);
  const lc = locale.code;
  const tz = workspace.timezone;
  const base = `/dashboard/w/${workspace.id}`;
  const num = (n: number) => formatNumber(n, lc);
  const limitText = (n: number) => (n > 0 ? num(n) : t("pricing.unlimited"));
  const x = xLimit(entitlements.maxXPostsMonthly);
  const canCompose = roleCan(role, "post.create");
  const canApprove = roleCan(role, "approve");
  const canChannels = roleCan(role, "channels.manage");
  const isOwner = workspace.ownerId === user.id;
  const channelById = new Map(channels.map((c) => [c.id, c]));
  const unhealthy = channelProblems(channels);
  const steps = {
    channel: channels.length > 0,
    slots: channels.some((c) => c.queueSlots.length > 0),
    scheduled: counts.scheduled + counts.published + counts.partially_failed + counts.publishing > 0,
    team: members.length > 1,
  };
  const setupDone = Object.values(steps).every(Boolean);
  const { totals, previous } = week;
  const vs = t("dash.analytics.vsPrevious");

  return (
    <div className="space-y-6">
      {query.created === "1" ? (
        <>
          <RefreshOnce cleanUrl={base} />
          <Alert tone="success">{t("dash.ws.created")}</Alert>
        </>
      ) : null}
      <DashHeader
        title={workspace.name}
        description={t("dash.home.subtitle", { timezone: tz.replaceAll("_", " ") })}
        actions={
          canCompose ? (
            <ButtonLink href={`${base}/compose`}>
              <PenSquare aria-hidden />
              {t("dash.home.compose")}
            </ButtonLink>
          ) : null
        }
      />

      {counts.failed + counts.partially_failed > 0 || unhealthy.length || (canApprove && pending.length) ? (
        <div className="grid gap-3 md:grid-cols-3">
          {counts.failed + counts.partially_failed > 0 ? (
            <Link href={`${base}/posts?status=failed`} className="flex items-center gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm hover:border-red-300 dark:border-red-900 dark:bg-red-950/40">
              <XCircle className="size-5 shrink-0 text-red-600 dark:text-red-400" aria-hidden />
              <span className="min-w-0">
                <span className="block font-medium text-red-800 dark:text-red-300">{plural(t, "dash.home.attnFailed", counts.failed + counts.partially_failed, { n: num(counts.failed + counts.partially_failed) })}</span>
                <span className="block text-xs text-red-700/80 dark:text-red-300/80">{t("dash.home.attnFailedText")}</span>
              </span>
            </Link>
          ) : null}
          {unhealthy.length ? (
            <Link href={`${base}/channels`} className="flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm hover:border-amber-300 dark:border-amber-900 dark:bg-amber-950/40">
              <AlertTriangle className="size-5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
              <span className="min-w-0">
                <span className="block font-medium text-amber-900 dark:text-amber-300">{plural(t, "dash.home.attnChannels", unhealthy.length, { n: num(unhealthy.length) })}</span>
                <span className="block text-xs text-amber-800/80 dark:text-amber-300/80">{t("dash.home.attnChannelsText")}</span>
              </span>
            </Link>
          ) : null}
          {canApprove && pending.length ? (
            <Link href={`${base}/team/approvals`} className="flex items-center gap-3 rounded-xl border border-primary-line bg-primary-soft px-4 py-3 text-sm hover:border-primary">
              <CheckCheck className="size-5 shrink-0 text-primary" aria-hidden />
              <span className="min-w-0">
                <span className="block font-medium text-primary">{plural(t, "dash.home.attnApprovals", counts.pending_approval, { n: num(counts.pending_approval) })}</span>
                <span className="block text-xs text-muted">{t("dash.home.attnApprovalsText")}</span>
              </span>
            </Link>
          ) : null}
        </div>
      ) : null}

      <section aria-label={t("dash.home.week")}>
        <h2 className="mb-2 text-xs font-medium tracking-wide text-muted uppercase">{t("dash.home.week")}</h2>
        <KpiGrid className="grid-cols-2 lg:grid-cols-5 [&>*:last-child]:col-span-2 lg:[&>*:last-child]:col-span-1">
          <Kpi label={t("dash.analytics.kpiPublished")} value={num(totals.published)} delta={<Delta current={totals.published} previous={previous.published} label={vs} />} accent="bg-slate-400" />
          <Kpi label={t("dash.analytics.kpiEngagements")} value={num(totals.engagements)} delta={<Delta current={totals.engagements} previous={previous.engagements} label={vs} />} accent="bg-primary" />
          <Kpi label={t("dash.analytics.kpiViews")} value={num(totals.views)} delta={<Delta current={totals.views} previous={previous.views} label={vs} />} accent="bg-sky-500" />
          <Kpi label={t("dash.analytics.kpiClicks")} value={num(totals.linkClicks)} accent="bg-emerald-500" />
          <Kpi label={t("dash.home.scheduled")} value={num(counts.scheduled)} hint={t("dash.home.draftsCount", { n: num(counts.draft) })} accent="bg-amber-500" />
        </KpiGrid>
      </section>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-6">
          <Panel title={t("dash.home.upcoming")} actions={<Link href={`${base}/calendar`} className="text-sm font-medium text-primary hover:underline">{t("dash.home.calendar")}</Link>} padded={false}>
            {upcoming.length ? (
              <ul className="divide-y divide-line">
                {upcoming.map((post) => (
                  <li key={post.id} className="flex items-start gap-4 px-5 py-3.5">
                    <CalendarClock className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <p dir="auto" className="line-clamp-2 text-sm break-words">
                        {post.content.text || t("dash.home.noText")}
                      </p>
                      <p className="mt-1 text-xs text-muted">
                        <bdi>{formatInZone(post.scheduledAt, lc, tz)}</bdi> · {formatRelative(post.scheduledAt, lc)}
                      </p>
                    </div>
                    <div className="flex shrink-0 -space-x-1.5 rtl:space-x-reverse">
                      {post.targets.slice(0, 5).map((tg) => (
                        <PlatformIcon key={tg.id} platform={tg.platform} className="size-6 rounded-md ring-2 ring-surface" title={channelById.get(tg.channelId)?.name} />
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty icon={<CalendarClock />} title={t("dash.home.upcomingEmpty")} action={canCompose ? <ButtonLink href={`${base}/compose`}>{t("dash.home.compose")}</ButtonLink> : null}>
                {t("dash.home.upcomingEmptyText")}
              </Empty>
            )}
          </Panel>

          {pending.length ? (
            <Panel title={t("dash.home.pendingTitle")} actions={<Link href={`${base}/team/approvals`} className="text-sm font-medium text-primary hover:underline">{t("dash.home.openInbox")}</Link>} padded={false}>
              <ul className="divide-y divide-line">
                {pending.map((post) => (
                  <li key={post.id} className="flex items-start gap-3 px-5 py-3">
                    <Badge tone="warning">{t("dash.home.pendingBadge")}</Badge>
                    <div className="min-w-0 flex-1">
                      <p dir="auto" className="line-clamp-1 text-sm">
                        {post.content.text || t("dash.home.noText")}
                      </p>
                      <p className="text-xs text-muted">{post.scheduledAt ? <bdi>{formatInZone(post.scheduledAt, lc, tz)}</bdi> : t("dash.approvals.noDate")}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}

          {failed.length ? (
            <Panel title={t("dash.home.failedTitle")} actions={<Link href={`${base}/posts?status=failed`} className="text-sm font-medium text-primary hover:underline">{t("dash.home.reviewAll")}</Link>} padded={false}>
              <ul className="divide-y divide-line">
                {failed.map((post) => {
                  const errors = post.targets.filter((tg) => tg.status === "failed" || tg.status === "needs_reauth");
                  return (
                    <li key={post.id} className="flex items-start gap-3 px-5 py-3">
                      <XCircle className="mt-0.5 size-5 shrink-0 text-red-500" aria-hidden />
                      <div className="min-w-0 flex-1">
                        <p dir="auto" className="line-clamp-1 text-sm">
                          {post.content.text || t("dash.home.noText")}
                        </p>
                        {errors.slice(0, 2).map((tg) => (
                          <p key={tg.id} className="mt-0.5 flex items-center gap-1.5 text-xs text-red-700 dark:text-red-400">
                            <PlatformIcon platform={tg.platform} className="size-3.5" />
                            <span dir="auto" className="line-clamp-1">
                              {tg.error || t("dash.home.failedUnknown")}
                            </span>
                          </p>
                        ))}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </Panel>
          ) : null}

          <Panel title={t("dash.home.channels")} actions={<Link href={`${base}/channels`} className="text-sm font-medium text-primary hover:underline">{t("dash.home.manage")}</Link>} padded={false}>
            {channels.length ? (
              <ul className="grid gap-px bg-line sm:grid-cols-2">
                {channels.slice(0, 10).map((c) => {
                  const issue = unhealthy.find((u) => u.channel.id === c.id);
                  return (
                    <li key={c.id} className="flex items-center gap-3 bg-surface px-5 py-3">
                      <PlatformIcon platform={c.platform} className="size-8" />
                      <span className="min-w-0 flex-1">
                        <span dir="auto" className="block truncate text-sm font-medium">
                          {c.name}
                        </span>
                        <span dir="ltr" className="block truncate text-start text-xs text-muted">
                          {c.handle || PLATFORM_CAPABILITIES[c.platform].name}
                        </span>
                      </span>
                      {issue ? (
                        <Badge tone={issue.state === "soon" ? "warning" : "danger"}>{t(`dash.home.health.${issue.state}` as MessageKey)}</Badge>
                      ) : (
                        <ShieldCheck className="size-4 shrink-0 text-emerald-500" aria-label={t("dash.home.health.ok")} />
                      )}
                    </li>
                  );
                })}
                {Math.min(channels.length, 10) % 2 === 1 ? <li className="hidden bg-surface sm:block" aria-hidden /> : null}
              </ul>
            ) : (
              <Empty icon={<Radio />} title={t("dash.home.noChannels")} action={canChannels ? <ButtonLink href={`${base}/channels`}>{t("dash.home.connect")}</ButtonLink> : null}>
                {t("dash.home.noChannelsText")}
              </Empty>
            )}
          </Panel>
        </div>

        <div className="space-y-6">
          {!setupDone ? (
            <Panel title={t("dash.home.gettingStarted")}>
              <ul className="divide-y divide-line">
                <CheckItem done={steps.channel} title={t("dash.home.step1")} text={t("dash.home.step1Text")} action={canChannels ? <ButtonLink href={`${base}/channels`} size="sm" variant="outline">{t("dash.home.go")}</ButtonLink> : null} />
                <CheckItem done={steps.slots} title={t("dash.home.step2")} text={t("dash.home.step2Text")} action={<ButtonLink href={`${base}/queue`} size="sm" variant="outline">{t("dash.home.go")}</ButtonLink>} />
                <CheckItem done={steps.scheduled} title={t("dash.home.step3")} text={t("dash.home.step3Text")} action={canCompose ? <ButtonLink href={`${base}/compose`} size="sm" variant="outline">{t("dash.home.go")}</ButtonLink> : null} />
                <CheckItem done={steps.team} title={t("dash.home.step4")} text={t("dash.home.step4Text")} action={roleCan(role, "members.manage") ? <ButtonLink href={`${base}/team`} size="sm" variant="outline">{t("dash.home.go")}</ButtonLink> : null} />
              </ul>
            </Panel>
          ) : null}

          <Panel title={t("dash.home.usage")} description={isOwner ? t("dash.home.usageOwn") : t("dash.home.usageOwner")}>
            <div className="space-y-4">
              <Meter label={t("dash.home.meterPosts")} used={usage.postsScheduled} limit={entitlements.maxScheduledMonthly} usedText={num(usage.postsScheduled)} limitText={limitText(entitlements.maxScheduledMonthly)} critical />
              <Meter label={t("dash.home.meterChannels")} used={quota.used} limit={quota.limit} usedText={num(quota.used)} limitText={limitText(quota.limit)} critical />
              <Meter label={t("dash.home.meterSeats")} used={seats} limit={entitlements.maxMembers} usedText={num(seats)} limitText={limitText(entitlements.maxMembers)} />
              {x.allowed ? <Meter label={t("dash.home.meterX")} used={usage.xPosts} limit={x.limit} usedText={num(usage.xPosts)} limitText={limitText(x.limit)} critical /> : <p className="text-sm text-muted">{t("dash.home.noX")}</p>}
              {entitlements.allowAi ? (
                <Meter label={t("dash.home.meterAi")} used={usage.aiRequests} limit={entitlements.maxAiMonthly} usedText={num(usage.aiRequests)} limitText={limitText(entitlements.maxAiMonthly)} critical />
              ) : (
                <p className="text-sm text-muted">{t("dash.home.noAi")}</p>
              )}
            </div>
            {isOwner && !entitlements.isPremium ? (
              <ButtonLink href="/pricing" size="sm" variant="secondary" className="mt-4 w-full">
                {t("dash.banner.cta")}
              </ButtonLink>
            ) : null}
          </Panel>
        </div>
      </div>
    </div>
  );
}
