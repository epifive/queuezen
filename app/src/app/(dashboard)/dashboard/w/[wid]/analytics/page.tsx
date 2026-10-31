import type { Metadata } from "next";
import { BarChart3, Download, ExternalLink, Info, Sparkles } from "lucide-react";
import { AnalyticsChannelFilter } from "@/components/dashboard/analytics-filter";
import { BarChart, HBars, HeatmapGrid } from "@/components/dashboard/analytics-charts";
import { Delta, Kpi, KpiGrid } from "@/components/dashboard/kit";
import { DashHeader, DTable, DTd, DTh, Empty, LinkTabs, Panel } from "@/components/dashboard/ui";
import { PlatformIcon } from "@/components/social/platform-icon";
import { ButtonLink } from "@/components/ui/button";
import { ANALYTICS_PERIODS, getWorkspaceAnalytics } from "@/lib/analytics";
import { getWorkspaceChannels } from "@/lib/channels";
import { formatDay, formatNumber } from "@/lib/dash-format";
import { requireWorkspace } from "@/lib/dashboard";
import { getLocale, getT } from "@/lib/i18n/server";
import { getCapabilities } from "@/social/platforms";
import { formatInZone } from "@/components/dashboard/approval-preview";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("dash.nav.analytics") };
}

const METRICS = ["engagements", "views", "published"] as const;
type Metric = (typeof METRICS)[number];

