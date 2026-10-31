import type { Metadata } from "next";
import Link from "next/link";
import { FlaskConical, Radio, ShieldCheck } from "lucide-react";
import { ChannelCard, type ChannelCardData, type ChannelDisplayStatus } from "@/components/dashboard/channel-card";
import { ConnectForm } from "@/components/dashboard/channel-connect";
import { DashHeader, Empty, Meter, Panel } from "@/components/dashboard/ui";
import { PlatformIcon } from "@/components/social/platform-icon";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { buttonClass } from "@/components/ui/button";
import { channelQuota, getWorkspaceChannels } from "@/lib/channels";
import { formatDateTime, formatNumber, formatRelative } from "@/lib/dash-format";
import { now } from "@/lib/db";
import { requireWorkspace } from "@/lib/dashboard";
import type { MessageKey } from "@/lib/i18n/messages";
import { getLocale, getT } from "@/lib/i18n/server";
import { getDriver } from "@/lib/platforms";
import { ensureDrivers, getDriverContext, isPlatformConfigured } from "@/lib/platforms/runtime";
import { getSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { getWorkspaceEntitlements } from "@/lib/workspaces";
import { platformName } from "@/social/format";
import { roleCan } from "@/social/normalize";
import { PLATFORM_CAPABILITIES } from "@/social/platforms";
import { V1_PLATFORMS, type ConnectField, type Platform } from "@/social/types";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("dash.nav.channels") };
}

const DAY = 86_400_000;

/**
 * Connected social accounts of the workspace and the networks that can be connected: OAuth
 * networks start at /api/oauth/<platform>/start, the others unfold their connect form.
 */
