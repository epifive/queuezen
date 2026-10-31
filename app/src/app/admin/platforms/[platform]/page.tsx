import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { Card, PageHeader } from "@/components/admin/ui";
import { PlatformIcon } from "@/components/social/platform-icon";
import { Badge } from "@/components/ui/badge";
import { getPlatformUsage, isPlatformConfigured, YOUTUBE_DAILY_UNITS, YOUTUBE_DAILY_UPLOADS } from "@/lib/platforms/runtime";
import { NO_APP_NOTES, SETUP_GUIDES } from "@/lib/platforms/setup-guide";
import { getSettings, SECRET_SETTINGS } from "@/lib/settings";
import { absoluteUrl } from "@/lib/site";
import { isPlatform } from "@/social/normalize";
import { oauthCallbackPath, PLATFORM_CAPABILITIES } from "@/social/platforms";
import { V1_PLATFORMS } from "@/social/types";
import { CopyValue } from "../../system/scheduler-forms";
import { PlatformAppForm, TestAppForm } from "../platform-forms";

export async function generateMetadata({ params }: { params: Promise<{ platform: string }> }) {
  const { platform } = await params;
  return { title: isPlatform(platform) ? `${PLATFORM_CAPABILITIES[platform].name} · Platforms` : "Platforms" };
}

const usd = (micros: number) => `$${(micros / 1_000_000).toFixed(2)}`;

