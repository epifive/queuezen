import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, Clock } from "lucide-react";
import { AccountPicker } from "@/components/dashboard/channel-connect";
import { DashHeader, Empty, Panel } from "@/components/dashboard/ui";
import { PlatformIcon } from "@/components/social/platform-icon";
import { channelQuota, getWorkspaceChannels } from "@/lib/channels";
import { requireWorkspace } from "@/lib/dashboard";
import { formatNumber } from "@/lib/dash-format";
import { getLocale, getT } from "@/lib/i18n/server";
import { getConnectSession } from "@/lib/platforms/runtime";
import { getWorkspaceEntitlements } from "@/lib/workspaces";
import { platformName } from "@/social/format";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("dash.channels.pick.title"), robots: { index: false } };
}

/** Choose which of the accounts shared in one connect (Facebook Pages, Instagram accounts…) to add. */
export default async function PickAccountsPage({ params, searchParams }: { params: Promise<{ wid: string }>; searchParams: Promise<{ s?: string }> }) {
  const { workspace, user } = await requireWorkspace((await params).wid, "admin");
  const token = (await searchParams).s ?? "";
  const [t, locale, session] = await Promise.all([getT(), getLocale(), getConnectSession(token, user.id, workspace.id)]);
  const back = `/dashboard/w/${workspace.id}/channels`;
  const backLink = (
    <Link href={back} className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline">
      <ArrowLeft className="size-4 rtl:rotate-180" aria-hidden />
      {t("dash.nav.channels")}
    </Link>
  );
  if (!session) {
    return (
      <div className="space-y-6">
        <DashHeader title={t("dash.channels.pick.title")} actions={backLink} />
        <Panel>
          <Empty icon={<Clock />} title={t("dash.channels.pick.expiredTitle")}>
            {t("dash.channels.err.expired")}
          </Empty>
        </Panel>
      </div>
    );
  }
  const [existing, entitlements] = await Promise.all([getWorkspaceChannels(workspace.id), getWorkspaceEntitlements(workspace)]);
  const quota = await channelQuota(workspace.ownerId, entitlements);
  const remaining = quota.limit > 0 ? Math.max(0, quota.limit - quota.used) : null;
  const connected = new Set(existing.filter((c) => c.platform === session.platform).map((c) => c.externalId));
  const name = platformName(session.platform);
  return (
    <div className="space-y-6">
      <DashHeader title={t("dash.channels.pick.title")} description={t("dash.channels.pick.subtitle", { platform: name })} actions={backLink} />
      <Panel
        title={
          <span className="inline-flex items-center gap-2">
            <PlatformIcon platform={session.platform} className="size-5" />
            {name}
          </span>
        }
        description={remaining === null ? t("dash.channels.pick.unlimited") : t("dash.channels.pick.slots", { n: formatNumber(remaining, locale.code) })}
      >
        <AccountPicker
          workspaceId={workspace.id}
          token={token}
          remaining={remaining}
          accounts={session.accounts.map((a) => ({ externalId: a.externalId, name: a.name, handle: a.handle, avatarUrl: a.avatarUrl, connected: connected.has(a.externalId) }))}
        />
      </Panel>
    </div>
  );
}