export default async function ChannelsPage({ params, searchParams }: { params: Promise<{ wid: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { workspace, role, user } = await requireWorkspace((await params).wid);
  const sp = await searchParams;
  const q = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : "");
  const [t, locale, channels, entitlements, settings, simulated] = await Promise.all([getT(), getLocale(), getWorkspaceChannels(workspace.id), getWorkspaceEntitlements(workspace), getSettings(), ensureDrivers()]);
  const quota = await channelQuota(workspace.ownerId, entitlements);
  const lc = locale.code;
  const num = (n: number) => formatNumber(n, lc);
  const canManage = roleCan(role, "channels.manage");
  const nowMs = Date.parse(now());
  const base = `/dashboard/w/${workspace.id}`;

  // Connect form fields of the non-OAuth networks (straight from their drivers).
  const formFields = new Map<Platform, ConnectField[]>();
  for (const p of V1_PLATFORMS) {
    const kind = PLATFORM_CAPABILITIES[p].auth.kind;
    if (simulated || (kind !== "app_password" && kind !== "bot_token" && kind !== "webhook" && p !== "mastodon")) continue;
    const driver = getDriver(p);
    if (!driver) continue;
    try {
      const start = await driver.connectStart(await getDriverContext(p), { workspaceId: workspace.id, userId: user.id, state: "", codeVerifier: "", form: {} });
      if (start.kind === "form") formFields.set(p, start.fields);
    } catch {
      // A broken driver shouldn't hide the page.
    }
  }
  const startHref = (p: Platform, reconnect?: number) => `/api/oauth/${p}/start?wid=${workspace.id}${reconnect ? `&reconnect=${reconnect}` : ""}`;

  const cards: ChannelCardData[] = channels.map((c) => {
    const auth = PLATFORM_CAPABILITIES[c.platform].auth;
    const exp = c.tokenExpiresAt ? Date.parse(c.tokenExpiresAt) : NaN;
    let status: ChannelDisplayStatus = c.status === "active" ? "active" : c.status === "error" ? "error" : "expired";
    // LinkedIn-style tokens without refresh show "Expires soon" from the reminder lead time on.
    if (status === "active" && auth.refresh === "reauth" && Number.isFinite(exp) && exp - nowMs < auth.refreshLeadDays * DAY) status = exp <= nowMs ? "expired" : "expiring";
    // Short-lived tokens (X, Google, Bluesky) are refreshed in the background: their expiry isn't news.
    const showExpiry = Number.isFinite(exp) && (auth.refresh === "reauth" || auth.refresh === "exchange");
    const expiryText = !showExpiry
      ? ""
      : auth.refresh === "reauth"
        ? t(exp <= nowMs || c.status === "expired" ? "dash.channels.reauthEnded" : "dash.channels.reauthHint", { date: formatDateTime(c.tokenExpiresAt, lc, false) })
        : t("dash.channels.expires", { date: formatDateTime(c.tokenExpiresAt, lc, false) });
    const fields = formFields.get(c.platform);
    return {
      id: c.id,
      platform: c.platform,
      name: c.name,
      handle: c.handle,
      avatarUrl: c.avatarUrl,
      profileUrl: c.profileUrl,
      status,
      lastError: c.lastError,
      expiryText,
      checkedText: c.lastCheckedAt ? t("dash.channels.lastChecked", { date: formatRelative(c.lastCheckedAt, lc, nowMs) }) : "",
      firstComment: c.settings.defaultFirstComment,
      hashtags: c.settings.hashtags,
      utm: {
        mode: !c.settings.utm ? "workspace" : c.settings.utm.enabled ? "custom" : "off",
        source: (c.settings.utm ?? workspace.settings.utm).source,
        medium: (c.settings.utm ?? workspace.settings.utm).medium,
        campaign: (c.settings.utm ?? workspace.settings.utm).campaign,
      },
      simulated: c.meta.simulated === true,
      reconnect: fields ? { kind: "form", fields } : { kind: "link", href: startHref(c.platform, c.id) },
    };
  });

  const connected = q("connected");
  const openForm = q("connect");
  const error = q("error");
  const errorKey = error && /^[a-z]+$/.test(error) ? (`dash.channels.err.${error}` as MessageKey) : null;

  return (
    <div className="space-y-6">
      <DashHeader title={t("dash.nav.channels")} description={t("dash.channels.subtitle")} />

      {simulated ? (
        <Alert tone="warning">
          <span className="inline-flex items-center gap-1.5">
            <FlaskConical className="size-4" aria-hidden />
            {t("dash.channels.simulatedBanner")}
          </span>
        </Alert>
      ) : null}
      {connected && V1_PLATFORMS.includes(connected as Platform) ? (
        <Alert tone="success">{t("dash.channels.connectedFlash", { platform: platformName(connected as Platform), added: num(Number(q("added")) || 0), updated: num(Number(q("updated")) || 0) })}</Alert>
      ) : null}
      {errorKey ? (
        <Alert tone="error">
          {t(errorKey)}
          {q("detail") ? <span className="mt-1 block text-xs opacity-80">{q("detail")}</span> : null}
        </Alert>
      ) : null}

      <Panel>
        <Meter
          label={t("dash.channels.quota")}
          used={quota.used}
          limit={quota.limit}
          usedText={num(quota.used)}
          limitText={quota.limit > 0 ? num(quota.limit) : t("pricing.unlimited")}
          critical
        />
        <p className="mt-2 text-xs text-muted">{t("dash.channels.quotaHint")}</p>
      </Panel>

      <section aria-labelledby="channels-connected">
        <h2 id="channels-connected" className="mb-3 font-sans text-sm font-semibold tracking-normal">
          {t("dash.channels.connected")}
        </h2>
        {cards.length ? (
          <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {cards.map((c) => (
              <ChannelCard key={c.id} channel={c} workspaceId={workspace.id} canManage={canManage} queueHref={`${base}/queue`} />
            ))}
          </ul>
        ) : (
          <Panel>
            <Empty icon={<Radio />} title={t("dash.channels.emptyTitle")}>
              {t("dash.channels.emptyText")}
            </Empty>
          </Panel>
        )}
      </section>

      <section aria-labelledby="channels-connect">
        <h2 id="channels-connect" className="mb-3 font-sans text-sm font-semibold tracking-normal">
          {t("dash.channels.connect")}
        </h2>
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {V1_PLATFORMS.map((p) => {
            const caps = PLATFORM_CAPABILITIES[p];
            const configured = isPlatformConfigured(p, settings, simulated);
            const fields = formFields.get(p);
            const full = quota.full;
            return (
              <li key={p} id={`connect-${p}`} className={cn("flex h-full flex-col gap-3 rounded-xl border bg-surface p-4", openForm === p ? "border-primary" : "border-line")}>
                <div className="flex items-center gap-3">
                  <PlatformIcon platform={p} className="size-10" />
                  <div className="min-w-0">
                    <p className="font-semibold">{caps.name}</p>
                    <p className="text-xs text-muted">{t(`dash.channels.auth.${caps.auth.kind}` as MessageKey)}</p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {caps.auth.reviewRequired ? (
                    <Badge tone="warning">{t("dash.channels.review")}</Badge>
                  ) : (
                    <Badge tone="success">
                      <ShieldCheck className="size-3" aria-hidden />
                      {t("dash.channels.noReview")}
                    </Badge>
                  )}
                  {caps.analytics.supported ? <Badge>{t("dash.channels.analytics")}</Badge> : null}
                  {caps.cost ? <Badge tone="primary">{t("dash.channels.paidApi")}</Badge> : null}
                </div>
                <div className="mt-auto">
                  {!canManage ? null : !configured ? (
                    <div className="space-y-2">
                      <p className="text-xs text-muted">{t("dash.channels.notConfigured", { platform: caps.name })}</p>
                      {user.role === "admin" ? (
                        <Link href={`/admin/platforms/${p}`} className="text-xs font-medium text-primary hover:underline">
                          {t("dash.channels.setupLink")}
                        </Link>
                      ) : null}
                    </div>
                  ) : full ? (
                    <p className="text-xs text-muted">{t("dash.channels.err.limit")}</p>
                  ) : fields ? (
                    <ConnectForm workspaceId={workspace.id} platform={p} fields={fields} defaultOpen={openForm === p} triggerLabel={t("dash.channels.connectBtn")} />
                  ) : (
                    <a href={startHref(p)} className={buttonClass("primary", "sm")} data-connect={p}>
                      {t("dash.channels.connectBtn")}
                    </a>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
