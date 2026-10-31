import "server-only";
import { getDb, now } from "./db";
import { getWorkspaceChannels, type ChannelRecord } from "./channels";
import { getPost, savePost, takenTimes, type PostRecord } from "./posts";
import { getSettings } from "./settings";
import { bannedOwnerWorkspaceIds, toWorkspaceRecord, type WorkspaceRecord } from "./workspaces";
import { bool, extractHashtags, idList, int, mergeContent, nextQueueSlot, parseJson } from "@/social/normalize";
import type { ContentOverride } from "@/social/types";

/**
 * Evergreen recycling: published posts marked evergreen go back into the queue as NEW posts
 * (source "recycle", source_ref = the original post id) after `intervalDays`, up to `maxRecycles`
 * times, into the next free queue slot of their channels. X rejects a tweet identical to a recent
 * one, so copies to X get a small variation (hashtags rotated, else a ♻ marker).
 *
 * Also home of the queue placement helpers used by RSS, recycling and the REST API.
 */

export interface RecycleSettings {
  enabled: boolean;
  /** Days between two publications of the same post. */
  intervalDays: number;
  /** How many times a post may be recycled (0 = no limit). */
  maxRecycles: number;
  /** Channels for the copies; [] = the original post's channels. */
  channelIds: number[];
  /** Pick eligible posts in random order instead of the longest-waiting first. */
  randomize: boolean;
  /** Posts recycled per run (the job runs hourly). */
  perRun: number;
}

export const DEFAULT_RECYCLE: RecycleSettings = { enabled: false, intervalDays: 30, maxRecycles: 3, channelIds: [], randomize: false, perRun: 2 };

export function normalizeRecycleSettings(v: unknown): RecycleSettings {
  const o = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  return {
    enabled: bool(o.enabled, DEFAULT_RECYCLE.enabled),
    intervalDays: int(o.intervalDays, DEFAULT_RECYCLE.intervalDays, 1, 365),
    maxRecycles: int(o.maxRecycles, DEFAULT_RECYCLE.maxRecycles, 0, 100),
    channelIds: idList(o.channelIds, 100),
    randomize: bool(o.randomize, DEFAULT_RECYCLE.randomize),
    perRun: int(o.perRun, DEFAULT_RECYCLE.perRun, 1, 20),
  };
}

export async function getRecycleSettings(workspaceId: number): Promise<RecycleSettings> {
  const db = await getDb();
  const row = await db.selectFrom("workspaces").select("recycle_settings").where("id", "=", workspaceId).executeTakeFirst();
  return normalizeRecycleSettings(parseJson(row?.recycle_settings ?? null));
}

export async function saveRecycleSettings(workspaceId: number, settings: RecycleSettings): Promise<void> {
  const db = await getDb();
  await db
    .updateTable("workspaces")
    .set({ recycle_settings: JSON.stringify(normalizeRecycleSettings(settings)), updated_at: now() })
    .where("id", "=", workspaceId)
    .execute();
}

// ── Queue placement ──

/** The next `count` free queue slots of a channel after `from` (ISO, ascending). */
export async function freeSlots(channel: Pick<ChannelRecord, "id" | "queueSlots">, timezone: string, from: number, count = 60): Promise<string[]> {
  if (!channel.queueSlots.length) return [];
  const taken = new Set(await takenTimes(channel.id, new Date(from).toISOString()));
  const out: string[] = [];
  let cursor = from;
  for (let i = 0; i < count; i++) {
    const next = nextQueueSlot(channel.queueSlots, timezone, cursor, taken);
    if (!next) break;
    out.push(next);
    cursor = Date.parse(next);
  }
  return out;
}

/**
 * One time for a post on several channels: the earliest time that is a free queue slot on every
 * channel that has queue slots; when their slots never coincide, the latest of their next free
 * slots (no channel posts earlier than its queue allows). null when no channel has queue slots.
 */
export async function commonQueueSlot(channels: Array<Pick<ChannelRecord, "id" | "queueSlots">>, timezone: string, from = Date.now()): Promise<string | null> {
  const lists = (await Promise.all(channels.map((c) => freeSlots(c, timezone, from)))).filter((l) => l.length);
  if (!lists.length) return null;
  if (lists.length === 1) return lists[0][0];
  const sets = lists.slice(1).map((l) => new Set(l));
  const shared = lists[0].find((t) => sets.every((s) => s.has(t)));
  if (shared) return shared;
  return lists.map((l) => l[0]).sort().pop() ?? null;
}

