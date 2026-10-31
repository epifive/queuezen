import "server-only";
import { channelQuota, saveConnectedAccount } from "@/lib/channels";
import { isDemoMode } from "@/lib/config";
import { createOAuthState, createPkcePair, OAUTH_COOKIE, OAUTH_STATE_TTL_MS, sealOAuthCookie } from "@/lib/oauth-state";
import type { Entitlements } from "@/lib/plans";
import { getSettings } from "@/lib/settings";
import { getWorkspaceEntitlements, type WorkspaceRecord } from "@/lib/workspaces";
import { isPlatform } from "@/social/normalize";
import { DriverError, V1_PLATFORMS, type ConnectedAccount, type ConnectField, type Platform } from "@/social/types";
import { getDriver } from "./index";
import { createConnectSession, ensureDrivers, getDriverContext, isPlatformConfigured } from "./runtime";

/**
 * The connect flow shared by the OAuth routes (/api/oauth/<platform>/start|callback|simulate),
 * the connect forms (Bluesky, Telegram, Discord, Mastodon server) and the account picker.
 *
 * Error codes (shown translated on the Channels page as dash.channels.err.<code>):
 *   platform, demo, config, limit, rate, state, denied, connect, empty, expired
 */

export type ConnectErrorCode = "platform" | "demo" | "config" | "limit" | "rate" | "state" | "denied" | "connect" | "empty" | "expired";

export const OAUTH_COOKIE_PATH = "/api/oauth";

export function oauthCookieOptions(secure: boolean, maxAgeSec = Math.floor(OAUTH_STATE_TTL_MS / 1000)) {
  return { httpOnly: true, sameSite: "lax" as const, secure, path: OAUTH_COOKIE_PATH, maxAge: maxAgeSec };
}

/** The signed-in user's workspace when they may manage its channels (null otherwise). */
export async function channelManager(userId: number, workspaceId: number): Promise<WorkspaceRecord | null> {
  const { getMembership } = await import("@/lib/workspaces");
  const { roleCan } = await import("@/social/normalize");
  const m = Number.isInteger(workspaceId) && workspaceId > 0 ? await getMembership(workspaceId, userId) : undefined;
  return m && roleCan(m.role, "channels.manage") ? m.workspace : null;
}

export function channelsPath(workspaceId: number, query = ""): string {
  return `/dashboard/w/${workspaceId}/channels${query ? `?${query}` : ""}`;
}

/** The platform from a route segment / form value, if users can connect it. */
export function connectablePlatform(value: unknown): Platform | null {
  return isPlatform(value) && V1_PLATFORMS.includes(value) ? value : null;
}

export type StartResult =
  | { kind: "redirect"; url: string; cookie: { name: string; value: string } }
  | { kind: "form"; fields: ConnectField[] }
  | { kind: "error"; code: ConnectErrorCode; message?: string };

/**
 * Begins connecting `platform` to the workspace: checks demo mode, the operator's app and the
 * plan's channel limit, then asks the driver for its consent URL (with a signed state and the
 * PKCE verifier sealed in the OAuth cookie) or its form fields.
 */
