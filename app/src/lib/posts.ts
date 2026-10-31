import "server-only";
import type { Transaction } from "kysely";
import { getDb, now } from "./db";
import type { Database, PostRow, PostTargetRow } from "./db/schema";
import { getWorkspaceChannels, type ChannelRecord } from "./channels";
import { getEntitlementsForUserId } from "./plans";
import { checkQuotaAlerts } from "./notify/quota";
import { getUsage, releasePosts, reservePosts, usageMonth } from "./usage";
import type { WorkspaceRecord } from "./workspaces";
import {
  aggregatePostStatus,
  canPublishDirectly,
  canTransition,
  isEditable,
  isPostStatus,
  mergeContent,
  normalizeLabels,
  normalizeOverride,
  normalizePostContent,
  normalizePostSource,
  parseJson,
  parseJsonList,
  roleCan,
  validatePostForChannel,
} from "@/social/normalize";
import type { ContentOverride, MediaInfo, Platform, PostContent, PostSource, PostStatus, TargetStatus, ValidationResult, WorkspaceRole } from "@/social/types";

/**
 * Posts and their publications (post_targets), with the status rules and the monthly quota.
 *
 * Status flow (canTransition() in src/social/normalize.ts):
 *   draft ──submit──▶ pending_approval ──approve──▶ approved / scheduled ──engine──▶ publishing ──▶
 *   published | partially_failed | failed.  Rejecting sends it back to draft.
 * Targets mirror it: pending while the post is a draft / waiting, scheduled once the post is,
 * then the engine moves them through claimed → … → published / failed.
 *
 * Quota: each target counts once against the owner's max_scheduled_monthly (and X targets against
 * max_x_posts_monthly) when it is first scheduled; the month is stored in quota_month. It is given
 * back when the target is removed or unscheduled before publishing in the same month.
 */

export interface TargetRecord {
  id: number;
  postId: number;
  channelId: number;
  platform: Platform;
  override: ContentOverride;
  status: TargetStatus;
  scheduledAt: string | null;
  nextAttemptAt: string | null;
  attempts: number;
  externalId: string | null;
  permalink: string | null;
  publishedAt: string | null;
  error: string | null;
  errorKind: string | null;
  quotaMonth: string | null;
}

export interface PostRecord {
  id: number;
  workspaceId: number;
  authorId: number | null;
  status: PostStatus;
  scheduledAt: string | null;
  content: PostContent;
  labels: string[];
  source: PostSource;
  sourceRef: string | null;
  isEvergreen: boolean;
  recycleCount: number;
  approvedBy: number | null;
  approvedAt: string | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  targets: TargetRecord[];
}

export function toTargetRecord(row: PostTargetRow): TargetRecord {
  return {
    id: row.id,
    postId: row.post_id,
    channelId: row.channel_id,
    platform: row.platform as Platform,
    override: normalizeOverride(parseJson(row.override)),
    status: row.status,
    scheduledAt: row.scheduled_at,
    nextAttemptAt: row.next_attempt_at,
    attempts: row.attempts,
    externalId: row.external_id,
    permalink: row.permalink,
    publishedAt: row.published_at,
    error: row.error,
    errorKind: row.error_kind,
    quotaMonth: row.quota_month,
  };
}

export function toPostRecord(row: PostRow, targets: PostTargetRow[] = []): PostRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    authorId: row.author_id,
    status: isPostStatus(row.status) ? row.status : "draft",
    scheduledAt: row.scheduled_at,
    content: normalizePostContent(parseJson(row.content)),
    labels: parseJsonList(row.labels),
    source: normalizePostSource(row.source),
    sourceRef: row.source_ref,
    isEvergreen: row.is_evergreen === 1,
    recycleCount: row.recycle_count,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    publishedAt: row.published_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    targets: targets.map(toTargetRecord),
  };
}

export async function getPost(workspaceId: number, postId: number): Promise<PostRecord | undefined> {
  if (!Number.isInteger(postId) || postId < 1) return undefined;
  const db = await getDb();
  const row = await db.selectFrom("posts").selectAll().where("id", "=", postId).where("workspace_id", "=", workspaceId).executeTakeFirst();
  if (!row) return undefined;
  const targets = await db.selectFrom("post_targets").selectAll().where("post_id", "=", postId).orderBy("id").execute();
  return toPostRecord(row, targets);
}

