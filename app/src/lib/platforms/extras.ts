import type { DriverChannel, DriverContext, Platform, PublishResult, SocialDriver } from "@/social/types";
import type { PublishUsage } from "./http";

export type { PublishUsage, PublishResultWithUsage } from "./http";
export { PENDING_CODE } from "./http";

/**
 * Optional capabilities on top of the SocialDriver contract. Drivers in this folder implement
 * them where the network supports it; callers check with the type guards below.
 */
export interface DriverExtras {
  /** Revoke the channel's token at the network (Disconnect). Best effort; never throws. */
  revoke?(ctx: DriverContext, channel: DriverChannel): Promise<boolean>;
}

export type PlatformDriver = SocialDriver & DriverExtras;

export function canRevoke(driver: SocialDriver): driver is SocialDriver & Required<DriverExtras> {
  return typeof (driver as PlatformDriver).revoke === "function";
}

/** The usage block a driver attached to its PublishResult (null when it reported none). */
export function usageOf(result: PublishResult): PublishUsage | null {
  const u = (result as PublishResult & { usage?: PublishUsage }).usage;
  return u && typeof u === "object" ? u : null;
}

/** USD price of X posts (October 2026 pricing, from the capabilities registry) in micro-dollars. */
export function xPostCostMicros(withUrl: boolean, prices: { perPost: number; perPostWithUrl: number }): number {
  return Math.round((withUrl ? prices.perPostWithUrl : prices.perPost) * 1_000_000);
}

export type { Platform };