/** Analytics of the workspace: KPIs, results over time, channels, best times, top posts, CSV. */
export default async function AnalyticsPage({ params, searchParams }: { params: Promise<{ wid: string }>; searchParams: Promise<{ days?: string; channel?: string; metric?: string }> }) {
  const { workspace } = await requireWorkspace((await params).wid, "viewer");
  const query = await searchParams;
  const days = (ANALYTICS_PERIODS as readonly number[]).includes(Number(query.days)) ? Number(query.days) : 30;
  const metric: Metric = (METRICS as readonly string[]).includes(query.metric ?? "") ? (query.metric as Metric) : "engagements";
  const [t, locale, channels] = await Promise.all([getT(), getLocale(), getWorkspaceChannels(workspace.id, { includeDisconnected: true })]);
  const channelId = channels.some((c) => c.id === Number(query.channel)) ? Number(query.channel) : 0;
  const data = await getWorkspaceAnalytics(workspace, days, channelId || undefined);
  const lc = locale.code;
  const num = (n: number) => formatNumber(n, lc);
  const base = `/dashboard/w/${workspace.id}/analytics`;
  const qs = (patch: Record<string, string | number>) => {
    const p = new URLSearchParams({ days: String(days), metric, ...(channelId ? { channel: String(channelId) } : {}) });
    for (const [k, v] of Object.entries(patch)) p.set(k, String(v));
    return `${base}?${p.toString()}`;
  };
  const channelById = new Map(channels.map((c) => [c.id, c]));
  const { totals, previous } = data;
  const vs = t("dash.analytics.vsPrevious");
  const rate = (r: number | null) => (r === null ? "—" : `${formatNumber(r, lc, { maximumFractionDigits: 1 })}%`);
  const noAnalytics = channels.filter((c) => c.status !== "disconnected" && !getCapabilities(c.platform).analytics.supported);
  const dayLabels = ["", ...[1, 2, 3, 4, 5, 6, 7].map((d) => new Date(Date.UTC(2026, 0, 4 + d)).toLocaleDateString(lc, { weekday: "short", timeZone: "UTC" }))];
  const dayOrder = workspace.settings.weekStart === 7 ? [7, 1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5, 6, 7];
  const seriesValue = (d: (typeof data.series)[number]) => (metric === "views" ? d.views : metric === "published" ? d.published : d.engagements);
  const metricLabel = t(`dash.analytics.metric.${metric}`);

  return (
    <div className="space-y-6">
      <DashHeader
        title={t("dash.nav.analytics")}
        description={t("dash.analytics.subtitleTz", { timezone: workspace.timezone.replaceAll("_", " ") })}
        actions={
          <ButtonLink href={`${base}/export?days=${days}${channelId ? `&channel=${channelId}` : ""}`} variant="outline" prefetch={false}>
            <Download aria-hidden />
            {t("dash.analytics.export")}
          </ButtonLink>
        }
      />

      <div className="flex flex-wrap items-center gap-3">
        <LinkTabs label={t("dash.analytics.period")} items={ANALYTICS_PERIODS.map((d) => ({ href: qs({ days: d }), label: t("dash.analytics.days", { n: d }), active: d === days }))} />
        <AnalyticsChannelFilter channels={channels.map((c) => ({ id: c.id, name: `${c.name} · ${getCapabilities(c.platform).name}` }))} value={channelId} label={t("dash.analytics.channel")} allLabel={t("dash.analytics.allChannels")} />
      </div>

      <KpiGrid className="grid-cols-2 lg:grid-cols-5 [&>*:last-child]:col-span-2 lg:[&>*:last-child]:col-span-1">
        <Kpi label={t("dash.analytics.kpiPublished")} value={num(totals.published)} delta={<Delta current={totals.published} previous={previous.published} label={vs} />} accent="bg-slate-400" />
        <Kpi label={t("dash.analytics.kpiEngagements")} value={num(totals.engagements)} delta={<Delta current={totals.engagements} previous={previous.engagements} label={vs} />} accent="bg-primary" />
        <Kpi label={t("dash.analytics.kpiViews")} value={num(totals.views)} delta={<Delta current={totals.views} previous={previous.views} label={vs} />} accent="bg-sky-500" />
        <Kpi label={t("dash.analytics.kpiClicks")} value={channelId ? "—" : num(totals.linkClicks)} delta={channelId ? null : <Delta current={totals.linkClicks} previous={previous.linkClicks} label={vs} />} hint={channelId ? t("dash.analytics.clicksAll") : undefined} accent="bg-emerald-500" />
        <Kpi label={t("dash.analytics.kpiRate")} value={rate(totals.rate)} hint={t("dash.analytics.rateHint")} accent="bg-amber-500" />
      </KpiGrid>

      {totals.published && totals.measured < totals.published ? (
        <p className="flex items-start gap-2 text-xs text-muted">
          <Info className="mt-px size-3.5 shrink-0" aria-hidden />
          {t("dash.analytics.measured", { measured: num(totals.measured), total: num(totals.published) })}
        </p>
      ) : null}

      <Panel title={t("dash.analytics.overTime")} actions={<LinkTabs label={t("dash.analytics.metric")} items={METRICS.map((m) => ({ href: qs({ metric: m }), label: t(`dash.analytics.metric.${m}`), active: m === metric }))} />}>
        {totals.published ? (
          <>
            <BarChart data={data.series.map((d) => ({ key: d.day, label: formatDay(d.day, lc), value: seriesValue(d) }))} locale={lc} label={`${t("dash.analytics.overTime")}: ${metricLabel}`} valueLabel={metricLabel} />
            <details className="mt-4">
              <summary className="cursor-pointer text-xs font-medium text-primary">{t("dash.analytics.showTable")}</summary>
              <DTable minWidth={360} label={t("dash.analytics.overTime")} dense>
                <thead>
                  <tr>
                    <DTh>{t("dash.analytics.day")}</DTh>
                    <DTh className="text-end">{t("dash.analytics.metric.published")}</DTh>
                    <DTh className="text-end">{t("dash.analytics.metric.engagements")}</DTh>
                    <DTh className="text-end">{t("dash.analytics.metric.views")}</DTh>
                  </tr>
                </thead>
                <tbody>
                  {data.series
                    .filter((d) => d.published)
                    .map((d) => (
                      <tr key={d.day}>
                        <DTd>{formatDay(d.day, lc, true)}</DTd>
                        <DTd className="text-end tabular-nums">{num(d.published)}</DTd>
                        <DTd className="text-end tabular-nums">{num(d.engagements)}</DTd>
                        <DTd className="text-end tabular-nums">{num(d.views)}</DTd>
                      </tr>
                    ))}
                </tbody>
              </DTable>
            </details>
          </>
        ) : (
          <Empty icon={<BarChart3 />} title={t("dash.analytics.emptyTitle")}>
            {t("dash.analytics.emptyText")}
          </Empty>
        )}
      </Panel>

      <Panel title={t("dash.analytics.bestTimes")} description={t("dash.analytics.bestTimesText", { n: num(data.heatmapPosts) })}>
        {data.heatmap.best.length ? (
          <p className="mb-4 flex flex-wrap items-center gap-2 text-sm">
            <Sparkles className="size-4 text-amber-500" aria-hidden />
            <span className="font-medium">{t("dash.analytics.bestSlots")}</span>
            {data.heatmap.best.map((c) => (
              <span key={`${c.day}-${c.hour}`} className="rounded-full bg-primary-soft px-2.5 py-0.5 text-xs font-medium text-primary">
                <bdi>
                  {dayLabels[c.day]} {new Date(Date.UTC(2026, 0, 5, c.hour)).toLocaleTimeString(lc, { hour: "numeric", timeZone: "UTC" })}
                </bdi>
              </span>
            ))}
          </p>
        ) : (
          <p className="mb-4 text-sm text-muted">{t("dash.analytics.bestNotEnough")}</p>
        )}
        <HeatmapGrid
          heatmap={data.heatmap}
          locale={lc}
          dayLabels={dayLabels}
          dayOrder={dayOrder}
          labels={{ chart: t("dash.analytics.bestTimes"), less: t("dash.analytics.less"), more: t("dash.analytics.more"), noPosts: t("dash.analytics.noPostsHour"), avg: t("dash.analytics.avgEngagement"), posts: t("dash.analytics.postsCount") }}
        />
      </Panel>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Panel title={t("dash.analytics.perChannel")} description={t("dash.analytics.perChannelText")}>
          {data.perChannel.length ? (
            <HBars
              locale={lc}
              label={t("dash.analytics.perChannel")}
              rows={data.perChannel.map((c) => {
                const ch = channelById.get(c.channelId);
                return {
                  key: c.channelId,
                  icon: <PlatformIcon platform={c.platform} className="size-5" />,
                  label: <bdi dir="auto">{ch?.name ?? c.platform}</bdi>,
                  value: c.engagements,
                  muted: !c.supported,
                  display: c.supported ? num(c.engagements) : "—",
                  note: c.supported
                    ? t("dash.analytics.channelLine", { posts: num(c.published), avg: formatNumber(c.avgEngagement, lc, { maximumFractionDigits: 1 }), rate: rate(c.rate) })
                    : t("dash.analytics.notAvailable", { network: getCapabilities(c.platform).name }),
                };
              })}
            />
          ) : (
            <p className="text-sm text-muted">{t("dash.analytics.emptyText")}</p>
          )}
          {noAnalytics.length ? (
            <p className="mt-4 flex items-start gap-2 border-t border-line pt-3 text-xs text-muted">
              <Info className="mt-px size-3.5 shrink-0" aria-hidden />
              {t("dash.analytics.noAnalyticsList", { networks: [...new Set(noAnalytics.map((c) => getCapabilities(c.platform).name))].join(", ") })}
            </p>
          ) : null}
        </Panel>

        <Panel title={t("dash.analytics.topPosts")} padded={false}>
          {data.top.length ? (
            <ol className="divide-y divide-line">
              {data.top.map((p, i) => {
                const ch = channelById.get(p.channelId);
                return (
                  <li key={p.targetId} className="flex gap-3 px-5 py-3">
                    <span className="mt-0.5 w-5 shrink-0 text-end text-xs font-semibold text-muted tabular-nums">{i + 1}</span>
                    <PlatformIcon platform={p.platform} className="mt-0.5 size-5" title={ch?.name} />
                    <div className="min-w-0 flex-1">
                      <p dir="auto" className="line-clamp-2 text-sm">
                        {p.text || t("dash.home.noText")}
                      </p>
                      <p className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-muted">
                        <span>{formatInZone(p.publishedAt, lc, workspace.timezone)}</span>
                        <span>{t("dash.analytics.topLine", { engagements: num(p.engagement), views: num(p.views) })}</span>
                        {p.permalink ? (
                          <a href={p.permalink} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
                            {t("dash.analytics.view")}
                            <ExternalLink className="size-3" aria-hidden />
                          </a>
                        ) : null}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ol>
          ) : (
            <Empty title={t("dash.analytics.noTop")}>{t("dash.analytics.noTopText")}</Empty>
          )}
        </Panel>
      </div>
    </div>
  );
}