export interface PostListFilter {
  status?: PostStatus[];
  /** scheduled_at range (ISO), e.g. a calendar month. */
  from?: string;
  to?: string;
  channelId?: number;
  label?: string;
  limit?: number;
  offset?: number;
  order?: "scheduled_asc" | "scheduled_desc" | "updated_desc";
}

/** Posts of a workspace with their targets (filters for lists, calendar and queue). */
export async function listPosts(workspaceId: number, filter: PostListFilter = {}): Promise<PostRecord[]> {
  const db = await getDb();
  let q = db.selectFrom("posts").selectAll().where("workspace_id", "=", workspaceId);
  if (filter.status?.length) q = q.where("status", "in", filter.status);
  if (filter.from) q = q.where("scheduled_at", ">=", filter.from);
  if (filter.to) q = q.where("scheduled_at", "<", filter.to);
  if (filter.channelId) {
    const channelId = filter.channelId;
    q = q.where("id", "in", (eb) => eb.selectFrom("post_targets").select("post_id").where("channel_id", "=", channelId));
  }
  if (filter.label) q = q.where("labels", "like", `%${JSON.stringify(filter.label).slice(1, -1).replace(/[%_]/g, "")}%`);
  q =
    filter.order === "scheduled_desc"
      ? q.orderBy("scheduled_at", "desc").orderBy("id", "desc")
      : filter.order === "updated_desc"
        ? q.orderBy("updated_at", "desc").orderBy("id", "desc")
        : q.orderBy("scheduled_at", "asc").orderBy("id", "asc");
  const rows = await q.limit(Math.min(filter.limit ?? 100, 1000)).offset(filter.offset ?? 0).execute();
  if (!rows.length) return [];
  const targets = await db.selectFrom("post_targets").selectAll().where("post_id", "in", rows.map((r) => r.id)).orderBy("id").execute();
  const byPost = new Map<number, PostTargetRow[]>();
  for (const t of targets) byPost.set(t.post_id, [...(byPost.get(t.post_id) ?? []), t]);
  return rows.map((r) => toPostRecord(r, byPost.get(r.id) ?? []));
}

/** Number of posts per status in a workspace (dashboard home). */
export async function countPostsByStatus(workspaceId: number): Promise<Record<PostStatus, number>> {
  const db = await getDb();
  const rows = await db
    .selectFrom("posts")
    .select(["status", (eb) => eb.fn.countAll<number>().as("n")])
    .where("workspace_id", "=", workspaceId)
    .groupBy("status")
    .execute();
  const out = { draft: 0, pending_approval: 0, approved: 0, scheduled: 0, publishing: 0, published: 0, partially_failed: 0, failed: 0 } as Record<PostStatus, number>;
  for (const r of rows) if (isPostStatus(r.status)) out[r.status] = Number(r.n);
  return out;
}

// ── Media facts for validation ──

/** MediaInfo of library items of the workspace (missing ids are left out). */
export async function getMediaInfo(workspaceId: number, ids: number[]): Promise<MediaInfo[]> {
  const clean = [...new Set(ids.filter((n) => Number.isInteger(n) && n > 0))];
  if (!clean.length) return [];
  const db = await getDb();
  const rows = await db.selectFrom("media").selectAll().where("workspace_id", "=", workspaceId).where("id", "in", clean).execute();
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    mime: r.mime,
    size: Number(r.size),
    width: r.width,
    height: r.height,
    duration: r.duration === null ? null : Number(r.duration),
    altText: r.alt_text,
    url: r.url,
  }));
}

/** Validation of a post for each of its channels (base content merged with each override). */
export async function validatePost(workspaceId: number, content: PostContent, targets: Array<{ channel: Pick<ChannelRecord, "id" | "platform">; override?: ContentOverride | null }>): Promise<Map<number, ValidationResult>> {
  const effective = targets.map((t) => ({ channelId: t.channel.id, platform: t.channel.platform, content: mergeContent(content, t.override) }));
  const media = await getMediaInfo(workspaceId, effective.flatMap((e) => e.content.mediaIds));
  return new Map(effective.map((e) => [e.channelId, validatePostForChannel(e.content, media, e.platform)]));
}

// ── Saving ──

