import "server-only";
import crypto from "node:crypto";
import { hashPassword, verifyPassword } from "./auth/password";
import { sign, verifySignature } from "./crypto";
import { getDb, now } from "./db";
import type { ApprovalLinkRow } from "./db/schema";
import { mailConfigured, sendMail } from "./mail";
import { buildNotifyPayload, notifyWorkspace, workspaceDashboardPath } from "./notify";
import { describeNotification, notificationPlainText } from "./notify/format";
import { addPostComment, approvePost, getPost, listPosts, rejectPost, toPostRecord, type PostRecord } from "./posts";
import { getSettings } from "./settings";
import { randomToken } from "./tokens";
import { getWorkspace, type WorkspaceRecord } from "./workspaces";
import { idList, parseJson, roleCan } from "@/social/normalize";
import type { NotifyPayload, PostStatus, WorkspaceRole } from "@/social/types";

/**
 * Approval workflow: the members' "Pending approval" inbox, decisions with a comment, client
 * approval links (/approve/<token>, no login, optional password, expiry) and the notifications
 * (approval_requested → notification channels + approvers by email; approval_decided →
 * notification channels + the author by email).
 */

export const MAX_APPROVAL_LINKS = 100;
export const APPROVAL_LINK_MAX_DAYS = 90;
export const APPROVAL_COOKIE_PREFIX = "qz_al_";
const UNLOCK_PURPOSE = "approval-link-unlock";

export interface ApprovalLinkRecord {
  id: number;
  workspaceId: number;
  label: string;
  /** Fixed post set, or null = posts waiting for approval (within the range when set). */
  postIds: number[] | null;
  rangeFrom: string | null;
  rangeTo: string | null;
  hasPassword: boolean;
  createdBy: number | null;
  expiresAt: string;
  revokedAt: string | null;
  lastViewedAt: string | null;
  createdAt: string;
}

const hashToken = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

function toRecord(row: ApprovalLinkRow): ApprovalLinkRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    label: row.label,
    postIds: row.post_ids === null ? null : idList(parseJson(row.post_ids), 500),
    rangeFrom: row.range_from ?? null,
    rangeTo: row.range_to ?? null,
    hasPassword: Boolean(row.password_hash),
    createdBy: row.created_by,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    lastViewedAt: row.last_viewed_at,
    createdAt: row.created_at,
  };
}

export function isLinkActive(link: Pick<ApprovalLinkRecord, "expiresAt" | "revokedAt">, at = now()): boolean {
  return !link.revokedAt && link.expiresAt > at;
}

export async function getApprovalLinks(workspaceId: number): Promise<ApprovalLinkRecord[]> {
  const db = await getDb();
  const rows = await db.selectFrom("approval_links").selectAll().where("workspace_id", "=", workspaceId).orderBy("id", "desc").limit(MAX_APPROVAL_LINKS).execute();
  return rows.map(toRecord);
}

export type CreateLinkResult = { ok: true; id: number; token: string } | { ok: false; error: "posts" | "range" | "limit" | "password" };

/**
 * Creates a client approval link and returns its token (shown once: only its hash is stored).
 * Either a fixed post set (`postIds`, posts of the workspace) or "everything waiting for
 * approval", optionally limited to a scheduled-time range.
 */
