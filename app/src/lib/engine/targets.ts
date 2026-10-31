import "server-only";
import { getDriverChannel, type ChannelRecord } from "@/lib/channels";
import { getDb, now } from "@/lib/db";
import { takenTimes } from "@/lib/posts";
import { canTransition, isEditable, isPostStatus, nextQueueSlot } from "@/social/normalize";
import { DriverError, type PostStatus, type QueueSlot } from "@/social/types";
import { driverContext, driverFor, freshChannel } from "./context";
import { runPublishEngine } from "./index";

/**
 * Engine-side operations behind the dashboard: retry failed publications, delete a published post
 * on the network, the attempt history, rescheduling (calendar drag, bulk), queue slot lookup,
 * swapping and shuffling queued posts, and "Post now".
 */

/** A scheduled time may be up to 2 minutes in the past (same grace as savePost). */
const PAST_GRACE_MS = 2 * 60_000;

// ── Retry / delete on the network ──

/**
 * Failed / needs-reconnect targets of the workspace go back to "scheduled" for right now, with a
 * fresh attempt counter (upload_state is kept so a resumable upload continues and findExisting
 * still prevents duplicates). Returns the ids that were rescheduled.
 */
export async function retryTargets(workspaceId: number, targetIds: number[]): Promise<number[]> {
  const db = await getDb();
  const rows = await db
    .selectFrom("post_targets")
    .select(["id", "post_id"])
    .where("workspace_id", "=", workspaceId)
    .where("id", "in", targetIds.length ? targetIds : [0])
    .where("status", "in", ["failed", "needs_reauth"])
    .execute();
  const ids: number[] = [];
  const ts = now();
  for (const row of rows) {
    const res = await db
      .updateTable("post_targets")
      .set({ status: "scheduled", next_attempt_at: ts, attempts: 0, error: null, error_kind: null, lease_token: null, lease_until: null, updated_at: ts })
      .where("id", "=", row.id)
      .where("status", "in", ["failed", "needs_reauth"])
      .executeTakeFirst();
    if (Number(res.numUpdatedRows) === 1) ids.push(row.id);
  }
  // The posts are publishing again.
  const postIds = [...new Set(rows.filter((r) => ids.includes(r.id)).map((r) => r.post_id))];
  if (postIds.length) await db.updateTable("posts").set({ status: "publishing", updated_at: ts }).where("id", "in", postIds).where("status", "in", ["failed", "partially_failed"]).execute();
  return ids;
}

/** Failed targets of whole posts (the posts list's "Retry failed" bulk action). */
export async function failedTargetIds(workspaceId: number, postIds: number[]): Promise<number[]> {
  if (!postIds.length) return [];
  const db = await getDb();
  const rows = await db.selectFrom("post_targets").select("id").where("workspace_id", "=", workspaceId).where("post_id", "in", postIds).where("status", "in", ["failed", "needs_reauth"]).execute();
  return rows.map((r) => r.id);
}

export type DeleteRemoteResult = { ok: true } | { ok: false; error: "not_found" | "state" | "channel" | "driver" | "unsupported" | "network"; message?: string };

/** Deletes a published post on its network (best effort by the driver); the target is marked cancelled. */
export async function deleteRemoteTarget(workspaceId: number, targetId: number): Promise<DeleteRemoteResult> {
  const db = await getDb();
  const row = await db.selectFrom("post_targets").selectAll().where("id", "=", targetId).where("workspace_id", "=", workspaceId).executeTakeFirst();
  if (!row) return { ok: false, error: "not_found" };
  if (row.status !== "published" || !row.external_id) return { ok: false, error: "state" };
  const channel = await getDriverChannel(row.channel_id);
  if (!channel) return { ok: false, error: "channel" };
  const driver = await driverFor(channel.platform);
  if (!driver) return { ok: false, error: "driver" };
  try {
    await driver.deleteRemote(await driverContext(channel.platform), await freshChannel(channel), row.external_id);
  } catch (error) {
    // Instagram has no delete API; YouTube would need a scope we don't request.
    if (error instanceof DriverError && error.kind === "validation") return { ok: false, error: "unsupported", message: error.message };
    return { ok: false, error: "network", message: error instanceof Error ? error.message : undefined };
  }
  await db
    .updateTable("post_targets")
    .set({ status: "cancelled", error: `Deleted from the network on ${now().slice(0, 16).replace("T", " ")} UTC.`, error_kind: null, updated_at: now() })
    .where("id", "=", row.id)
    .where("status", "=", "published")
    .execute();
  return { ok: true };
}