export async function startConnect(input: {
  userId: number;
  workspace: WorkspaceRecord;
  platform: Platform;
  form?: Record<string, string>;
  entitlements?: Entitlements;
  /** Reconnecting an existing channel doesn't need a free slot. */
  reconnect?: boolean;
}): Promise<StartResult> {
  if (isDemoMode()) return { kind: "error", code: "demo" };
  const simulated = await ensureDrivers();
  const settings = await getSettings();
  if (!isPlatformConfigured(input.platform, settings, simulated)) return { kind: "error", code: "config" };
  const driver = getDriver(input.platform);
  if (!driver) return { kind: "error", code: "platform" };
  if (!input.reconnect) {
    const entitlements = input.entitlements ?? (await getWorkspaceEntitlements(input.workspace));
    if ((await channelQuota(input.workspace.ownerId, entitlements)).full) return { kind: "error", code: "limit" };
  }
  const { state, nonce } = await createOAuthState({ userId: input.userId, workspaceId: input.workspace.id, platform: input.platform });
  const pkce = createPkcePair();
  try {
    const result = await driver.connectStart(await getDriverContext(input.platform), {
      workspaceId: input.workspace.id,
      userId: input.userId,
      state,
      codeVerifier: pkce.verifier,
      form: input.form ?? {},
    });
    if (result.kind === "form") return result;
    const value = await sealOAuthCookie({ nonce, codeVerifier: pkce.verifier, carry: result.carry ?? {} });
    return { kind: "redirect", url: result.url, cookie: { name: OAUTH_COOKIE, value } };
  } catch (error) {
    return { kind: "error", code: "connect", message: error instanceof Error ? error.message : String(error) };
  }
}

export type SaveResult = { kind: "saved"; added: number; updated: number; limit: boolean } | { kind: "pick"; token: string } | { kind: "error"; code: ConnectErrorCode; message?: string };

/**
 * Saves what connectFinish returned: one account is added right away; several (Facebook Pages,
 * Instagram accounts, simulated) go to the picker, unless every one of them is already connected
 * (a reconnect), in which case they are all refreshed.
 */
export async function saveOrPick(input: { userId: number; workspace: WorkspaceRecord; platform: Platform; accounts: ConnectedAccount[]; entitlements?: Entitlements }): Promise<SaveResult> {
  const { accounts } = input;
  if (!accounts.length) return { kind: "error", code: "empty" };
  if (accounts.length > 1) {
    const { getWorkspaceChannels } = await import("@/lib/channels");
    const existing = new Set((await getWorkspaceChannels(input.workspace.id)).filter((c) => c.platform === input.platform).map((c) => c.externalId));
    if (!accounts.every((a) => existing.has(a.externalId))) {
      return { kind: "pick", token: await createConnectSession({ userId: input.userId, workspaceId: input.workspace.id, platform: input.platform, accounts }) };
    }
  }
  return saveAccounts(input);
}

export async function saveAccounts(input: { userId: number; workspace: WorkspaceRecord; platform: Platform; accounts: ConnectedAccount[]; entitlements?: Entitlements }): Promise<SaveResult & { kind: "saved" }> {
  const entitlements = input.entitlements ?? (await getWorkspaceEntitlements(input.workspace));
  let added = 0;
  let updated = 0;
  let limit = false;
  for (const account of input.accounts) {
    const res = await saveConnectedAccount({ id: input.workspace.id, ownerId: input.workspace.ownerId, settings: input.workspace.settings }, input.platform, account, { connectedBy: input.userId, entitlements });
    if (!res.ok) {
      limit = true;
      continue;
    }
    if (res.created) added += 1;
    else updated += 1;
  }
  return { kind: "saved", added, updated, limit };
}

/** Query string for the Channels page after a connect. */
export function savedQuery(platform: Platform, res: SaveResult & { kind: "saved" }): string {
  const q = new URLSearchParams({ connected: platform, added: String(res.added), updated: String(res.updated) });
  if (res.limit) q.set("error", "limit");
  return q.toString();
}

export function errorQuery(code: ConnectErrorCode, message?: string): string {
  const q = new URLSearchParams({ error: code });
  if (message) q.set("detail", message.slice(0, 300));
  return q.toString();
}

/** Message of a connect failure for the page (auth cancellations become "denied"). */
export function connectFailure(error: unknown): { code: ConnectErrorCode; message?: string } {
  if (error instanceof DriverError) {
    if (error.kind === "auth" && /cancel|access_denied|denied/i.test(`${error.code} ${error.message}`)) return { code: "denied" };
    return { code: "connect", message: error.message };
  }
  return { code: "connect", message: error instanceof Error ? error.message : String(error) };
}

