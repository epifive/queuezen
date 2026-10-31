/**
 * Display helpers shared by server and client components (dashboard, previews, emails): platform
 * names, colours and icons, status tones, limits and money. Dependency-free.
 *
 * Platform icons are simple original glyphs drawn for Queuezen (24 × 24, stroke 2, round caps):
 * generic shapes or letter marks, not the networks' trademarked logos. Render them with
 * <PlatformIcon> (src/components/social/platform-icon.tsx) or platformIconSvg() in emails.
 */

import { PLATFORM_CAPABILITIES } from "./platforms";
import type { ChannelStatus, Platform, PostStatus, TargetStatus } from "./types";

export interface PlatformStyle {
  /** Brand colour used for the icon tile and preview accents. */
  color: string;
  /** Text colour on the brand colour. */
  onColor: string;
  /** SVG path data of the glyph (stroked, 24 × 24 view box). */
  glyph: string[];
}

export const PLATFORM_STYLES: Record<Platform, PlatformStyle> = {
  facebook: { color: "#1877f2", onColor: "#ffffff", glyph: ["M14.5 6.5H13a2.5 2.5 0 0 0-2.5 2.5v9.5", "M8.5 12h5"] },
  instagram: {
    color: "#d62976",
    onColor: "#ffffff",
    glyph: ["M8 5h8a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3z", "M12 9.25a2.75 2.75 0 1 1 0 5.5a2.75 2.75 0 1 1 0-5.5z", "M16 8h.01"],
  },
  instagram_login: {
    color: "#c13584",
    onColor: "#ffffff",
    glyph: ["M8 5h8a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3z", "M12 9.25a2.75 2.75 0 1 1 0 5.5a2.75 2.75 0 1 1 0-5.5z", "M16 8h.01"],
  },
  threads: { color: "#101010", onColor: "#ffffff", glyph: ["M15 12a3 3 0 1 1-3-3a3 3 0 0 1 3 3v1.25a1.75 1.75 0 0 0 3.5 0V12a6.5 6.5 0 1 0-2.6 5.2"] },
  x: { color: "#0f1419", onColor: "#ffffff", glyph: ["M7 7l10 10", "M17 7L7 17"] },
  linkedin: { color: "#0a66c2", onColor: "#ffffff", glyph: ["M8 10.5V17", "M8 7.5v.01", "M11.5 17v-6.5", "M11.5 13a2.5 2.5 0 0 1 5 0v4"] },
  youtube: { color: "#ff0000", onColor: "#ffffff", glyph: ["M7.5 6.5h9A2.5 2.5 0 0 1 19 9v6a2.5 2.5 0 0 1-2.5 2.5h-9A2.5 2.5 0 0 1 5 15V9a2.5 2.5 0 0 1 2.5-2.5z", "M10.5 9.75v4.5L14.25 12z"] },
  bluesky: { color: "#1185fe", onColor: "#ffffff", glyph: ["M7.75 17.5h8.5a3.25 3.25 0 0 0 .4-6.48a4.75 4.75 0 0 0-9.1-1.1a3.8 3.8 0 0 0 .2 7.58z"] },
  mastodon: { color: "#6364ff", onColor: "#ffffff", glyph: ["M7 17v-6.5", "M7 12.5a2.5 2.5 0 0 1 5 0V17", "M12 12.5a2.5 2.5 0 0 1 5 0V17"] },
  telegram: { color: "#229ed9", onColor: "#ffffff", glyph: ["M18.5 5.5L5 11l5 2", "M18.5 5.5L16 18l-6-5", "M18.5 5.5L10 13v4l2.5-2.5"] },
  discord: { color: "#5865f2", onColor: "#ffffff", glyph: ["M7 5.5h10A2 2 0 0 1 19 7.5v6.5a2 2 0 0 1-2 2h-5.5L8 19v-3H7a2 2 0 0 1-2-2V7.5a2 2 0 0 1 2-2z", "M9.5 10.75h.01", "M14.5 10.75h.01"] },
  tiktok: { color: "#111111", onColor: "#ffffff", glyph: ["M13.5 5.5v9a3 3 0 1 1-3-3", "M13.5 5.5a4 4 0 0 0 4 4"] },
  pinterest: { color: "#e60023", onColor: "#ffffff", glyph: ["M12 4.5a5 5 0 0 1 5 5c0 2.76-2.24 4.5-5 4.5s-5-1.74-5-4.5a5 5 0 0 1 5-5z", "M11 13.5L9.5 19.5"] },
};