export async function createApprovalLink(
  workspace: Pick<WorkspaceRecord, "id">,
  input: { label: string; postIds?: number[] | null; rangeFrom?: string | null; rangeTo?: string | null; expiresInDays: number; password?: string; createdBy: number | null },
): Promise<CreateLinkResult> {
  const db = await getDb();
  const active = await db
    .selectFrom("approval_links")
    .select((eb) => eb.fn.countAll<number>().as("n"))
    .where("workspace_id", "=", workspace.id)
    .where("revoked_at", "is", null)
    .where("expires_at", ">", now())
    .executeTakeFirst();
  if (Number(active?.n ?? 0) >= MAX_APPROVAL_LINKS) return { ok: false, error: "limit" };

  let postIds: number[] | null = null;
  if (input.postIds && input.postIds.length) {
    const wanted = [...new Set(input.postIds.filter((n) => Number.isInteger(n) && n > 0))].slice(0, 500);
    const rows = wanted.length ? await db.selectFrom("posts").select("id").where("workspace_id", "=", workspace.id).where("id", "in", wanted).execute() : [];
    postIds = rows.map((r) => r.id).sort((a, b) => a - b);
    if (!postIds.length) return { ok: false, error: "posts" };
  }
  const iso = (v: string | null | undefined) => (v && Number.isFinite(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : null);
  const rangeFrom = postIds ? null : iso(input.rangeFrom);
  const rangeTo = postIds ? null : iso(input.rangeTo);
  if (rangeFrom && rangeTo && rangeFrom >= rangeTo) return { ok: false, error: "range" };
  const password = (input.password ?? "").trim();
  if (password && (password.length < 4 || password.length > 200)) return { ok: false, error: "password" };

  const days = Math.min(APPROVAL_LINK_MAX_DAYS, Math.max(1, Math.round(input.expiresInDays) || 14));
  const token = randomToken(32);
  const res = await db
    .insertInto("approval_links")
    .values({
      workspace_id: workspace.id,
      token_hash: hashToken(token),
      post_ids: postIds ? JSON.stringify(postIds) : null,
      range_from: rangeFrom,
      range_to: rangeTo,
      password_hash: password ? await hashPassword(password) : null,
      label: input.label.trim().slice(0, 120),
      created_by: input.createdBy,
      expires_at: new Date(Date.now() + days * 86_400_000).toISOString(),
      revoked_at: null,
      last_viewed_at: null,
      created_at: now(),
    })
    .executeTakeFirstOrThrow();
  return { ok: true, id: Number(res.insertId), token };
}

/**
 * The seeded demo's showcase approval link (setting `showcase_approval_token`, written by
 * DEMO_SEED): its raw token, so the live demo can open the client page that real links only show
 * once. Undefined when there is none or it is no longer active.
 */
export async function getShowcaseApprovalLink(): Promise<{ id: number; workspaceId: number; token: string } | undefined> {
  const db = await getDb();
  const row = await db.selectFrom("settings").select("value").where("key", "=", "showcase_approval_token").executeTakeFirst();
  const token = row?.value?.trim();
  if (!token) return undefined;
  const resolved = await findApprovalLink(token);
  return resolved ? { id: resolved.link.id, workspaceId: resolved.workspace.id, token } : undefined;
}

export async function revokeApprovalLink(workspaceId: number, id: number): Promise<boolean> {
  const db = await getDb();
  const res = await db.updateTable("approval_links").set({ revoked_at: now() }).where("id", "=", id).where("workspace_id", "=", workspaceId).where("revoked_at", "is", null).executeTakeFirst();
  return Number(res.numUpdatedRows) > 0;
}

export async function deleteApprovalLink(workspaceId: number, id: number): Promise<boolean> {
  const db = await getDb();
  const res = await db.deleteFrom("approval_links").where("id", "=", id).where("workspace_id", "=", workspaceId).executeTakeFirst();
  return Number(res.numDeletedRows) > 0;
}

export interface ResolvedLink {
  link: ApprovalLinkRecord;
  workspace: WorkspaceRecord;
  passwordHash: string | null;
}

/** The link behind a token: undefined when unknown, expired or revoked. */
export async function findApprovalLink(token: string): Promise<ResolvedLink | undefined> {
  if (!/^[\w-]{20,100}$/.test(token)) return undefined;
  const db = await getDb();
  const row = await db.selectFrom("approval_links").selectAll().where("token_hash", "=", hashToken(token)).executeTakeFirst();
  if (!row) return undefined;
  const link = toRecord(row);
  if (!isLinkActive(link)) return undefined;
  const workspace = await getWorkspace(row.workspace_id);
  if (!workspace) return undefined;
  return { link, workspace, passwordHash: row.password_hash ?? null };
}

/** Remembers when the client last opened the link (at most once a minute). */
export async function touchApprovalLink(link: ApprovalLinkRecord): Promise<void> {
  if (link.lastViewedAt && Date.now() - Date.parse(link.lastViewedAt) < 60_000) return;
  const db = await getDb();
  await db.updateTable("approval_links").set({ last_viewed_at: now() }).where("id", "=", link.id).execute();
}

export async function checkLinkPassword(resolved: ResolvedLink, password: string): Promise<boolean> {
  if (!resolved.passwordHash) return true;
  if (!password || password.length > 200) return false;
  return verifyPassword(password, resolved.passwordHash);
}

/** Cookie value proving the password was entered (bound to the link and its password hash). */
export async function unlockValue(resolved: ResolvedLink): Promise<string> {
  return sign(`${resolved.link.id}:${resolved.passwordHash ?? ""}`, UNLOCK_PURPOSE);
}

export async function isUnlocked(resolved: ResolvedLink, cookieValue: string | undefined): Promise<boolean> {
  if (!resolved.passwordHash) return true;
  if (!cookieValue) return false;
  return verifySignature(`${resolved.link.id}:${resolved.passwordHash}`, cookieValue, UNLOCK_PURPOSE);
}

/** Statuses a client sees on a link (drafts and failed posts are internal). */
const CLIENT_STATUSES: PostStatus[] = ["pending_approval", "approved", "scheduled", "publishing", "published", "partially_failed"];

/** Posts shown on a client approval link, by scheduled time. */
export async function getLinkPosts(link: ApprovalLinkRecord): Promise<PostRecord[]> {
  if (link.postIds) {
    if (!link.postIds.length) return [];
    const db = await getDb();
    // Rejected posts go back to draft: they stay visible on a fixed set so the client sees the outcome.
    const rows = await db
      .selectFrom("posts")
      .selectAll()
      .where("workspace_id", "=", link.workspaceId)
      .where("id", "in", link.postIds)
      .where("status", "in", [...CLIENT_STATUSES, "draft"])
      .orderBy("scheduled_at")
      .orderBy("id")
      .execute();
    if (!rows.length) return [];
    const targets = await db.selectFrom("post_targets").selectAll().where("post_id", "in", rows.map((r) => r.id)).orderBy("id").execute();
    return rows.map((r) => toPostRecord(r, targets.filter((t) => t.post_id === r.id)));
  }
  const posts = await listPosts(link.workspaceId, { status: ["pending_approval"], from: link.rangeFrom ?? undefined, to: link.rangeTo ?? undefined, limit: 200 });
  if (link.rangeFrom || link.rangeTo) return posts;
  // Pending posts without a date are included when there is no range.
  const undated = await listPosts(link.workspaceId, { status: ["pending_approval"], limit: 200 });
  const seen = new Set(posts.map((p) => p.id));
  return [...posts, ...undated.filter((p) => !seen.has(p.id))];
}

/** True when the post may be decided through the link. */
export function linkCovers(link: ApprovalLinkRecord, post: Pick<PostRecord, "id" | "scheduledAt">): boolean {
  if (link.postIds) return link.postIds.includes(post.id);
  if (link.rangeFrom && (!post.scheduledAt || post.scheduledAt < link.rangeFrom)) return false;
  if (link.rangeTo && (!post.scheduledAt || post.scheduledAt >= link.rangeTo)) return false;
  return true;
}

// ── Decisions ──

export type Decision = "approved" | "rejected";

export type DecisionResult = { ok: true; status: PostStatus } | { ok: false; error: "not_found" | "forbidden" | "state" | "quota" | "comment" };

/**
 * Approves or sends back (rejects) a post waiting for approval, records the decision as a comment
 * and notifies. A rejection needs a comment (what to change). `role: "guest"` = a client on an
 * approval link (the caller checked the link).
 */
export async function decidePost(
  workspace: WorkspaceRecord,
  postId: number,
  decision: Decision,
  actor: { userId: number | null; name: string; role: WorkspaceRole | "guest" },
  comment = "",
): Promise<DecisionResult> {
  if (actor.role !== "guest" && !roleCan(actor.role, "approve")) return { ok: false, error: "forbidden" };
  const note = comment.trim().slice(0, 5000);
  if (decision === "rejected" && !note) return { ok: false, error: "comment" };
  const post = await getPost(workspace.id, postId);
  if (!post) return { ok: false, error: "not_found" };
  if (post.status !== "pending_approval") return { ok: false, error: "state" };
  let status: PostStatus;
  if (decision === "approved") {
    const result = await approvePost(workspace, post.id, { userId: actor.userId, role: actor.role });
    if (!result.ok) return { ok: false, error: result.error };
    status = result.status;
  } else {
    if (!(await rejectPost(workspace.id, post.id))) return { ok: false, error: "state" };
    status = "draft";
  }
  await addPostComment(post, { userId: actor.userId, name: actor.name }, decision, note);
  await notifyApprovalDecided(workspace, post, decision, actor, note);
  return { ok: true, status };
}

// ── Notifications ──

function excerpt(text: string, max = 120): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t || "(no text)";
}

