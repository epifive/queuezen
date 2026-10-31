import "server-only";
import crypto from "node:crypto";
import { getDriverChannel, setChannelStatus } from "@/lib/channels";
import { getDb, now } from "@/lib/db";
import type { PostTargetRow } from "@/lib/db/schema";
import { mediaAssetsFor } from "@/lib/media/service";
import { buildNotifyPayload, notifyWorkspace, workspaceDashboardPath } from "@/lib/notify";
import { PENDING_CODE, usageOf, xPostCostMicros } from "@/lib/platforms/extras";
import { refreshPostStatus } from "@/lib/posts";
import { shortenLinksInText, shortenUrl, shortLinkUrl } from "@/lib/shortlinks";
import { bannedOwnerWorkspaceIds, getWorkspace, type WorkspaceRecord } from "@/lib/workspaces";
import { getCapabilities } from "@/social/platforms";
import { applyUtmToText, buildUtmUrl, countChars, extractUrls, isPlatform, MAX_PUBLISH_ATTEMPTS, mergeContent, normalizeOverride, normalizePostContent, parseJson, retryDelayMs, textLimitFor } from "@/social/normalize";
import { DriverError, IN_FLIGHT_TARGET_STATUSES, type Platform, type PostContent, type PublishResult, type UploadState, type UtmSettings } from "@/social/types";
import { bumpPlatformUsage, driverContext, driverFor, freshChannel, recordUsage } from "./context";

/**
 * The publishing engine (job "publish", first in the scheduler's list; also "Post now").
 *
 * 1. Claim. Due targets (status "scheduled", next_attempt_at <= now, channel not paused) are
 *    claimed one by one with a conditional UPDATE … WHERE id = ? AND status = 'scheduled', which
 *    sets a random lease_token and lease_until = now + 3 min and counts the attempt. Two ticks, a
 *    cron call and a "Post now" request racing for the same row can't both win: only one UPDATE
 *    matches. Targets whose lease expired while in flight (a crashed or timed-out run) are
 *    reclaimed the same way (conditional on the old token) and marked "resumed".
 * 2. Publish. The driver gets the channel (decrypted credentials), the effective content (base +
 *    override, UTM, short links) and the media as MediaAssets. Every saveState() is persisted to
 *    upload_state (container_id too) BEFORE the driver's next irreversible step, guarded by the
 *    lease token, and renews the lease; a heartbeat renews it during long uploads.
 * 3. Idempotency. Before any retry or resumed run, driver.findExisting() looks for the post the
 *    earlier attempt may have created (X, LinkedIn and Facebook Reels have no idempotency key);
 *    when found, the target is marked published without posting again. When the check itself
 *    fails (on any network), the target waits 2 min and checks again; after the third failed
 *    check it is published, flagged as a possible duplicate.
 * 4. Outcome. Success → published (external id, permalink, time, usage meters). Retryable errors
 *    → back to "scheduled" with next_attempt_at = now + 1 / 5 / 15 / 60 min (or Retry-After),
 *    until MAX_PUBLISH_ATTEMPTS. Auth errors → target and channel need a reconnect. Anything
 *    else → failed with the platform's reason. Each attempt is logged in post_attempts; the post's
 *    status is recomputed and post_failed / post_published notifications go out.
 * Per-tick and per-account limits (capabilities.limits.perAccount, e.g. Instagram 100 / 24 h)
 * defer targets instead of failing them.
 */

export const LEASE_MS = 3 * 60_000;
/** Targets of one channel handled per run (bursts are spread over ticks). */
const PER_CHANNEL_PER_RUN = 3;
/** Targets claimed per batch. */
const BATCH = 8;
/** Channels published in parallel. */
const PARALLEL = 4;
/** Don't claim another batch with less time than this left in the budget. */
const MIN_TIME_LEFT_MS = 1_500;
/** A platform may keep a target "pending" (processing) for at most this long. */
const MAX_PENDING_MS = 24 * 3600_000;

const ENGINE_KEY = "_engine";

interface EngineMeta {
  firstAttemptAt?: string;
  pendingSince?: string;
  /** findExisting() calls that failed (a retry waits for a working check). */
  failedChecks?: number;
}