/**
 * - draft:        save without a date requirement (validation errors allowed)
 * - submit:       send for approval (pending_approval)
 * - schedule:     publish at `scheduledAt`
 * - publish_now:  publish on the next engine tick
 */
export type SaveIntent = "draft" | "submit" | "schedule" | "publish_now";

export interface SavePostInput {
  workspace: Pick<WorkspaceRecord, "id" | "ownerId" | "settings">;
  /** Acting member and their role. */
  actor: { userId: number | null; role: WorkspaceRole };
  postId?: number;
  content: unknown;
  /** channel id → override (only for selected channels). */
  overrides?: Record<number, unknown>;
  channelIds: number[];
  labels?: unknown;
  scheduledAt?: string | null;
  intent: SaveIntent;
  source?: PostSource;
  sourceRef?: string | null;
  isEvergreen?: boolean;
}

export type SavePostError =
  | { code: "not_found" }
  | { code: "forbidden" }
  | { code: "not_editable"; status: PostStatus }
  | { code: "no_channels" }
  | { code: "date_required" }
  | { code: "date_past" }
  | { code: "approval_required" }
  | { code: "invalid"; issues: Map<number, ValidationResult> }
  | { code: "quota"; reason: "posts" | "x"; used: number; limit: number };

export type SavePostResult = { ok: true; post: PostRecord } | ({ ok: false } & SavePostError);

/** A scheduled time may be up to 2 minutes in the past (clock skew, slow forms). */
const PAST_GRACE_MS = 2 * 60_000;
const MAX_AHEAD_MS = 2 * 366 * 86_400_000;

function statusesFor(intent: SaveIntent): { post: PostStatus; target: TargetStatus } {
  if (intent === "submit") return { post: "pending_approval", target: "pending" };
  if (intent === "schedule" || intent === "publish_now") return { post: "scheduled", target: "scheduled" };
  return { post: "draft", target: "pending" };
}

/**
 * Creates or updates a post with its targets in one go: checks the actor's role and the
 * workspace's approval rule, the status transition, the channels, the date, validation (except
 * for drafts) and the monthly quota, then writes the post and its targets in a transaction.
 */
