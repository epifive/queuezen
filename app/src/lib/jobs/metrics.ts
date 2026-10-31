import "server-only";
import { getDriverChannel } from "@/lib/channels";
import { getDb, now } from "@/lib/db";
import { bumpPlatformUsage, driverContext, driverFor, freshChannel } from "@/lib/engine/context";
import { getSettings } from "@/lib/settings";
import { bannedOwnerWorkspaceIds } from "@/lib/workspaces";
import { getCapabilities } from "@/social/platforms";
import { DriverError, METRIC_FIELDS, PLATFORMS, type MetricsRequest, type Platform, type PostMetrics } from "@/social/types";
import type { Job } from "./index";
import { chunk, isDue, scheduleNext } from "./shared";

/**
 * metrics (every 10 minutes): analytics of published posts from the networks that have an
 * analytics API. Freshness depends on the post's age: hourly during its first day, then daily
 * until `metrics_days` (default 30). Requests go per channel in batches (`metrics_batch_size`),
 * at most MAX_CHANNELS_PER_RUN channels per run, so per-account rate limits are respected; a
 * rate-limited channel is skipped for the rest of the run and retried on the next one.
 */

const INTERVAL_MS = 10 * 60_000;
const MAX_TARGETS_PER_RUN = 1000;
const MAX_CHANNELS_PER_RUN = 25;
const HOUR = 3_600_000;

/** How old the last fetch may be for a post published `ageMs` ago. */
export function metricsMaxAgeMs(ageMs: number): number {
  return ageMs < 24 * HOUR ? HOUR : 24 * HOUR;
}

export function supportedMetricPlatforms(): Platform[] {
  return PLATFORMS.filter((p) => getCapabilities(p).analytics.supported);
}

interface DueTarget {
  id: number;
  postId: number;
  channelId: number;
  workspaceId: number;
  platform: Platform;
  externalId: string;
  publishedAt: string;
}

/** Published targets whose metrics are missing or stale (oldest fetch first). */
export async function dueMetricTargets(nowMs = Date.now(), days = 30, limit = MAX_TARGETS_PER_RUN): Promise<DueTarget[]> {
  const db = await getDb();
  const since = new Date(nowMs - days * 24 * HOUR).toISOString();
  const banned = await bannedOwnerWorkspaceIds();
  let q = db
    .selectFrom("post_targets as t")
    .innerJoin("channels as c", "c.id", "t.channel_id")
    .leftJoin("post_metrics as m", "m.target_id", "t.id")
    .select(["t.id", "t.post_id", "t.channel_id", "t.workspace_id", "t.platform", "t.external_id", "t.published_at", "m.fetched_at"])
    .where("t.status", "=", "published")
    .where("t.published_at", ">=", since)
    .where("t.external_id", "is not", null)
    .where("t.platform", "in", supportedMetricPlatforms())
    .where("c.status", "=", "active")
    .where((eb) => eb.or([eb("m.fetched_at", "is", null), eb("m.fetched_at", "<", new Date(nowMs - HOUR).toISOString())]));
  if (banned.length) q = q.where("t.workspace_id", "not in", banned);
  const rows = await q
    .orderBy("m.fetched_at")
    .limit(limit * 3)
    .execute();
  const out: DueTarget[] = [];
  for (const r of rows) {
    if (!r.published_at || !r.external_id) continue;
    const age = nowMs - Date.parse(r.published_at);
    if (r.fetched_at && nowMs - Date.parse(r.fetched_at) < metricsMaxAgeMs(age)) continue;
    out.push({ id: r.id, postId: r.post_id, channelId: r.channel_id, workspaceId: r.workspace_id, platform: r.platform as Platform, externalId: r.external_id, publishedAt: r.published_at });
    if (out.length >= limit) break;
  }
  return out;
}

const value = (m: PostMetrics, f: (typeof METRIC_FIELDS)[number]) => {
  const v = m[f];
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
};

/** Stores the latest metrics of a target (one row per target, updated in place). */
export async function saveMetrics(target: Pick<DueTarget, "id" | "postId" | "channelId" | "workspaceId">, metrics: PostMetrics, at = now()): Promise<void> {
  const db = await getDb();
  const fields = Object.fromEntries(METRIC_FIELDS.map((f) => [f, value(metrics, f)])) as Record<(typeof METRIC_FIELDS)[number], number | null>;
  const res = await db.updateTable("post_metrics").set({ ...fields, fetched_at: at }).where("target_id", "=", target.id).executeTakeFirst();
  if (Number(res.numUpdatedRows) > 0) return;
  try {
    await db.insertInto("post_metrics").values({ target_id: target.id, post_id: target.postId, channel_id: target.channelId, workspace_id: target.workspaceId, fetched_at: at, ...fields }).execute();
  } catch {
    await db.updateTable("post_metrics").set({ ...fields, fetched_at: at }).where("target_id", "=", target.id).execute();
  }
}

