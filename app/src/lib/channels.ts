import "server-only";
import { getDb, now } from "./db";
import type { ChannelRow } from "./db/schema";
import { decryptSecret, encryptSecret } from "./crypto";
import { atLimit, type Entitlements } from "./plans";
import { REFUNDABLE_TARGET_STATUSES, releaseTargetsQuota } from "./usage";
import { isPlatform, normalizeChannelSettings, normalizeQueueSlots, normalizeWorkspaceSettings, parseJson } from "@/social/normalize";
import type { ChannelCredentials, ChannelSettings, ChannelStatus, ConnectedAccount, DriverChannel, Platform, QueueSlot } from "@/social/types";

/**
 * Channels = connected social accounts of a workspace (not to be confused with notification
 * channels, src/lib/notify-channels.ts). Credentials are encrypted with the app secret
 * (AES-256-GCM, purpose "channel-credentials") and only decrypted for drivers and the engine.
 *
 * Plan limit: max_channels counts every channel that isn't "disconnected" in all workspaces the
 * owner owns. Queue slots are stored as JSON on the channel (channels.queue_slots).
 */

const CREDENTIALS_PURPOSE = "channel-credentials";

export interface ChannelRecord {
  id: number;
  workspaceId: number;
  platform: Platform;
  externalId: string;
  name: string;
  handle: string;
  avatarUrl: string;
  profileUrl: string;
  tokenExpiresAt: string | null;
  status: ChannelStatus;
  lastError: string | null;
  lastCheckedAt: string | null;
  settings: ChannelSettings;
  queueSlots: QueueSlot[];
  meta: Record<string, unknown>;
  createdAt: string;
}

export function toChannelRecord(row: ChannelRow): ChannelRecord | null {
  if (!isPlatform(row.platform)) return null;
  const meta = parseJson(row.meta);
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    platform: row.platform,
    externalId: row.external_id,
    name: row.name,
    handle: row.handle,
    avatarUrl: row.avatar_url ?? "",
    profileUrl: row.profile_url ?? "",
    tokenExpiresAt: row.token_expires_at,
    status: row.status,
    lastError: row.last_error,
    lastCheckedAt: row.last_checked_at,
    settings: normalizeChannelSettings(parseJson(row.settings), row.platform),
    queueSlots: normalizeQueueSlots(parseJson(row.queue_slots)),
    meta: meta && typeof meta === "object" && !Array.isArray(meta) ? (meta as Record<string, unknown>) : {},
    createdAt: row.created_at,
  };
}

const records = (rows: ChannelRow[]) => rows.map(toChannelRecord).filter((c): c is ChannelRecord => c !== null);

export async function encryptCredentials(credentials: ChannelCredentials): Promise<string> {
  return encryptSecret(JSON.stringify(credentials), CREDENTIALS_PURPOSE);
}

/** Decrypted credentials; {} when the value can't be read (wrong APP_SECRET, tampered row). */
export async function decryptCredentials(stored: string): Promise<ChannelCredentials> {
  if (!stored) return {};
  try {
    const parsed = JSON.parse(await decryptSecret(stored, CREDENTIALS_PURPOSE)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as ChannelCredentials) : {};
  } catch {
    return {};
  }
}

/** Channels of a workspace (without "disconnected" ones unless asked), ordered by platform and name. */
export async function getWorkspaceChannels(workspaceId: number, options: { includeDisconnected?: boolean } = {}): Promise<ChannelRecord[]> {
  const db = await getDb();
  let q = db.selectFrom("channels").selectAll().where("workspace_id", "=", workspaceId);
  if (!options.includeDisconnected) q = q.where("status", "!=", "disconnected");
  return records(await q.orderBy("platform").orderBy("name").execute());
}

/** A channel of the workspace (undefined for invalid ids and other workspaces' channels). */
export async function getChannel(workspaceId: number, channelId: number): Promise<ChannelRecord | undefined> {
  if (!Number.isInteger(channelId) || channelId < 1) return undefined;
  const db = await getDb();
  const row = await db.selectFrom("channels").selectAll().where("id", "=", channelId).where("workspace_id", "=", workspaceId).executeTakeFirst();
  return row ? (toChannelRecord(row) ?? undefined) : undefined;
}

/** The ids from `ids` that are usable channels of the workspace (use it for ids from user input). */
export async function workspaceChannelIds(workspaceId: number, ids: number[]): Promise<number[]> {
  const clean = [...new Set(ids.filter((n) => Number.isInteger(n) && n > 0))].slice(0, 200);
  if (!clean.length) return [];
  const db = await getDb();
  const rows = await db.selectFrom("channels").select("id").where("workspace_id", "=", workspaceId).where("id", "in", clean).where("status", "!=", "disconnected").execute();
  const ok = new Set(rows.map((r) => r.id));
  return clean.filter((id) => ok.has(id));
}