/** Failed duplicate checks before publishing anyway (the target is flagged as a possible duplicate). */
const MAX_FAILED_CHECKS = 3;
/** Wait between two duplicate checks. */
const CHECK_RETRY_MS = 2 * 60_000;
const POSSIBLE_DUPLICATE = "Queuezen couldn't check whether an earlier attempt had already published this post, so it may appear twice on the network.";

class LeaseLost extends Error {
  constructor() {
    super("The lease of this publication was taken over by another run.");
  }
}

export interface ClaimedTarget {
  row: PostTargetRow;
  token: string;
  /** Reclaimed after its lease expired mid-flight: the platform may already have the post. */
  resumed: boolean;
}

export interface EngineRunSummary {
  claimed: number;
  published: number;
  retried: number;
  failed: number;
  deferred: number;
}

const iso = (ms: number) => new Date(ms).toISOString();
const newToken = () => crypto.randomBytes(16).toString("hex");

// ── Claiming ──

async function pausedChannelIds(): Promise<number[]> {
  const db = await getDb();
  const rows = await db.selectFrom("channels").select("id").where((eb) => eb.or([eb("queue_paused", "=", 1), eb("status", "=", "disconnected")])).execute();
  return rows.map((r) => r.id);
}

/**
 * Claims up to `limit` targets: first those whose lease expired mid-flight, then due ones.
 * `onlyIds` restricts the claim (Post now). `perChannel` counts targets already taken this run.
 */
export async function claimTargets(limit: number, options: { onlyIds?: number[]; perChannel?: Map<number, number> } = {}): Promise<ClaimedTarget[]> {
  const db = await getDb();
  const perChannel = options.perChannel ?? new Map<number, number>();
  const nowIso = now();
  const paused = await pausedChannelIds();
  const banned = await bannedOwnerWorkspaceIds();
  const claimed: ClaimedTarget[] = [];
  const room = (channelId: number) => (perChannel.get(channelId) ?? 0) < PER_CHANNEL_PER_RUN;
  const take = (row: PostTargetRow) => perChannel.set(row.channel_id, (perChannel.get(row.channel_id) ?? 0) + 1);

  // 1. Expired leases of in-flight targets.
  let stale = db
    .selectFrom("post_targets")
    .selectAll()
    .where("status", "in", [...IN_FLIGHT_TARGET_STATUSES])
    .where("lease_until", "<", nowIso)
    .orderBy("lease_until")
    .limit(limit);
  if (options.onlyIds?.length) stale = stale.where("id", "in", options.onlyIds);
  if (banned.length) stale = stale.where("workspace_id", "not in", banned);
  for (const row of await stale.execute()) {
    if (claimed.length >= limit || !room(row.channel_id)) continue;
    const token = newToken();
    const res = await db
      .updateTable("post_targets")
      .set({ lease_token: token, lease_until: iso(Date.now() + LEASE_MS), status: "claimed", attempts: row.attempts + 1, updated_at: now() })
      .where("id", "=", row.id)
      .where("status", "in", [...IN_FLIGHT_TARGET_STATUSES])
      .where("lease_until", "<", nowIso)
      .where((eb) => (row.lease_token === null ? eb("lease_token", "is", null) : eb("lease_token", "=", row.lease_token)))
      .executeTakeFirst();
    if (Number(res.numUpdatedRows) === 1) {
      take(row);
      claimed.push({ row: { ...row, status: "claimed", lease_token: token, attempts: row.attempts + 1 }, token, resumed: true });
    }
  }

  // 2. Due targets.
  if (claimed.length < limit) {
    let due = db
      .selectFrom("post_targets")
      .selectAll()
      .where("status", "=", "scheduled")
      .where("next_attempt_at", "<=", nowIso)
      .orderBy("next_attempt_at")
      .orderBy("id")
      .limit(limit * 3);
    if (paused.length) due = due.where("channel_id", "not in", paused);
    // Owners banned by the admin: their posts wait (nothing is published while the ban lasts).
    if (banned.length) due = due.where("workspace_id", "not in", banned);
    if (options.onlyIds?.length) due = due.where("id", "in", options.onlyIds);
    for (const row of await due.execute()) {
      if (claimed.length >= limit) break;
      if (!room(row.channel_id)) continue;
      const token = newToken();
      const res = await db
        .updateTable("post_targets")
        .set({ status: "claimed", lease_token: token, lease_until: iso(Date.now() + LEASE_MS), attempts: row.attempts + 1, updated_at: now() })
        .where("id", "=", row.id)
        .where("status", "=", "scheduled")
        .where("next_attempt_at", "<=", nowIso)
        .executeTakeFirst();
      if (Number(res.numUpdatedRows) === 1) {
        take(row);
        claimed.push({ row: { ...row, status: "claimed", lease_token: token, attempts: row.attempts + 1 }, token, resumed: false });
      }
    }
  }
  return claimed;
}

