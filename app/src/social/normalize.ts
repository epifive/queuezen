/**
 * Turns untrusted input (dashboard forms, CSV imports, stored JSON, REST API bodies) into valid
 * values, and holds the pure logic shared by the composer, the engine, the drivers and the tests:
 * text counting, post validation per platform, queue slots, time zones, UTM links, roles and
 * status transitions. Unknown keys are dropped, missing keys get defaults.
 * Dependency-free (server, client components and tests).
 */

import { getCapabilities, mediaRulesFor, PLATFORM_CAPABILITIES, type ImageRules, type MediaRules, type VideoRules } from "./platforms";
import {
  ASSIGNABLE_ROLES,
  DEFAULT_NOTIFY_EVENTS,
  FB_POST_TYPES,
  IG_POST_TYPES,
  MASTODON_VISIBILITY,
  NOTIFY_CHANNEL_TYPES,
  NOTIFY_EVENTS,
  PLATFORMS,
  POST_SOURCES,
  POST_STATUSES,
  TIKTOK_PRIVACY,
  WORKSPACE_ROLES,
  YOUTUBE_PRIVACY,
  type AssignableRole,
  type ChannelSettings,
  type ContentOverride,
  type LinkMeta,
  type MediaInfo,
  type MediaKind,
  type NotifyChannelType,
  type NotifyConfigByType,
  type NotifyEvent,
  type Platform,
  type PlatformOptions,
  type PostContent,
  type PostSource,
  type PostStatus,
  type QueueSlot,
  type TargetStatus,
  type UtmSettings,
  type ValidationIssue,
  type ValidationResult,
  type WorkspaceBranding,
  type WorkspaceCapability,
  type WorkspaceRole,
  type WorkspaceSettings,
} from "./types";

type Obj = Record<string, unknown>;
const asObj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const oneOf = <T extends string>(values: readonly T[], v: unknown, fallback: T): T =>
  typeof v === "string" && (values as readonly string[]).includes(v) ? (v as T) : fallback;

// ── Primitive helpers ──

/** JSON.parse that never throws: {} for empty or invalid text. */
export function parseJson(text: string | null | undefined): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/** A JSON array of strings (labels, scopes…) from stored text; [] when invalid. */
export function parseJsonList(text: string | null | undefined): string[] {
  const v = parseJson(text);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** A JSON array of positive integers (ids) from stored text or a value; [] when invalid. */
export function idList(v: unknown, max = 100): number[] {
  const raw = typeof v === "string" ? (v.trim().startsWith("[") ? parseJson(v) : v.split(/[\s,]+/)) : v;
  if (!Array.isArray(raw)) return [];
  const out: number[] = [];
  for (const x of raw) {
    const n = typeof x === "number" ? x : typeof x === "string" && /^\d{1,10}$/.test(x.trim()) ? Number(x) : NaN;
    if (Number.isInteger(n) && n > 0 && !out.includes(n)) out.push(n);
    if (out.length >= max) break;
  }
  return out;
}

/** Trimmed string without control characters, at most `max` characters. */
export function str(v: unknown, fallback = "", max = 500): string {
  if (typeof v === "number" && Number.isFinite(v)) return String(v).slice(0, max);
  if (typeof v !== "string") return fallback;
  return v.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "").trim().slice(0, max);
}

/** Like str() but keeps line breaks (post text, notes). */
export function text(v: unknown, max = 20_000): string {
  if (typeof v !== "string") return "";
  return v.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "").trim().slice(0, max);
}

export function bool(v: unknown, fallback: boolean): boolean {
  if (typeof v === "boolean") return v;
  if (v === "true" || v === "on" || v === 1 || v === "1") return true;
  if (v === "false" || v === "off" || v === 0 || v === "0") return false;
  return fallback;
}

/** Integer clamped to [min, max]; `fallback` when not a number. */
export function int(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function list(v: unknown, max: number, each: (s: string) => string): string[] {
  const raw = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[\n,]+/) : [];
  return [...new Set(raw.map((x) => each(String(x))).filter(Boolean))].slice(0, max);
}

/** Lowercase email or "" when it doesn't look like one. */
export function normalizeEmail(v: unknown): string {
  const s = str(v, "", 190).toLowerCase();
  return /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']{2,}$/.test(s) ? s : "";
}

/** Up to `max` valid, distinct email addresses from a comma / space / newline separated list. */
export function normalizeEmailList(v: unknown, max = 10): string[] {
  return list(typeof v === "string" ? v.replace(/[;\s]+/g, ",") : v, max, normalizeEmail);
}

/** #rrggbb (or "" when invalid). "#abc" is expanded. */
export function normalizeColor(v: unknown): string {
  const s = str(v, "", 7).toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  if (/^#[0-9a-f]{3}$/.test(s)) return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  return "";
}

/** http(s) URL or "". */
export function httpUrl(v: unknown): string {
  if (typeof v !== "string") return "";
  const value = v.trim().slice(0, 2000);
  return /^https?:\/\/[^\s"'<>]+$/i.test(value) ? value : "";
}

/** Labels / tags: trimmed, single spaces, distinct (case-insensitive), at most 20 × 40 characters. */
export function normalizeLabels(v: unknown, max = 20): string[] {
  const raw = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of raw) {
    const label = str(x, "", 40).replace(/\s+/g, " ");
    const key = label.toLowerCase();
    if (!label || seen.has(key)) continue;
    seen.add(key);
    out.push(label);
    if (out.length >= max) break;
  }
  return out;
}

// ── Platforms ──

export function isPlatform(v: unknown): v is Platform {
  return typeof v === "string" && (PLATFORMS as readonly string[]).includes(v);
}

export function isPostStatus(v: unknown): v is PostStatus {
  return typeof v === "string" && (POST_STATUSES as readonly string[]).includes(v);
}

// ── Text counting ──

const URL_RE = /\bhttps?:\/\/[^\s<>"'()]+(?:\([^\s<>"']*\)[^\s<>"'()]*)*/gi;
/** Bare domains that X and Mastodon turn into links ("example.com/page"). Common TLDs only. */
const BARE_URL_RE =
  /(?<![\w@./-])(?:www\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|io|co|ai|app|dev|me|info|biz|us|uk|in|de|fr|es|it|nl|eu|ca|au|jp|br|ru|ch|se|no|xyz|site|online|store|blog|tech|ly|gg|tv|fm|so|to|be|at|pl)(?::\d{2,5})?(?:\/[^\s<>"']*)?(?![\w-])/gi;
const TRAILING_PUNCT = /[.,!?;:'"»)\]]+$/;

/** URLs in a text (with and without http://), trailing punctuation removed. */
export function extractUrls(input: string): string[] {
  const found: string[] = [];
  const scrubbed = input.replace(URL_RE, (m) => {
    found.push(m.replace(TRAILING_PUNCT, ""));
    return " ".repeat(m.length);
  });
  for (const m of scrubbed.matchAll(BARE_URL_RE)) found.push(m[0].replace(TRAILING_PUNCT, ""));
  return found.filter((u) => u.length > 3);
}

function segmentGraphemes(input: string): string[] {
  const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: "grapheme" }) => { segment(s: string): Iterable<{ segment: string }> } }).Segmenter;
  if (Seg) return Array.from(new Seg(undefined, { granularity: "grapheme" }).segment(input), (s) => s.segment);
  return Array.from(input);
}

