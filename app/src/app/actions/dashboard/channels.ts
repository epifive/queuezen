"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { disconnectChannel, getChannel, getDriverChannel, setChannelStatus, updateChannelProfile, updateChannelSettings } from "@/lib/channels";
import { guardWorkspace } from "@/lib/dashboard";
import { getT } from "@/lib/i18n/server";
import type { MessageKey } from "@/lib/i18n/messages";
import { getDriver } from "@/lib/platforms";
import { channelsPath, connectablePlatform, connectFailure, oauthCookieOptions, saveAccounts, saveOrPick, savedQuery, startConnect } from "@/lib/platforms/connect";
import { canRevoke } from "@/lib/platforms/extras";
import { deleteConnectSession, ensureDrivers, ensureFreshChannel, getConnectSession, getDriverContext } from "@/lib/platforms/runtime";
import { rateLimit } from "@/lib/rate-limit";
import { platformName } from "@/social/format";
import { DEFAULT_UTM, normalizeUtm } from "@/social/normalize";
import type { FormState } from "../types";
import { idOf, str } from "./helpers";

/**
 * Channels of a workspace (Workspace → Channels): connect forms (Bluesky, Telegram, Discord,
 * Mastodon server), the account picker, test connection, per-channel settings and disconnect.
 * OAuth connects go through /api/oauth/<platform>/start. Managing channels needs channels.manage.
 */

async function isHttps(): Promise<boolean> {
  const h = await headers();
  return h.get("x-forwarded-proto") === "https" || (h.get("origin") ?? "").startsWith("https://");
}

/** Submits a connect form: either finishes the connection or (Mastodon) continues to the server's consent screen. */
export async function connectFormAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const guard = await guardWorkspace(formData.get("wid"), { capability: "channels.manage" });
  if (!guard.ok) return { error: guard.error };
  const t = await getT();
  const platform = connectablePlatform(str(formData.get("platform")));
  if (!platform) return { error: t("dash.channels.err.platform") };
  if (!rateLimit(`connect-form:${guard.user.id}`, 30, 60 * 60_000)) return { error: t("dash.channels.err.rate") };
  const form: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (typeof value === "string" && !["wid", "platform", "channel_id"].includes(key) && !key.startsWith("$")) form[key] = value.trim().slice(0, 2000);
  }
  const reconnect = str(formData.get("channel_id")) !== "";
  const started = await startConnect({ userId: guard.user.id, workspace: guard.workspace, platform, form, entitlements: guard.entitlements, reconnect });
  if (started.kind === "error") return { error: errorText(t, started.code, started.message) };
  if (started.kind === "redirect") {
    (await cookies()).set(started.cookie.name, started.cookie.value, oauthCookieOptions(await isHttps()));
    redirect(started.url);
  }
  const driver = getDriver(platform);
  if (!driver) return { error: t("dash.channels.err.platform") };
  let target = "";
  try {
    const accounts = await driver.connectFinish(await getDriverContext(platform), { workspaceId: guard.workspace.id, userId: guard.user.id, query: {}, codeVerifier: "", form, carry: {} });
    const result = await saveOrPick({ userId: guard.user.id, workspace: guard.workspace, platform, accounts, entitlements: guard.entitlements });
    if (result.kind === "error") return { error: errorText(t, result.code, result.message) };
    if (result.kind === "pick") target = `/dashboard/w/${guard.workspace.id}/channels/pick?s=${encodeURIComponent(result.token)}`;
    else {
      if (!result.added && !result.updated && result.limit) return { error: t("dash.channels.err.limit") };
      target = channelsPath(guard.workspace.id, savedQuery(platform, result));
    }
  } catch (error) {
    const f = connectFailure(error);
    return { error: errorText(t, f.code, f.message) };
  }
  redirect(target);
}

function errorText(t: Awaited<ReturnType<typeof getT>>, code: string, detail?: string): string {
  const base = t(`dash.channels.err.${code}` as MessageKey);
  return detail ? `${base} ${detail}` : base;
}

/** Adds the accounts ticked in the picker. */
export async function pickAccountsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const guard = await guardWorkspace(formData.get("wid"), { capability: "channels.manage" });
  if (!guard.ok) return { error: guard.error };
  const t = await getT();
  const token = str(formData.get("s"));
  const session = await getConnectSession(token, guard.user.id, guard.workspace.id);
  if (!session) return { error: t("dash.channels.err.expired") };
  const wanted = new Set(formData.getAll("account").map(String));
  const accounts = session.accounts.filter((a) => wanted.has(a.externalId));
  if (!accounts.length) return { error: t("dash.channels.pick.none") };
  const result = await saveAccounts({ userId: guard.user.id, workspace: guard.workspace, platform: session.platform, accounts, entitlements: guard.entitlements });
  await deleteConnectSession(token);
  redirect(channelsPath(guard.workspace.id, savedQuery(session.platform, result)));
}