// ── Lease-guarded writes ──

async function guardedUpdate(targetId: number, token: string, values: Partial<Omit<PostTargetRow, "id">>): Promise<void> {
  const db = await getDb();
  const res = await db
    .updateTable("post_targets")
    .set({ ...values, updated_at: now() })
    .where("id", "=", targetId)
    .where("lease_token", "=", token)
    .executeTakeFirst();
  if (Number(res.numUpdatedRows) > 0) return;
  // MySQL counts changed rows only: make sure we really lost the lease.
  const row = await db.selectFrom("post_targets").select("lease_token").where("id", "=", targetId).executeTakeFirst();
  if (row?.lease_token !== token) throw new LeaseLost();
}

async function renewLease(targetId: number, token: string): Promise<void> {
  await guardedUpdate(targetId, token, { lease_until: iso(Date.now() + LEASE_MS) });
}

async function logAttempt(row: PostTargetRow, outcome: string, startedMs: number, error?: { message: string; kind: string | null }): Promise<void> {
  try {
    const db = await getDb();
    await db
      .insertInto("post_attempts")
      .values({
        target_id: row.id,
        post_id: row.post_id,
        workspace_id: row.workspace_id,
        channel_id: row.channel_id,
        attempt: row.attempts,
        outcome,
        error: error ? error.message.slice(0, 1000) : null,
        error_kind: error?.kind ?? null,
        started_at: iso(startedMs),
        duration_ms: Math.max(0, Date.now() - startedMs),
      })
      .execute();
  } catch (e) {
    console.error("[queuezen] attempt log failed:", e);
  }
}

// ── Content for a channel ──

/**
 * The effective content of a target: base + override, UTM parameters and tracked short links.
 * A part (text, thread part, first comment) that the added UTM tags or short links would push
 * over the network's limit keeps its original links instead; `note` then says so.
 */
export async function effectiveContent(
  workspace: WorkspaceRecord,
  row: Pick<PostTargetRow, "post_id" | "channel_id" | "override">,
  base: PostContent,
  platform: Platform,
  channelUtm: UtmSettings | null,
): Promise<{ content: PostContent; note: string | null }> {
  const content = mergeContent(base, normalizeOverride(parseJson(row.override)));
  const utm = channelUtm ?? workspace.settings.utm;
  // Links already shortened in the composer (/l/<code>) carry their own UTM tags: left alone.
  const own = await shortLinkUrl("");
  const isOwn = (url: string) => url.startsWith(own);
  const tag = (text: string) => (utm.enabled ? applyUtmToText(text, utm, platform, isOwn) : text);
  let out: PostContent = {
    ...content,
    text: tag(content.text),
    firstComment: tag(content.firstComment),
    thread: content.thread.map(tag),
    link: content.link && utm.enabled && !isOwn(content.link) ? buildUtmUrl(content.link, utm, { platform }) : content.link,
  };
  if (workspace.settings.shortenLinks) {
    const opts = { postId: row.post_id, channelId: row.channel_id, platform };
    const shorten = async (text: string) => (extractUrls(text).length ? shortenLinksInText(workspace.id, text, null, opts) : text);
    out = {
      ...out,
      text: await shorten(out.text),
      firstComment: await shorten(out.firstComment),
      thread: await Promise.all(out.thread.map(shorten)),
      link: out.link && !isOwn(out.link) ? (await shortenUrl(workspace.id, out.link, null, opts)).shortUrl : out.link,
    };
  }
  // Too long with the rewritten links: fall back to the original links (when that fits).
  const kept: string[] = [];
  const fit = (final: string, original: string, limit: number, label: string) => {
    if (final === original || countChars(final, platform) <= limit || countChars(original, platform) > limit) return final;
    kept.push(label);
    return original;
  };
  const max = getCapabilities(platform).text.max;
  out = {
    ...out,
    text: fit(out.text, content.text, textLimitFor(platform, content.mediaIds.length > 0), "text"),
    thread: out.thread.map((part, i) => fit(part, content.thread[i] ?? part, max, `thread part ${i + 2}`)),
    firstComment: fit(out.firstComment, content.firstComment, max, "first comment"),
  };
  const note = kept.length
    ? `With UTM tags or short links the ${kept.join(", ")} would have been longer than ${getCapabilities(platform).name} allows, so it was posted with the original links.`
    : null;
  return { content: out, note };
}

