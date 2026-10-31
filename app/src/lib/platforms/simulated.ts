import { PLATFORM_CAPABILITIES } from "@/social/platforms";
import { DriverError, PLATFORMS, type ConnectedAccount, type DriverContext, type MetricsResult, type Platform, type PostMetrics, type SocialDriver } from "@/social/types";
import type { PlatformDriver } from "./extras";
import { asRecord, asString, sleep, type PublishResultWithUsage } from "./http";

/**
 * Simulated driver for every platform (DEMO_MODE, or Admin → Platforms → "Simulated platforms"
 * for testing). Nothing leaves the server:
 * - connect: a local fake consent page (/api/oauth/<platform>/simulate) lists 1-3 fake accounts;
 * - publish: succeeds after a short delay with a fake permalink (https://example.social/…);
 *   about 3% of publications fail once with a retryable error (deterministic by target id), so
 *   the retry UI can be seen;
 * - metrics: plausible numbers that grow with the post's age.
 */

/** FNV-1a: a small deterministic hash for fake data. */
export function simHash(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const BRANDS = [
  ["Northwind Coffee", "northwindcoffee"],
  ["Bluebird Studio", "bluebird.studio"],
  ["Acme Outdoors", "acmeoutdoors"],
  ["Lumen Labs", "lumenlabs"],
  ["Harbor Bakery", "harborbakery"],
  ["Pixel & Pine", "pixelandpine"],
  ["Orbit Fitness", "orbitfitness"],
  ["Maple Street Books", "maplestreetbooks"],
] as const;

const COLORS = ["#4338ca", "#0e7490", "#b45309", "#be185d", "#15803d", "#7c3aed", "#b91c1c", "#0369a1"];

/** Initials avatar as an SVG data URI (no network, fits the avatar column). */
export function simAvatar(name: string): string {
  const initials = name
    .split(/\s+/)
    .filter((w) => /^[A-Za-z]/.test(w))
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");
  const color = COLORS[simHash(name) % COLORS.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><rect width="96" height="96" rx="48" fill="${color}"/><text x="48" y="58" font-family="Arial,sans-serif" font-size="34" font-weight="700" fill="#fff" text-anchor="middle">${initials}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function handleFor(platform: Platform, slug: string): string {
  if (platform === "mastodon") return `@${slug.replace(/\./g, "")}@example.social`;
  if (platform === "bluesky") return `@${slug.replace(/\./g, "-")}.bsky.social`;
  if (platform === "telegram") return `@${slug.replace(/\./g, "_")}`;
  if (platform === "discord") return "#announcements";
  if (platform === "linkedin") return "";
  return `@${slug}`;
}

/** The fake accounts the consent page offers to a workspace (stable, so reconnecting updates them). */
export function simulatedAccounts(platform: Platform, workspaceId: number, nowMs: number): ConnectedAccount[] {
  const seed = simHash(`${platform}:${workspaceId}`);
  const count = platform === "facebook" || platform === "instagram" ? 2 + (seed % 2) : 1 + (seed % 3);
  const ttl = PLATFORM_CAPABILITIES[platform].auth.accessTtl;
  return Array.from({ length: count }, (_, i) => {
    const [brand, slug] = BRANDS[(seed + i * 3) % BRANDS.length];
    const name = platform === "linkedin" ? ["Alex Morgan", "Priya Shah", "Sam Lee"][i % 3] : brand;
    const handle = handleFor(platform, slug);
    const externalId = `sim-${platform}-${workspaceId}-${(seed + i) % 100_000}`;
    const expiresAt = ttl ? new Date(nowMs + ttl * 1000).toISOString() : null;
    return {
      externalId,
      name,
      handle,
      avatarUrl: simAvatar(name),
      profileUrl: `https://example.social/${platform}/${encodeURIComponent(slug)}`,
      credentials: { accessToken: `sim_${externalId}_${nowMs.toString(36)}`, refreshToken: ttl ? `simr_${externalId}` : undefined, expiresAt },
      tokenExpiresAt: expiresAt,
      meta: { simulated: true, followers: 500 + ((seed >> (i * 3)) % 25_000) },
    };
  });
}

/** True for about 3% of targets, on their first attempt only (the retry then succeeds). */
export function simShouldFail(targetId: number, attempt: number): boolean {
  return attempt <= 1 && simHash(`target:${targetId}`) % 100 < 3;
}

const FAILURES: Array<{ message: string; kind: "network" | "rate_limit" }> = [
  { message: "Simulated: the network timed out. It will be retried.", kind: "network" },
  { message: "Simulated: rate limit reached (429). It will be retried.", kind: "rate_limit" },
  { message: "Simulated: the platform returned 503 Service Unavailable.", kind: "network" },
];

/**
 * The audience of a channel for simulated metrics (from channel.meta, set by the demo seeder):
 * followers scale the reach, `audienceTz` gives weekday / hour seasonality (posts at lunch and in
 * the evening on weekdays do best) and `audienceSince` a slow growth trend. Without them the
 * numbers are plain hash-based noise.
 */
export interface SimAudience {
  followers?: number;
  timeZone?: string;
  since?: string;
}

export function simAudience(meta: Record<string, unknown>): SimAudience {
  const followers = typeof meta.followers === "number" && meta.followers > 0 ? meta.followers : undefined;
  const timeZone = typeof meta.audienceTz === "string" ? meta.audienceTz : undefined;
  const since = typeof meta.audienceSince === "string" ? meta.audienceSince : undefined;
  return { followers, timeZone, since };
}

const tzFormats = new Map<string, Intl.DateTimeFormat>();
const WEEKDAY_INDEX: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
const DAY_FACTOR = [1.0, 1.12, 1.2, 1.1, 0.92, 0.68, 0.6];

/** Engagement multiplier of a publication time in the audience's time zone (about 0.4 to 1.9). */
export function simSeason(publishedMs: number, timeZone: string): number {
  let fmt = tzFormats.get(timeZone);
  if (!fmt) {
    try {
      fmt = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    } catch {
      fmt = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    }
    tzFormats.set(timeZone, fmt);
  }
  let day = 0;
  let hour = 12;
  for (const p of fmt.formatToParts(new Date(publishedMs))) {
    if (p.type === "weekday") day = WEEKDAY_INDEX[p.value] ?? 0;
    if (p.type === "hour") hour = Number(p.value) % 24;
    if (p.type === "minute") hour += Number(p.value) / 60;
  }
  const bell = (center: number, width: number) => Math.exp(-((hour - center) ** 2) / (2 * width * width));
  return DAY_FACTOR[day] * (0.42 + 1.05 * bell(12.5, 1.5) + 0.9 * bell(19, 1.7) + 0.3 * bell(8.5, 1.1));
}

/** Engagement metrics that grow over ~48 h after publishing and then flatten. */
export function simMetrics(platform: Platform, externalId: string, publishedAt: string, nowMs: number, audience: SimAudience = {}): PostMetrics {
  const fields = PLATFORM_CAPABILITIES[platform].analytics.fields;
  if (!fields.length) return {};
  const h = simHash(externalId);
  const publishedMs = Date.parse(publishedAt);
  const ageH = Math.max(0, (nowMs - publishedMs) / 3_600_000);
  const growth = 1 - Math.exp(-ageH / 18);
  let reach: number;
  let rate: number;
  if (audience.followers) {
    const season = audience.timeZone && Number.isFinite(publishedMs) ? simSeason(publishedMs, audience.timeZone) : 1;
    const sinceMs = audience.since ? Date.parse(audience.since) : NaN;
    const trend = Number.isFinite(sinceMs) && Number.isFinite(publishedMs) ? 1 + 0.8 * Math.min(1.3, Math.max(0, (publishedMs - sinceMs) / (100 * 86_400_000))) : 1;
    reach = Math.round(audience.followers * 0.1 * (0.78 + (h % 45) / 100) * season * trend);
    rate = 0.028 + ((h >> 8) % 16) / 1000;
  } else {
    reach = 200 + (h % 4_800);
    rate = 0.01 + ((h >> 8) % 40) / 1000;
  }
  const views = Math.round(reach * (1.3 + (h % 70) / 100) * growth);
  const out: PostMetrics = {};
  for (const f of fields) {
    const n =
      f === "views" || f === "impressions"
        ? views
        : f === "reach"
          ? Math.round(reach * growth)
          : f === "likes"
            ? Math.round(views * rate)
            : f === "comments"
              ? Math.round(views * rate * 0.12)
              : f === "shares"
                ? Math.round(views * rate * 0.08)
                : f === "saves"
                  ? Math.round(views * rate * 0.1)
                  : f === "clicks"
                    ? Math.round(views * rate * 0.6)
                    : Math.round(views * rate * 0.03);
    out[f] = n;
  }
  return out;
}

function simulateUrl(ctx: DriverContext): string {
  return ctx.redirectUri.replace(/\/callback$/, "/simulate");
}

export function createSimulatedDriver(platform: Platform): PlatformDriver {
  return {
    platform,
    async connectStart(ctx, input) {
      const u = new URL(simulateUrl(ctx));
      u.searchParams.set("state", input.state);
      return { kind: "redirect", url: u.toString() };
    },
    async connectFinish(ctx, input) {
      if (input.query.error) throw new DriverError("The connection was cancelled.", "auth", { platform, code: input.query.error });
      if (!/^sim\./.test(input.query.code ?? "")) throw new DriverError("No authorization code was returned.", "auth", { platform });
      const all = simulatedAccounts(platform, input.workspaceId, ctx.now());
      const wanted = (input.query.code ?? "").split(".").slice(1).filter(Boolean);
      const picked = wanted.length ? all.filter((a) => wanted.includes(a.externalId)) : all;
      return picked.length ? picked : all;
    },
    async refresh(ctx, channel) {
      const { accessTtl: ttl, refresh } = PLATFORM_CAPABILITIES[platform].auth;
      // Like the real network: LinkedIn profiles can't be refreshed (re-auth reminders instead).
      if (!ttl || refresh === "reauth" || refresh === "none") return null;
      const expiresAt = new Date(ctx.now() + ttl * 1000).toISOString();
      return { credentials: { ...channel.credentials, accessToken: `sim_${channel.externalId}_${ctx.now().toString(36)}`, expiresAt }, tokenExpiresAt: expiresAt };
    },
    async testConnection(_ctx, channel) {
      return { ok: true, account: { name: channel.name, handle: channel.handle, meta: { ...channel.meta, simulated: true } } };
    },
    async publish(ctx, input): Promise<PublishResultWithUsage> {
      const done = asRecord(input.target.uploadState.published);
      if (done.id) return { externalId: asString(done.id), permalink: asString(done.permalink) };
      await sleep(ctx, 300 + (simHash(`delay:${input.target.id}`) % 1200));
      if (simShouldFail(input.target.id, input.target.attempt)) {
        const f = FAILURES[simHash(`kind:${input.target.id}`) % FAILURES.length];
        throw new DriverError(f.message, f.kind, { platform, retryable: true, retryAfterMs: 60_000, code: "simulated" });
      }
      const id = `${platform}-${input.target.id}-${simHash(`${input.target.id}:${input.target.postId}`).toString(36)}`;
      const slug = (input.channel.handle || input.channel.name).replace(/^[@#]/, "").replace(/[^a-z0-9._-]+/gi, "-").toLowerCase() || "account";
      const permalink = `https://example.social/${platform}/${slug}/${id}`;
      await input.saveState({ published: { id, permalink } });
      // Like the real networks: only platforms with threads post the extra parts.
      const threadIds = PLATFORM_CAPABILITIES[platform].threads.supported ? input.content.thread.filter((p) => p.trim()).map((_, i) => `${id}-t${i + 1}`) : [];
      const firstCommentId = input.content.firstComment.trim() && PLATFORM_CAPABILITIES[platform].firstComment !== "none" ? `${id}-c` : undefined;
      const cost = PLATFORM_CAPABILITIES[platform].cost;
      return {
        externalId: id,
        permalink,
        threadIds: threadIds.length ? threadIds : undefined,
        firstCommentId,
        usage: {
          posts: 1 + threadIds.length + (firstCommentId ? 1 : 0),
          ...(cost ? { costMicros: Math.round(cost.perPost * 1_000_000) * (1 + threadIds.length + (firstCommentId ? 1 : 0)) } : {}),
          ...(platform === "youtube" ? { uploads: 1 } : {}),
        },
      };
    },
    async deleteRemote() {
      // Nothing to delete on a simulated network.
    },
    async fetchMetrics(ctx, channel, items): Promise<MetricsResult[]> {
      if (!PLATFORM_CAPABILITIES[platform].analytics.supported) return [];
      const audience = simAudience(channel.meta);
      return items.map((i) => ({ externalId: i.externalId, metrics: simMetrics(platform, i.externalId, i.publishedAt, ctx.now(), audience) }));
    },
    async findExisting(_ctx, input) {
      const done = asRecord(input.uploadState.published);
      return done.id ? { externalId: asString(done.id), permalink: asString(done.permalink) } : null;
    },
    async revoke() {
      return true;
    },
  };
}

export const SIMULATED_DRIVERS: Record<Platform, SocialDriver> = Object.fromEntries(PLATFORMS.map((p) => [p, createSimulatedDriver(p)])) as Record<Platform, SocialDriver>;