/** Marks targets as checked without numbers (deleted on the network, not reported) so they aren't asked again right away. */
async function touchMetrics(targets: DueTarget[], at = now()): Promise<void> {
  const db = await getDb();
  for (const t of targets) {
    const res = await db.updateTable("post_metrics").set({ fetched_at: at }).where("target_id", "=", t.id).executeTakeFirst();
    if (Number(res.numUpdatedRows) > 0) continue;
    try {
      await db.insertInto("post_metrics").values({ target_id: t.id, post_id: t.postId, channel_id: t.channelId, workspace_id: t.workspaceId, fetched_at: at }).execute();
    } catch {
      // Inserted concurrently.
    }
  }
}

export interface MetricsRunSummary {
  channels: number;
  fetched: number;
  failed: number;
}

/** One pass of the metrics collection (also used by tests through the scheduler). */
export async function collectMetrics(deadline: number, nowMs = Date.now()): Promise<MetricsRunSummary> {
  const settings = await getSettings();
  const summary: MetricsRunSummary = { channels: 0, fetched: 0, failed: 0 };
  if (!settings.metrics_enabled) return summary;
  const days = Math.min(365, Math.max(1, settings.metrics_days || 30));
  const batch = Math.min(100, Math.max(1, settings.metrics_batch_size || 50));
  const due = await dueMetricTargets(nowMs, days);
  const byChannel = new Map<number, DueTarget[]>();
  for (const t of due) byChannel.set(t.channelId, [...(byChannel.get(t.channelId) ?? []), t]);
  for (const [channelId, targets] of [...byChannel.entries()].slice(0, MAX_CHANNELS_PER_RUN)) {
    if (Date.now() > deadline) break;
    const platform = targets[0].platform;
    const driver = await driverFor(platform);
    const stored = await getDriverChannel(channelId);
    if (!driver || !stored) continue;
    // A token about to expire is refreshed first (rotated tokens are saved; auth failures mark the channel expired).
    let channel = stored;
    try {
      channel = await freshChannel(stored);
    } catch {
      summary.failed += targets.length;
      continue;
    }
    summary.channels += 1;
    const ctx = await driverContext(platform);
    for (const part of chunk(targets.slice(0, batch * 3), batch)) {
      if (Date.now() > deadline) break;
      const items: MetricsRequest[] = part.map((t) => ({ externalId: t.externalId, publishedAt: t.publishedAt }));
      try {
        const results = process.env.QZ_TEST_METRICS === "1" ? testMetrics(items) : await driver.fetchMetrics(ctx, channel, items);
        await bumpPlatformUsage(platform, { apiCalls: 1 });
        const byId = new Map(results.map((r) => [r.externalId, r.metrics]));
        const missing: DueTarget[] = [];
        for (const t of part) {
          const metrics = byId.get(t.externalId);
          if (metrics) {
            await saveMetrics(t, metrics);
            summary.fetched += 1;
          } else missing.push(t);
        }
        if (missing.length) await touchMetrics(missing);
      } catch (error) {
        summary.failed += part.length;
        await bumpPlatformUsage(platform, { apiCalls: 1, errors: 1 });
        if (error instanceof DriverError) {
          // Rate limited / auth problem: leave this channel for the next run (the token refresh job handles auth).
          if (error.kind === "rate_limit" || error.kind === "auth" || error.kind === "quota") break;
          if (!error.retryable) await touchMetrics(part);
        } else {
          console.error(`[queuezen] metrics fetch failed (${platform}):`, error);
        }
        break;
      }
    }
  }
  return summary;
}

/**
 * TESTING ONLY (QZ_TEST_METRICS=1, never on a real site): deterministic numbers instead of the
 * network, derived from the external id; ids containing "gone" are reported as deleted (no row).
 */
function testMetrics(items: MetricsRequest[]): Array<{ externalId: string; metrics: PostMetrics }> {
  return items
    .filter((i) => !i.externalId.includes("gone"))
    .map((i) => {
      let h = 0;
      for (const ch of i.externalId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      return { externalId: i.externalId, metrics: { views: 100 + (h % 900), likes: 5 + (h % 50), comments: h % 7, shares: h % 5 } };
    });
}

export const metricsJob: Job = {
  name: "metrics",
  async run(ctx) {
    if (!(await isDue("metrics", ctx))) return 0;
    const summary = await collectMetrics(ctx.deadline);
    await scheduleNext("metrics", INTERVAL_MS);
    return summary.fetched;
  },
};