// ── Publishing one target ──

type Outcome = "published" | "found_existing" | "retry" | "failed" | "needs_reauth" | "deferred" | "pending" | "lost";

function engineMeta(state: UploadState): EngineMeta {
  const meta = state[ENGINE_KEY];
  return meta && typeof meta === "object" ? (meta as EngineMeta) : {};
}

function excerpt(text: string, max = 120): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean || "(no text)";
}

/** Count of this channel's posts published in the last `hours`. */
async function publishedSince(channelId: number, hours: number): Promise<{ count: number; oldest: string | null }> {
  const db = await getDb();
  const rows = await db
    .selectFrom("post_targets")
    .select("published_at")
    .where("channel_id", "=", channelId)
    .where("status", "=", "published")
    .where("published_at", ">=", iso(Date.now() - hours * 3600_000))
    .orderBy("published_at")
    .execute();
  return { count: rows.length, oldest: rows[0]?.published_at ?? null };
}

async function publishOne(claim: ClaimedTarget): Promise<Outcome> {
  const { row, token } = claim;
  const started = Date.now();
  const db = await getDb();
  let state: UploadState = (() => {
    const v = parseJson(row.upload_state);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as UploadState) : {};
  })();
  const meta = engineMeta(state);
  if (!meta.firstAttemptAt) {
    meta.firstAttemptAt = iso(started);
    state = { ...state, [ENGINE_KEY]: meta };
  }
  const platform: Platform | null = isPlatform(row.platform) ? row.platform : null;

  const finish = async (outcome: Outcome, values: Partial<Omit<PostTargetRow, "id">>, error?: { message: string; kind: string | null }) => {
    state = { ...state, [ENGINE_KEY]: { ...engineMeta(state), ...meta } };
    await guardedUpdate(row.id, token, { ...values, upload_state: JSON.stringify(state), lease_token: null, lease_until: null });
    await logAttempt(row, outcome, started, error);
    return outcome;
  };
  // Filled in as the checks below pass (the failure handler reports with what is known).
  const known: { workspace?: WorkspaceRecord; channelName: string } = { channelName: `#${row.channel_id}` };
  /** Terminal failure: the target fails, the post's status is recomputed, post_failed goes out. */
  const fail = async (message: string, kind: string | null, status: "failed" | "needs_reauth" = "failed") => {
    const outcome = await finish(status === "needs_reauth" ? "needs_reauth" : "failed", { status, error: message.slice(0, 1000), error_kind: kind, next_attempt_at: null }, { message, kind });
    if (known.workspace && platform) await afterTarget(known.workspace, row, known.channelName, platform, "failed", message);
    else await refreshPostStatus(row.post_id).catch(() => null);
    return outcome;
  };

  const post = await db.selectFrom("posts").selectAll().where("id", "=", row.post_id).executeTakeFirst();
  if (!post) return finish("failed", { status: "cancelled", next_attempt_at: null }, { message: "The post was deleted.", kind: null });
  if (post.status === "draft" || post.status === "pending_approval") {
    // The post was taken back meanwhile: release the target without publishing.
    return finish("deferred", { status: "pending", next_attempt_at: null, attempts: Math.max(0, row.attempts - 1) });
  }
  if (!platform) return fail(`Unknown network "${row.platform}".`, "validation");
  const workspace = await getWorkspace(row.workspace_id);
  if (!workspace) return fail("The workspace no longer exists.", null);
  known.workspace = workspace;

  const channelRow = await db.selectFrom("channels").select(["status", "name"]).where("id", "=", row.channel_id).executeTakeFirst();
  const channel = await getDriverChannel(row.channel_id);
  if (!channel || !channelRow) {
    const outcome = await finish("failed", { status: "cancelled", next_attempt_at: null, error: "The channel was disconnected.", error_kind: null }, { message: "The channel was disconnected.", kind: null });
    await refreshPostStatus(row.post_id).catch(() => null);
    return outcome;
  }
  known.channelName = channel.name;
  const channelName = channel.name;
  if (channelRow.status === "expired") return fail(`${channel.name} needs to be reconnected.`, "auth", "needs_reauth");

  const driver = await driverFor(platform);
  if (!driver) return fail(`Publishing to ${getCapabilities(platform).name} isn't set up on this site.`, "validation");

  // Per-account publishing limits (e.g. Instagram 100 per 24 h): wait instead of failing.
  for (const limit of getCapabilities(platform).limits.perAccount) {
    const used = await publishedSince(row.channel_id, limit.windowHours);
    if (used.count >= limit.count) {
      const until = used.oldest ? Date.parse(used.oldest) + limit.windowHours * 3600_000 + 60_000 : Date.now() + 15 * 60_000;
      const message = `${getCapabilities(platform).name} allows ${limit.count} posts per ${limit.windowHours >= 1 ? `${limit.windowHours} h` : `${Math.round(limit.windowHours * 60)} min`}: waiting for the limit to reset.`;
      return finish("deferred", { status: "scheduled", next_attempt_at: iso(Math.max(until, Date.now() + 60_000)), attempts: Math.max(0, row.attempts - 1), error: message, error_kind: "rate_limit" }, { message, kind: "rate_limit" });
    }
  }

  // Move the post into "publishing" when its first target starts.
  if (post.status === "scheduled" || post.status === "approved" || post.status === "failed" || post.status === "partially_failed") {
    await db.updateTable("posts").set({ status: "publishing", updated_at: now() }).where("id", "=", post.id).where("status", "=", post.status).execute();
  }

  const base = normalizePostContent(parseJson(post.content));
  const { content, note: linkNote } = await effectiveContent(workspace, row, base, platform, channel.settings.utm);
  const media = await mediaAssetsFor(row.workspace_id, content.mediaIds);
  if (media.length < content.mediaIds.length) return fail("An attached image or video was deleted from the media library.", "media");

  const ctx = await driverContext(platform);
  // Tokens expiring within 10 minutes are refreshed first (an auth failure marks the channel expired).
  let liveChannel = channel;
  try {
    liveChannel = await freshChannel(channel);
  } catch (error) {
    return handleFailure(claim, platform, meta, started, error, finish, fail);
  }

  // Idempotency: a retry or a resumed run first looks for the post an earlier attempt created.
  let possibleDuplicate = false;
  if (claim.resumed || row.attempts > 1) {
    try {
      const found = await driver.findExisting(ctx, { channel: liveChannel, content, uploadState: state, since: meta.firstAttemptAt ?? iso(started) });
      if (found) {
        const outcome = await finish("found_existing", { status: "published", external_id: found.externalId.slice(0, 190), permalink: found.permalink.slice(0, 1000) || null, published_at: now(), error: null, error_kind: null, next_attempt_at: null });
        await afterTarget(workspace, row, channelName, platform, "published");
        return outcome;
      }
    } catch (error) {
      if (error instanceof LeaseLost) return "lost";
      console.warn(`[queuezen] findExisting failed for target ${row.id}:`, error instanceof Error ? error.message : error);
      // Can't tell: a blind retry could duplicate the post, so check again a little later; after
      // two retries publish anyway, flagged as a possible duplicate.
      meta.failedChecks = (meta.failedChecks ?? 0) + 1;
      if (meta.failedChecks < MAX_FAILED_CHECKS) {
        const message = "Couldn't check whether an earlier attempt already published this post. Checking again shortly.";
        return finish("retry", { status: "scheduled", next_attempt_at: iso(Date.now() + CHECK_RETRY_MS), error: message, error_kind: "network" }, { message, kind: "network" });
      }
      possibleDuplicate = true;
    }
  }

  await guardedUpdate(row.id, token, { status: "publishing", upload_state: JSON.stringify(state), lease_until: iso(Date.now() + LEASE_MS) });
  const heartbeat = setInterval(() => {
    renewLease(row.id, token).catch(() => undefined);
  }, LEASE_MS / 3);
  let result: PublishResult;
  try {
    result = await driver.publish(ctx, {
      channel: liveChannel,
      content,
      media,
      target: { id: row.id, postId: row.post_id, attempt: row.attempts, uploadState: state, idempotencyKey: `qz-${row.id}-${row.post_id}` },
      saveState: async (patch) => {
        state = { ...state, ...patch, [ENGINE_KEY]: { ...engineMeta(state), ...meta } };
        const container = patch.containerId ?? patch.container_id ?? patch.creationId;
        await guardedUpdate(row.id, token, {
          upload_state: JSON.stringify(state),
          status: container ? "container_created" : "uploading",
          ...(typeof container === "string" || typeof container === "number" ? { container_id: String(container).slice(0, 190) } : {}),
          lease_until: iso(Date.now() + LEASE_MS),
        });
      },
    });
  } catch (error) {
    clearInterval(heartbeat);
    if (error instanceof LeaseLost) return "lost";
    return handleFailure(claim, platform, meta, started, error, finish, fail);
  }
  clearInterval(heartbeat);

  // Success.
  // Metered once, on success: the driver's usage covers every attempt of this publication.
  const usage = usageOf(result);
  if (usage) await recordUsage(platform, usage);
  else {
    const caps = getCapabilities(platform);
    const withUrl = Boolean(content.link || extractUrls(content.text).length);
    const parts = 1 + (result.threadIds?.length ?? 0);
    await bumpPlatformUsage(platform, { posts: parts, uploads: platform === "youtube" ? 1 : 0, costMicros: caps.cost ? xPostCostMicros(withUrl, caps.cost) * parts : 0 });
  }
  const warnings = [...(result.warnings ?? []), ...(possibleDuplicate ? [POSSIBLE_DUPLICATE] : []), ...(linkNote ? [linkNote] : [])].filter(Boolean).join(" ");
  state = { ...state, published: { id: result.externalId, threadIds: result.threadIds ?? [], firstCommentId: result.firstCommentId ?? null } };
  const outcome = await finish("published", {
    status: "published",
    external_id: result.externalId.slice(0, 190),
    permalink: result.permalink ? result.permalink.slice(0, 1000) : null,
    published_at: result.publishedAt && Number.isFinite(Date.parse(result.publishedAt)) ? new Date(result.publishedAt).toISOString() : now(),
    error: warnings ? warnings.slice(0, 1000) : null,
    error_kind: null,
    next_attempt_at: null,
  }, warnings ? { message: warnings, kind: null } : undefined);
  await afterTarget(workspace, row, channelName, platform, "published");
  return outcome;
}