function MeterRow({ label, used, limit, text }: { label: string; used: number; limit: number; text: string }) {
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="font-medium">{label}</span>
        <span className="tabular-nums text-muted">{text}</span>
      </div>
      <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-line" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={limit} aria-valuenow={used}>
        <div className={pct >= 90 ? "h-full bg-red-500" : pct >= 70 ? "h-full bg-amber-500" : "h-full bg-primary"} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** Setup wizard of one network: redirect URI, scopes, app credentials, Test, review checklist and quotas. */
export default async function PlatformSetupPage({ params }: { params: Promise<{ platform: string }> }) {
  const { platform } = await params;
  if (!isPlatform(platform) || !V1_PLATFORMS.includes(platform)) notFound();
  const caps = PLATFORM_CAPABILITIES[platform];
  const guide = SETUP_GUIDES[platform];
  const settings = await getSettings();
  const usage = await getPlatformUsage(platform);
  const configured = isPlatformConfigured(platform, settings, false);
  const redirect = absoluteUrl(settings, oauthCallbackPath(platform));
  const values: Record<string, string> = {};
  const secretsSet: Record<string, boolean> = {};
  for (const f of guide?.fields ?? []) {
    const v = settings[f.key];
    if (f.secret || SECRET_SETTINGS.includes(f.key)) secretsSet[f.key] = Boolean(v);
    else values[f.key] = String(v ?? "");
  }
  const budget = Number(settings.x_monthly_budget) || 0;

  return (
    <>
      <PageHeader
        title={`${caps.name} setup`}
        description={caps.auth.review}
        actions={
          <Link href="/admin/platforms" className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline">
            <ArrowLeft className="size-4 rtl:rotate-180" aria-hidden />
            All platforms
          </Link>
        }
      />
      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Card
            title={
              <span className="inline-flex items-center gap-2">
                <PlatformIcon platform={platform} className="size-5" />
                {guide ? "1. Create the developer app" : "Connection"}
              </span>
            }
            actions={guide ? configured ? <Badge tone="success">Configured</Badge> : <Badge>Not set up</Badge> : <Badge tone="primary">No app needed</Badge>}
          >
            {guide ? (
              <div className="space-y-5">
                {guide.sharedWith?.length ? (
                  <p className="rounded-lg bg-primary-soft px-3 py-2 text-xs text-ink">
                    These credentials are shared with {guide.sharedWith.map((p) => PLATFORM_CAPABILITIES[p].name).join(", ")} (one Meta app).
                  </p>
                ) : null}
                <div>
                  <p className="mb-1.5 text-sm font-medium">Redirect URI (copy it into the app exactly)</p>
                  <CopyValue value={redirect} label={`${caps.name} redirect URI`} />
                  {!settings.site_url && !process.env.SITE_URL ? <p className="mt-1.5 text-xs text-amber-700 dark:text-amber-400">Set your Site URL in Settings → General first: the redirect URI is built from it.</p> : null}
                </div>
                <div>
                  <p className="mb-1.5 text-sm font-medium">Permissions (scopes)</p>
                  <ul className="flex flex-wrap gap-1.5">
                    {caps.auth.scopes.map((s) => (
                      <li key={s}>
                        <code dir="ltr" className="rounded bg-paper px-1.5 py-0.5 font-mono text-xs">
                          {s}
                        </code>
                      </li>
                    ))}
                  </ul>
                </div>
                <ol className="list-decimal space-y-1.5 ps-5 text-sm">
                  {guide.steps.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ol>
                <div className="flex flex-wrap gap-2">
                  {guide.consoles.map((c) => (
                    <a key={c.url} href={c.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-xs font-medium hover:border-primary-line hover:text-primary">
                      <ExternalLink className="size-3.5" aria-hidden />
                      {c.label}
                    </a>
                  ))}
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted">{NO_APP_NOTES[platform]}</p>
            )}
          </Card>

          {guide ? (
            <Card title="2. App credentials">
              <PlatformAppForm platform={platform} fields={guide.fields} values={values} secretsSet={secretsSet} />
              <div className="mt-6 border-t border-line pt-5">
                <TestAppForm platform={platform} disabled={!configured} />
              </div>
            </Card>
          ) : null}

          {guide ? (
            <Card title="3. Review and going live">
              <ul className="space-y-2 text-sm">
                {guide.checklist.map((c) => (
                  <li key={c} className="flex gap-2">
                    <span className="mt-2 size-1.5 shrink-0 rounded-full bg-primary/70" aria-hidden />
                    <span>{c}</span>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </div>

        <div className="space-y-6">
          <Card title="Usage">
            <div className="space-y-4">
              {platform === "youtube" ? (
                <>
                  <MeterRow label="Uploads today (per Cloud project)" used={usage.today.uploads} limit={YOUTUBE_DAILY_UPLOADS} text={`${usage.today.uploads} / ${YOUTUBE_DAILY_UPLOADS}`} />
                  <MeterRow label="Other quota units today" used={usage.today.apiCalls} limit={YOUTUBE_DAILY_UNITS} text={`${usage.today.apiCalls.toLocaleString("en-US")} / ${YOUTUBE_DAILY_UNITS.toLocaleString("en-US")}`} />
                </>
              ) : null}
              {platform === "x" ? (
                budget > 0 ? (
                  <MeterRow label="API spend this month" used={usage.month.costMicros / 1_000_000} limit={budget} text={`${usd(usage.month.costMicros)} / $${budget.toFixed(2)}`} />
                ) : (
                  <p className="text-sm">
                    <span className="font-display text-2xl font-bold">{usd(usage.month.costMicros)}</span> <span className="text-muted">estimated this month</span>
                  </p>
                )
              ) : null}
              <dl className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <dt className="text-xs text-muted">Posts today</dt>
                  <dd className="font-semibold tabular-nums">{usage.today.posts}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">Posts this month</dt>
                  <dd className="font-semibold tabular-nums">{usage.month.posts}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">Errors this month</dt>
                  <dd className="font-semibold tabular-nums">{usage.month.errors}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">Uploads this month</dt>
                  <dd className="font-semibold tabular-nums">{usage.month.uploads}</dd>
                </div>
              </dl>
              {caps.cost ? <p className="text-xs text-muted">Pricing: ${caps.cost.perPost.toFixed(3)} per post, ${caps.cost.perPostWithUrl.toFixed(2)} per post with a link.</p> : null}
            </div>
          </Card>

          <Card title="Facts">
            <dl className="space-y-3 text-sm">
              <div>
                <dt className="text-xs text-muted">Tokens</dt>
                <dd>{caps.auth.tokenLifetime}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Limits</dt>
                <dd>{caps.limits.note}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Analytics</dt>
                <dd>{caps.analytics.supported ? caps.analytics.note : `None: ${caps.analytics.note}`}</dd>
              </div>
            </dl>
            {guide?.tips.length ? (
              <ul className="mt-4 space-y-2 border-t border-line pt-4 text-xs text-muted">
                {guide.tips.map((tip) => (
                  <li key={tip}>{tip}</li>
                ))}
              </ul>
            ) : null}
            <ul className="mt-4 space-y-1 border-t border-line pt-4 text-xs">
              {caps.docs.map((d) => (
                <li key={d} className="truncate">
                  <a href={d} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline" dir="ltr">
                    {d.replace(/^https:\/\//, "")}
                  </a>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}
