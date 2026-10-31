import "server-only";
import { getDb, now } from "./db";
import type { Plan } from "./db/schema";
import type { SessionUser } from "./auth/session";

/**
 * Plans and what they allow. Limits belong to an ACCOUNT: a workspace uses the plan of its
 * owner, and the counts (channels, scheduled posts, members) add up across all the workspaces
 * the owner owns, so creating more workspaces never raises a limit. See src/lib/workspaces.ts.
 */
export interface Entitlements {
  plan: Plan | null;
  /** True when the user has an active paid plan. */
  isPremium: boolean;
  /** Connected social accounts across the owner's workspaces; 0 = unlimited. */
  maxChannels: number;
  /** Publications scheduled per calendar month (a post on 3 channels counts 3); 0 = unlimited. */
  maxScheduledMonthly: number;
  /** Team seats across the owner's workspaces, the owner included; 0 = unlimited. */
  maxMembers: number;
  /** Posts to X per calendar month: 0 = X not allowed, -1 = unlimited. */
  maxXPostsMonthly: number;
  allowAi: boolean;
  allowRss: boolean;
  /** REST API access (/api/v1). */
  allowApi: boolean;
  /** Client branding of approval links (white label). The links themselves work on every plan. */
  allowWhiteLabel: boolean;
  /** Hide the "Powered by" line on approval links and emails. */
  removeBranding: boolean;
  /** AI assistant requests per calendar month; 0 = unlimited (when allowAi). */
  maxAiMonthly: number;
  expiresAt: string | null;
}

type Limits = Omit<Entitlements, "plan" | "isPremium" | "expiresAt">;

/** Limits used if no plan is marked as the free plan (the same as the default free plan). */
const FALLBACK_FREE: Limits = {
  maxChannels: 3,
  maxScheduledMonthly: 30,
  maxMembers: 1,
  maxXPostsMonthly: 0,
  allowAi: false,
  allowRss: false,
  allowApi: false,
  allowWhiteLabel: false,
  removeBranding: false,
  maxAiMonthly: 0,
};

/** Administrators run the platform, so their own workspaces are never limited. */
const ADMIN_LIMITS: Limits = {
  maxChannels: 0,
  maxScheduledMonthly: 0,
  maxMembers: 0,
  maxXPostsMonthly: -1,
  allowAi: true,
  allowRss: true,
  allowApi: true,
  allowWhiteLabel: true,
  removeBranding: true,
  maxAiMonthly: 0,
};

export async function getActivePlans(): Promise<Plan[]> {
  const db = await getDb();
  return db.selectFrom("plans").selectAll().where("is_active", "=", 1).orderBy("sort_order").orderBy("id").execute();
}

export async function getAllPlans(): Promise<Plan[]> {
  const db = await getDb();
  return db.selectFrom("plans").selectAll().orderBy("sort_order").orderBy("id").execute();
}

export async function getPlan(id: number): Promise<Plan | undefined> {
  const db = await getDb();
  return db.selectFrom("plans").selectAll().where("id", "=", id).executeTakeFirst();
}

export async function getFreePlan(): Promise<Plan | undefined> {
  const db = await getDb();
  return db.selectFrom("plans").selectAll().where("is_free", "=", 1).orderBy("id").executeTakeFirst();
}

export function hasActivePaidPlan(user: Pick<SessionUser, "plan_id" | "plan_expires_at"> | null): boolean {
  return Boolean(user?.plan_id && user.plan_expires_at && user.plan_expires_at > now());
}

export function limitsFromPlan(plan: Pick<Plan, "max_channels" | "max_scheduled_monthly" | "max_members" | "max_x_posts_monthly" | "allow_ai" | "allow_rss" | "allow_api" | "allow_white_label" | "remove_branding" | "max_ai_monthly">): Limits {
  return {
    maxChannels: plan.max_channels,
    maxScheduledMonthly: plan.max_scheduled_monthly,
    maxMembers: plan.max_members,
    maxXPostsMonthly: plan.max_x_posts_monthly,
    allowAi: plan.allow_ai === 1,
    allowRss: plan.allow_rss === 1,
    allowApi: plan.allow_api === 1,
    allowWhiteLabel: plan.allow_white_label === 1,
    removeBranding: plan.remove_branding === 1,
    maxAiMonthly: Math.max(0, Number(plan.max_ai_monthly) || 0),
  };
}

export async function getEntitlements(user: Pick<SessionUser, "role" | "plan_id" | "plan_expires_at"> | null): Promise<Entitlements> {
  if (user?.role === "admin") return { plan: null, isPremium: true, ...ADMIN_LIMITS, expiresAt: null };
  if (user && hasActivePaidPlan(user)) {
    const plan = await getPlan(user.plan_id!);
    if (plan && !plan.is_free) return { plan, isPremium: true, ...limitsFromPlan(plan), expiresAt: user.plan_expires_at };
  }
  const free = await getFreePlan();
  return {
    plan: free ?? null,
    isPremium: false,
    ...(free ? limitsFromPlan(free) : FALLBACK_FREE),
    expiresAt: null,
  };
}

/** True when `used` has reached a limit (0 = unlimited). */
export function atLimit(used: number, limit: number): boolean {
  return limit > 0 && used >= limit;
}

/** How many more items fit under a limit (Infinity when unlimited, never negative). */
export function remaining(used: number, limit: number): number {
  return limit > 0 ? Math.max(0, limit - used) : Infinity;
}

/** The X quota as a normal limit: -1 (unlimited) → 0 (unlimited), 0 (none) → a limit nothing fits under. */
export function xLimit(maxXPostsMonthly: number): { allowed: boolean; limit: number } {
  if (maxXPostsMonthly < 0) return { allowed: true, limit: 0 };
  return { allowed: maxXPostsMonthly > 0, limit: maxXPostsMonthly };
}

export function planFeatures(plan: Pick<Plan, "features">): string[] {
  return (plan.features ?? "")
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean);
}

/** Entitlements of a user by id (e.g. the owner of a workspace in jobs and the REST API). */
export async function getEntitlementsForUserId(userId: number): Promise<Entitlements> {
  const db = await getDb();
  const user = await db.selectFrom("users").select(["role", "plan_id", "plan_expires_at"]).where("id", "=", userId).executeTakeFirst();
  return getEntitlements(user ?? null);
}