async function handleFailure(
  claim: ClaimedTarget,
  platform: Platform,
  meta: EngineMeta,
  started: number,
  error: unknown,
  finish: (outcome: Outcome, values: Partial<Omit<PostTargetRow, "id">>, error?: { message: string; kind: string | null }) => Promise<Outcome>,
  fail: (message: string, kind: string | null, status?: "failed" | "needs_reauth") => Promise<Outcome>,
): Promise<Outcome> {
  const { row } = claim;
  const err =
    error instanceof DriverError
      ? error
      : new DriverError(error instanceof Error ? error.message : "Publishing failed for an unknown reason.", "unknown", { retryable: true, platform, cause: error });
  if (!(error instanceof DriverError)) console.error(`[queuezen] publish of target ${row.id} threw:`, error);
  await bumpPlatformUsage(platform, { errors: 1 });

  // Still processing on the platform (video transcoding, container not ready): check back later.
  if (err.code === PENDING_CODE) {
    const since = meta.pendingSince ?? iso(started);
    meta.pendingSince = since;
    if (Date.now() - Date.parse(since) < MAX_PENDING_MS) {
      return finish("pending", { status: "scheduled", next_attempt_at: iso(Date.now() + Math.max(15_000, err.retryAfterMs ?? 60_000)), attempts: Math.max(0, row.attempts - 1), error: err.message.slice(0, 1000), error_kind: null });
    }
  }

  if (err.kind === "auth") {
    await setChannelStatus(row.channel_id, "expired", err.message);
    return fail(err.message, "auth", "needs_reauth");
  }
  if (err.retryable && row.attempts < MAX_PUBLISH_ATTEMPTS) {
    return finish(
      "retry",
      { status: "scheduled", next_attempt_at: iso(Date.now() + retryDelayMs(row.attempts, err.retryAfterMs)), error: err.message.slice(0, 1000), error_kind: err.kind },
      { message: err.message, kind: err.kind },
    );
  }
  return fail(err.retryable ? `${err.message} (gave up after ${row.attempts} attempts)` : err.message, err.kind);
}

