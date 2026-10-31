import "server-only";
import type { DriverContext, Platform, SocialDriver } from "@/social/types";
import { BUILTIN_DRIVERS } from "./drivers";
import { SIMULATED_DRIVERS } from "./simulated";

/**
 * Driver registry: every platform driver registers itself here, and the publishing engine,
 * the connect routes and the metrics job only ever look drivers up through `getDriver`.
 *
 * Real drivers are registered in `./drivers.ts` (platform drivers). In demo mode, or when the
 * admin turns on "Simulated" for testing, `getDriver` hands out the simulated driver instead.
 * Tests may register their own driver with `registerDriver` / `setDriverOverride`.
 *
 * The built-in drivers are registered lazily on the first lookup. Whether simulation is on is
 * read synchronously from a flag that src/lib/platforms/runtime.ts keeps current (ensureDrivers()
 * loads it from the settings); before that, DEMO_MODE or the cached settings decide.
 */
const drivers = new Map<Platform, SocialDriver>();
let override: ((platform: Platform) => SocialDriver | null) | null = null;
let builtinsLoaded = false;

type CtxGlobal = { __queuezenDriverContext?: (platform: Platform) => Promise<DriverContext> };

function loadBuiltins(): void {
  if (builtinsLoaded) return;
  builtinsLoaded = true;
  for (const d of BUILTIN_DRIVERS) if (!drivers.has(d.platform)) drivers.set(d.platform, d);
  // The publishing engine's driverContext() (src/lib/engine/context.ts) uses this factory: app
  // credentials, the SSRF-guarded fetch and the Mastodon app store. Dynamic import: no cycle.
  const g = globalThis as CtxGlobal;
  g.__queuezenDriverContext ??= async (platform) => (await import("./runtime")).getDriverContext(platform);
  // Load the "Simulated platforms" switch for the next lookups.
  void import("./runtime").then((m) => m.ensureDrivers()).catch(() => undefined);
}

type SimGlobal = { __qzSimulatedPlatforms?: boolean; __queuezenSettings?: { platforms_simulated?: boolean } };

/** Simulated platforms: DEMO_MODE, or the admin's "Simulated platforms (testing only)" switch. */
function simulationActive(): boolean {
  if (process.env.DEMO_MODE === "true") return true;
  const g = globalThis as SimGlobal;
  if (typeof g.__qzSimulatedPlatforms === "boolean") return g.__qzSimulatedPlatforms;
  return g.__queuezenSettings?.platforms_simulated === true;
}

export function registerDriver(driver: SocialDriver): void {
  drivers.set(driver.platform, driver);
}

/** Replace driver lookup entirely (demo/simulated mode, tests). Pass null to restore. */
export function setDriverOverride(fn: ((platform: Platform) => SocialDriver | null) | null): void {
  override = fn;
}

export function getDriver(platform: Platform): SocialDriver | null {
  loadBuiltins();
  if (override) {
    const d = override(platform);
    if (d) return d;
  }
  if (simulationActive()) return SIMULATED_DRIVERS[platform] ?? null;
  return drivers.get(platform) ?? null;
}

export function registeredPlatforms(): Platform[] {
  loadBuiltins();
  return [...drivers.keys()];
}
