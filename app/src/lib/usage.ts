import "server-only";
import { sql } from "kysely";
import { getDb } from "./db";
import { xLimit, type Entitlements } from "./plans";

/**
 * Monthly usage per account (usage_monthly, UTC month), always booked on the workspace OWNER:
 * - posts_scheduled: publications scheduled this month (one post on 3 channels = 3), the plan's
 *   max_scheduled_monthly quota. Counted once per post target when it is first scheduled
 *   (post_targets.quota_month), given back if it is removed before publishing in the same month.
 * - x_posts: of which on X (max_x_posts_monthly).
 * - ai_requests: AI assistant calls (the plan's max_ai_monthly).
 * Channels and members are limits on what exists, not on usage: see src/lib/channels.ts and
 * src/lib/workspaces.ts.
 */

export interface MonthlyUsage {
  postsScheduled: number;
  xPosts: number;
  aiRequests: number;
}

export type UsageCounter = keyof MonthlyUsage;

const COLUMN: Record<UsageCounter, "posts_scheduled" | "x_posts" | "ai_requests"> = {
  postsScheduled: "posts_scheduled",
  xPosts: "x_posts",
  aiRequests: "ai_requests",
};

/** "YYYY-MM" of an instant (UTC). */
export function usageMonth(at: Date | number = Date.now()): string {
  return new Date(at).toISOString().slice(0, 7);
}

export async function getUsage(userId: number, month = usageMonth()): Promise<MonthlyUsage> {
  const db = await getDb();
  const row = await db
    .selectFrom("usage_monthly")
    .select(["posts_scheduled", "x_posts", "ai_requests"])
    .where("user_id", "=", userId)
    .where("month", "=", month)
    .executeTakeFirst();
  return { postsScheduled: Number(row?.posts_scheduled ?? 0), xPosts: Number(row?.x_posts ?? 0), aiRequests: Number(row?.ai_requests ?? 0) };
}

async function ensureRow(userId: number, month: string): Promise<void> {
  const db = await getDb();
  const exists = await db.selectFrom("usage_monthly").select("user_id").where("user_id", "=", userId).where("month", "=", month).executeTakeFirst();
  if (exists) return;
  try {
    await db.insertInto("usage_monthly").values({ user_id: userId, month, posts_scheduled: 0, x_posts: 0, ai_requests: 0, quota_alerts: null }).execute();
  } catch {
    // Created by a concurrent request in the meantime.
  }
}

/** Add to this month's counters (creates the row on first use). Negative deltas are allowed (corrections, refunds); counters never go below 0. */
export async function incrementUsage(userId: number, delta: Partial<MonthlyUsage>, month = usageMonth()): Promise<void> {
  const entries = (Object.keys(COLUMN) as UsageCounter[]).map((k) => [COLUMN[k], Math.trunc(delta[k] ?? 0)] as const).filter(([, n]) => n !== 0);
  if (!entries.length) return;
  await ensureRow(userId, month);
  const db = await getDb();
  const set = Object.fromEntries(entries.map(([col, n]) => [col, n >= 0 ? sql`${sql.ref(col)} + ${n}` : sql`CASE WHEN ${sql.ref(col)} + ${n} < 0 THEN 0 ELSE ${sql.ref(col)} + ${n} END`]));
  await db.updateTable("usage_monthly").set(set).where("user_id", "=", userId).where("month", "=", month).execute();
}

export type ReserveResult = { ok: true } | { ok: false; reason: "posts" | "x"; used: number; limit: number };

/**
 * Books `posts` publications (`xPosts` of them on X) on the owner's monthly quota, atomically:
 * a single conditional UPDATE, so concurrent requests can't both take the last free post.
 * Nothing is booked when either quota would be exceeded.
 */
export async function reservePosts(
  ownerId: number,
  amount: { posts: number; xPosts: number },
  entitlements: Pick<Entitlements, "maxScheduledMonthly" | "maxXPostsMonthly">,
  month = usageMonth(),
): Promise<ReserveResult> {
  const posts = Math.max(0, Math.trunc(amount.posts));
  const xPosts = Math.max(0, Math.trunc(amount.xPosts));
  if (!posts && !xPosts) return { ok: true };
  const x = xLimit(entitlements.maxXPostsMonthly);
  if (xPosts && !x.allowed) return { ok: false, reason: "x", used: 0, limit: 0 };
  await ensureRow(ownerId, month);
  const db = await getDb();
  let q = db
    .updateTable("usage_monthly")
    .set({ posts_scheduled: sql`posts_scheduled + ${posts}`, x_posts: sql`x_posts + ${xPosts}` })
    .where("user_id", "=", ownerId)
    .where("month", "=", month);
  if (entitlements.maxScheduledMonthly > 0) q = q.where(sql<boolean>`posts_scheduled + ${posts} <= ${entitlements.maxScheduledMonthly}`);
  if (x.limit > 0) q = q.where(sql<boolean>`x_posts + ${xPosts} <= ${x.limit}`);
  const res = await q.executeTakeFirst();
  if (Number(res.numUpdatedRows) === 1) return { ok: true };
  const usage = await getUsage(ownerId, month);
  if (entitlements.maxScheduledMonthly > 0 && usage.postsScheduled + posts > entitlements.maxScheduledMonthly) {
    return { ok: false, reason: "posts", used: usage.postsScheduled, limit: entitlements.maxScheduledMonthly };
  }
  return { ok: false, reason: "x", used: usage.xPosts, limit: x.limit };
}

/** Gives back publications booked with reservePosts() (e.g. a scheduled post deleted before it went out). */
export async function releasePosts(ownerId: number, amount: { posts: number; xPosts: number }, month = usageMonth()): Promise<void> {
  await incrementUsage(ownerId, { postsScheduled: -Math.abs(amount.posts), xPosts: -Math.abs(amount.xPosts) }, month);
}

/** Post targets that hold a quota booking until they are published (released when they are cancelled). */
export const REFUNDABLE_TARGET_STATUSES = ["pending", "scheduled", "failed", "needs_reauth"] as const;

/**
 * Gives back the quota of unpublished targets that are being cancelled or deleted (channel
 * disconnected, workspace deleted), in the month each one was booked in.
 */
export async function releaseTargetsQuota(ownerId: number, targets: ReadonlyArray<{ platform: string; quota_month: string | null }>): Promise<void> {
  const byMonth = new Map<string, { posts: number; xPosts: number }>();
  for (const t of targets) {
    if (!t.quota_month) continue;
    const m = byMonth.get(t.quota_month) ?? { posts: 0, xPosts: 0 };
    m.posts += 1;
    if (t.platform === "x") m.xPosts += 1;
    byMonth.set(t.quota_month, m);
  }
  for (const [month, amount] of byMonth) await releasePosts(ownerId, amount, month);
}
