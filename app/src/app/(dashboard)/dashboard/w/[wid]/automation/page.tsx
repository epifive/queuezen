import type { Metadata } from "next";
import { AlertTriangle, CircleMinus, Crown, Leaf, Pause, Play, RefreshCw, Rss, Trash2 } from "lucide-react";
import { feedCommandAction, setEvergreenAction } from "@/app/actions/dashboard/automation";
import { ActionButton } from "@/components/dashboard/actions";
import { FeedForm, RecycleForm, type ChannelOption } from "@/components/dashboard/automation-forms";
import { AutomationTabs } from "@/components/dashboard/automation-tabs";
import { DashHeader, Empty, Panel } from "@/components/dashboard/ui";
import { PlatformIcon } from "@/components/social/platform-icon";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { getWorkspaceChannels } from "@/lib/channels";
import { formatDateTime, formatNumber, formatRelative } from "@/lib/dash-format";
import { requireWorkspace } from "@/lib/dashboard";
import { plural, type MessageKey } from "@/lib/i18n/messages";
import { getLocale, getT } from "@/lib/i18n/server";
import { getEvergreenPosts, getRecycleSettings, getRecyclableCandidates } from "@/lib/recycle";
import { getFeedItems, getFeeds } from "@/lib/rss";
import { getSettings } from "@/lib/settings";
import { getWorkspaceEntitlements } from "@/lib/workspaces";
import { canPublishDirectly, roleCan } from "@/social/normalize";
import { getCapabilities } from "@/social/platforms";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("dash.nav.automation") };
}