const EMOJI_RE = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u;

/** X weights: code points in these ranges count 1, everything else (CJK, most scripts outside Latin…) 2. */
function xWeight(cp: number): number {
  if ((cp >= 0 && cp <= 4351) || (cp >= 8192 && cp <= 8205) || (cp >= 8208 && cp <= 8223) || (cp >= 8242 && cp <= 8247)) return 1;
  return 2;
}

/** Removes the URLs from a text (trailing punctuation stays); returns the rest and the URL count. */
function stripUrls(input: string): { rest: string; urls: number } {
  let urls = 0;
  const cut = (m: string) => {
    urls += 1;
    return (TRAILING_PUNCT.exec(m) ?? [""])[0];
  };
  const rest = input.replace(URL_RE, cut).replace(BARE_URL_RE, cut);
  return { rest, urls };
}

/**
 * The length of `input` as `platform` counts it (see TextCounting in ./platforms.ts):
 * X weighs URLs as 23 and CJK / emoji as 2, Bluesky counts graphemes, Telegram UTF-16 units,
 * Mastodon counts URLs as 23 and remote mentions without their domain.
 */
export function countChars(input: string, platform: Platform): number {
  const caps = PLATFORM_CAPABILITIES[platform].text;
  const value = input.normalize("NFC");
  switch (caps.counting) {
    case "utf16":
      return value.length;
    case "graphemes":
      return segmentGraphemes(value).length;
    case "mastodon": {
      const withoutDomains = value.replace(/(^|[^\w/])@([a-z0-9_]+(?:[a-z0-9_.-]+[a-z0-9_]+)?)@[a-z0-9.-]+\.[a-z]{2,}/gi, "$1@$2");
      const { rest, urls } = stripUrls(withoutDomains);
      return Array.from(rest).length + urls * (caps.urlLength ?? 23);
    }
    case "x_weighted": {
      const { rest, urls } = stripUrls(value);
      let weight = urls * (caps.urlLength ?? 23);
      for (const g of segmentGraphemes(rest)) {
        if (EMOJI_RE.test(g)) {
          weight += 2;
          continue;
        }
        for (const ch of g) weight += xWeight(ch.codePointAt(0) ?? 0);
      }
      return weight;
    }
    default:
      return Array.from(value).length;
  }
}

