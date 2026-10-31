import "server-only";
import crypto from "node:crypto";
import { sql } from "kysely";
import { Agent, fetch as undiciFetch } from "undici";
import { getDb, now } from "@/lib/db";
import { isDemoMode } from "@/lib/config";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { guardedLookup } from "@/lib/net/ssrf";
import { getSettings, type Settings } from "@/lib/settings";
import { absoluteUrl } from "@/lib/site";
import { needsOperatorApp, oauthCallbackPath, PLATFORM_CAPABILITIES } from "@/social/platforms";
import { DriverError, V1_PLATFORMS, type ConnectedAccount, type DriverChannel, type Platform, type PlatformAppConfig, type PublishResult } from "@/social/types";
import { usageOf, type PublishUsage } from "./extras";
import type { MastodonAppRecord, PlatformContext } from "./http";
import { getDriver } from "./index";

/**
 * Server side of the platform drivers: app credentials from the settings, the DriverContext
 * (fetch, clock, redirect URI, Mastodon app store), the simulated switch, on-demand token
 * refresh, the platform_usage_daily meters and the picker's pending connect sessions.
 *
 * Callers (publishing engine, metrics job, connect routes):
 *   await ensureDrivers();                       // loads the simulated switch
 *   const driver = getDriver(platform);
 *   const ctx = await getDriverContext(platform);
 *   const channel = await ensureFreshChannel(driverChannel);   // refresh tokens about to expire
 *   const result = await driver.publish(ctx, input);
 *   await recordPublishUsage(platform, result);  // posts, uploads, YouTube units, X cost
 */

// ── Simulated platforms ──

type SimGlobal = { __qzSimulatedPlatforms?: boolean };

/** Loads the "Simulated platforms" switch (DEMO_MODE forces it on) for getDriver(). */
export async function ensureDrivers(): Promise<boolean> {
  let on = isDemoMode();
  if (!on) {
    try {
      on = (await getSettings()).platforms_simulated === true;
    } catch {
      on = false;
    }
  }
  (globalThis as SimGlobal).__qzSimulatedPlatforms = on;
  return on;
}

/** Called after the admin changes the switch. */
export function setSimulatedFlag(on: boolean): void {
  (globalThis as SimGlobal).__qzSimulatedPlatforms = isDemoMode() || on;
}

export async function isSimulated(): Promise<boolean> {
  return ensureDrivers();
}

// ── App credentials ──

export function appConfigFor(platform: Platform, s: Settings): PlatformAppConfig | null {
  const site = { siteName: s.site_name, siteUrl: absoluteUrl(s, "/") };
  const cfg = (clientId: string, clientSecret: string, extra: Record<string, string> = {}): PlatformAppConfig | null =>
    clientId.trim() ? { clientId: clientId.trim(), clientSecret: clientSecret.trim(), extra: { ...site, ...extra } } : null;
  switch (platform) {
    case "facebook":
    case "instagram":
      return cfg(s.meta_app_id, s.meta_app_secret, s.meta_config_id.trim() ? { configId: s.meta_config_id.trim() } : {});
    case "instagram_login":
      return cfg(s.instagram_app_id, s.instagram_app_secret);
    case "threads":
      return cfg(s.threads_app_id, s.threads_app_secret);
    case "x":
      return cfg(s.x_client_id, s.x_client_secret, { monthlyBudget: String(s.x_monthly_budget ?? 0) });
    case "linkedin":
      return cfg(s.linkedin_client_id, s.linkedin_client_secret, s.linkedin_api_version.trim() ? { apiVersion: s.linkedin_api_version.trim() } : {});
    case "youtube":
      return cfg(s.google_client_id, s.google_client_secret);
    default:
      // No operator app (Mastodon registers itself per instance; form-based platforms need none).
      return { clientId: "", clientSecret: "", extra: site };
  }
}

/** True when users can connect this platform now (the operator's app is set up, or simulated). */
export function isPlatformConfigured(platform: Platform, s: Settings, simulated: boolean): boolean {
  if (simulated) return true;
  if (!V1_PLATFORMS.includes(platform)) return false;
  if (!needsOperatorApp(platform)) return true;
  const app = appConfigFor(platform, s);
  return Boolean(app?.clientId && app.clientSecret);
}

// ── fetch ──

/**
 * TESTING ONLY: QUEUEZEN_TEST_API_OVERRIDES="https://api.telegram.org=http://127.0.0.1:5611/tg,
 * https://bsky.social=http://127.0.0.1:5611/pds" sends requests for those prefixes to local mock
 * servers (the driver e2e tests). Never set it in production.
 */
function testOverrides(): Array<[string, string]> {
  const raw = process.env.QUEUEZEN_TEST_API_OVERRIDES?.trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((pair) => pair.split("=").map((x) => x.trim()) as [string, string])
    .filter(([from, to]) => from && to);
}

/** Outgoing requests: no connections to private addresses (user-entered Mastodon servers, link thumbnails). */
const agent = new Agent({ connect: { lookup: guardedLookup, timeout: 15_000 }, headersTimeout: 120_000, bodyTimeout: 120_000 });