export async function savePost(input: SavePostInput): Promise<SavePostResult> {
  const { workspace, actor, intent } = input;
  if (!roleCan(actor.role, "post.create")) return { ok: false, code: "forbidden" };
  if ((intent === "schedule" || intent === "publish_now") && !canPublishDirectly(actor.role, workspace.settings)) return { ok: false, code: "approval_required" };

  const db = await getDb();
  const existing = input.postId ? await getPost(workspace.id, input.postId) : undefined;
  if (input.postId && !existing) return { ok: false, code: "not_found" };
  const next = statusesFor(intent);
  if (existing && (!isEditable(existing.status) || !canTransition(existing.status, next.post))) return { ok: false, code: "not_editable", status: existing.status };

  const content = normalizePostContent(input.content);
  const channels = await getWorkspaceChannels(workspace.id);
  const wanted = [...new Set(input.channelIds)];
  const selected = channels.filter((c) => wanted.includes(c.id));
  if (!selected.length && intent !== "draft") return { ok: false, code: "no_channels" };

  // Date
  let scheduledAt: string | null = input.scheduledAt ?? existing?.scheduledAt ?? null;
  if (intent === "publish_now") scheduledAt = now();
  if (scheduledAt) {
    const ms = Date.parse(scheduledAt);
    if (!Number.isFinite(ms)) return { ok: false, code: "date_required" };
    if (intent === "schedule" && ms < Date.now() - PAST_GRACE_MS) return { ok: false, code: "date_past" };
    if (ms > Date.now() + MAX_AHEAD_MS) return { ok: false, code: "date_required" };
    scheduledAt = new Date(ms).toISOString();
  }
  if (intent === "schedule" && !scheduledAt) return { ok: false, code: "date_required" };

  const overrides = new Map<number, ContentOverride>(selected.map((c) => [c.id, normalizeOverride(input.overrides?.[c.id] ?? existing?.targets.find((t) => t.channelId === c.id)?.override ?? {})]));

  if (intent !== "draft") {
    const issues = await validatePost(workspace.id, content, selected.map((c) => ({ channel: c, override: overrides.get(c.id) })));
    if ([...issues.values()].some((r) => r.errors.length)) return { ok: false, code: "invalid", issues };
  }

  // Quota: targets newly scheduled book a post; targets leaving "scheduled" (or removed) give theirs back.
  const month = usageMonth();
  const previous = new Map((existing?.targets ?? []).map((t) => [t.channelId, t]));
  const book = { posts: 0, xPosts: 0 };
  const refund = { posts: 0, xPosts: 0 };
  const quotaMonth = new Map<number, string | null>();
  for (const c of selected) {
    const prev = previous.get(c.id);
    const counted = prev?.quotaMonth ?? null;
    if (next.target === "scheduled") {
      if (!counted) {
        book.posts += 1;
        if (c.platform === "x") book.xPosts += 1;
        quotaMonth.set(c.id, month);
      } else quotaMonth.set(c.id, counted);
    } else {
      if (counted === month) {
        refund.posts += 1;
        if (c.platform === "x") refund.xPosts += 1;
      }
      quotaMonth.set(c.id, null);
    }
  }
  const removed = (existing?.targets ?? []).filter((t) => !selected.some((c) => c.id === t.channelId));
  for (const t of removed) {
    if (t.quotaMonth === month) {
      refund.posts += 1;
      if (t.platform === "x") refund.xPosts += 1;
    }
  }
  const entitlements = book.posts ? await getEntitlementsForUserId(workspace.ownerId) : null;
  if (book.posts && entitlements) {
    const reserved = await reservePosts(workspace.ownerId, book, entitlements, month);
    if (!reserved.ok) return { ok: false, code: "quota", reason: reserved.reason, used: reserved.used, limit: reserved.limit };
  }

  const ts = now();
  let postId: number;
  try {
    postId = await db.transaction().execute(async (trx) => {
      const values = {
        status: next.post,
        scheduled_at: scheduledAt,
        content: JSON.stringify(content),
        labels: JSON.stringify(normalizeLabels(input.labels ?? existing?.labels ?? [])),
        is_evergreen: (input.isEvergreen ?? existing?.isEvergreen ?? false) ? 1 : 0,
        updated_at: ts,
      };
      let id: number;
      if (existing) {
        const res = await trx.updateTable("posts").set(values).where("id", "=", existing.id).where("status", "=", existing.status).executeTakeFirst();
        if (Number(res.numUpdatedRows) !== 1) throw new ConcurrentChange();
        id = existing.id;
      } else {
        const res = await trx
          .insertInto("posts")
          .values({
            ...values,
            workspace_id: workspace.id,
            author_id: actor.userId,
            source: input.source ?? "manual",
            source_ref: input.sourceRef ?? null,
            recycle_count: 0,
            last_recycled_at: null,
            approved_by: null,
            approved_at: null,
            published_at: null,
            created_at: ts,
          })
          .executeTakeFirstOrThrow();
        id = Number(res.insertId);
      }
      if (removed.length) await trx.deleteFrom("post_targets").where("id", "in", removed.map((t) => t.id)).execute();
      for (const c of selected) {
        await upsertTarget(trx, {
          postId: id,
          workspaceId: workspace.id,
          channel: c,
          override: overrides.get(c.id) ?? {},
          status: next.target,
          scheduledAt: next.target === "scheduled" ? scheduledAt : null,
          quotaMonth: quotaMonth.get(c.id) ?? null,
          ts,
        });
      }
      return id;
    });
  } catch (error) {
    if (book.posts) await releasePosts(workspace.ownerId, book, month);
    if (error instanceof ConcurrentChange) return { ok: false, code: "not_editable", status: (await getPost(workspace.id, existing!.id))?.status ?? existing!.status };
    throw error;
  }
  if (refund.posts) await releasePosts(workspace.ownerId, refund, month);
  if (entitlements) {
    const usage = await getUsage(workspace.ownerId, month);
    await checkQuotaAlerts(workspace.ownerId, "posts", usage.postsScheduled, entitlements.maxScheduledMonthly);
    if (book.xPosts && entitlements.maxXPostsMonthly > 0) await checkQuotaAlerts(workspace.ownerId, "x", usage.xPosts, entitlements.maxXPostsMonthly);
  }
  return { ok: true, post: (await getPost(workspace.id, postId))! };
}

class ConcurrentChange extends Error {}