/** Channels counted against max_channels: not disconnected, in any workspace the owner owns. */
export async function countOwnerChannels(ownerId: number): Promise<number> {
  const db = await getDb();
  const row = await db
    .selectFrom("channels as c")
    .innerJoin("workspaces as w", "w.id", "c.workspace_id")
    .select((eb) => eb.fn.countAll<number>().as("n"))
    .where("w.owner_id", "=", ownerId)
    .where("c.status", "!=", "disconnected")
    .executeTakeFirst();
  return Number(row?.n ?? 0);
}

export async function channelQuota(ownerId: number, entitlements: Pick<Entitlements, "maxChannels">): Promise<{ used: number; limit: number; full: boolean }> {
  const used = await countOwnerChannels(ownerId);
  return { used, limit: entitlements.maxChannels, full: atLimit(used, entitlements.maxChannels) };
}

export type SaveAccountResult = { ok: true; id: number; created: boolean } | { ok: false; error: "limit" };

/**
 * Adds a connected account to a workspace, or refreshes it when it is already there (same
 * platform and external id): new credentials, status active, profile data updated. Only a new or
 * previously disconnected channel needs a free slot under the owner's max_channels.
 */
export async function saveConnectedAccount(
  workspace: { id: number; ownerId: number; settings: unknown },
  platform: Platform,
  account: ConnectedAccount,
  options: { connectedBy: number | null; entitlements: Pick<Entitlements, "maxChannels"> },
): Promise<SaveAccountResult> {
  const db = await getDb();
  const ts = now();
  const credentials = await encryptCredentials(account.credentials);
  const profile = {
    name: account.name.trim().slice(0, 190) || account.handle || platform,
    handle: account.handle.trim().slice(0, 190),
    avatar_url: account.avatarUrl.slice(0, 1000) || null,
    profile_url: account.profileUrl.slice(0, 1000) || null,
    credentials,
    token_expires_at: account.tokenExpiresAt,
    meta: JSON.stringify(account.meta ?? {}),
    updated_at: ts,
  };
  const existing = await db
    .selectFrom("channels")
    .select(["id", "status"])
    .where("workspace_id", "=", workspace.id)
    .where("platform", "=", platform)
    .where("external_id", "=", account.externalId)
    .executeTakeFirst();
  if (existing && existing.status !== "disconnected") {
    await db.updateTable("channels").set({ ...profile, status: "active", last_error: null, last_checked_at: ts }).where("id", "=", existing.id).execute();
    return { ok: true, id: existing.id, created: false };
  }
  if ((await channelQuota(workspace.ownerId, options.entitlements)).full) return { ok: false, error: "limit" };
  if (existing) {
    await db.updateTable("channels").set({ ...profile, status: "active", last_error: null, last_checked_at: ts, connected_by: options.connectedBy }).where("id", "=", existing.id).execute();
    await channelQuotaAlert(workspace.ownerId, options.entitlements.maxChannels);
    return { ok: true, id: existing.id, created: false };
  }
  const slots = normalizeWorkspaceSettings(typeof workspace.settings === "string" ? parseJson(workspace.settings) : workspace.settings).defaultSlots;
  const res = await db
    .insertInto("channels")
    .values({
      workspace_id: workspace.id,
      platform,
      external_id: account.externalId.slice(0, 190),
      ...profile,
      status: "active",
      last_error: null,
      last_checked_at: ts,
      settings: JSON.stringify(normalizeChannelSettings({}, platform)),
      queue_slots: JSON.stringify(slots),
      connected_by: options.connectedBy,
      created_at: ts,
    })
    .executeTakeFirstOrThrow();
  await channelQuotaAlert(workspace.ownerId, options.entitlements.maxChannels);
  return { ok: true, id: Number(res.insertId), created: true };
}

/** quota_warning / quota_reached of the plan's channel limit after a channel was added (once a month each). */
async function channelQuotaAlert(ownerId: number, limit: number): Promise<void> {
  if (limit <= 0) return;
  const { checkQuotaAlerts } = await import("@/lib/notify/quota");
  await checkQuotaAlerts(ownerId, "channels", await countOwnerChannels(ownerId), limit);
}

/** New credentials after a token refresh (rotating refresh tokens: write both in this one update). */
export async function updateChannelCredentials(channelId: number, credentials: ChannelCredentials, tokenExpiresAt: string | null): Promise<void> {
  const db = await getDb();
  await db
    .updateTable("channels")
    .set({ credentials: await encryptCredentials(credentials), token_expires_at: tokenExpiresAt, status: "active", last_error: null, updated_at: now() })
    .where("id", "=", channelId)
    .where("status", "!=", "disconnected")
    .execute();
}

/** Marks a channel active / expired (reconnect needed) / error, with the reason. */
export async function setChannelStatus(channelId: number, status: Exclude<ChannelStatus, "disconnected">, error: string | null = null): Promise<void> {
  const db = await getDb();
  await db
    .updateTable("channels")
    .set({ status, last_error: error ? error.slice(0, 1000) : null, last_checked_at: now(), updated_at: now() })
    .where("id", "=", channelId)
    .where("status", "!=", "disconnected")
    .execute();
}