export const platformFetch: typeof fetch = async (input, init) => {
  let url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  for (const [from, to] of testOverrides()) {
    if (url.startsWith(from)) {
      url = to + url.slice(from.length);
      return fetch(url, init);
    }
  }
  try {
    return (await undiciFetch(url, { ...(init as object), dispatcher: agent } as Parameters<typeof undiciFetch>[1])) as unknown as Response;
  } catch (error) {
    const code = (error as { cause?: { code?: string } }).cause?.code;
    if (code === "EBLOCKED") throw new DriverError("This address points to a private network and can't be used.", "validation", { code: "private_address" });
    throw error;
  }
};

// ── Mastodon apps ──

const MASTODON_PURPOSE = "mastodon-app";
const sha = (v: string) => crypto.createHash("sha256").update(v).digest("hex");

export const mastodonAppStore: NonNullable<PlatformContext["mastodonApps"]> = {
  async get(instance, redirectUri): Promise<MastodonAppRecord | null> {
    const db = await getDb();
    const row = await db.selectFrom("mastodon_apps").selectAll().where("instance", "=", instance).where("redirect_hash", "=", sha(redirectUri)).executeTakeFirst();
    if (!row) return null;
    try {
      return { clientId: row.client_id, clientSecret: await decryptSecret(row.client_secret, MASTODON_PURPOSE) };
    } catch {
      return null;
    }
  },
  async save(instance, redirectUri, app) {
    const db = await getDb();
    const hash = sha(redirectUri);
    await db.deleteFrom("mastodon_apps").where("instance", "=", instance).where("redirect_hash", "=", hash).execute();
    await db
      .insertInto("mastodon_apps")
      .values({ instance: instance.slice(0, 190), redirect_hash: hash, client_id: app.clientId.slice(0, 255), client_secret: await encryptSecret(app.clientSecret, MASTODON_PURPOSE), created_at: now() })
      .execute();
  },
};

// ── Context ──

export async function getDriverContext(platform: Platform, options: { pollBudgetMs?: number } = {}): Promise<PlatformContext> {
  const settings = await getSettings();
  return {
    app: appConfigFor(platform, settings),
    redirectUri: absoluteUrl(settings, oauthCallbackPath(platform)),
    fetch: platformFetch,
    now: () => Date.now(),
    mastodonApps: mastodonAppStore,
    ...(options.pollBudgetMs !== undefined ? { pollBudgetMs: options.pollBudgetMs } : {}),
  };
}

// ── Token refresh on demand ──

/** Refresh this long before the access token expires (short-lived tokens: X 2 h, Google 1 h, Bluesky). */
export const REFRESH_SKEW_MS = 10 * 60_000;

/**
 * The channel with a usable access token: refreshes it (and saves the new credentials, rotating
 * refresh tokens included) when it expires within 10 minutes. Auth failures mark the channel
 * "expired" (reconnect needed) and are rethrown.
 */
export async function ensureFreshChannel(channel: DriverChannel, options: { force?: boolean } = {}): Promise<DriverChannel> {
  const expiresAt = Date.parse(channel.credentials.expiresAt ?? "");
  const due = options.force || (Number.isFinite(expiresAt) && expiresAt - Date.now() < REFRESH_SKEW_MS);
  if (!due) return channel;
  await ensureDrivers();
  const driver = getDriver(channel.platform);
  if (!driver) return channel;
  const { updateChannelCredentials, setChannelStatus } = await import("@/lib/channels");
  try {
    const result = await driver.refresh(await getDriverContext(channel.platform), channel);
    if (!result) return channel;
    await updateChannelCredentials(channel.id, result.credentials, result.tokenExpiresAt);
    return { ...channel, credentials: result.credentials };
  } catch (error) {
    if (error instanceof DriverError && error.kind === "auth" && !error.retryable) await setChannelStatus(channel.id, "expired", error.message);
    throw error;
  }
}

// ── Usage meters (platform_usage_daily) ──

const today = () => new Date().toISOString().slice(0, 10);

/** Adds to today's app-wide counters of a platform (YouTube uploads / units, X cost…). Never throws. */
export async function recordPlatformUsage(platform: Platform, usage: PublishUsage & { errors?: number }, day = today()): Promise<void> {
  const delta = {
    posts: Math.max(0, Math.round(usage.posts ?? 0)),
    uploads: Math.max(0, Math.round(usage.uploads ?? 0)),
    // YouTube: api_calls holds Data API quota units; other platforms count calls.
    api_calls: Math.max(0, Math.round(usage.quotaUnits ?? usage.apiCalls ?? 0)),
    errors: Math.max(0, Math.round(usage.errors ?? 0)),
    cost_micros: Math.max(0, Math.round(usage.costMicros ?? 0)),
  };
  if (!Object.values(delta).some((v) => v > 0)) return;
  try {
    const db = await getDb();
    const bump = () =>
      db
        .updateTable("platform_usage_daily")
        .set({
          posts: sql`posts + ${delta.posts}`,
          uploads: sql`uploads + ${delta.uploads}`,
          api_calls: sql`api_calls + ${delta.api_calls}`,
          errors: sql`errors + ${delta.errors}`,
          cost_micros: sql`cost_micros + ${delta.cost_micros}`,
        })
        .where("platform", "=", platform)
        .where("day", "=", day)
        .executeTakeFirst();
    const res = await bump();
    if (Number(res.numUpdatedRows) > 0) return;
    try {
      await db.insertInto("platform_usage_daily").values({ platform, day, ...delta }).execute();
    } catch {
      await bump();
    }
  } catch (error) {
    console.error("[queuezen] platform usage not recorded:", error instanceof Error ? error.message : error);
  }
}