async function upsertTarget(
  trx: Transaction<Database>,
  t: { postId: number; workspaceId: number; channel: Pick<ChannelRecord, "id" | "platform">; override: ContentOverride; status: TargetStatus; scheduledAt: string | null; quotaMonth: string | null; ts: string },
): Promise<void> {
  const values = {
    override: JSON.stringify(t.override),
    status: t.status,
    scheduled_at: t.scheduledAt,
    next_attempt_at: t.status === "scheduled" ? t.scheduledAt : null,
    quota_month: t.quotaMonth,
    updated_at: t.ts,
  };
  const found = await trx.selectFrom("post_targets").select(["id", "status"]).where("post_id", "=", t.postId).where("channel_id", "=", t.channel.id).executeTakeFirst();
  if (found) {
    // A failed publication that is rescheduled starts over (the engine keeps upload_state for idempotency).
    await trx
      .updateTable("post_targets")
      .set({ ...values, ...(found.status === "failed" || found.status === "needs_reauth" ? { attempts: 0, error: null, error_kind: null } : {}) })
      .where("id", "=", found.id)
      .where("status", "not in", ["claimed", "uploading", "container_created", "publishing", "published"])
      .execute();
    return;
  }
  await trx
    .insertInto("post_targets")
    .values({
      ...values,
      post_id: t.postId,
      workspace_id: t.workspaceId,
      channel_id: t.channel.id,
      platform: t.channel.platform,
      attempts: 0,
      lease_until: null,
      lease_token: null,
      external_id: null,
      container_id: null,
      upload_state: "{}",
      permalink: null,
      published_at: null,
      error: null,
      error_kind: null,
      created_at: t.ts,
    })
    .execute();
}

// ── Status changes ──

/** Conditional status change (only from `from`); false when the post changed meanwhile or the move isn't allowed. */
export async function transitionPost(postId: number, from: PostStatus, to: PostStatus, extra: Partial<Pick<PostRow, "approved_by" | "approved_at" | "published_at" | "scheduled_at">> = {}): Promise<boolean> {
  if (!canTransition(from, to)) return false;
  const db = await getDb();
  const res = await db
    .updateTable("posts")
    .set({ status: to, ...extra, updated_at: now() })
    .where("id", "=", postId)
    .where("status", "=", from)
    .executeTakeFirst();
  return Number(res.numUpdatedRows) === 1;
}

export type ApprovalResult = { ok: true; status: PostStatus } | { ok: false; error: "not_found" | "forbidden" | "state" | "quota" };

/**
 * Approves a post waiting for approval: it becomes "scheduled" (targets scheduled, quota booked)
 * when it has a future date, else "approved" (ready to be scheduled or queued).
 */
export async function approvePost(workspace: Pick<WorkspaceRecord, "id" | "ownerId" | "settings">, postId: number, approver: { userId: number | null; role: WorkspaceRole | "guest" }): Promise<ApprovalResult> {
  if (approver.role !== "guest" && !roleCan(approver.role, "approve")) return { ok: false, error: "forbidden" };
  const post = await getPost(workspace.id, postId);
  if (!post) return { ok: false, error: "not_found" };
  if (post.status !== "pending_approval") return { ok: false, error: "state" };
  const ts = now();
  const future = post.scheduledAt && Date.parse(post.scheduledAt) > Date.now() - PAST_GRACE_MS;
  if (!future) {
    return (await transitionPost(post.id, "pending_approval", "approved", { approved_by: approver.userId, approved_at: ts })) ? { ok: true, status: "approved" } : { ok: false, error: "state" };
  }
  const result = await savePost({
    workspace,
    actor: { userId: approver.userId, role: "owner" },
    postId: post.id,
    content: post.content,
    overrides: Object.fromEntries(post.targets.map((t) => [t.channelId, t.override])),
    channelIds: post.targets.map((t) => t.channelId),
    labels: post.labels,
    scheduledAt: post.scheduledAt,
    intent: "schedule",
  });
  if (!result.ok) return { ok: false, error: result.code === "quota" ? "quota" : "state" };
  const db = await getDb();
  await db.updateTable("posts").set({ approved_by: approver.userId, approved_at: ts }).where("id", "=", post.id).execute();
  return { ok: true, status: "scheduled" };
}