/** RSS auto-posting and evergreen recycling (short links are on /links, same tabs). */
export default async function AutomationPage({ params, searchParams }: { params: Promise<{ wid: string }>; searchParams: Promise<{ tab?: string }> }) {
  const { user, workspace, role } = await requireWorkspace((await params).wid);
  const tab = (await searchParams).tab === "recycle" ? "recycle" : "rss";
  const [t, locale, entitlements, channels, settings] = await Promise.all([getT(), getLocale(), getWorkspaceEntitlements(workspace), getWorkspaceChannels(workspace.id), getSettings()]);
  const lc = locale.code;
  const canEdit = roleCan(role, "post.create");
  const options: ChannelOption[] = channels.map((c) => ({ id: c.id, name: c.name, platform: c.platform, textOk: getCapabilities(c.platform).media.required === "none" }));
  const channelById = new Map(channels.map((c) => [c.id, c]));
  const tabs = <AutomationTabs workspaceId={workspace.id} active={tab} labels={{ rss: t("dash.automation.tabRss"), recycle: t("dash.automation.tabRecycle"), links: t("dash.automation.tabLinks"), nav: t("dash.nav.automation") }} />;

  if (tab === "recycle") {
    const [recycle, evergreen, candidates] = await Promise.all([getRecycleSettings(workspace.id), getEvergreenPosts(workspace.id), getRecyclableCandidates(workspace.id)]);
    return (
      <div className="space-y-6">
        <DashHeader title={t("dash.nav.automation")} description={t("dash.recycle.subtitle")} />
        {tabs}
        {!settings.recycle_enabled ? <Alert tone="warning">{t("dash.recycle.offSite")}</Alert> : null}
        <Panel title={t("dash.recycle.settingsTitle")} description={t("dash.recycle.settingsText")}>
          <RecycleForm workspaceId={workspace.id} channels={options} values={recycle} canEdit={roleCan(role, "settings.manage")} />
        </Panel>
        <Panel title={t("dash.recycle.evergreenTitle")} description={t("dash.recycle.evergreenText")} padded={false}>
          {evergreen.length ? (
            <ul className="divide-y divide-line">
              {evergreen.map((p) => {
                const next = p.lastRecycledAt ?? p.publishedAt;
                const due = next ? new Date(Date.parse(next) + recycle.intervalDays * 86_400_000).toISOString() : null;
                const done = recycle.maxRecycles > 0 && p.recycleCount >= recycle.maxRecycles;
                return (
                  <li key={p.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                    <Leaf className="size-5 shrink-0 text-emerald-600" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <p dir="auto" className="line-clamp-2 text-sm">
                        {p.text || t("dash.home.noText")}
                      </p>
                      <p className="mt-0.5 text-xs text-muted">
                        {t("dash.recycle.count", { n: p.recycleCount, max: recycle.maxRecycles || "∞" })}
                        {" · "}
                        {done ? t("dash.recycle.done") : p.status !== "published" && p.status !== "partially_failed" ? t("dash.recycle.notPublished") : due ? t("dash.recycle.nextDue", { date: formatDateTime(due, lc, false) }) : null}
                      </p>
                    </div>
                    {canEdit ? (
                      <ActionButton action={setEvergreenAction} fields={{ wid: workspace.id, post_id: p.id, on: 0 }} variant="ghost">
                        <CircleMinus aria-hidden />
                        {t("dash.recycle.unmark")}
                      </ActionButton>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : (
            <Empty icon={<Leaf />} title={t("dash.recycle.emptyTitle")}>
              {t("dash.recycle.emptyText")}
            </Empty>
          )}
        </Panel>
        {canEdit && candidates.length ? (
          <Panel title={t("dash.recycle.candidatesTitle")} description={t("dash.recycle.candidatesText")} padded={false}>
            <ul className="divide-y divide-line">
              {candidates.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                  <div className="min-w-0 flex-1">
                    <p dir="auto" className="line-clamp-1 text-sm">
                      {p.text || t("dash.home.noText")}
                    </p>
                    <p className="text-xs text-muted">{formatDateTime(p.publishedAt, lc)}</p>
                  </div>
                  <ActionButton action={setEvergreenAction} fields={{ wid: workspace.id, post_id: p.id, on: 1 }}>
                    <Leaf aria-hidden />
                    {t("dash.recycle.mark")}
                  </ActionButton>
                </li>
              ))}
            </ul>
          </Panel>
        ) : null}
      </div>
    );
  }

  const feeds = await getFeeds(workspace.id);
  const items = new Map(await Promise.all(feeds.map(async (f) => [f.id, await getFeedItems(f.id, 8)] as const)));
  const draftOnly = !canPublishDirectly(role, workspace.settings);
  const formProps = { workspaceId: workspace.id, channels: options, maxItemsCap: Math.max(1, settings.rss_max_items_per_run || 10), minInterval: Math.max(5, settings.rss_min_interval_minutes || 15), draftOnly };
  const intervalText = (m: number) => (m < 60 ? t("dash.rss.everyMinutes", { n: m }) : m < 1440 ? t("dash.rss.everyHours", { n: Math.round(m / 60) }) : t("dash.rss.everyDay"));

  return (
    <div className="space-y-6">
      <DashHeader title={t("dash.nav.automation")} description={t("dash.automation.subtitle")} />
      {tabs}
      {!entitlements.allowRss ? (
        <Alert tone="warning" title={t("dash.rss.upgradeTitle")}>
          <p>{t("dash.rss.upgrade")}</p>
          {workspace.ownerId === user.id ? (
            <ButtonLink href="/pricing" size="sm" className="mt-3">
              <Crown aria-hidden />
              {t("dash.banner.cta")}
            </ButtonLink>
          ) : null}
        </Alert>
      ) : null}

      <Panel title={t("dash.rss.listTitle")} description={t("dash.rss.listText")} padded={false}>
        {feeds.length ? (
          <ul className="divide-y divide-line">
            {feeds.map((f) => {
              const recent = items.get(f.id) ?? [];
              return (
                <li key={f.id} className="px-5 py-4">
                  <div className="flex flex-wrap items-start gap-3">
                    <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-orange-100 text-orange-600 dark:bg-orange-950 dark:text-orange-300">
                      <Rss className="size-4" aria-hidden />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2">
                        <bdi dir="auto" className="truncate font-medium">
                          {f.title || f.url}
                        </bdi>
                        <Badge tone={f.status === "active" ? "success" : f.status === "paused" ? "neutral" : "danger"}>{t(`dash.rss.status.${f.status}` as MessageKey)}</Badge>
                      </p>
                      <p dir="ltr" className="truncate text-start text-xs text-muted">
                        {f.url}
                      </p>
                      <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                        <span className="flex items-center gap-1">
                          {f.channelIds.map((id) => {
                            const c = channelById.get(id);
                            return c ? <PlatformIcon key={id} platform={c.platform} className="size-4" title={c.name} /> : null;
                          })}
                        </span>
                        <span>{t(`dash.rss.modeShort.${f.mode}` as MessageKey)}</span>
                        <span>{intervalText(f.intervalMinutes)}</span>
                        <span>{plural(t, "dash.rss.posted", f.itemsPosted, { n: formatNumber(f.itemsPosted, lc) })}</span>
                        <span>{f.lastCheckedAt ? t("dash.rss.lastChecked", { when: formatRelative(f.lastCheckedAt, lc) }) : t("dash.rss.neverChecked")}</span>
                      </p>
                      {f.lastError ? (
                        <p className="mt-2 flex items-start gap-1.5 text-xs text-red-600 dark:text-red-400">
                          <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
                          <span dir="auto">{f.lastError}</span>
                        </p>
                      ) : null}
                    </div>
                    {canEdit ? (
                      <div className="flex flex-wrap gap-1">
                        <ActionButton action={feedCommandAction} fields={{ wid: workspace.id, feed_id: f.id, command: "check" }} variant="ghost" showSuccess label={t("dash.rss.checkNow")}>
                          <RefreshCw aria-hidden />
                          <span className="hidden sm:inline">{t("dash.rss.checkNow")}</span>
                        </ActionButton>
                        <ActionButton action={feedCommandAction} fields={{ wid: workspace.id, feed_id: f.id, command: f.status === "paused" ? "resume" : "pause" }} variant="ghost" label={f.status === "paused" ? t("dash.rss.resume") : t("dash.rss.pause")}>
                          {f.status === "paused" ? <Play aria-hidden /> : <Pause aria-hidden />}
                        </ActionButton>
                        <ActionButton action={feedCommandAction} fields={{ wid: workspace.id, feed_id: f.id, command: "delete" }} variant="ghost" label={t("dash.rss.delete")} confirmText={t("dash.rss.deleteConfirm")}>
                          <Trash2 aria-hidden />
                        </ActionButton>
                      </div>
                    ) : null}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2 sm:ps-12">
                    {recent.length ? (
                      <details className="min-w-0 flex-1">
                        <summary className="cursor-pointer text-xs font-medium text-primary">{t("dash.rss.recent", { n: recent.length })}</summary>
                        <ul className="mt-2 space-y-1 text-xs">
                          {recent.map((i) => (
                            <li key={i.id} className="flex items-center gap-2">
                              <Badge tone={i.postId ? "success" : "neutral"}>{i.postId ? t("dash.rss.itemPosted") : t("dash.rss.itemSkipped")}</Badge>
                              <bdi dir="auto" className="min-w-0 truncate text-muted">
                                {i.title || i.url}
                              </bdi>
                            </li>
                          ))}
                        </ul>
                      </details>
                    ) : null}
                    {canEdit ? (
                      <details className="w-full">
                        <summary className="cursor-pointer text-xs font-medium text-primary">{t("dash.rss.edit")}</summary>
                        <div className="mt-3 rounded-lg border border-line p-4">
                          <FeedForm
                            {...formProps}
                            feed={{ id: f.id, url: f.url, title: f.title, channelIds: f.channelIds, template: f.template, mode: f.mode, intervalMinutes: f.intervalMinutes, maxItems: f.options.maxItems, backfill: f.options.backfill, hashtags: f.options.hashtags, shortenLinks: f.options.shortenLinks, utm: f.options.utm }}
                          />
                        </div>
                      </details>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <Empty icon={<Rss />} title={t("dash.rss.emptyTitle")}>
            {t("dash.rss.emptyText")}
          </Empty>
        )}
      </Panel>

      {canEdit && entitlements.allowRss ? (
        <Panel title={t("dash.rss.addTitle")} description={t("dash.rss.addText")}>
          <FeedForm {...formProps} />
        </Panel>
      ) : null}
    </div>
  );
}