/** Test connection: a cheap authenticated call; refreshes the profile, or marks the channel. */
export async function testChannelAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const guard = await guardWorkspace(formData.get("wid"), { capability: "channels.manage", allowInDemo: true });
  if (!guard.ok) return { error: guard.error };
  const t = await getT();
  const record = await getChannel(guard.workspace.id, idOf(formData.get("channel_id")));
  if (!record || record.status === "disconnected") return { error: t("dash.channels.err.notFound") };
  if (!rateLimit(`channel-test:${guard.user.id}`, 30, 10 * 60_000)) return { error: t("dash.channels.err.rate") };
  await ensureDrivers();
  const driver = getDriver(record.platform);
  let channel = await getDriverChannel(record.id);
  if (!driver || !channel) return { error: t("dash.channels.err.platform") };
  try {
    channel = await ensureFreshChannel(channel);
  } catch (error) {
    return { error: t("dash.channels.test.failed", { error: error instanceof Error ? error.message : String(error) }) };
  }
  const res = await driver.testConnection(await getDriverContext(record.platform), channel);
  if (!res.ok) {
    const err = res.error;
    await setChannelStatus(record.id, err.kind === "auth" && !err.retryable ? "expired" : "error", err.message);
    return { error: t("dash.channels.test.failed", { error: err.message }) };
  }
  if (res.account) {
    const a = res.account;
    await updateChannelProfile(record.id, {
      ...(a.name ? { name: a.name } : {}),
      ...(a.handle ? { handle: a.handle } : {}),
      ...(a.avatarUrl ? { avatarUrl: a.avatarUrl } : {}),
      ...(a.profileUrl ? { profileUrl: a.profileUrl } : {}),
      ...(a.meta ? { meta: { ...record.meta, ...a.meta } } : {}),
    });
  }
  await setChannelStatus(record.id, "active");
  return { success: t("dash.channels.test.ok", { platform: platformName(record.platform) }) };
}

/** Disconnect: revokes the token at the network where it can (best effort), then removes the credentials. */
export async function disconnectChannelAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const guard = await guardWorkspace(formData.get("wid"), { capability: "channels.manage" });
  if (!guard.ok) return { error: guard.error };
  const t = await getT();
  const record = await getChannel(guard.workspace.id, idOf(formData.get("channel_id")));
  if (!record || record.status === "disconnected") return { error: t("dash.channels.err.notFound") };
  await ensureDrivers();
  const driver = getDriver(record.platform);
  const channel = await getDriverChannel(record.id);
  let revoked = false;
  if (driver && channel && canRevoke(driver)) {
    revoked = await driver.revoke(await getDriverContext(record.platform), channel).catch(() => false);
  }
  await disconnectChannel(record);
  return { success: revoked ? t("dash.channels.disconnect.revoked") : t("dash.channels.disconnect.done") };
}

/** Per-channel defaults for new posts: first comment, hashtags and the UTM tags of its links. */
export async function saveChannelSettingsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const guard = await guardWorkspace(formData.get("wid"), { capability: "channels.manage" });
  if (!guard.ok) return { error: guard.error };
  const t = await getT();
  const record = await getChannel(guard.workspace.id, idOf(formData.get("channel_id")));
  if (!record || record.status === "disconnected") return { error: t("dash.channels.err.notFound") };
  const firstComment = str(formData.get("defaultFirstComment")).trim();
  const hashtags = str(formData.get("hashtags")).trim();
  if (firstComment.length > 2000 || hashtags.length > 1000) return { error: t("dash.channels.settings.tooLong") };
  // UTM tags: the workspace's (null), the channel's own, or none (disabled).
  const mode = str(formData.get("utm_mode"));
  const utm =
    mode === "custom" || mode === "off"
      ? normalizeUtm({ enabled: mode === "custom", source: str(formData.get("utm_source")).trim() || DEFAULT_UTM.source, medium: str(formData.get("utm_medium")).trim() || DEFAULT_UTM.medium, campaign: str(formData.get("utm_campaign")).trim() })
      : mode === "workspace"
        ? null
        : record.settings.utm;
  await updateChannelSettings(record, { ...record.settings, defaultFirstComment: firstComment, hashtags, utm });
  return { success: t("dash.channels.settings.saved") };
}
