import "server-only";
import { getChannelsExpiringBefore, getDriverChannel, setChannelStatus, updateChannelCredentials, updateChannelProfile, type ChannelRecord } from "@/lib/channels";
import { getDb } from "@/lib/db";
import { buildNotifyPayload, notifyWorkspace, workspaceDashboardPath } from "@/lib/notify";
import { getDriver } from "@/lib/platforms";
import { ensureDrivers, getDriverContext } from "@/lib/platforms/runtime";
import { platformName } from "@/social/format";
import { PLATFORM_CAPABILITIES } from "@/social/platforms";
import { DriverError, PLATFORMS } from "@/social/types";
import type { Job } from "./index";
import { isDue, scheduleNext } from "./shared";

/**
 * token-refresh (every 10 minutes): renews access tokens before they expire.
 * - rotating / refresh / session platforms (X 2 h, YouTube 1 h, Bluesky sessions) within 30 min
 *   of expiry; exchange platforms (Instagram Login, Threads: 60 days) refreshLeadDays before
 * - LinkedIn has no refresh for profiles: a "channel_expiring" notification refreshLeadDays (7)
 *   before the 60-day token runs out, then the channel is marked expired
 * - an auth failure (revoked, invalid_grant…) marks the channel expired and sends
 *   "channel_disconnected"
 */

const INTERVAL_MS = 10 * 60_000;
const DAY = 86_400_000;
/** Short-lived tokens are refreshed this long before they expire. */
const SHORT_LEAD_MS = 30 * 60_000;
const BATCH = 50;

/** How long before expiry a channel is refreshed, or reminded (LinkedIn): capabilities' refreshLeadDays. */
const leadMs = (platform: ChannelRecord["platform"]) => {
  const auth = PLATFORM_CAPABILITIES[platform].auth;
  return auth.refreshLeadDays > 0 ? auth.refreshLeadDays * DAY : SHORT_LEAD_MS;
};

const MAX_LEAD_MS = Math.max(...PLATFORMS.map(leadMs));

async function workspaceName(id: number): Promise<{ id: number; name: string }> {
  const db = await getDb();
  const row = await db.selectFrom("workspaces").select(["id", "name"]).where("id", "=", id).executeTakeFirst();
  return { id, name: row?.name ?? "" };
}

async function notify(channel: ChannelRecord, event: "channel_expiring" | "channel_disconnected", message: string, data: Record<string, string | number>): Promise<void> {
  const ws = await workspaceName(channel.workspaceId);
  const payload = await buildNotifyPayload(ws, event, message, { channel: channel.name, platform: platformName(channel.platform), ...data }, workspaceDashboardPath(channel.workspaceId, "channels"));
  await notifyWorkspace(channel.workspaceId, payload, { ownerFallback: true });
}

/** Marks the channel expired and tells the workspace (once: expired channels aren't picked again). */
async function markExpired(channel: ChannelRecord, reason: string): Promise<void> {
  await setChannelStatus(channel.id, "expired", reason);
  await notify(channel, "channel_disconnected", `${platformName(channel.platform)} channel "${channel.name}" must be reconnected: ${reason}`, { reason });
}

export async function refreshChannel(channel: ChannelRecord, nowMs = Date.now()): Promise<"refreshed" | "reminded" | "expired" | "skipped" | "failed"> {
  const exp = Date.parse(channel.tokenExpiresAt ?? "");
  if (!Number.isFinite(exp)) return "skipped";
  const auth = PLATFORM_CAPABILITIES[channel.platform].auth;
  if (exp - nowMs > leadMs(channel.platform)) return "skipped";
  const driver = getDriver(channel.platform);
  const full = await getDriverChannel(channel.id);
  if (!driver || !full) return "skipped";
  try {
    const result = await driver.refresh(await getDriverContext(channel.platform), full);
    if (result) {
      await updateChannelCredentials(channel.id, result.credentials, result.tokenExpiresAt);
      return "refreshed";
    }
  } catch (error) {
    const err = error instanceof DriverError ? error : new DriverError(error instanceof Error ? error.message : String(error), "unknown");
    if ((err.kind === "auth" && !err.retryable) || exp <= nowMs) {
      await markExpired(channel, err.message);
      return "expired";
    }
    console.error(`[queuezen] token refresh failed for channel ${channel.id} (${channel.platform}):`, err.message);
    return "failed";
  }
  // Nothing to refresh (LinkedIn profiles; Meta tokens younger than 24 h).
  if (exp <= nowMs) {
    await markExpired(channel, "the access token expired");
    return "expired";
  }
  if (auth.refresh === "reauth" && channel.meta.expiryReminderFor !== channel.tokenExpiresAt) {
    const days = Math.max(1, Math.ceil((exp - nowMs) / DAY));
    await notify(channel, "channel_expiring", `${platformName(channel.platform)} channel "${channel.name}" must be reconnected within ${days} day${days === 1 ? "" : "s"} (its 60-day access can't be renewed automatically).`, {
      expires_at: channel.tokenExpiresAt ?? "",
      days,
    });
    await updateChannelProfile(channel.id, { meta: { ...channel.meta, expiryReminderFor: channel.tokenExpiresAt } });
    return "reminded";
  }
  return "skipped";
}

export const tokenRefreshJob: Job = {
  name: "token-refresh",
  async run(ctx) {
    if (!(await isDue("token-refresh", ctx))) return 0;
    await ensureDrivers();
    const nowMs = Date.now();
    const channels = await getChannelsExpiringBefore(new Date(nowMs + MAX_LEAD_MS).toISOString(), BATCH);
    let handled = 0;
    let left = false;
    for (const channel of channels) {
      if (Date.now() > ctx.deadline) {
        left = true;
        break;
      }
      const outcome = await refreshChannel(channel, nowMs).catch((error: unknown) => {
        console.error("[queuezen] token refresh:", error instanceof Error ? error.message : error);
        return "failed" as const;
      });
      if (outcome !== "skipped") handled += 1;
    }
    await scheduleNext("token-refresh", left ? 0 : INTERVAL_MS);
    return handled;
  },
};
