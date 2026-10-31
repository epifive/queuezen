import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { Card, PageHeader } from "@/components/admin/ui";
import { PlatformIcon } from "@/components/social/platform-icon";
import { Badge } from "@/components/ui/badge";
import { isDemoMode } from "@/lib/config";
import { getDb } from "@/lib/db";
import { appConfigFor, ensureDrivers, getPlatformUsage, isPlatformConfigured, YOUTUBE_DAILY_UPLOADS } from "@/lib/platforms/runtime";
import { NO_APP_NOTES } from "@/lib/platforms/setup-guide";
import { getSettings } from "@/lib/settings";
import { absoluteUrl } from "@/lib/site";
import { needsOperatorApp, PLATFORM_CAPABILITIES } from "@/social/platforms";
import { V1_PLATFORMS } from "@/social/types";
import { CopyValue } from "../system/scheduler-forms";
import { SimulatedSwitchForm } from "./platform-forms";

export const metadata = { title: "Platforms" };

const usd = (micros: number) => `$${(micros / 1_000_000).toFixed(2)}`;

/** Platform Health: which networks are set up, their channels, quotas and the Meta callback URLs. */
export default async function PlatformsPage() {
  const [settings, simulated] = await Promise.all([getSettings(), ensureDrivers()]);
  const db = await getDb();
  const channelRows = await db
    .selectFrom("channels")
    .select(["platform", "status", (eb) => eb.fn.countAll<number>().as("n")])
    .where("status", "!=", "disconnected")
    .groupBy(["platform", "status"])
    .execute();
  const counts = new Map<string, { total: number; failing: number }>();
  for (const r of channelRows) {
    const c = counts.get(r.platform) ?? { total: 0, failing: 0 };
    c.total += Number(r.n);
    if (r.status !== "active") c.failing += Number(r.n);
    counts.set(r.platform, c);
  }
  const [xUsage, ytUsage] = await Promise.all([getPlatformUsage("x"), getPlatformUsage("youtube")]);
  const budget = Number(settings.x_monthly_budget) || 0;
  const privacy = absoluteUrl(settings, "/p/privacy-policy");
  const terms = absoluteUrl(settings, "/p/terms-of-service");

  return (
    <>
      <PageHeader title="Platforms" description="Set up the developer apps of each social network, check their health and watch the paid / limited APIs." />

      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Card title="Networks" padded={false}>
            <ul className="divide-y divide-line">
              {V1_PLATFORMS.map((p) => {
                const caps = PLATFORM_CAPABILITIES[p];
                const needsApp = needsOperatorApp(p);
                const configured = isPlatformConfigured(p, settings, false);
                const c = counts.get(p) ?? { total: 0, failing: 0 };
                const hasApp = Boolean(appConfigFor(p, settings)?.clientId);
                return (
                  <li key={p}>
                    <Link href={`/admin/platforms/${p}`} className="flex flex-wrap items-center gap-3 px-5 py-3.5 hover:bg-paper" data-platform={p}>
                      <PlatformIcon platform={p} className="size-9" />
                      <div className="min-w-0 flex-1">
                        <p className="font-medium">{caps.name}</p>
                        <p className="truncate text-xs text-muted">
                          {c.total} channel{c.total === 1 ? "" : "s"}
                          {c.failing ? ` · ${c.failing} need attention` : ""}
                          {p === "x" ? ` · ${usd(xUsage.month.costMicros)} this month` : ""}
                          {p === "youtube" ? ` · ${ytUsage.today.uploads}/${YOUTUBE_DAILY_UPLOADS} uploads today` : ""}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        {!needsApp ? <Badge tone="primary">No app needed</Badge> : configured ? <Badge tone="success">Configured</Badge> : hasApp ? <Badge tone="warning">Secret missing</Badge> : <Badge>Not set up</Badge>}
                        {caps.auth.reviewRequired ? <Badge tone="warning">Review</Badge> : null}
                        {caps.cost ? <Badge tone="danger">Paid API</Badge> : null}
                      </div>
                      <ChevronRight className="size-4 text-muted rtl:rotate-180" aria-hidden />
                    </Link>
                  </li>
                );
              })}
            </ul>
          </Card>
        </div>

        <div className="space-y-6">
          <Card title="Testing">
            <SimulatedSwitchForm on={settings.platforms_simulated} forced={isDemoMode()} />
            {simulated ? <p className="mt-3 text-xs font-medium text-amber-700 dark:text-amber-400">Simulation is active now.</p> : null}
          </Card>

          <Card title="X API spend">
            <p className="font-display text-3xl font-bold tabular-nums">{usd(xUsage.month.costMicros)}</p>
            <p className="mt-1 text-xs text-muted">
              Estimated this month from {xUsage.month.posts} post{xUsage.month.posts === 1 ? "" : "s"}
              {budget > 0 ? ` · budget $${budget.toFixed(2)}` : ""}.
            </p>
            {budget > 0 ? (
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-line" role="meter" aria-valuemin={0} aria-valuemax={budget} aria-valuenow={xUsage.month.costMicros / 1_000_000} aria-label="X budget used">
                <div className={xUsage.month.costMicros / 1_000_000 >= budget ? "h-full bg-red-500" : "h-full bg-primary"} style={{ width: `${Math.min(100, (xUsage.month.costMicros / 1_000_000 / budget) * 100)}%` }} />
              </div>
            ) : null}
          </Card>

          <Card title="Meta callbacks">
            <div className="space-y-4 text-sm">
              <div>
                <p className="mb-1.5 font-medium">Data deletion request URL</p>
                <CopyValue value={absoluteUrl(settings, "/api/meta/data-deletion")} label="Data deletion request URL" wrap />
                <p className="mt-1.5 text-xs text-muted">Meta app → App settings → Basic → Data deletion. Also use it for the Instagram and Threads apps (Threads: &quot;Delete callback URL&quot;).</p>
              </div>
              <div>
                <p className="mb-1.5 font-medium">Deauthorize (uninstall) callback URL</p>
                <CopyValue value={absoluteUrl(settings, "/api/meta/deauthorize")} label="Deauthorize callback URL" wrap />
                <p className="mt-1.5 text-xs text-muted">Facebook Login for Business → Settings → Deauthorize callback URL; Instagram and Threads apps: &quot;Uninstall callback URL&quot;. Disconnects the person&apos;s channels when they remove the app.</p>
              </div>
              <div>
                <p className="mb-1.5 font-medium">Privacy policy URL</p>
                <CopyValue value={privacy} label="Privacy policy URL" wrap />
              </div>
              <div>
                <p className="mb-1.5 font-medium">Terms of service URL</p>
                <CopyValue value={terms} label="Terms of service URL" wrap />
              </div>
            </div>
          </Card>

          <Card title="No developer app needed">
            <ul className="space-y-2 text-xs text-muted">
              {Object.entries(NO_APP_NOTES).map(([p, note]) => (
                <li key={p}>
                  <span className="font-medium text-ink">{PLATFORM_CAPABILITIES[p as keyof typeof PLATFORM_CAPABILITIES].name}:</span> {note}
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}
