import type { Metadata } from "next";
import { Link2, Trash2 } from "lucide-react";
import { deleteLinkAction } from "@/app/actions/dashboard/links";
import { ActionButton } from "@/components/dashboard/actions";
import { BarChart } from "@/components/dashboard/analytics-charts";
import { LinkForm } from "@/components/dashboard/automation-links";
import { AutomationTabs } from "@/components/dashboard/automation-tabs";
import { CopyButton } from "@/components/dashboard/copy";
import { Kpi, KpiGrid } from "@/components/dashboard/kit";
import { DashHeader, DTable, DTd, DTh, Empty, Panel } from "@/components/dashboard/ui";
import { formatDateTime, formatDay, formatNumber, formatRelative } from "@/lib/dash-format";
import { requireWorkspace } from "@/lib/dashboard";
import { getLocale, getT } from "@/lib/i18n/server";
import { periodDays } from "@/lib/periods";
import { getSettings } from "@/lib/settings";
import { clicksByDay, clicksPerLink, countShortLinks, getShortLinks } from "@/lib/shortlinks";
import { absoluteUrl } from "@/lib/site";
import { roleCan } from "@/social/normalize";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("dash.links.title") };
}

/** Tracked short links (/l/<code>) with UTM parameters and daily clicks. */
export default async function LinksPage({ params, searchParams }: { params: Promise<{ wid: string }>; searchParams: Promise<{ q?: string }> }) {
  const { workspace, role } = await requireWorkspace((await params).wid);
  const q = ((await searchParams).q ?? "").slice(0, 100);
  const days = periodDays(30);
  const [t, locale, settings, links, total, series, perLink] = await Promise.all([
    getT(),
    getLocale(),
    getSettings(),
    getShortLinks(workspace.id, { limit: 200, search: q }),
    countShortLinks(workspace.id),
    clicksByDay(workspace.id, days),
    clicksPerLink(workspace.id, days[0], days[days.length - 1]),
  ]);
  const lc = locale.code;
  const canEdit = roleCan(role, "post.create");
  const clicks30 = series.reduce((n, d) => n + d.clicks, 0);
  const allClicks = links.reduce((n, l) => n + l.clicks, 0);
  const shortBase = absoluteUrl(settings, "/l/");

  return (
    <div className="space-y-6">
      <DashHeader title={t("dash.links.title")} description={t("dash.links.subtitle")} />
      <AutomationTabs workspaceId={workspace.id} active="links" labels={{ rss: t("dash.automation.tabRss"), recycle: t("dash.automation.tabRecycle"), links: t("dash.automation.tabLinks"), nav: t("dash.nav.automation") }} />

      <KpiGrid className="grid-cols-1 sm:grid-cols-3">
        <Kpi label={t("dash.links.kpiLinks")} value={formatNumber(total, lc)} />
        <Kpi label={t("dash.links.kpiClicks30")} value={formatNumber(clicks30, lc)} accent="bg-primary" />
        <Kpi label={t("dash.links.kpiClicksAll")} value={formatNumber(allClicks, lc)} />
      </KpiGrid>

      <Panel title={t("dash.links.chartTitle")} description={t("dash.links.chartText")}>
        <BarChart data={series.map((d) => ({ key: d.day, label: formatDay(d.day, lc), value: d.clicks }))} locale={lc} label={t("dash.links.chartTitle")} valueLabel={t("dash.links.clicks")} />
      </Panel>

      {canEdit ? (
        <Panel title={t("dash.links.createTitle")} description={t("dash.links.createText")}>
          <LinkForm workspaceId={workspace.id} />
        </Panel>
      ) : null}

      <Panel
        title={t("dash.links.listTitle")}
        actions={
          <form className="flex gap-2" role="search">
            <input name="q" defaultValue={q} placeholder={t("dash.links.search")} aria-label={t("dash.links.search")} dir="auto" className="h-8 w-44 rounded-lg border border-line bg-surface px-2.5 text-sm" />
          </form>
        }
        padded={false}
      >
        {links.length ? (
          <DTable minWidth={760} label={t("dash.links.listTitle")}>
            <thead>
              <tr>
                <DTh>{t("dash.links.link")}</DTh>
                <DTh>{t("dash.links.short")}</DTh>
                <DTh className="text-end">{t("dash.links.clicks30")}</DTh>
                <DTh className="text-end">{t("dash.links.clicksAll")}</DTh>
                <DTh>{t("dash.links.createdAt")}</DTh>
                <DTh className="text-end">
                  <span className="sr-only">{t("dash.api.actions")}</span>
                </DTh>
              </tr>
            </thead>
            <tbody>
              {links.map((l) => (
                <tr key={l.id} className="align-top">
                  <DTd>
                    <p dir="auto" className="max-w-72 truncate font-medium">
                      {l.title || l.baseUrl}
                    </p>
                    <p dir="ltr" className="max-w-72 truncate text-start text-xs text-muted" title={l.url}>
                      {l.url}
                    </p>
                    {canEdit ? (
                      <details className="mt-1">
                        <summary className="cursor-pointer text-xs font-medium text-primary">{t("dash.links.edit")}</summary>
                        <div className="mt-3 w-[min(36rem,80vw)] rounded-lg border border-line p-4">
                          <LinkForm workspaceId={workspace.id} link={{ id: l.id, url: l.baseUrl, title: l.title, utm: l.utm }} />
                        </div>
                      </details>
                    ) : null}
                  </DTd>
                  <DTd>
                    <div className="flex items-center gap-2">
                      <code dir="ltr" className="font-mono text-[13px]">
                        /l/{l.code}
                      </code>
                      <CopyButton text={`${shortBase}${l.code}`} variant="ghost" />
                    </div>
                  </DTd>
                  <DTd className="text-end tabular-nums">{formatNumber(perLink.get(l.id) ?? 0, lc)}</DTd>
                  <DTd className="text-end tabular-nums">
                    {formatNumber(l.clicks, lc)}
                    {l.lastClickedAt ? <p className="text-xs text-muted">{formatRelative(l.lastClickedAt, lc)}</p> : null}
                  </DTd>
                  <DTd className="text-muted">{formatDateTime(l.createdAt, lc, false)}</DTd>
                  <DTd className="text-end">
                    {canEdit ? (
                      <ActionButton action={deleteLinkAction} fields={{ wid: workspace.id, link_id: l.id }} variant="ghost" label={t("dash.links.delete")} confirmText={t("dash.links.deleteConfirm")} className="items-end">
                        <Trash2 aria-hidden />
                      </ActionButton>
                    ) : null}
                  </DTd>
                </tr>
              ))}
            </tbody>
          </DTable>
        ) : (
          <Empty icon={<Link2 />} title={q ? t("dash.links.noMatch") : t("dash.links.emptyTitle")}>
            {q ? null : t("dash.links.emptyText")}
          </Empty>
        )}
      </Panel>
    </div>
  );
}
