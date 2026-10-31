import "server-only";
import { getDb, today } from "@/lib/db";
import { getDriver } from "@/lib/platforms";
import { getSettings } from "@/lib/settings";
import { absoluteUrl } from "@/lib/site";
import { oauthCallbackPath } from "@/social/platforms";
import type { PublishUsage } from "@/lib/platforms/extras";
import type { DriverChannel, DriverContext, Platform, SocialDriver } from "@/social/types";

/**
 * How the engine reaches the drivers: the driver registry (src/lib/platforms), the driver
 * context (operator app credentials, redirect URI, fetch, clock) and the app-wide usage meters
 * (platform_usage_daily: posts, uploads, API calls, errors, X cost).
 *
 * QZ_TEST_DRIVER=1 (testing only, off by default) swaps every platform for the deterministic
 * test driver in ./test-driver.ts. Never set it on a real site.
 */

let testDriverReady: Promise<void> | null = null;

/** Installs the test driver once when QZ_TEST_DRIVER=1 (end-to-end tests of the engine). */
export function ensureTestDriver(): Promise<void> {
  if (process.env.QZ_TEST_DRIVER !== "1") return Promise.resolve();
  testDriverReady ??= import("./test-driver").then((m) => m.installTestDriver());
  return testDriverReady;
}

export async function driverFor(platform: Platform): Promise<SocialDriver | null> {
  await ensureTestDriver();
  // Built-in drivers, the "simulated platforms" switch and the driver context factory (app
  // credentials, SSRF-guarded fetch, Mastodon app store) are loaded by the platforms runtime.
  const { ensureDrivers } = await import("@/lib/platforms/runtime");
  await ensureDrivers();
  return getDriver(platform);
}

/** Refreshes the channel's token when it expires within 10 minutes (rotated tokens are saved). */
export async function freshChannel(channel: DriverChannel): Promise<DriverChannel> {
  const { ensureFreshChannel } = await import("@/lib/platforms/runtime");
  return ensureFreshChannel(channel);
}

/** Meters a successful publication with the usage the driver reported (YouTube quota units, X cost...). */
export async function recordUsage(platform: Platform, usage: PublishUsage): Promise<void> {
  try {
    const { recordPlatformUsage } = await import("@/lib/platforms/runtime");
    await recordPlatformUsage(platform, usage);
  } catch (error) {
    console.error("[queuezen] platform usage could not be recorded:", error);
  }
}

type ContextFactory = (platform: Platform) => Promise<DriverContext>;

const globalForCtx = globalThis as unknown as { __queuezenDriverContext?: ContextFactory };

/**
 * The platform drivers' runtime may register a richer context factory (operator app credentials
 * from Admin → Platforms, Mastodon app store, poll budgets). Until it does, drivers get the basic
 * context below (no app credentials: publishing with a stored access token doesn't need them).
 */
export function setDriverContextFactory(factory: ContextFactory | null): void {
  globalForCtx.__queuezenDriverContext = factory ?? undefined;
}

export async function driverContext(platform: Platform): Promise<DriverContext> {
  const factory = globalForCtx.__queuezenDriverContext;
  if (factory) return factory(platform);
  const settings = await getSettings();
  return { app: null, redirectUri: absoluteUrl(settings, oauthCallbackPath(platform)), fetch: globalThis.fetch.bind(globalThis), now: () => Date.now() };
}

// ── App-wide usage per platform and UTC day ──

export interface PlatformUsageDelta {
  posts?: number;
  uploads?: number;
  apiCalls?: number;
  errors?: number;
  costMicros?: number;
}

/** Adds to today's platform_usage_daily row (created on first use). Never throws. */
export async function bumpPlatformUsage(platform: Platform, delta: PlatformUsageDelta, day = today()): Promise<void> {
  const values = {
    posts: Math.max(0, Math.round(delta.posts ?? 0)),
    uploads: Math.max(0, Math.round(delta.uploads ?? 0)),
    api_calls: Math.max(0, Math.round(delta.apiCalls ?? 0)),
    errors: Math.max(0, Math.round(delta.errors ?? 0)),
    cost_micros: Math.max(0, Math.round(delta.costMicros ?? 0)),
  };
  if (!Object.values(values).some(Boolean)) return;
  try {
    const db = await getDb();
    const add = () =>
      db
        .updateTable("platform_usage_daily")
        .set((eb) => ({
          posts: eb("posts", "+", values.posts),
          uploads: eb("uploads", "+", values.uploads),
          api_calls: eb("api_calls", "+", values.api_calls),
          errors: eb("errors", "+", values.errors),
          cost_micros: eb("cost_micros", "+", values.cost_micros),
        }))
        .where("platform", "=", platform)
        .where("day", "=", day)
        .executeTakeFirst();
    const res = await add();
    if (Number(res.numUpdatedRows) > 0) return;
    try {
      await db.insertInto("platform_usage_daily").values({ platform, day, ...values }).execute();
    } catch {
      await add(); // created concurrently
    }
  } catch (error) {
    console.error("[queuezen] platform usage could not be recorded:", error);
  }
}
