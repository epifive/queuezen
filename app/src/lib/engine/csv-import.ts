import "server-only";
import crypto from "node:crypto";
import type { ChannelRecord } from "@/lib/channels";
import { getWorkspaceChannels } from "@/lib/channels";
import { importMediaFromUrl, MediaServiceError } from "@/lib/media/service";
import { savePost, takenTimes } from "@/lib/posts";
import type { WorkspaceRecord } from "@/lib/workspaces";
import { canPublishDirectly, httpUrl, isPlatform, nextQueueSlot, normalizeLabels, parseLocalDateTime, text, validatePostForChannel } from "@/social/normalize";
import type { Platform, PostContent, WorkspaceRole } from "@/social/types";

const platformOrNull = (v: string): Platform | null => (isPlatform(v) ? v : null);

/**
 * Bulk import of posts from a CSV file (Posts → Import CSV). Columns (header row, any order,
 * case-insensitive; "," or ";" separated, UTF-8 with or without BOM):
 *   text           the post text (required unless media_urls is set)
 *   channels       channel names, @handles, ids or platform ids, separated by "|" (or "all")
 *   scheduled_at   "YYYY-MM-DD HH:MM" in the workspace's time zone, or ISO 8601 with an offset
 *   queue          yes / 1 / true: the next free queue slot (instead of scheduled_at)
 *   media_urls     public image / video URLs separated by spaces or "|" (downloaded into the library)
 *   link           a link to attach
 *   first_comment  first comment / self-reply
 *   labels         labels separated by "|" or ","
 * Rows without a date or queue become drafts. A dry run checks every row and reports problems
 * without saving anything; the import then saves the valid rows (plan limits apply per row).
 */

export const MAX_CSV_ROWS = 500;
export const MAX_CSV_BYTES = 2 * 1024 * 1024;
const MAX_MEDIA_PER_ROW = 10;

/**
 * A problem of a row: `code` is a CSV code (text_required, channel_unknown, date_past…) or a
 * validation code of src/social/normalize.ts (then `channel` / `platform` say where), translated by
 * the dashboard; `message` is the English text for codes without a translation.
 */
export interface CsvIssue {
  code: string;
  params?: Record<string, string | number>;
  channel?: string;
  platform?: Platform;
  message?: string;
}

export interface CsvRowReport {
  /** Line number in the file (header = 1). */
  line: number;
  ok: boolean;
  errors: CsvIssue[];
  warnings: CsvIssue[];
  channels: string[];
  /** ISO time, "queue" or null (draft). */
  when: string | null;
  action: "schedule" | "queue" | "draft" | "submit";
  excerpt: string;
  postId?: number;
}

export interface CsvImportReport {
  rows: CsvRowReport[];
  valid: number;
  invalid: number;
  imported: number;
  /** Problem with the whole file (missing header, too many rows…). */
  fileError: string | null;
}