// ── X duplicate text ──

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** A version of `text` that differs from every text in `previous` (for X duplicate-content rules). */
export function varyText(text: string, previous: string[], recycleNumber: number): string {
  const seen = new Set(previous.map(norm));
  if (!seen.has(norm(text))) return text;
  const tags = extractHashtags(text);
  const tail = /((?:\s*#[\p{L}\p{N}_]+)+)\s*$/u.exec(text);
  if (tags.length >= 2 && tail) {
    const own = tail[1].trim().split(/\s+/);
    for (let shift = 1; shift < own.length; shift++) {
      const k = ((recycleNumber + shift - 2) % (own.length - 1)) + 1;
      const rotated = [...own.slice(k), ...own.slice(0, k)].join(" ");
      const candidate = `${text.slice(0, tail.index).trimEnd()} ${rotated}`;
      if (!seen.has(norm(candidate))) return candidate;
    }
  }
  for (let n = 0; n < 50; n++) {
    const candidate = `${text.trimEnd()} ♻${n ? ` ${n + 1}` : ""}`;
    if (!seen.has(norm(candidate))) return candidate;
  }
  return `${text.trimEnd()} ♻ ${Date.now() % 1000}`;
}

// ── Recycling ──

async function lineageXTexts(original: PostRecord): Promise<string[]> {
  const texts: string[] = [];
  for (const t of original.targets) if (t.platform === "x") texts.push(mergeContent(original.content, t.override).text);
  const db = await getDb();
  const copies = await db.selectFrom("posts").select("id").where("workspace_id", "=", original.workspaceId).where("source", "=", "recycle").where("source_ref", "=", String(original.id)).orderBy("id", "desc").limit(50).execute();
  for (const c of copies) {
    const post = await getPost(original.workspaceId, c.id);
    if (!post) continue;
    for (const t of post.targets) if (t.platform === "x") texts.push(mergeContent(post.content, t.override).text);
  }
  return texts;
}

export type RecycleOutcome = { ok: true; postId: number; scheduledAt: string } | { ok: false; reason: string };

/** Puts one evergreen post back into the queue as a new post. */
export async function recyclePost(workspace: WorkspaceRecord, original: PostRecord, settings: RecycleSettings, channels: ChannelRecord[]): Promise<RecycleOutcome> {
  const active = channels.filter((c) => c.status === "active");
  const wanted = settings.channelIds.length ? settings.channelIds : original.targets.map((t) => t.channelId);
  const selected = active.filter((c) => wanted.includes(c.id));
  if (!selected.length) return { ok: false, reason: "no_channels" };
  const slot = (await commonQueueSlot(selected, workspace.timezone)) ?? new Date(Date.now() + 60 * 60_000).toISOString();
  const recycleNumber = original.recycleCount + 1;

  const overrides: Record<number, ContentOverride> = {};
  const xPrevious = selected.some((c) => c.platform === "x") ? await lineageXTexts(original) : [];
  for (const c of selected) {
    const prev = original.targets.find((t) => t.channelId === c.id)?.override ?? {};
    const override: ContentOverride = { ...prev };
    if (c.platform === "x") {
      const effective = mergeContent(original.content, prev).text;
      const varied = varyText(effective, xPrevious, recycleNumber);
      if (varied !== effective) override.text = varied;
    }
    overrides[c.id] = override;
  }

  const result = await savePost({
    workspace,
    actor: { userId: original.authorId, role: "owner" },
    content: original.content,
    overrides,
    channelIds: selected.map((c) => c.id),
    labels: original.labels,
    scheduledAt: slot,
    intent: "schedule",
    source: "recycle",
    sourceRef: String(original.id),
    isEvergreen: false,
  });
  if (!result.ok) return { ok: false, reason: result.code };
  const db = await getDb();
  await db
    .updateTable("posts")
    .set({ recycle_count: recycleNumber, last_recycled_at: now() })
    .where("id", "=", original.id)
    .execute();
  return { ok: true, postId: result.post.id, scheduledAt: slot };
}

/** Evergreen posts of a workspace due for recycling (no copy already waiting). */
export async function dueEvergreenPosts(workspaceId: number, settings: RecycleSettings, at = Date.now()): Promise<number[]> {
  const cutoff = new Date(at - settings.intervalDays * 86_400_000).toISOString();
  const db = await getDb();
  let q = db
    .selectFrom("posts")
    .select(["id", "last_recycled_at", "published_at"])
    .where("workspace_id", "=", workspaceId)
    .where("is_evergreen", "=", 1)
    .where("status", "in", ["published", "partially_failed"])
    .where("published_at", "<=", cutoff)
    .where((eb) => eb.or([eb("last_recycled_at", "is", null), eb("last_recycled_at", "<=", cutoff)]));
  if (settings.maxRecycles > 0) q = q.where("recycle_count", "<", settings.maxRecycles);
  const rows = await q.limit(500).execute();
  if (!rows.length) return [];
  const waiting = await db
    .selectFrom("posts")
    .select("source_ref")
    .where("workspace_id", "=", workspaceId)
    .where("source", "=", "recycle")
    .where("status", "not in", ["published", "partially_failed", "failed"])
    .execute();
  const busy = new Set(waiting.map((w) => w.source_ref));
  const eligible = rows.filter((r) => !busy.has(String(r.id)));
  const order = (r: (typeof rows)[number]) => r.last_recycled_at ?? r.published_at ?? "";
  if (settings.randomize) {
    for (let i = eligible.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [eligible[i], eligible[j]] = [eligible[j], eligible[i]];
    }
  } else eligible.sort((a, b) => order(a).localeCompare(order(b)) || a.id - b.id);
  return eligible.map((r) => r.id);
}

/** Recycles up to `perRun` posts of one workspace. Returns the number of copies created. */
export async function recycleWorkspace(workspace: WorkspaceRecord, settings: RecycleSettings): Promise<{ created: number; errors: string[] }> {
  const ids = await dueEvergreenPosts(workspace.id, settings);
  if (!ids.length) return { created: 0, errors: [] };
  const channels = await getWorkspaceChannels(workspace.id);
  let created = 0;
  const errors: string[] = [];
  for (const id of ids) {
    if (created >= settings.perRun) break;
    const original = await getPost(workspace.id, id);
    if (!original) continue;
    const outcome = await recyclePost(workspace, original, settings, channels);
    if (outcome.ok) created += 1;
    else {
      errors.push(`${id}:${outcome.reason}`);
      // The plan's monthly quota is full: stop for this workspace until next run.
      if (outcome.reason === "quota") break;
    }
  }
  return { created, errors };
}

/** Workspaces with recycling turned on (for the job). */
export async function recyclingWorkspaces(limit = 200): Promise<Array<{ workspace: WorkspaceRecord; settings: RecycleSettings }>> {
  const site = await getSettings();
  if (!site.recycle_enabled) return [];
  const db = await getDb();
  const banned = await bannedOwnerWorkspaceIds();
  let q = db.selectFrom("workspaces").selectAll().where("recycle_settings", "is not", null).where("recycle_settings", "like", '%"enabled":true%');
  if (banned.length) q = q.where("id", "not in", banned);
  const rows = await q.limit(limit).execute();
  const out: Array<{ workspace: WorkspaceRecord; settings: RecycleSettings }> = [];
  for (const row of rows) {
    const settings = normalizeRecycleSettings(parseJson(row.recycle_settings));
    if (!settings.enabled) continue;
    // Copies book posts on the owner's monthly quota like any scheduled post.
    out.push({ workspace: toWorkspaceRecord(row), settings });
  }
  return out;
}

/** Evergreen posts of a workspace with their recycling state (Automation → Recycling). */
export async function getEvergreenPosts(workspaceId: number, limit = 100): Promise<Array<{ id: number; text: string; status: string; recycleCount: number; lastRecycledAt: string | null; publishedAt: string | null }>> {
  const db = await getDb();
  const rows = await db
    .selectFrom("posts")
    .select(["id", "content", "status", "recycle_count", "last_recycled_at", "published_at"])
    .where("workspace_id", "=", workspaceId)
    .where("is_evergreen", "=", 1)
    .orderBy("updated_at", "desc")
    .limit(limit)
    .execute();
  return rows.map((r) => {
    const content = parseJson(r.content) as { text?: unknown } | null;
    return { id: r.id, text: typeof content?.text === "string" ? content.text : "", status: r.status, recycleCount: r.recycle_count, lastRecycledAt: r.last_recycled_at, publishedAt: r.published_at };
  });
}

/** Recently published posts that could be made evergreen (not recycled copies). */
export async function getRecyclableCandidates(workspaceId: number, limit = 10): Promise<Array<{ id: number; text: string; publishedAt: string | null }>> {
  const db = await getDb();
  const rows = await db
    .selectFrom("posts")
    .select(["id", "content", "published_at"])
    .where("workspace_id", "=", workspaceId)
    .where("is_evergreen", "=", 0)
    .where("source", "!=", "recycle")
    .where("status", "in", ["published", "partially_failed"])
    .orderBy("published_at", "desc")
    .limit(limit)
    .execute();
  return rows.map((r) => {
    const content = parseJson(r.content) as { text?: unknown } | null;
    return { id: r.id, text: typeof content?.text === "string" ? content.text : "", publishedAt: r.published_at };
  });
}