export async function updateChannelProfile(channelId: number, input: { name?: string; handle?: string; avatarUrl?: string; profileUrl?: string; meta?: Record<string, unknown> }): Promise<void> {
  const db = await getDb();
  await db
    .updateTable("channels")
    .set({
      ...(input.name !== undefined ? { name: input.name.trim().slice(0, 190) } : {}),
      ...(input.handle !== undefined ? { handle: input.handle.trim().slice(0, 190) } : {}),
      ...(input.avatarUrl !== undefined ? { avatar_url: input.avatarUrl.slice(0, 1000) || null } : {}),
      ...(input.profileUrl !== undefined ? { profile_url: input.profileUrl.slice(0, 1000) || null } : {}),
      ...(input.meta !== undefined ? { meta: JSON.stringify(input.meta) } : {}),
      updated_at: now(),
    })
    .where("id", "=", channelId)
    .execute();
}

export async function updateChannelSettings(channel: Pick<ChannelRecord, "id" | "platform">, settings: unknown): Promise<void> {
  const db = await getDb();
  await db.updateTable("channels").set({ settings: JSON.stringify(normalizeChannelSettings(settings, channel.platform)), updated_at: now() }).where("id", "=", channel.id).execute();
}

export async function setQueueSlots(channelId: number, slots: unknown): Promise<QueueSlot[]> {
  const clean = normalizeQueueSlots(slots);
  const db = await getDb();
  await db.updateTable("channels").set({ queue_slots: JSON.stringify(clean), updated_at: now() }).where("id", "=", channelId).execute();
  return clean;
}

/**
 * Disconnects a channel: credentials are wiped, the row stays (status "disconnected") so the
 * post history keeps its channel. Publications not yet published are cancelled and their quota
 * given back. Revoking the token at the network is the driver's job before calling this.
 */
export async function disconnectChannel(channel: Pick<ChannelRecord, "id" | "workspaceId">): Promise<void> {
  const db = await getDb();
  const ws = await db.selectFrom("workspaces").select("owner_id").where("id", "=", channel.workspaceId).executeTakeFirst();
  const pending = await db
    .selectFrom("post_targets")
    .select(["id", "post_id", "platform", "quota_month"])
    .where("channel_id", "=", channel.id)
    .where("status", "in", REFUNDABLE_TARGET_STATUSES)
    .execute();
  await db.transaction().execute(async (trx) => {
    if (pending.length) {
      await trx
        .updateTable("post_targets")
        .set({ status: "cancelled", next_attempt_at: null, quota_month: null, updated_at: now() })
        .where("id", "in", pending.map((t) => t.id))
        .execute();
    }
    await trx
      .updateTable("channels")
      .set({ status: "disconnected", credentials: "", token_expires_at: null, last_error: null, updated_at: now() })
      .where("id", "=", channel.id)
      .execute();
  });
  if (ws) await releaseTargetsQuota(ws.owner_id, pending);
  // Posts left without any channel can't be published any more: back to drafts (the author picks
  // other channels); posts publishing elsewhere get their status recomputed.
  const { refreshPostStatus } = await import("@/lib/posts");
  for (const postId of [...new Set(pending.map((t) => t.post_id))]) {
    const post = await db.selectFrom("posts").select("status").where("id", "=", postId).executeTakeFirst();
    if (!post) continue;
    const live = await db.selectFrom("post_targets").select("id").where("post_id", "=", postId).where("status", "!=", "cancelled").executeTakeFirst();
    if (!live && (post.status === "scheduled" || post.status === "approved" || post.status === "pending_approval")) {
      await db.updateTable("posts").set({ status: "draft", updated_at: now() }).where("id", "=", postId).where("status", "=", post.status).execute();
    } else if (post.status === "publishing" || post.status === "failed" || post.status === "partially_failed") {
      await refreshPostStatus(postId);
    }
  }
}

/** A channel with decrypted credentials, for drivers and the engine (never send it to a browser). */
export async function getDriverChannel(channelId: number): Promise<DriverChannel | undefined> {
  const db = await getDb();
  const row = await db.selectFrom("channels").selectAll().where("id", "=", channelId).executeTakeFirst();
  const record = row ? toChannelRecord(row) : null;
  if (!row || !record || record.status === "disconnected") return undefined;
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    platform: record.platform,
    externalId: record.externalId,
    name: record.name,
    handle: record.handle,
    credentials: await decryptCredentials(row.credentials),
    settings: record.settings,
    meta: record.meta,
  };
}

/** Active channels whose token expires before `beforeIso` (the token refresh job). */
export async function getChannelsExpiringBefore(beforeIso: string, limit = 50): Promise<ChannelRecord[]> {
  const db = await getDb();
  const rows = await db
    .selectFrom("channels")
    .selectAll()
    .where("status", "=", "active")
    .where("token_expires_at", "is not", null)
    .where("token_expires_at", "<", beforeIso)
    .orderBy("token_expires_at")
    .limit(limit)
    .execute();
  return records(rows);
}