async function emailPeople(userIds: number[], payload: NotifyPayload): Promise<number> {
  const ids = [...new Set(userIds.filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) return 0;
  const settings = await getSettings();
  if (!mailConfigured(settings)) return 0;
  const db = await getDb();
  const users = await db.selectFrom("users").select(["email", "status"]).where("id", "in", ids).execute();
  const text = notificationPlainText(payload, settings.site_name);
  const subject = describeNotification(payload, settings.site_name).subject;
  let sent = 0;
  for (const u of users) {
    if (u.status !== "active") continue;
    try {
      await sendMail({ to: u.email, subject, text });
      sent += 1;
    } catch (error) {
      console.error("[queuezen] approval email failed:", error instanceof Error ? error.message : error);
    }
  }
  return sent;
}

/** Members who can approve posts in a workspace (approver, admin, owner). */
export async function getApproverIds(workspaceId: number): Promise<number[]> {
  const db = await getDb();
  const rows = await db.selectFrom("workspace_members").select(["user_id", "role"]).where("workspace_id", "=", workspaceId).execute();
  return rows.filter((r) => roleCan(r.role as WorkspaceRole, "approve")).map((r) => r.user_id);
}

/**
 * "A post is waiting for approval": the workspace's notification channels plus an email to every
 * approver except the person who submitted it. Call it after a post was submitted for approval
 * (composer, REST API, RSS). Never throws.
 */
export async function notifyApprovalRequested(workspace: Pick<WorkspaceRecord, "id" | "name">, post: Pick<PostRecord, "id" | "content" | "scheduledAt">, by: { userId: number | null; name: string }): Promise<void> {
  try {
    const data: Record<string, string | number> = { post: excerpt(post.content.text), by: by.name || "Automation" };
    if (post.scheduledAt) data.scheduled = post.scheduledAt.slice(0, 16).replace("T", " ") + " UTC";
    const payload = await buildNotifyPayload(workspace, "approval_requested", `${by.name || "Automation"} sent a post for approval.`, data, workspaceDashboardPath(workspace.id, "team/approvals"));
    await notifyWorkspace(workspace.id, payload, { postId: post.id });
    const approvers = (await getApproverIds(workspace.id)).filter((id) => id !== by.userId);
    await emailPeople(approvers, payload);
  } catch (error) {
    console.error("[queuezen] approval request notification failed:", error);
  }
}

/** "A post was approved / sent back": notification channels plus an email to the author. Never throws. */
export async function notifyApprovalDecided(
  workspace: Pick<WorkspaceRecord, "id" | "name">,
  post: Pick<PostRecord, "id" | "content" | "authorId">,
  decision: Decision,
  by: { userId: number | null; name: string },
  comment: string,
): Promise<void> {
  try {
    const data: Record<string, string | number> = { post: excerpt(post.content.text), decision, by: by.name || "Client" };
    if (comment) data.comment = excerpt(comment, 500);
    const verb = decision === "approved" ? "approved" : "sent back";
    const payload = await buildNotifyPayload(workspace, "approval_decided", `${by.name || "A client"} ${verb} a post.`, data, workspaceDashboardPath(workspace.id, "posts"));
    await notifyWorkspace(workspace.id, payload, { postId: post.id });
    if (post.authorId && post.authorId !== by.userId) await emailPeople([post.authorId], payload);
  } catch (error) {
    console.error("[queuezen] approval decision notification failed:", error);
  }
}

/** Posts waiting for approval in a workspace (the approvers' inbox), soonest first. */
export async function getPendingApprovals(workspaceId: number, limit = 100): Promise<PostRecord[]> {
  const posts = await listPosts(workspaceId, { status: ["pending_approval"], limit });
  // Dated posts first (soonest), then undated ones (newest).
  return posts.sort((a, b) => {
    if (a.scheduledAt && b.scheduledAt) return a.scheduledAt.localeCompare(b.scheduledAt);
    if (a.scheduledAt) return -1;
    if (b.scheduledAt) return 1;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

// ── Team helpers (Team page) ──

export interface MemberActivity {
  /** Posts created by the member in the last 30 days. */
  posts30: number;
  /** Decisions (approved / sent back) in the last 30 days. */
  decisions30: number;
  /** Last post created / comment written. */
  lastActiveAt: string | null;
}

/** Light activity per member from posts and comments (no tracking beyond what the app stores). */
export async function getMemberActivity(workspaceId: number): Promise<Map<number, MemberActivity>> {
  const db = await getDb();
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const [posts, lastPosts, comments] = await Promise.all([
    db
      .selectFrom("posts")
      .select(["author_id", (eb) => eb.fn.countAll<number>().as("n")])
      .where("workspace_id", "=", workspaceId)
      .where("created_at", ">=", since)
      .where("author_id", "is not", null)
      .groupBy("author_id")
      .execute(),
    db
      .selectFrom("posts")
      .select(["author_id", (eb) => eb.fn.max("created_at").as("last")])
      .where("workspace_id", "=", workspaceId)
      .where("author_id", "is not", null)
      .groupBy("author_id")
      .execute(),
    db
      .selectFrom("post_comments")
      .select(["user_id", "kind", (eb) => eb.fn.countAll<number>().as("n"), (eb) => eb.fn.max("created_at").as("last")])
      .where("workspace_id", "=", workspaceId)
      .where("user_id", "is not", null)
      .groupBy(["user_id", "kind"])
      .execute(),
  ]);
  const out = new Map<number, MemberActivity>();
  const get = (id: number) => {
    let a = out.get(id);
    if (!a) out.set(id, (a = { posts30: 0, decisions30: 0, lastActiveAt: null }));
    return a;
  };
  const later = (a: string | null, b: string | null) => (!a ? b : !b ? a : a > b ? a : b);
  for (const r of posts) if (r.author_id) get(r.author_id).posts30 = Number(r.n);
  for (const r of lastPosts) if (r.author_id) get(r.author_id).lastActiveAt = later(get(r.author_id).lastActiveAt, (r.last as string | null) ?? null);
  for (const r of comments) {
    if (!r.user_id) continue;
    const a = get(r.user_id);
    a.lastActiveAt = later(a.lastActiveAt, (r.last as string | null) ?? null);
  }
  const decided = await db
    .selectFrom("post_comments")
    .select(["user_id", (eb) => eb.fn.countAll<number>().as("n")])
    .where("workspace_id", "=", workspaceId)
    .where("kind", "in", ["approved", "rejected"])
    .where("created_at", ">=", since)
    .where("user_id", "is not", null)
    .groupBy("user_id")
    .execute();
  for (const r of decided) if (r.user_id) get(r.user_id).decisions30 = Number(r.n);
  return out;
}

export type TransferResult = { ok: true } | { ok: false; error: "personal" | "member" | "self" };

/**
 * Makes another member the owner of a workspace: they become "owner", the previous owner becomes
 * "admin". From then on the workspace's limits come from the NEW owner's plan. Personal
 * workspaces can't be transferred.
 */
export async function transferOwnership(workspace: Pick<WorkspaceRecord, "id" | "ownerId" | "isPersonal">, toUserId: number): Promise<TransferResult> {
  if (workspace.isPersonal) return { ok: false, error: "personal" };
  if (toUserId === workspace.ownerId) return { ok: false, error: "self" };
  const db = await getDb();
  const member = await db.selectFrom("workspace_members").select(["id", "role"]).where("workspace_id", "=", workspace.id).where("user_id", "=", toUserId).executeTakeFirst();
  if (!member) return { ok: false, error: "member" };
  await db.transaction().execute(async (trx) => {
    await trx.updateTable("workspace_members").set({ role: "admin" }).where("workspace_id", "=", workspace.id).where("user_id", "=", workspace.ownerId).execute();
    await trx.updateTable("workspace_members").set({ role: "owner" }).where("id", "=", member.id).execute();
    await trx.updateTable("workspaces").set({ owner_id: toUserId, updated_at: now() }).where("id", "=", workspace.id).execute();
  });
  return { ok: true };
}
