import "server-only";
import crypto from "node:crypto";
import { disconnectChannel, updateChannelProfile } from "@/lib/channels";
import { getDb, now } from "@/lib/db";
import type { Settings } from "@/lib/settings";
import type { Platform } from "@/social/types";

/**
 * Meta's data deletion callback (Meta app → Settings → Basic → "Data deletion request URL"):
 * Meta POSTs a signed_request when a person removes the app; we verify it with the app secret
 * (Facebook / Instagram / Threads apps each have their own), remove the stored data of that
 * person's channels (tokens, profile data) and answer with a status URL and confirmation code.
 * The deauthorize callback (/api/meta/deauthorize) only disconnects them.
 */

export interface SignedRequest {
  algorithm: string;
  user_id: string;
  issued_at?: number;
  [key: string]: unknown;
}

const b64urlDecode = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

/** Verifies "<signature>.<payload>" (HMAC-SHA256 of the payload with the app secret). */
export function parseSignedRequest(signedRequest: string, secret: string): SignedRequest | null {
  const [sig, payload] = signedRequest.split(".", 2);
  if (!sig || !payload || !secret) return null;
  const expected = crypto.createHmac("sha256", secret).update(payload).digest();
  const given = b64urlDecode(sig);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const data = JSON.parse(b64urlDecode(payload).toString("utf8")) as SignedRequest;
    if (String(data.algorithm).toUpperCase() !== "HMAC-SHA256" || !data.user_id) return null;
    return { ...data, user_id: String(data.user_id) };
  } catch {
    return null;
  }
}

/** The app secrets that may have signed a request, with the platforms their users connect. */
export function metaSecrets(s: Settings): Array<{ secret: string; platforms: Platform[]; label: string }> {
  return [
    { secret: s.meta_app_secret.trim(), platforms: ["facebook", "instagram"] as Platform[], label: "facebook" },
    { secret: s.instagram_app_secret.trim(), platforms: ["instagram_login"] as Platform[], label: "instagram_login" },
    { secret: s.threads_app_secret.trim(), platforms: ["threads"] as Platform[], label: "threads" },
  ].filter((x) => x.secret);
}

/** Channels connected by the person a signed_request is about (by account id or Meta user id). */
async function channelsOf(userId: string, platforms: Platform[], connectedOnly = false) {
  const db = await getDb();
  let q = db
    .selectFrom("channels")
    .select(["id", "workspace_id", "external_id", "meta"])
    .where("platform", "in", platforms)
    .where((eb) => eb.or([eb("external_id", "=", userId), eb("meta", "like", `%"metaUserId":"${userId}"%`)]));
  if (connectedOnly) q = q.where("status", "!=", "disconnected");
  return q.execute();
}

/**
 * Meta's deauthorize ("uninstall") callback: the person removed the app, so its tokens stopped
 * working. Their channels are disconnected (scheduled posts cancelled, quota given back); the
 * profile data stays until a data deletion request. Returns the number of channels.
 */
export async function handleDeauthorize(request: SignedRequest, platforms: Platform[]): Promise<number> {
  const userId = request.user_id.replace(/[^0-9A-Za-z-]/g, "").slice(0, 100);
  const rows = await channelsOf(userId, platforms, true);
  for (const row of rows) await disconnectChannel({ id: row.id, workspaceId: row.workspace_id });
  return rows.length;
}

/** Removes the data of the channels the person connected; returns the confirmation code. */
export async function handleDeletion(request: SignedRequest, platforms: Platform[], label: string): Promise<{ code: string; deleted: number }> {
  const db = await getDb();
  const userId = request.user_id.replace(/[^0-9A-Za-z-]/g, "").slice(0, 100);
  const code = crypto.randomBytes(10).toString("hex");
  await db.insertInto("data_deletion_requests").values({ code, platform: label, external_user_id: userId, channels_deleted: 0, status: "received", created_at: now() }).execute();
  const rows = await channelsOf(userId, platforms);
  for (const row of rows) {
    await disconnectChannel({ id: row.id, workspaceId: row.workspace_id });
    await updateChannelProfile(row.id, { name: "Deleted account", handle: "", avatarUrl: "", profileUrl: "", meta: { deletedByRequest: code } });
  }
  await db.updateTable("data_deletion_requests").set({ channels_deleted: rows.length, status: "completed", completed_at: now() }).where("code", "=", code).execute();
  return { code, deleted: rows.length };
}

export async function getDeletionRequest(code: string) {
  if (!/^[a-f0-9]{20}$/.test(code)) return undefined;
  const db = await getDb();
  return db.selectFrom("data_deletion_requests").selectAll().where("code", "=", code).executeTakeFirst();
}