export function platformName(platform: Platform): string {
  return PLATFORM_CAPABILITIES[platform].name;
}

/** Short name for tight spots ("Instagram" for both Instagram APIs). */
export function platformShortName(platform: Platform): string {
  return platform === "instagram_login" ? "Instagram" : PLATFORM_CAPABILITIES[platform].name;
}

/** Standalone SVG markup of a platform tile (emails, OG images). */
export function platformIconSvg(platform: Platform, size = 24): string {
  const s = PLATFORM_STYLES[platform];
  const paths = s.glyph.map((d) => `<path d="${d}"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="${s.color}"/><g fill="none" stroke="${s.onColor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</g></svg>`;
}

/** Translator shape accepted by these helpers (server getT() and client useT() both fit). */
type LimitT = (key: "pricing.unlimited") => string;

/** 0 → "Unlimited", otherwise a grouped number. */
export function formatLimit(value: number, t: LimitT, locale?: string): string {
  return value ? value.toLocaleString(locale) : t("pricing.unlimited");
}

const TONE = {
  neutral: "bg-line/70 text-muted",
  info: "bg-primary-soft text-primary",
  good: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  warn: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  bad: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
} as const;

/** Tailwind classes of a post status badge. */
export function postStatusTone(status: PostStatus): string {
  switch (status) {
    case "published":
      return TONE.good;
    case "scheduled":
    case "approved":
      return TONE.info;
    case "pending_approval":
    case "partially_failed":
    case "publishing":
      return TONE.warn;
    case "failed":
      return TONE.bad;
    default:
      return TONE.neutral;
  }
}

/** Tailwind classes of a target (one channel of a post) status badge. */
export function targetStatusTone(status: TargetStatus): string {
  if (status === "published") return TONE.good;
  if (status === "failed" || status === "needs_reauth") return TONE.bad;
  if (status === "scheduled") return TONE.info;
  if (status === "pending" || status === "cancelled") return TONE.neutral;
  return TONE.warn;
}

/** Tailwind classes of a channel status badge. */
export function channelStatusTone(status: ChannelStatus): string {
  if (status === "active") return TONE.good;
  if (status === "expired" || status === "error") return TONE.bad;
  return TONE.neutral;
}

const plainSymbols = new Map<string, string>();

/**
 * The sign English shows for a currency when it is a plain, unambiguous sign ($, €, £, ¥, ₹ …),
 * else "". CA$, A$ or CN¥ stay as they are, and so do letter codes (AED).
 */
function plainSymbol(currency: string): string {
  const code = currency.toUpperCase();
  let symbol = plainSymbols.get(code);
  if (symbol === undefined) {
    try {
      const sign = (currencyDisplay: "narrowSymbol" | "symbol") =>
        new Intl.NumberFormat("en", { style: "currency", currency: code, currencyDisplay }).formatToParts(1).find((p) => p.type === "currency")?.value ?? "";
      const narrow = sign("narrowSymbol");
      symbol = narrow === sign("symbol") && !/[A-Za-z]/.test(narrow) ? narrow : "";
    } catch {
      symbol = "";
    }
    plainSymbols.set(code, symbol);
  }
  return symbol;
}

/**
 * Intl currency formatting in the reader's language with the plain sign where there is one
 * (some languages spell even common signs out, "US$" in Arabic). Throws like Intl.NumberFormat
 * on an unknown currency.
 */
export function formatCurrency(value: number, currency: string, locale: string, options: Intl.NumberFormatOptions = {}): string {
  const symbol = plainSymbol(currency);
  const nf = new Intl.NumberFormat(locale, { style: "currency", currency, ...(symbol ? { currencyDisplay: "narrowSymbol" } : {}), ...options });
  if (!symbol) return nf.format(value);
  return nf
    .formatToParts(value)
    .map((p) => (p.type === "currency" ? symbol : p.value))
    .join("");
}