export interface AttemptRecord {
  id: number;
  targetId: number;
  attempt: number;
  outcome: string;
  error: string | null;
  errorKind: string | null;
  startedAt: string;
  durationMs: number;
}

export async function getAttempts(workspaceId: number, postId: number): Promise<AttemptRecord[]> {
  const db = await getDb();
  const rows = await db.selectFrom("post_attempts").selectAll().where("workspace_id", "=", workspaceId).where("post_id", "=", postId).orderBy("id", "desc").limit(200).execute();
  return rows.map((r) => ({ id: r.id, targetId: r.target_id, attempt: r.attempt, outcome: r.outcome, error: r.error, errorKind: r.error_kind, startedAt: r.started_at, durationMs: r.duration_ms }));
}

// ── Rescheduling ──

export type RescheduleResult = { ok: true; status: PostStatus } | { ok: false; error: "not_found" | "state" | "date_past" | "date" };

/**
 * Moves a post to another time (calendar drag, bulk reschedule). Scheduled posts move with their
 * scheduled targets (scheduled → scheduled is allowed by canTransition); drafts and posts waiting
 * for approval only change their planned date. Published and publishing posts can't move.
 */
export async function reschedulePost(workspaceId: number, postId: number, whenIso: string): Promise<RescheduleResult> {
  const ms = Date.parse(whenIso);
  if (!Number.isFinite(ms)) return { ok: false, error: "date" };
  const db = await getDb();
  const post = await db.selectFrom("posts").select(["id", "status"]).where("id", "=", postId).where("workspace_id", "=", workspaceId).executeTakeFirst();
  if (!post || !isPostStatus(post.status)) return { ok: false, error: "not_found" };
  const status = post.status;
  if (!isEditable(status) || status === "failed" || !canTransition(status, status)) return { ok: false, error: "state" };
  if (status === "scheduled" && ms < Date.now() - PAST_GRACE_MS) return { ok: false, error: "date_past" };
  const at = new Date(ms).toISOString();
  const ts = now();
  const ok = await db.transaction().execute(async (trx) => {
    const res = await trx.updateTable("posts").set({ scheduled_at: at, updated_at: ts }).where("id", "=", post.id).where("status", "=", status).executeTakeFirst();
    if (Number(res.numUpdatedRows) !== 1) return false;
    if (status === "scheduled") {
      await trx.updateTable("post_targets").set({ scheduled_at: at, next_attempt_at: at, updated_at: ts }).where("post_id", "=", post.id).where("status", "=", "scheduled").execute();
    }
    return true;
  });
  return ok ? { ok: true, status } : { ok: false, error: "state" };
}

// ── Queue ──

/**
 * The next free queue time for a set of channels: a slot of any of them, at least a minute after
 * `from`, that none of them has a post at yet (posts share one time across their channels).
 */
export async function nextFreeSlot(channels: Array<Pick<ChannelRecord, "id" | "queueSlots">>, timezone: string, from = Date.now()): Promise<string | null> {
  const slots: QueueSlot[] = channels.flatMap((c) => c.queueSlots);
  if (!slots.length) return null;
  const fromIso = new Date(from).toISOString();
  const taken = (await Promise.all(channels.map((c) => takenTimes(c.id, fromIso)))).flat();
  return nextQueueSlot(slots, timezone, from + 60_000, taken);
}

export interface QueueEntry {
  postId: number;
  targetId: number;
  scheduledAt: string;
  /** The post also goes to other channels (moving it moves them too). */
  multiChannel: boolean;
}