/** "#tags" in a text (Unicode letters, digits and "_"). */
export function extractHashtags(input: string): string[] {
  return Array.from(input.matchAll(/(?:^|[^\p{L}\p{N}_&/])#([\p{L}\p{N}_]*\p{L}[\p{L}\p{N}_]*)/gu), (m) => m[1]);
}

/** "@mentions" in a text. */
export function extractMentions(input: string): string[] {
  return Array.from(input.matchAll(/(?:^|[^\w@/])@([A-Za-z0-9_.]{1,64})/g), (m) => m[1]);
}

// ── Post content ──

export const MAX_TEXT = 70_000;
export const MAX_THREAD_PARTS = 25;
export const MAX_MEDIA_PER_POST = 35;

function normalizeLinkMeta(v: unknown): LinkMeta | null {
  if (!v || typeof v !== "object") return null;
  const o = asObj(v);
  const meta = { title: str(o.title, "", 300), description: str(o.description, "", 1000), imageUrl: httpUrl(o.imageUrl) };
  return meta.title || meta.description || meta.imageUrl ? meta : null;
}

function cleanUsernames(v: unknown, max: number): string[] {
  return list(v, max, (s) => s.trim().replace(/^@/, "").replace(/[^A-Za-z0-9_.]/g, "").slice(0, 64));
}

/** Platform options with defaults; unknown platforms and keys are dropped. Only present blocks are kept. */
export function normalizePlatformOptions(v: unknown): PlatformOptions {
  const o = asObj(v);
  const out: PlatformOptions = {};
  if (o.facebook) out.facebook = { postType: oneOf(FB_POST_TYPES, asObj(o.facebook).postType, "feed") };
  if (o.instagram) {
    const ig = asObj(o.instagram);
    out.instagram = {
      postType: oneOf(IG_POST_TYPES, ig.postType, "feed"),
      shareToFeed: bool(ig.shareToFeed, true),
      collaborators: cleanUsernames(ig.collaborators, 3),
      coverMediaId: int(ig.coverMediaId, 0, 0, 2_147_483_647),
    };
  }
  if (o.threads) {
    const th = asObj(o.threads);
    out.threads = {
      replyControl: oneOf(["everyone", "accounts_you_follow", "mentioned_only"] as const, th.replyControl, "everyone"),
      topicTag: str(th.topicTag, "", 50).replace(/^#/, "").replace(/[.&]/g, ""),
    };
  }
  if (o.x) out.x = { replySettings: oneOf(["everyone", "following", "mentionedUsers"] as const, asObj(o.x).replySettings, "everyone") };
  if (o.linkedin) out.linkedin = { visibility: oneOf(["PUBLIC", "CONNECTIONS"] as const, asObj(o.linkedin).visibility, "PUBLIC") };
  if (o.youtube) {
    const yt = asObj(o.youtube);
    out.youtube = {
      title: str(yt.title, "", 100).replace(/[<>]/g, ""),
      privacy: oneOf(YOUTUBE_PRIVACY, yt.privacy, "public"),
      tags: list(yt.tags, 30, (s) => s.trim().slice(0, 60)),
      categoryId: /^\d{1,3}$/.test(str(yt.categoryId)) ? str(yt.categoryId) : "22",
      madeForKids: bool(yt.madeForKids, false),
      notifySubscribers: bool(yt.notifySubscribers, true),
      thumbnailMediaId: int(yt.thumbnailMediaId, 0, 0, 2_147_483_647),
    };
  }
  if (o.bluesky) out.bluesky = { langs: list(asObj(o.bluesky).langs, 3, (s) => (/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(s.trim()) ? s.trim() : "")) };
  if (o.mastodon) {
    const m = asObj(o.mastodon);
    out.mastodon = { visibility: oneOf(MASTODON_VISIBILITY, m.visibility, "public"), spoilerText: str(m.spoilerText, "", 500), language: /^[a-z]{2}$/.test(str(m.language)) ? str(m.language) : "" };
  }
  if (o.telegram) {
    const tg = asObj(o.telegram);
    out.telegram = { silent: bool(tg.silent, false), disablePreview: bool(tg.disablePreview, false) };
  }
  if (o.discord) {
    const d = asObj(o.discord);
    out.discord = { username: str(d.username, "", 80), avatarUrl: httpUrl(d.avatarUrl), threadName: str(d.threadName, "", 100) };
  }
  if (o.tiktok) {
    const tt = asObj(o.tiktok);
    out.tiktok = {
      privacy: oneOf(TIKTOK_PRIVACY, tt.privacy, ""),
      allowComment: bool(tt.allowComment, false),
      allowDuet: bool(tt.allowDuet, false),
      allowStitch: bool(tt.allowStitch, false),
      brandedContent: bool(tt.brandedContent, false),
    };
  }
  if (o.pinterest) {
    const p = asObj(o.pinterest);
    out.pinterest = { boardId: str(p.boardId, "", 64).replace(/[^\w-]/g, ""), title: str(p.title, "", 100), link: httpUrl(p.link) };
  }
  return out;
}

export const EMPTY_CONTENT: PostContent = { text: "", mediaIds: [], link: "", linkMeta: null, firstComment: "", thread: [], options: {} };

/** Base content of a post (posts.content) from stored JSON or input. */
export function normalizePostContent(v: unknown): PostContent {
  const o = asObj(v);
  return {
    text: text(o.text, MAX_TEXT),
    mediaIds: idList(o.mediaIds, MAX_MEDIA_PER_POST),
    link: httpUrl(o.link),
    linkMeta: normalizeLinkMeta(o.linkMeta),
    firstComment: text(o.firstComment, 10_000),
    thread: (Array.isArray(o.thread) ? o.thread : []).map((p) => text(p, 10_000)).filter(Boolean).slice(0, MAX_THREAD_PARTS - 1),
    options: normalizePlatformOptions(o.options),
  };
}

/** A channel's override (post_targets.override): only the keys present in the input are kept. */
export function normalizeOverride(v: unknown): ContentOverride {
  const o = asObj(v);
  const out: ContentOverride = {};
  if ("text" in o) out.text = text(o.text, MAX_TEXT);
  if ("mediaIds" in o) out.mediaIds = idList(o.mediaIds, MAX_MEDIA_PER_POST);
  if ("link" in o) out.link = httpUrl(o.link);
  if ("linkMeta" in o) out.linkMeta = normalizeLinkMeta(o.linkMeta);
  if ("firstComment" in o) out.firstComment = text(o.firstComment, 10_000);
  if ("thread" in o) out.thread = (Array.isArray(o.thread) ? o.thread : []).map((p) => text(p, 10_000)).filter(Boolean).slice(0, MAX_THREAD_PARTS - 1);
  if ("options" in o) out.options = normalizePlatformOptions(o.options);
  return out;
}

/** The effective content of one channel: the base with the channel's override on top. */
export function mergeContent(base: PostContent, override: ContentOverride | null | undefined): PostContent {
  if (!override) return base;
  return {
    text: override.text ?? base.text,
    mediaIds: override.mediaIds ?? base.mediaIds,
    link: override.link ?? base.link,
    linkMeta: override.linkMeta !== undefined ? override.linkMeta : base.linkMeta,
    firstComment: override.firstComment ?? base.firstComment,
    thread: override.thread ?? base.thread,
    options: override.options ? { ...base.options, ...override.options } : base.options,
  };
}

/** Media kind from a MIME type (null = not supported). */
export function mediaKindOf(mime: string): MediaKind | null {
  const m = mime.toLowerCase();
  if (m === "image/gif") return "gif";
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  return null;
}

// ── Validation ──

const MB = 1024 * 1024;
const fmtMb = (bytes: number) => (bytes >= 1024 * MB ? `${Math.round((bytes / (1024 * MB)) * 10) / 10} GB` : `${Math.round((bytes / MB) * 10) / 10} MB`);
const fmtSec = (s: number) => (s >= 3600 ? `${Math.round((s / 3600) * 10) / 10} h` : s >= 120 ? `${Math.round(s / 6) / 10} min` : `${Math.round(s * 10) / 10} s`);
const ratio = (w: number | null, h: number | null) => (w && h ? w / h : null);
const fmtRatio = (r: number) => (Math.abs(r - 4 / 5) < 0.005 ? "4:5" : Math.abs(r - 9 / 16) < 0.005 ? "9:16" : Math.abs(r - 1) < 0.005 ? "1:1" : String(Math.round(r * 100) / 100));

function postTypeOf(content: PostContent, platform: Platform): string | null {
  if (platform === "instagram" || platform === "instagram_login") return content.options.instagram?.postType ?? "feed";
  if (platform === "facebook") return content.options.facebook?.postType ?? "feed";
  return null;
}

function checkImage(item: MediaInfo, rules: ImageRules, gifMax: number | null, name: string, push: (issue: ValidationIssue) => void) {
  const field = `media:${item.id}`;
  const isGif = item.kind === "gif";
  if (!rules.types.includes(item.mime.toLowerCase()) && !(isGif && gifMax !== null)) {
    push({ code: "media_type", message: `${name} doesn't accept ${item.mime} images (use ${rules.types.map((t) => t.replace("image/", "").toUpperCase()).join(", ")}).`, params: { mime: item.mime }, field });
    return;
  }
  const max = isGif && gifMax !== null ? gifMax : rules.maxBytes;
  if (item.size > max) push({ code: "media_too_large", message: `Image is ${fmtMb(item.size)}; ${name} allows up to ${fmtMb(max)}.`, params: { size: item.size, max }, field });
  const r = ratio(item.width, item.height);
  if (r !== null) {
    if (rules.minAspect !== null && r < rules.minAspect - 0.01)
      push({ code: "media_ratio", message: `Image ratio ${fmtRatio(r)} is too tall for ${name} (at least ${fmtRatio(rules.minAspect)}).`, params: { ratio: r, min: rules.minAspect }, field });
    if (rules.maxAspect !== null && r > rules.maxAspect + 0.01)
      push({ code: "media_ratio", message: `Image ratio ${fmtRatio(r)} is too wide for ${name} (at most ${fmtRatio(rules.maxAspect)}).`, params: { ratio: r, max: rules.maxAspect }, field });
  }
  if (item.width) {
    if (rules.minWidth !== null && item.width < rules.minWidth) push({ code: "media_width", message: `Image is ${item.width} px wide; ${name} needs at least ${rules.minWidth} px.`, params: { width: item.width, min: rules.minWidth }, field });
  }
}

function checkVideo(item: MediaInfo, rules: VideoRules, name: string, errors: ValidationIssue[], warnings: ValidationIssue[]) {
  const field = `media:${item.id}`;
  if (!rules.types.includes(item.mime.toLowerCase())) {
    errors.push({ code: "media_type", message: `${name} doesn't accept ${item.mime} videos (export an H.264/AAC MP4).`, params: { mime: item.mime }, field });
    return;
  }
  if (item.size > rules.maxBytes) errors.push({ code: "media_too_large", message: `Video is ${fmtMb(item.size)}; ${name} allows up to ${fmtMb(rules.maxBytes)}.`, params: { size: item.size, max: rules.maxBytes }, field });
  if (rules.minBytes && item.size < rules.minBytes) errors.push({ code: "media_too_small", message: `Video is too small for ${name}.`, params: { size: item.size, min: rules.minBytes }, field });
  if (item.duration === null) {
    warnings.push({ code: "media_duration_unknown", message: `The video's length is unknown, so ${name}'s ${fmtSec(rules.minDuration)} to ${fmtSec(rules.maxDuration)} limit couldn't be checked.`, field });
  } else {
    if (item.duration < rules.minDuration) errors.push({ code: "media_too_short", message: `Video is ${fmtSec(item.duration)}; ${name} needs at least ${fmtSec(rules.minDuration)}.`, params: { duration: item.duration, min: rules.minDuration }, field });
    if (item.duration > rules.maxDuration) errors.push({ code: "media_too_long", message: `Video is ${fmtSec(item.duration)}; ${name} allows up to ${fmtSec(rules.maxDuration)}.`, params: { duration: item.duration, max: rules.maxDuration }, field });
  }
  const r = ratio(item.width, item.height);
  if (r !== null) {
    if ((rules.minAspect !== null && r < rules.minAspect - 0.01) || (rules.maxAspect !== null && r > rules.maxAspect + 0.01)) {
      errors.push({ code: "media_ratio", message: `Video ratio ${fmtRatio(r)} isn't accepted by ${name}.`, params: { ratio: r }, field });
    }
  }
}

function checkMedia(media: MediaInfo[], rules: MediaRules, name: string, errors: ValidationIssue[], warnings: ValidationIssue[]) {
  const videos = media.filter((m) => m.kind === "video");
  const stills = media.filter((m) => m.kind !== "video");
  if (rules.required === "any" && !media.length) errors.push({ code: "media_required", message: `${name} needs at least one image or video.`, field: "media" });
  if (rules.required === "video" && !videos.length) errors.push({ code: "video_required", message: `${name} needs a video.`, field: "media" });
  if (rules.required === "image" && !stills.length) errors.push({ code: "image_required", message: `${name} needs an image.`, field: "media" });
  if (media.length > rules.maxItems) errors.push({ code: "media_count", message: `${name} allows up to ${rules.maxItems} media items per post (${media.length} attached).`, params: { count: media.length, max: rules.maxItems }, field: "media" });
  if (media.length > 1 && media.length < rules.minCarousel) errors.push({ code: "media_carousel_min", message: `${name} carousels need at least ${rules.minCarousel} items.`, params: { min: rules.minCarousel }, field: "media" });
  if (!rules.mixed && videos.length && stills.length) errors.push({ code: "media_mixed", message: `${name} can't mix images and videos in one post.`, field: "media" });
  if (videos.length > rules.maxVideos) errors.push({ code: "video_count", message: `${name} allows ${rules.maxVideos === 1 ? "one video" : `${rules.maxVideos} videos`} per post.`, params: { max: rules.maxVideos }, field: "media" });
  for (const item of media) {
    if (item.kind === "video") {
      if (!rules.video) errors.push({ code: "media_type", message: `${name} doesn't accept videos here.`, field: `media:${item.id}` });
      else checkVideo(item, rules.video, name, errors, warnings);
    } else if (item.kind === "gif" && !rules.gif && !rules.image?.types.includes("image/gif")) {
      errors.push({ code: "media_type", message: `${name} doesn't accept GIFs.`, field: `media:${item.id}` });
    } else if (!rules.image) {
      errors.push({ code: "media_type", message: `${name} doesn't accept images here.`, field: `media:${item.id}` });
    } else {
      checkImage(item, rules.image, rules.gif?.maxBytes ?? null, name, (issue) => errors.push(issue));
    }
  }
}

/**
 * Checks a post's effective content for one platform: text length (as the platform counts it),
 * hashtags / mentions / links, media count, types, sizes, ratios and durations, post-type rules
 * (Instagram reels and stories, Facebook reels, YouTube), threads and first comments. `media` are
 * the items of content.mediaIds, in order (missing ids are reported). Errors block publishing;
 * warnings are shown in the composer.
 */
export function validatePostForChannel(content: PostContent, media: MediaInfo[], platform: Platform): ValidationResult {
  const caps = getCapabilities(platform);
  const name = caps.name;
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const byId = new Map(media.map((m) => [m.id, m]));
  const items = content.mediaIds.map((id) => byId.get(id)).filter((m): m is MediaInfo => Boolean(m));
  if (items.length < content.mediaIds.length) errors.push({ code: "media_missing", message: "An attached media item no longer exists in the library.", field: "media" });

  // Text
  const used = countChars(content.text, platform);
  const limit = items.length && caps.text.maxWithMedia ? caps.text.maxWithMedia : caps.text.max;
  if (used > caps.text.max) errors.push({ code: "text_too_long", message: `${name} allows ${caps.text.max.toLocaleString("en-US")} characters; this text has ${used.toLocaleString("en-US")}.`, params: { used, max: caps.text.max }, field: "text" });
  else if (used > limit) warnings.push({ code: "caption_split", message: `With media, ${name} captions are limited to ${limit.toLocaleString("en-US")} characters: the text is sent as a separate message.`, params: { used, max: limit }, field: "text" });
  if (!content.text.trim() && !items.length && !content.link) errors.push({ code: "empty", message: "Write some text or attach media.", field: "text" });
  if (caps.text.maxHashtags !== null) {
    const tags = extractHashtags(content.text).length;
    if (tags > caps.text.maxHashtags) errors.push({ code: "too_many_hashtags", message: `${name} allows up to ${caps.text.maxHashtags} hashtags (${tags} used).`, params: { count: tags, max: caps.text.maxHashtags }, field: "text" });
  }
  if (caps.text.maxMentions !== null) {
    const mentions = extractMentions(content.text).length;
    if (mentions > caps.text.maxMentions) errors.push({ code: "too_many_mentions", message: `${name} allows up to ${caps.text.maxMentions} mentions (${mentions} used).`, params: { count: mentions, max: caps.text.maxMentions }, field: "text" });
  }
  const urls = extractUrls(content.text);
  if (caps.text.maxLinks !== null && urls.length + (content.link && !urls.includes(content.link) ? 1 : 0) > caps.text.maxLinks) {
    errors.push({ code: "too_many_links", message: `${name} allows up to ${caps.text.maxLinks} links per post.`, params: { max: caps.text.maxLinks }, field: "text" });
  }

  // Links
  if (content.link && caps.links === "none") warnings.push({ code: "link_not_clickable", message: `Links aren't clickable on ${name}; the link isn't attached.`, field: "link" });
  if (content.link && caps.links === "card" && platform === "linkedin" && items.length) warnings.push({ code: "link_ignored_with_media", message: "LinkedIn shows either media or a link card: the media is posted and the link card is left out.", field: "link" });
  if (platform === "x" && caps.cost && (urls.length || content.link)) {
    warnings.push({ code: "x_url_cost", message: `Posts with a link cost $${caps.cost.perPostWithUrl.toFixed(2)} on the X API instead of $${caps.cost.perPost.toFixed(3)}.`, params: { cost: caps.cost.perPostWithUrl }, field: "text" });
  }

  // Media and post types
  const postType = postTypeOf(content, platform);
  const rules = mediaRulesFor(platform, postType);
  checkMedia(items, rules, postType && postType !== "feed" ? `${name} ${caps.postTypes?.[postType]?.label ?? postType}` : name, errors, warnings);
  if ((platform === "instagram" || platform === "instagram_login") && postType === "story" && content.text.trim()) {
    warnings.push({ code: "story_caption", message: "Instagram stories don't show captions.", field: "text" });
  }
  if (platform === "bluesky" || platform === "mastodon" || platform === "x") {
    if (items.some((m) => m.kind !== "video" && !m.altText.trim())) warnings.push({ code: "alt_text_missing", message: "Add alt text to images so everyone can enjoy them.", field: "media" });
  }

  // Platform options
  if (platform === "youtube") {
    const yt = content.options.youtube;
    if (!yt?.title.trim()) errors.push({ code: "youtube_title", message: "YouTube videos need a title (up to 100 characters).", field: "option:title" });
    const video = items.find((m) => m.kind === "video");
    if (video?.duration && video.duration <= 180 && video.width && video.height && video.height >= video.width) {
      warnings.push({ code: "youtube_short", message: "This vertical video of 3 minutes or less will be published as a Short.", field: "media" });
    }
  }
  if (platform === "tiktok" && !content.options.tiktok?.privacy) errors.push({ code: "tiktok_privacy", message: "Choose who can view the TikTok post.", field: "option:privacy" });
  if (platform === "pinterest" && !content.options.pinterest?.boardId) errors.push({ code: "pinterest_board", message: "Choose a Pinterest board.", field: "option:board" });

  // Threads and first comment
  if (content.thread.length) {
    if (!caps.threads.supported) {
      warnings.push({ code: "thread_unsupported", message: `${name} has no threads: only the first part is posted.`, field: "thread" });
    } else {
      if (content.thread.length + 1 > caps.threads.maxParts) errors.push({ code: "thread_too_long", message: `${name} threads can have up to ${caps.threads.maxParts} parts.`, params: { max: caps.threads.maxParts }, field: "thread" });
      content.thread.forEach((part, i) => {
        const n = countChars(part, platform);
        if (n > caps.text.max) errors.push({ code: "text_too_long", message: `Part ${i + 2} has ${n.toLocaleString("en-US")} characters; ${name} allows ${caps.text.max.toLocaleString("en-US")}.`, params: { used: n, max: caps.text.max, part: i + 2 }, field: `thread:${i + 2}` });
      });
    }
  }
  if (content.firstComment.trim()) {
    if (caps.firstComment === "none") warnings.push({ code: "first_comment_unsupported", message: `${name} doesn't support a first comment; it is skipped.`, field: "first_comment" });
    else {
      const n = countChars(content.firstComment, platform);
      if (n > caps.text.max) errors.push({ code: "first_comment_too_long", message: `The first comment has ${n.toLocaleString("en-US")} characters; ${name} allows ${caps.text.max.toLocaleString("en-US")}.`, params: { used: n, max: caps.text.max }, field: "first_comment" });
    }
  }
  return { errors, warnings, length: { used, limit: caps.text.max } };
}

// ── Time zones (Intl only) ──

const dtfCache = new Map<string, Intl.DateTimeFormat>();

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Current IANA names of zones that ICU (Node, some browsers) still reports under their old names. */
const TZ_ALIASES: Record<string, string> = {
  "Asia/Calcutta": "Asia/Kolkata",
  "Asia/Katmandu": "Asia/Kathmandu",
  "Asia/Rangoon": "Asia/Yangon",
  "Asia/Saigon": "Asia/Ho_Chi_Minh",
  "Europe/Kiev": "Europe/Kyiv",
  "Atlantic/Faeroe": "Atlantic/Faroe",
  "America/Godthab": "America/Nuuk",
  "Pacific/Truk": "Pacific/Chuuk",
  "Pacific/Ponape": "Pacific/Pohnpei",
  "Pacific/Enderbury": "Pacific/Kanton",
  "Etc/UTC": "UTC",
  "Etc/GMT": "UTC",
};

/** The current IANA name of a zone ("Asia/Calcutta" → "Asia/Kolkata"). */
export function canonicalTimeZone(tz: string): string {
  return TZ_ALIASES[tz] ?? tz;
}

/** A valid IANA time zone (current name) or `fallback` ("UTC"). */
export function normalizeTimeZone(v: unknown, fallback = "UTC"): string {
  return isValidTimeZone(v) ? canonicalTimeZone(v) : fallback;
}

function tzFormatter(tz: string): Intl.DateTimeFormat {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: isValidTimeZone(tz) ? tz : "UTC", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short" });
    dtfCache.set(tz, f);
  }
  return f;
}

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** ISO weekday 1–7. */
  weekday: number;
}

/** Wall-clock parts of an instant in a time zone. */
export function zonedParts(ms: number, tz: string): ZonedParts {
  const out: Record<string, string> = {};
  for (const p of tzFormatter(tz).formatToParts(new Date(ms))) if (p.type !== "literal") out[p.type] = p.value;
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour) % 24,
    minute: Number(out.minute),
    second: Number(out.second),
    weekday: WEEKDAYS[out.weekday] ?? 1,
  };
}