/** After a target finished: the post's status and notifications. Never throws. */
async function afterTarget(workspace: WorkspaceRecord, row: PostTargetRow, channelName: string, platform: Platform, result: "published" | "failed", error = ""): Promise<void> {
  try {
    const status = await refreshPostStatus(row.post_id);
    const db = await getDb();
    const post = await db.selectFrom("posts").select(["content", "scheduled_at"]).where("id", "=", row.post_id).executeTakeFirst();
    const text = excerpt(normalizePostContent(parseJson(post?.content ?? "{}")).text);
    const path = workspaceDashboardPath(workspace.id, `posts/${row.post_id}`);
    if (result === "failed") {
      const payload = await buildNotifyPayload(workspace, "post_failed", `A post couldn't be published to ${channelName}.`, { post: text, channel: channelName, platform: getCapabilities(platform).name, error: error.slice(0, 300) }, path);
      await notifyWorkspace(workspace.id, payload, { postId: row.post_id, ownerFallback: true });
    } else if (status === "published" || status === "partially_failed") {
      const target = await db.selectFrom("post_targets").select("permalink").where("id", "=", row.id).executeTakeFirst();
      const data: Record<string, string> = { post: text, channel: channelName, platform: getCapabilities(platform).name };
      if (target?.permalink) data.permalink = target.permalink;
      const payload = await buildNotifyPayload(workspace, "post_published", status === "published" ? "A post was published." : "A post was published to some of its channels.", data, path);
      await notifyWorkspace(workspace.id, payload, { postId: row.post_id });
    }
  } catch (e) {
    console.error("[queuezen] after-publish step failed:", e);
  }
}