/** Upcoming scheduled publications of a channel, soonest first. */
export async function channelQueue(workspaceId: number, channelId: number, limit = 50): Promise<QueueEntry[]> {
  const db = await getDb();
  const rows = await db
    .selectFrom("post_targets as t")
    .innerJoin("posts as p", "p.id", "t.post_id")
    .select(["t.id as target_id", "t.post_id", "t.scheduled_at"])
    .where("t.workspace_id", "=", workspaceId)
    .where("t.channel_id", "=", channelId)
    .where("t.status", "=", "scheduled")
    .where("p.status", "=", "scheduled")
    .where("t.scheduled_at", ">=", now())
    .orderBy("t.scheduled_at")
    .limit(limit)
    .execute();
  if (!rows.length) return [];
  const counts = await db
    .selectFrom("post_targets")
    .select(["post_id", (eb) => eb.fn.countAll<number>().as("n")])
    .where("post_id", "in", rows.map((r) => r.post_id))
    .where("status", "!=", "cancelled")
    .groupBy("post_id")
    .execute();
  const multi = new Map(counts.map((c) => [c.post_id, Number(c.n) > 1]));
  return rows.map((r) => ({ postId: r.post_id, targetId: r.target_id, scheduledAt: r.scheduled_at ?? "", multiChannel: multi.get(r.post_id) ?? false }));
}

/** Gives each post the time of the other (queue reorder). Both must be scheduled in the future. */
export async function swapPostTimes(workspaceId: number, postA: number, postB: number): Promise<boolean> {
  if (postA === postB) return false;
  const db = await getDb();
  const posts = await db.selectFrom("posts").select(["id", "status", "scheduled_at"]).where("workspace_id", "=", workspaceId).where("id", "in", [postA, postB]).execute();
  if (posts.length !== 2 || posts.some((p) => p.status !== "scheduled" || !p.scheduled_at || Date.parse(p.scheduled_at) < Date.now())) return false;
  const [a, b] = posts;
  return assignTimes(new Map([
    [a.id, b.scheduled_at!],
    [b.id, a.scheduled_at!],
  ]));
}

/** Shuffles the times of a channel's upcoming queue (posts keep their channels). */
export async function shuffleQueue(workspaceId: number, channelId: number): Promise<number> {
  const queue = await channelQueue(workspaceId, channelId, 50);
  const postIds = [...new Set(queue.map((q) => q.postId))];
  if (postIds.length < 2) return 0;
  const times = postIds.map((id) => queue.find((q) => q.postId === id)!.scheduledAt);
  const shuffled = [...times];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  await assignTimes(new Map(postIds.map((id, i) => [id, shuffled[i]])));
  return postIds.length;
}

async function assignTimes(times: Map<number, string>): Promise<boolean> {
  const db = await getDb();
  const ts = now();
  return db.transaction().execute(async (trx) => {
    for (const [postId, at] of times) {
      const res = await trx.updateTable("posts").set({ scheduled_at: at, updated_at: ts }).where("id", "=", postId).where("status", "=", "scheduled").executeTakeFirst();
      if (Number(res.numUpdatedRows) !== 1) throw new Error("A post changed meanwhile.");
      await trx.updateTable("post_targets").set({ scheduled_at: at, next_attempt_at: at, updated_at: ts }).where("post_id", "=", postId).where("status", "=", "scheduled").execute();
    }
    return true;
  }).catch(() => false);
}

export async function setQueuePaused(workspaceId: number, channelId: number, paused: boolean): Promise<boolean> {
  const db = await getDb();
  const res = await db.updateTable("channels").set({ queue_paused: paused ? 1 : 0, updated_at: now() }).where("id", "=", channelId).where("workspace_id", "=", workspaceId).executeTakeFirst();
  return Number(res.numUpdatedRows) > 0;
}

export async function pausedChannels(workspaceId: number): Promise<Set<number>> {
  const db = await getDb();
  const rows = await db.selectFrom("channels").select("id").where("workspace_id", "=", workspaceId).where("queue_paused", "=", 1).execute();
  return new Set(rows.map((r) => r.id));
}

// ── Post now ──

/** Runs the engine for these targets right away (within the request's time limit). */
export async function publishTargetsNow(targetIds: number[], budgetMs = 20_000): Promise<void> {
  if (!targetIds.length) return;
  try {
    await runPublishEngine({ deadline: Date.now() + budgetMs, onlyIds: targetIds });
  } catch (error) {
    console.error("[queuezen] post now failed (the next tick retries):", error);
  }
}