/** Meters a successful publication (its `usage` block, see ./extras.ts). */
export async function recordPublishUsage(platform: Platform, result: PublishResult): Promise<void> {
  const usage = usageOf(result) ?? { posts: 1 };
  await recordPlatformUsage(platform, usage);
}

export interface PlatformUsageSummary {
  today: { posts: number; uploads: number; apiCalls: number; errors: number; costMicros: number };
  month: { posts: number; uploads: number; apiCalls: number; errors: number; costMicros: number };
  last14: Array<{ day: string; posts: number; uploads: number; costMicros: number }>;
}

export async function getPlatformUsage(platform: Platform): Promise<PlatformUsageSummary> {
  const db = await getDb();
  const day = today();
  const monthStart = `${day.slice(0, 7)}-01`;
  const from = new Date(Date.now() - 40 * 86_400_000).toISOString().slice(0, 10);
  const rows = await db.selectFrom("platform_usage_daily").selectAll().where("platform", "=", platform).where("day", ">=", from < monthStart ? from : monthStart).orderBy("day").execute();
  const zero = () => ({ posts: 0, uploads: 0, apiCalls: 0, errors: 0, costMicros: 0 });
  const sum = zero();
  const t = zero();
  for (const r of rows) {
    const v = { posts: Number(r.posts), uploads: Number(r.uploads), apiCalls: Number(r.api_calls), errors: Number(r.errors), costMicros: Number(r.cost_micros) };
    if (r.day >= monthStart) for (const k of Object.keys(sum) as Array<keyof typeof sum>) sum[k] += v[k];
    if (r.day === day) Object.assign(t, v);
  }
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const last14 = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(Date.now() - (13 - i) * 86_400_000).toISOString().slice(0, 10);
    const r = byDay.get(d);
    return { day: d, posts: Number(r?.posts ?? 0), uploads: Number(r?.uploads ?? 0), costMicros: Number(r?.cost_micros ?? 0) };
  });
  return { today: t, month: sum, last14 };
}

/** YouTube's upload bucket per Cloud project (since 1 Jun 2026) and the default units bucket. */
export const YOUTUBE_DAILY_UPLOADS = 100;
export const YOUTUBE_DAILY_UNITS = 10_000;

export function xCostLabel(): string {
  const c = PLATFORM_CAPABILITIES.x.cost;
  return c ? `$${c.perPost.toFixed(3)} per post, $${c.perPostWithUrl.toFixed(2)} with a link` : "";
}

// ── Pending connect sessions (picker) ──

const SESSION_PURPOSE = "connect-session";
const SESSION_TTL_MS = 20 * 60_000;

export async function createConnectSession(input: { userId: number; workspaceId: number; platform: Platform; accounts: ConnectedAccount[] }): Promise<string> {
  const db = await getDb();
  const token = crypto.randomBytes(24).toString("base64url");
  await db.deleteFrom("connect_sessions").where("expires_at", "<", new Date().toISOString()).execute();
  await db
    .insertInto("connect_sessions")
    .values({
      token_hash: sha(token),
      user_id: input.userId,
      workspace_id: input.workspaceId,
      platform: input.platform,
      payload: await encryptSecret(JSON.stringify(input.accounts), SESSION_PURPOSE),
      expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
      created_at: now(),
    })
    .execute();
  return token;
}

export async function getConnectSession(token: string, userId: number, workspaceId: number): Promise<{ platform: Platform; accounts: ConnectedAccount[] } | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const db = await getDb();
  const row = await db.selectFrom("connect_sessions").selectAll().where("token_hash", "=", sha(token)).executeTakeFirst();
  if (!row || row.user_id !== userId || row.workspace_id !== workspaceId || row.expires_at < new Date().toISOString()) return null;
  try {
    const accounts = JSON.parse(await decryptSecret(row.payload, SESSION_PURPOSE)) as ConnectedAccount[];
    return Array.isArray(accounts) ? { platform: row.platform as Platform, accounts } : null;
  } catch {
    return null;
  }
}

export async function deleteConnectSession(token: string): Promise<void> {
  const db = await getDb();
  await db.deleteFrom("connect_sessions").where("token_hash", "=", sha(token)).execute();
}