// ── Runs ──

async function processBatch(claims: ClaimedTarget[], summary: EngineRunSummary): Promise<void> {
  // One queue per channel (posts of a channel go out in order), channels in parallel.
  const byChannel = new Map<number, ClaimedTarget[]>();
  for (const c of claims) byChannel.set(c.row.channel_id, [...(byChannel.get(c.row.channel_id) ?? []), c]);
  const queues = [...byChannel.values()];
  const worker = async () => {
    for (;;) {
      const queue = queues.shift();
      if (!queue) return;
      for (const claim of queue) {
        let outcome: Outcome;
        try {
          outcome = await publishOne(claim);
        } catch (error) {
          if (!(error instanceof LeaseLost)) console.error(`[queuezen] target ${claim.row.id} could not be processed:`, error);
          // The lease runs out and the target is reclaimed later.
          continue;
        }
        if (outcome === "published" || outcome === "found_existing") summary.published += 1;
        else if (outcome === "retry" || outcome === "pending") summary.retried += 1;
        else if (outcome === "failed" || outcome === "needs_reauth") summary.failed += 1;
        else if (outcome === "deferred") summary.deferred += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, queues.length) }, worker));
}

/**
 * Publishes due targets until `deadline` (epoch ms). `onlyIds` limits the run to some targets
 * (Post now). Returns what happened.
 */
export async function runPublishEngine(options: { deadline: number; onlyIds?: number[] }): Promise<EngineRunSummary> {
  const summary: EngineRunSummary = { claimed: 0, published: 0, retried: 0, failed: 0, deferred: 0 };
  const perChannel = new Map<number, number>();
  while (options.deadline - Date.now() > MIN_TIME_LEFT_MS) {
    const claims = await claimTargets(BATCH, { onlyIds: options.onlyIds, perChannel });
    if (!claims.length) break;
    summary.claimed += claims.length;
    await processBatch(claims, summary);
  }
  return summary;
}

/** True when targets are due right now (the job uses it to decide whether to run again soon). */
export async function hasDueTargets(): Promise<boolean> {
  const db = await getDb();
  const row = await db.selectFrom("post_targets").select("id").where("status", "=", "scheduled").where("next_attempt_at", "<=", now()).limit(1).executeTakeFirst();
  return Boolean(row);
}
