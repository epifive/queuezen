import type { Metadata } from "next";
import { DashHeader, Panel } from "@/components/dashboard/ui";
import { BrandingForm } from "@/components/dashboard/approval-forms";
import { DeleteWorkspaceForm, WorkspaceSettingsForm } from "@/components/dashboard/workspace-forms";
import { requireWorkspace } from "@/lib/dashboard";
import { getT } from "@/lib/i18n/server";
import { getWorkspaceEntitlements } from "@/lib/workspaces";
import { roleCan, timeZoneOptions } from "@/social/normalize";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("dash.nav.settings") };
}

/** Workspace settings: general, approvals, links in posts (UTM, short links), client branding and deleting the workspace. */
export default async function WorkspaceSettingsPage({ params }: { params: Promise<{ wid: string }> }) {
  const { workspace, role } = await requireWorkspace((await params).wid);
  const [t, entitlements] = await Promise.all([getT(), getWorkspaceEntitlements(workspace)]);
  return (
    <>
      <DashHeader title={t("dash.nav.settings")} description={t("dash.settings.subtitle")} />
      <Panel title={t("dash.settings.general")}>
        <WorkspaceSettingsForm
          workspaceId={workspace.id}
          zones={timeZoneOptions()}
          canEdit={roleCan(role, "settings.manage")}
          values={{ name: workspace.name, timezone: workspace.timezone, approvalRequired: workspace.settings.approvalRequired, weekStart: workspace.settings.weekStart, utm: workspace.settings.utm, shortenLinks: workspace.settings.shortenLinks }}
        />
      </Panel>
      <Panel id="branding" title={t("dash.branding.title")} description={entitlements.allowWhiteLabel ? t("dash.branding.text") : t("dash.branding.upsell")} className="mt-6">
        <BrandingForm workspaceId={workspace.id} values={workspace.settings.branding} canEdit={roleCan(role, "settings.manage")} />
      </Panel>
      {roleCan(role, "workspace.delete") ? (
        <Panel id="delete" title={t("dash.settings.deleteTitle")} description={workspace.isPersonal ? undefined : t("dash.settings.deleteText")} className="mt-6">
          {workspace.isPersonal ? <p className="text-sm text-muted">{t("dash.settings.deletePersonal")}</p> : <DeleteWorkspaceForm workspaceId={workspace.id} name={workspace.name} />}
        </Panel>
      ) : null}
    </>
  );
}