/** Sends a post waiting for approval back to draft (the reason goes into a comment by the caller). */
export async function rejectPost(workspaceId: number, postId: number): Promise<boolean> {
  const post = await getPost(workspaceId, postId);
  if (!post || post.status !== "pending_approval") return false;
  return transitionPost(post.id, "pending_approval", "draft");
}

/**
 * Recomputes a post's status from its targets once publishing started (the engine calls it after
 * each target finishes): publishing → published / partially_failed / failed.
 */
export async function refreshPostStatus(postId: number): Promise<PostStatus | null> {
  const db = await getDb();
  const post = await db.selectFrom("posts").select(["status"]).where("id", "=", postId).executeTakeFirst();
  if (!post || !isPostStatus(post.status)) return null;
  const targets = await db.selectFrom("post_targets").select(["status", "published_at"]).where("post_id", "=", postId).execute();
  const status = aggregatePostStatus(targets.map((t) => t.status));
  if (status === post.status) return status;
  const done = status === "published" || status === "partially_failed" || status === "failed";
  const last = targets.map((t) => t.published_at).filter(Boolean).sort().pop() ?? null;
  await db
    .updateTable("posts")
    .set({ status, published_at: done ? (last ?? now()) : null, updated_at: now() })
    .where("id", "=", postId)
    .execute();
  return status;
}

/**
 * Deletes a post from Queuezen (not from the networks: deleting published posts remotely is the
 * engine's deleteRemote). Refuses while publishing. Unpublished quota is given back.
 */
export async function deletePost(workspace: Pick<WorkspaceRecord, "id" | "ownerId">, postId: number): Promise<boolean> {
  const post = await getPost(workspace.id, postId);
  if (!post || post.status === "publishing") return false;
  const month = usageMonth();
  const refund = { posts: 0, xPosts: 0 };
  for (const t of post.targets) {
    if (t.status !== "published" && t.quotaMonth === month) {
      refund.posts += 1;
      if (t.platform === "x") refund.xPosts += 1;
    }
  }
  const db = await getDb();
  await db.transaction().execute(async (trx) => {
    const targetIds = post.targets.map((t) => t.id);
    if (targetIds.length) await trx.deleteFrom("post_metrics").where("target_id", "in", targetIds).execute();
    await trx.deleteFrom("post_targets").where("post_id", "=", post.id).execute();
    await trx.deleteFrom("post_comments").where("post_id", "=", post.id).execute();
    await trx.updateTable("short_links").set({ post_id: null }).where("post_id", "=", post.id).execute();
    await trx.deleteFrom("posts").where("id", "=", post.id).execute();
  });
  if (refund.posts) await releasePosts(workspace.ownerId, refund, month);
  return true;
}

// ── Comments ──

export interface CommentRecord {
  id: number;
  userId: number | null;
  authorName: string;
  kind: "note" | "approved" | "rejected" | "system";
  body: string;
  createdAt: string;
}

export async function addPostComment(post: { id: number; workspaceId: number }, author: { userId: number | null; name: string }, kind: CommentRecord["kind"], body: string): Promise<void> {
  const db = await getDb();
  await db
    .insertInto("post_comments")
    .values({ post_id: post.id, workspace_id: post.workspaceId, user_id: author.userId, author_name: author.name.trim().slice(0, 120) || "Guest", kind, body: body.trim().slice(0, 5000), created_at: now() })
    .execute();
}

export async function getPostComments(workspaceId: number, postId: number): Promise<CommentRecord[]> {
  const db = await getDb();
  const rows = await db.selectFrom("post_comments").selectAll().where("post_id", "=", postId).where("workspace_id", "=", workspaceId).orderBy("created_at").orderBy("id").execute();
  return rows.map((r) => ({ id: r.id, userId: r.user_id, authorName: r.author_name, kind: r.kind, body: r.body, createdAt: r.created_at }));
}

/** Scheduled times already taken on a channel from `fromIso` on (queue slot lookup). */
export async function takenTimes(channelId: number, fromIso: string): Promise<string[]> {
  const db = await getDb();
  const rows = await db
    .selectFrom("post_targets")
    .select("scheduled_at")
    .where("channel_id", "=", channelId)
    .where("status", "not in", ["cancelled", "failed"])
    .where("scheduled_at", ">=", fromIso)
    .execute();
  return rows.map((r) => r.scheduled_at).filter((v): v is string => Boolean(v));
}