/** RFC 4180 parser: quoted fields, "" escapes, line breaks inside quotes, CRLF / LF. */
export function parseCsv(input: string, delimiter?: string): string[][] {
  const src = input.replace(/^﻿/, "");
  const firstLine = src.split(/\r?\n/, 1)[0] ?? "";
  const sep = delimiter ?? ((firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ";" : ",");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === "") quoted = true;
    else if (ch === sep) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

const COLUMN_ALIASES: Record<string, string> = {
  text: "text",
  caption: "text",
  message: "text",
  content: "text",
  channels: "channels",
  channel: "channels",
  accounts: "channels",
  scheduled_at: "scheduled_at",
  date: "scheduled_at",
  datetime: "scheduled_at",
  publish_at: "scheduled_at",
  queue: "queue",
  media_urls: "media_urls",
  media: "media_urls",
  image: "media_urls",
  images: "media_urls",
  link: "link",
  url: "link",
  first_comment: "first_comment",
  comment: "first_comment",
  labels: "labels",
  tags: "labels",
};

function matchChannels(spec: string, channels: ChannelRecord[]): { ids: number[]; unknown: string[] } {
  const parts = spec
    .split(/[|;\n]+|,(?![^(]*\))/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 1 && parts[0].toLowerCase() === "all") return { ids: channels.map((c) => c.id), unknown: [] };
  const ids = new Set<number>();
  const unknown: string[] = [];
  for (const part of parts) {
    const p = part.toLowerCase();
    const bare = p.replace(/^@/, "");
    const hits = channels.filter((c) => {
      if (String(c.id) === p) return true;
      if (c.name.toLowerCase() === p) return true;
      const handle = c.handle.toLowerCase().replace(/^@/, "");
      if (handle && handle === bare) return true;
      if (`${c.platform}:${handle}` === p || `${c.platform}:${c.name.toLowerCase()}` === p) return true;
      return false;
    });
    const byPlatform = hits.length ? hits : platformOrNull(p) ? channels.filter((c) => c.platform === platformOrNull(p)) : [];
    if (!byPlatform.length) unknown.push(part);
    for (const c of byPlatform) ids.add(c.id);
  }
  return { ids: [...ids], unknown };
}

function parseWhen(value: string, timezone: string): number {
  const v = value.trim();
  if (!v) return NaN;
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(v) && /T|\s/.test(v)) return Date.parse(v.replace(" ", "T"));
  return parseLocalDateTime(v.replace(/\//g, "-"), timezone);
}

const truthy = (v: string) => /^(1|y|yes|true|queue|x)$/i.test(v.trim());

export interface CsvImportInput {
  workspace: Pick<WorkspaceRecord, "id" | "ownerId" | "settings" | "timezone">;
  actor: { userId: number | null; role: WorkspaceRole };
  csv: string;
  dryRun: boolean;
}

/** Checks (dry run) or imports a CSV file. */
export async function importCsv(input: CsvImportInput): Promise<CsvImportReport> {
  const report: CsvImportReport = { rows: [], valid: 0, invalid: 0, imported: 0, fileError: null };
  if (input.csv.length > MAX_CSV_BYTES) return { ...report, fileError: "too_large" };
  const table = parseCsv(input.csv);
  if (table.length < 2) return { ...report, fileError: "empty" };
  const header = table[0].map((h) => COLUMN_ALIASES[h.trim().toLowerCase().replace(/[\s-]+/g, "_")] ?? "");
  if (!header.includes("text") || !header.includes("channels")) return { ...report, fileError: "header" };
  if (table.length - 1 > MAX_CSV_ROWS) return { ...report, fileError: "too_many" };

  const channels = await getWorkspaceChannels(input.workspace.id);
  const direct = canPublishDirectly(input.actor.role, input.workspace.settings);
  const batch = crypto.randomBytes(4).toString("hex");
  /** Queue times handed out in this import (rows share channels). */
  const reserved = new Map<number, string[]>();

  for (let i = 1; i < table.length; i++) {
    const cells = table[i];
    const get = (name: string) => {
      const idx = header.indexOf(name);
      return idx >= 0 ? (cells[idx] ?? "").trim() : "";
    };
    const row: CsvRowReport = { line: i + 1, ok: false, errors: [], warnings: [], channels: [], when: null, action: "draft", excerpt: get("text").replace(/\s+/g, " ").slice(0, 80) };
    const postText = text(get("text"), 70_000);
    const mediaUrls = get("media_urls")
      .split(/[\s|]+/)
      .map((u) => u.trim())
      .filter(Boolean);
    const link = get("link");
    if (!postText && !mediaUrls.length) row.errors.push({ code: "text_required" });
    if (mediaUrls.length > MAX_MEDIA_PER_ROW) row.errors.push({ code: "media_urls_count", params: { max: MAX_MEDIA_PER_ROW } });
    if (mediaUrls.some((u) => !httpUrl(u))) row.errors.push({ code: "media_url" });
    if (link && !httpUrl(link)) row.errors.push({ code: "link" });

    const { ids, unknown } = matchChannels(get("channels"), channels);
    if (!get("channels")) row.errors.push({ code: "channels_required" });
    for (const u of unknown) row.errors.push({ code: "channel_unknown", params: { name: u } });
    const selected = channels.filter((c) => ids.includes(c.id));
    row.channels = selected.map((c) => c.name);

    // When
    const when = get("scheduled_at");
    let scheduledAt: string | null = null;
    if (truthy(get("queue"))) {
      row.action = "queue";
      const slots = selected.flatMap((c) => c.queueSlots);
      if (!slots.length) row.errors.push({ code: "queue_no_slots" });
      else {
        const from = Date.now() + 60_000;
        const taken = (await Promise.all(selected.map((c) => takenTimes(c.id, new Date().toISOString())))).flat();
        for (const c of selected) taken.push(...(reserved.get(c.id) ?? []));
        scheduledAt = nextQueueSlot(slots, input.workspace.timezone, from, taken);
        if (!scheduledAt) row.errors.push({ code: "queue_full" });
        else for (const c of selected) reserved.set(c.id, [...(reserved.get(c.id) ?? []), scheduledAt]);
      }
    } else if (when) {
      const ms = parseWhen(when, input.workspace.timezone);
      if (!Number.isFinite(ms)) row.errors.push({ code: "date_invalid" });
      else if (ms < Date.now() - 2 * 60_000) row.errors.push({ code: "date_past" });
      else {
        scheduledAt = new Date(ms).toISOString();
        row.action = "schedule";
      }
    }
    if (row.action !== "draft" && !direct) row.action = "submit";
    row.when = scheduledAt;

    // Validation per channel (media is checked once downloaded).
    const content: PostContent = { text: postText, mediaIds: [], link: httpUrl(link), linkMeta: null, firstComment: text(get("first_comment"), 10_000), thread: [], options: {} };
    if (row.action !== "draft") {
      for (const c of selected) {
        const result = validatePostForChannel(content, [], c.platform);
        for (const e of result.errors) {
          if (mediaUrls.length && (e.code === "media_required" || e.code === "video_required" || e.code === "image_required" || e.code === "empty")) continue;
          row.errors.push({ code: e.code, params: e.params, channel: c.name, platform: c.platform, message: e.message });
        }
        for (const w of result.warnings) row.warnings.push({ code: w.code, params: w.params, channel: c.name, platform: c.platform, message: w.message });
      }
    }
    row.ok = row.errors.length === 0;
    if (row.ok) report.valid += 1;
    else report.invalid += 1;
    report.rows.push(row);

    if (input.dryRun || !row.ok) continue;

    // Import: media first, then the post.
    try {
      const mediaIds: number[] = [];
      for (const url of mediaUrls) {
        const item = await importMediaFromUrl({ workspace: input.workspace, userId: input.actor.userId, url });
        mediaIds.push(item.id);
      }
      const result = await savePost({
        workspace: input.workspace,
        actor: input.actor,
        content: { ...content, mediaIds },
        channelIds: selected.map((c) => c.id),
        labels: normalizeLabels(get("labels").split(/[|,]/)),
        scheduledAt,
        intent: row.action === "draft" ? "draft" : row.action === "submit" ? "submit" : "schedule",
        source: "csv",
        sourceRef: `csv:${batch}:${i + 1}`,
      });
      if (result.ok) {
        row.postId = result.post.id;
        report.imported += 1;
      } else {
        row.ok = false;
        if (result.code === "invalid") {
          for (const [id, r] of result.issues) {
            const c = channels.find((ch) => ch.id === id);
            for (const e of r.errors) row.errors.push({ code: e.code, params: e.params, channel: c?.name, platform: c?.platform, message: e.message });
          }
        } else row.errors.push({ code: `save_${result.code}`, params: result.code === "quota" ? { used: result.used, limit: result.limit } : undefined });
      }
    } catch (error) {
      row.ok = false;
      row.errors.push(error instanceof MediaServiceError ? { code: "media_import", message: error.message, params: { error: error.message } } : { code: "save_error" });
    }
  }
  return report;
}