/** Local time minus UTC at an instant, in ms (e.g. +7,200,000 for Berlin in summer). */
export function tzOffsetMs(ms: number, tz: string): number {
  const p = zonedParts(ms, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

/**
 * The UTC instant of a local wall-clock time. Times skipped by a DST change (02:30 on a
 * spring-forward day) move forward by the gap (→ 03:30); repeated times (fall-back) resolve to
 * the first occurrence.
 */
export function zonedTimeToUtc(local: { year: number; month: number; day: number; hour: number; minute: number }, tz: string): number {
  const guess = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  const o1 = tzOffsetMs(guess - tzOffsetMs(guess, tz), tz);
  const o2 = tzOffsetMs(guess - o1, tz);
  // Candidates for both offsets around the change; prefer the earliest that maps back to the wall time.
  const candidates = [...new Set([guess - o1, guess - o2, guess - tzOffsetMs(guess - 86_400_000, tz), guess - tzOffsetMs(guess + 86_400_000, tz)])].sort((a, b) => a - b);
  for (const c of candidates) {
    const p = zonedParts(c, tz);
    if (p.year === local.year && p.month === local.month && p.day === local.day && p.hour === local.hour && p.minute === local.minute) return c;
  }
  // Skipped (spring-forward gap): use the offset from before the change, which lands after the gap.
  return guess - tzOffsetMs(guess - 86_400_000, tz);
}

/** "YYYY-MM-DD" of an instant in a time zone. */
export function localDay(ms: number, tz: string): string {
  const p = zonedParts(ms, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** "HH:MM" of an instant in a time zone. */
export function localTime(ms: number, tz: string): string {
  const p = zonedParts(ms, tz);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

/** Interprets "YYYY-MM-DDTHH:MM" (a datetime-local input) in a time zone; NaN when invalid. */
export function parseLocalDateTime(value: string, tz: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(value.trim());
  if (!m) return NaN;
  const [year, month, day, hour, minute] = m.slice(1).map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return NaN;
  return zonedTimeToUtc({ year, month, day, hour, minute }, tz);
}

/** Common time zones for selects (all of Intl's when available). */
export function timeZoneOptions(): string[] {
  const supported = (Intl as unknown as { supportedValuesOf?: (key: "timeZone") => string[] }).supportedValuesOf;
  try {
    const all = supported ? supported("timeZone") : [];
    if (all.length) return ["UTC", ...[...new Set(all.map(canonicalTimeZone))].filter((z) => z !== "UTC").sort()];
  } catch {
    // Older runtimes.
  }
  return ["UTC", "Europe/London", "Europe/Berlin", "Europe/Paris", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "America/Sao_Paulo", "Asia/Dubai", "Asia/Kolkata", "Asia/Singapore", "Asia/Tokyo", "Australia/Sydney"];
}

// ── Queue slots ──

export const MAX_QUEUE_SLOTS = 100;

export function normalizeTime(v: unknown): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(str(v));
  if (!m) return "";
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h <= 23 && min <= 59 ? `${String(h).padStart(2, "0")}:${m[2]}` : "";
}

/** Distinct, sorted weekly slots (day 1–7, "HH:MM"). Accepts [{day, time}] or ["1@09:00", …]. */
export function normalizeQueueSlots(v: unknown): QueueSlot[] {
  const raw = Array.isArray(v) ? v : typeof v === "string" ? (v.trim().startsWith("[") ? (parseJson(v) as unknown[]) : v.split(/[\s,]+/)) : [];
  const seen = new Set<string>();
  const out: QueueSlot[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    let day: number;
    let time: string;
    if (typeof item === "string") {
      const m = /^([1-7])@(\d{1,2}:\d{2})$/.exec(item.trim());
      if (!m) continue;
      day = Number(m[1]);
      time = normalizeTime(m[2]);
    } else {
      const o = asObj(item);
      const n = int(o.day, 0, -1, 99);
      day = n >= 1 && n <= 7 ? n : 0;
      time = normalizeTime(o.time);
    }
    if (day < 1 || !time) continue;
    const key = `${day}@${time}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ day, time });
  }
  return out.sort((a, b) => a.day - b.day || a.time.localeCompare(b.time)).slice(0, MAX_QUEUE_SLOTS);
}

/** Weekday slots at 09:00, 12:30 and 17:00: the default for new workspaces. */
export const DEFAULT_QUEUE_SLOTS: QueueSlot[] = [1, 2, 3, 4, 5].flatMap((day) => ["09:00", "12:30", "17:00"].map((time) => ({ day, time })));

const minuteKey = (ms: number) => Math.floor(ms / 60_000);

/**
 * The next free queue time: the first slot (in `tz`) strictly after `from` whose minute is not in
 * `taken` (ISO strings or epoch ms of posts already queued on the channel). Looks up to
 * `weeks` weeks ahead; null when there are no slots or all are taken. DST-safe: slots are
 * wall-clock times, converted with zonedTimeToUtc() for each day.
 */
export function nextQueueSlot(slots: QueueSlot[], tz: string, from: Date | number | string = Date.now(), taken: Iterable<string | number> = [], weeks = 12): string | null {
  const clean = normalizeQueueSlots(slots);
  if (!clean.length) return null;
  const zone = normalizeTimeZone(tz);
  const start = typeof from === "number" ? from : new Date(from).getTime();
  if (!Number.isFinite(start)) return null;
  const busy = new Set<number>();
  for (const t of taken) {
    const ms = typeof t === "number" ? t : Date.parse(t);
    if (Number.isFinite(ms)) busy.add(minuteKey(ms));
  }
  const byDay = new Map<number, string[]>();
  for (const s of clean) byDay.set(s.day, [...(byDay.get(s.day) ?? []), s.time]);

  const first = zonedParts(start, zone);
  // Walk local calendar days from the start day.
  const base = Date.UTC(first.year, first.month - 1, first.day);
  for (let i = 0; i <= weeks * 7; i++) {
    const d = new Date(base + i * 86_400_000);
    const weekday = d.getUTCDay() || 7;
    const times = byDay.get(weekday);
    if (!times) continue;
    for (const time of times) {
      const [hour, minute] = time.split(":").map(Number);
      const at = zonedTimeToUtc({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour, minute }, zone);
      if (at <= start || busy.has(minuteKey(at))) continue;
      return new Date(at).toISOString();
    }
  }
  return null;
}

// ── UTM links ──

export const DEFAULT_UTM: UtmSettings = { enabled: false, source: "{platform}", medium: "social", campaign: "" };

export function normalizeUtm(v: unknown, fallback: UtmSettings = DEFAULT_UTM): UtmSettings {
  const o = asObj(v);
  const clean = (x: unknown, d: string) => (typeof x === "string" ? x.trim().replace(/[^\w{}.~+-]/g, "_").slice(0, 100) : d);
  return { enabled: bool(o.enabled, fallback.enabled), source: clean(o.source, fallback.source), medium: clean(o.medium, fallback.medium), campaign: clean(o.campaign, fallback.campaign) };
}

/**
 * Adds utm_* parameters to an http(s) URL. Existing utm_* values are kept unless `overwrite`;
 * "{platform}" in a value is replaced with `platform`. Returns `url` unchanged when it isn't a
 * valid http(s) URL or no parameter is set.
 */
export function buildUtmUrl(
  url: string,
  utm: { source?: string; medium?: string; campaign?: string; term?: string; content?: string },
  options: { platform?: Platform | string; overwrite?: boolean } = {},
): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return url;
  let changed = false;
  for (const key of ["source", "medium", "campaign", "term", "content"] as const) {
    const raw = utm[key]?.trim();
    if (!raw) continue;
    const value = raw.replaceAll("{platform}", options.platform ?? "");
    if (!value) continue;
    const param = `utm_${key}`;
    if (u.searchParams.has(param) && !options.overwrite) continue;
    u.searchParams.set(param, value);
    changed = true;
  }
  return changed ? u.toString() : url;
}

/** Applies UTM settings to every http(s) link in a text (only when `utm.enabled`), except links `skip` returns true for. */
export function applyUtmToText(input: string, utm: UtmSettings, platform: Platform, skip?: (url: string) => boolean): string {
  if (!utm.enabled) return input;
  return input.replace(URL_RE, (m) => {
    const trail = (TRAILING_PUNCT.exec(m) ?? [""])[0];
    const url = trail ? m.slice(0, -trail.length) : m;
    return (skip?.(url) ? url : buildUtmUrl(url, utm, { platform })) + trail;
  });
}

/** How links are rewritten when a post is published (workspace / channel UTM, workspace short links). */
export interface LinkRewrite {
  utm: UtmSettings;
  shorten: boolean;
  /** A short URL of the real length (Site URL + /l/ + code), standing in for every shortened link. */
  shortUrlSample: string;
  /** Prefix of the site's own short links (left alone when publishing). */
  ownPrefix: string;
}

/**
 * A text with its links in their final form, for length checks before publishing: shortened
 * links when shortening is on (each counted as `shortUrlSample`), otherwise URL + UTM tags.
 */
export function finalLinkText(input: string, rw: LinkRewrite, platform: Platform): string {
  const isOwn = (url: string) => Boolean(rw.ownPrefix) && url.startsWith(rw.ownPrefix);
  if (rw.shorten) {
    let out = applyUtmToText(input, rw.utm, platform, isOwn);
    for (const url of new Set(extractUrls(out))) if (!isOwn(url)) out = out.split(url).join(rw.shortUrlSample);
    return out;
  }
  return applyUtmToText(input, rw.utm, platform, isOwn);
}

/** The character limit of a post's text: the caption limit with media where the network has one. */
export function textLimitFor(platform: Platform, hasMedia: boolean): number {
  const caps = getCapabilities(platform).text;
  return hasMedia && caps.maxWithMedia ? caps.maxWithMedia : caps.max;
}

/**
 * Warning when UTM tags or short links added at publish time would push the text (or a thread
 * part, or the first comment) over the network's limit while the text as written fits. The
 * engine then publishes that part with the original links (see effectiveContent in src/lib/engine).
 */
export function linkRewriteIssue(content: PostContent, platform: Platform, rw: LinkRewrite): ValidationIssue | null {
  if (!rw.utm.enabled && !rw.shorten) return null;
  const max = getCapabilities(platform).text.max;
  const parts: Array<[string, number, string]> = [[content.text, textLimitFor(platform, content.mediaIds.length > 0), "text"], ...content.thread.map((p, i): [string, number, string] => [p, max, `thread:${i + 2}`]), [content.firstComment, max, "first_comment"]];
  for (const [text, limit, field] of parts) {
    if (!text || !extractUrls(text).length || countChars(text, platform) > limit) continue;
    const used = countChars(finalLinkText(text, rw, platform), platform);
    if (used > limit) {
      return {
        code: "link_final_too_long",
        message: `With the UTM tags or short links added when publishing, this text would have ${used.toLocaleString("en-US")} characters; ${getCapabilities(platform).name} allows ${limit.toLocaleString("en-US")}. It will be posted with the original links instead.`,
        params: { used, max: limit },
        field,
      };
    }
  }
  return null;
}

// ── Workspaces, roles and settings ──

const ROLE_RANK: Record<WorkspaceRole, number> = { viewer: 0, approver: 1, editor: 2, admin: 3, owner: 4 };

export function isWorkspaceRole(v: unknown): v is WorkspaceRole {
  return typeof v === "string" && (WORKSPACE_ROLES as readonly string[]).includes(v);
}

export function isAssignableRole(v: unknown): v is AssignableRole {
  return typeof v === "string" && (ASSIGNABLE_ROLES as readonly string[]).includes(v);
}

/** True when `role` ranks at least `min` (viewer < approver < editor < admin < owner). */
export function roleAtLeast(role: WorkspaceRole, min: WorkspaceRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

const CAPABILITIES: Record<WorkspaceCapability, readonly WorkspaceRole[]> = {
  view: ["viewer", "approver", "editor", "admin", "owner"],
  comment: ["approver", "editor", "admin", "owner"],
  approve: ["approver", "admin", "owner"],
  "post.create": ["editor", "admin", "owner"],
  // Editors publish directly unless the workspace requires approval (see canPublishDirectly()).
  "post.publish": ["editor", "admin", "owner"],
  "media.manage": ["editor", "admin", "owner"],
  "channels.manage": ["admin", "owner"],
  "members.manage": ["admin", "owner"],
  "settings.manage": ["admin", "owner"],
  "workspace.delete": ["owner"],
};

export function roleCan(role: WorkspaceRole, capability: WorkspaceCapability): boolean {
  return CAPABILITIES[capability].includes(role);
}

/** Editors in a workspace that requires approval submit posts instead of scheduling them. */
export function canPublishDirectly(role: WorkspaceRole, settings: Pick<WorkspaceSettings, "approvalRequired">): boolean {
  if (!roleCan(role, "post.publish")) return false;
  return role !== "editor" || !settings.approvalRequired;
}

/** An admin can't change the owner or make someone owner; only the owner manages admins. */
export function canManageMember(actor: WorkspaceRole, member: WorkspaceRole, newRole?: WorkspaceRole): boolean {
  if (!roleCan(actor, "members.manage") || member === "owner" || newRole === "owner") return false;
  if (actor === "owner") return true;
  return member !== "admin" && newRole !== "admin";
}

function normalizeBranding(v: unknown): WorkspaceBranding {
  const o = asObj(v);
  const logo = str(o.logo, "", 500);
  return { companyName: str(o.companyName, "", 120), logo: /^(https?:\/\/|\/|[\w./-]+$)/.test(logo) ? logo : "", color: normalizeColor(o.color) };
}

export const DEFAULT_WORKSPACE_SETTINGS: WorkspaceSettings = {
  approvalRequired: false,
  defaultSlots: DEFAULT_QUEUE_SLOTS,
  weekStart: 1,
  utm: DEFAULT_UTM,
  shortenLinks: false,
  branding: { companyName: "", logo: "", color: "" },
};

/** workspaces.settings with defaults. */
export function normalizeWorkspaceSettings(input: unknown): WorkspaceSettings {
  const o = asObj(input);
  return {
    approvalRequired: bool(o.approvalRequired, DEFAULT_WORKSPACE_SETTINGS.approvalRequired),
    defaultSlots: "defaultSlots" in o ? normalizeQueueSlots(o.defaultSlots) : DEFAULT_QUEUE_SLOTS,
    weekStart: o.weekStart === 7 || o.weekStart === "7" ? 7 : 1,
    utm: normalizeUtm(o.utm),
    shortenLinks: bool(o.shortenLinks, false),
    branding: normalizeBranding(o.branding),
  };
}

export const DEFAULT_CHANNEL_SETTINGS: ChannelSettings = { defaultFirstComment: "", hashtags: "", utm: null, defaults: {} };

/** channels.settings with defaults (options of other platforms are dropped). */
export function normalizeChannelSettings(input: unknown, platform: Platform): ChannelSettings {
  const o = asObj(input);
  const defaults = normalizePlatformOptions(o.defaults);
  const key = platform === "instagram_login" ? "instagram" : platform;
  const own = (defaults as Record<string, unknown>)[key];
  return {
    defaultFirstComment: text(o.defaultFirstComment, 2000),
    hashtags: str(o.hashtags, "", 1000)
      .split(/\s+/)
      .map((t) => t.replace(/^#*/, ""))
      .filter((t) => /^[\p{L}\p{N}_]+$/u.test(t))
      .slice(0, 30)
      .map((t) => `#${t}`)
      .join(" "),
    utm: o.utm && typeof o.utm === "object" ? normalizeUtm(o.utm) : null,
    defaults: own ? ({ [key]: own } as PlatformOptions) : {},
  };
}

/** Post source from input ("manual" by default). */
export function normalizePostSource(v: unknown): PostSource {
  return oneOf(POST_SOURCES, v, "manual");
}

// ── Post status transitions ──

const POST_TRANSITIONS: Record<PostStatus, readonly PostStatus[]> = {
  draft: ["draft", "pending_approval", "scheduled", "publishing"],
  pending_approval: ["pending_approval", "approved", "draft", "scheduled"],
  approved: ["approved", "scheduled", "draft", "publishing"],
  scheduled: ["scheduled", "draft", "publishing", "pending_approval"],
  publishing: ["publishing", "published", "partially_failed", "failed"],
  published: [],
  partially_failed: ["scheduled", "publishing"],
  failed: ["scheduled", "draft", "publishing"],
};

/** Allowed post status changes (rescheduling = scheduled → scheduled). Published posts are final. */
export function canTransition(from: PostStatus, to: PostStatus): boolean {
  return POST_TRANSITIONS[from].includes(to);
}

/** Posts whose content and targets may still be edited. */
export function isEditable(status: PostStatus): boolean {
  return status === "draft" || status === "pending_approval" || status === "approved" || status === "scheduled" || status === "failed";
}

/**
 * The post status implied by its targets once publishing started: all published → published;
 * none published and all finished → failed; some published, others failed → partially_failed;
 * anything still queued or in flight → publishing. Cancelled targets are ignored.
 */
export function aggregatePostStatus(targets: ReadonlyArray<TargetStatus>): PostStatus {
  const live = targets.filter((s) => s !== "cancelled");
  if (!live.length) return "failed";
  const published = live.filter((s) => s === "published").length;
  const failed = live.filter((s) => s === "failed" || s === "needs_reauth").length;
  if (published === live.length) return "published";
  if (published + failed < live.length) return "publishing";
  return published ? "partially_failed" : "failed";
}

/** Retry delay of the publishing engine: 1, 5, 15, 60 min (then 60). */
export function retryDelayMs(attempt: number, retryAfterMs?: number | null): number {
  const steps = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
  const base = steps[Math.min(Math.max(attempt, 1), steps.length) - 1];
  return retryAfterMs && retryAfterMs > base ? Math.min(retryAfterMs, 24 * 3_600_000) : base;
}

export const MAX_PUBLISH_ATTEMPTS = 5;

// ── Notification channels ──

export function isNotifyChannelType(v: unknown): v is NotifyChannelType {
  return typeof v === "string" && (NOTIFY_CHANNEL_TYPES as readonly string[]).includes(v);
}

export function normalizeNotifyEvents(v: unknown): NotifyEvent[] {
  if (!Array.isArray(v)) return [...DEFAULT_NOTIFY_EVENTS];
  return NOTIFY_EVENTS.filter((e) => e !== "test" && v.includes(e));
}

export function normalizeNotifyConfig<T extends NotifyChannelType>(type: T, input: unknown): NotifyConfigByType[T] {
  const o = asObj(input);
  let out: unknown;
  switch (type) {
    case "email":
      out = {
        to: str(o.to, "", 1000)
          .split(/[,;\s]+/)
          .filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))
          .slice(0, 10)
          .join(", "),
      };
      break;
    case "webhook":
      out = { url: httpUrl(o.url), secret: str(o.secret, "", 200) };
      break;
    case "slack":
    case "discord":
    case "teams":
      out = { webhookUrl: httpUrl(o.webhookUrl) };
      break;
    case "telegram":
      out = { botToken: str(o.botToken, "", 100).replace(/[^A-Za-z0-9:_-]/g, ""), chatId: str(o.chatId, "", 40).replace(/[^0-9@A-Za-z_-]/g, "") };
      break;
  }
  return out as NotifyConfigByType[T];
}

export function notifyConfigProblem(type: NotifyChannelType, config: unknown): string {
  const c = asObj(config);
  if (type === "email" && !c.to) return "Enter at least one valid email address.";
  if (type === "webhook" && !c.url) return "Enter the webhook URL (https://…).";
  if ((type === "slack" || type === "discord" || type === "teams") && !c.webhookUrl) return "Paste the incoming webhook URL.";
  if (type === "telegram" && (!c.botToken || !c.chatId)) return "Enter the bot token and the chat ID.";
  return "";
}
