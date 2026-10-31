import "server-only";
import { getDb } from "./db";

/**
 * Every configurable option with its default value. Values are stored as
 * strings in the `settings` table; the type of the default decides how the
 * stored value is parsed.
 */
export const SETTING_DEFAULTS = {
  // General
  site_name: "Queuezen",
  site_tagline: "Plan, approve and publish social posts everywhere",
  site_url: "",
  site_email: "support@example.com",
  logo: "",
  logo_dark: "",
  favicon: "",
  footer_text: "Social media scheduling, approvals and analytics for creators, teams and agencies.",
  copyright_text: "© {year} {site_name}. All rights reserved.",

  // Appearance
  primary_color: "#4338ca",
  default_theme: "system",
  home_hero_title: "Plan once. Publish everywhere. On time.",
  home_hero_subtitle:
    "Write a post once, adapt it for every network, get it approved and let the queue publish it at the right time, with first comments, threads and analytics built in.",
  show_stats_on_home: true,

  // SEO
  meta_title: "Queuezen — Social Media Scheduler for Teams & Agencies",
  meta_description:
    "Schedule posts to Facebook, Instagram, Threads, X, LinkedIn, YouTube, Bluesky, Mastodon, Telegram and Discord with a calendar, queue slots, approvals, first comments and analytics.",
  og_image: "",
  google_site_verification: "",
  bing_site_verification: "",
  robots_extra: "",
  title_separator: " | ",

  // Scheduler and branding
  branding_text: "Powered by Queuezen",
  branding_url: "",
  /** Run background jobs (publishing, token refresh, RSS, analytics) on page views when no cron job ran for a minute. */
  lazy_scheduler: true,

  // AI assistant (Admin → Settings → AI)
  /** "none", "openai" (any OpenAI-compatible endpoint: OpenAI, Groq, OpenRouter, Ollama…) or "anthropic". */
  ai_provider: "none",
  ai_base_url: "https://api.openai.com/v1",
  ai_api_key: "",
  ai_model: "",
  ai_anthropic_key: "",
  ai_anthropic_model: "claude-opus-5-5",
  ai_max_tokens: 1024,
  /** Requests per member per minute (on top of the plan's monthly cap). */
  ai_rate_per_minute: 10,

  // Automation (Admin → Settings → Automation)
  rss_min_interval_minutes: 15,
  rss_max_items_per_run: 10,
  rss_max_feeds: 20,
  recycle_enabled: true,
  metrics_enabled: true,
  /** Analytics are fetched for posts published in the last N days. */
  metrics_days: 30,
  /** Published posts per channel fetched in one run (respects the networks' rate limits). */
  metrics_batch_size: 50,

  // Media storage (Admin → Settings → Media storage). Env S3_* / BLOB_READ_WRITE_TOKEN override these.
  /** "local" (storage/uploads on this server), "s3" (S3, R2, MinIO, Wasabi…) or "blob" (Vercel Blob). */
  storage_driver: "local",
  /** S3 API endpoint, e.g. https://<account>.r2.cloudflarestorage.com ("" = AWS S3 for the region). */
  s3_endpoint: "",
  s3_region: "us-east-1",
  s3_bucket: "",
  s3_access_key: "",
  s3_secret_key: "",
  /** Public base URL of the bucket (custom domain / r2.dev / CDN), "" = the endpoint URL. */
  s3_public_url: "",
  /** Path-style URLs (endpoint/bucket/key): needed for MinIO and most self-hosted S3. */
  s3_path_style: false,
  /** Vercel Blob read-write token (BLOB_READ_WRITE_TOKEN). */
  blob_token: "",
  /** Largest image / video a user may upload, in MB. */
  media_max_image_mb: 20,
  media_max_video_mb: 500,
  /** Media library size per workspace owner, in MB (0 = unlimited). */
  media_quota_mb: 0,

  // Social platforms (Admin → Platforms): the operator's developer apps.
  /** Meta app (Facebook Pages + Instagram with Facebook Login). */
  meta_app_id: "",
  meta_app_secret: "",
  /** Facebook Login for Business configuration id ("" = plain scopes). */
  meta_config_id: "",
  /** Instagram API with Instagram Login: the Instagram app id / secret of the same Meta app. */
  instagram_app_id: "",
  instagram_app_secret: "",
  /** Threads: the Threads app id / secret of the Meta app. */
  threads_app_id: "",
  threads_app_secret: "",
  x_client_id: "",
  x_client_secret: "",
  /** Monthly X API budget in USD for the spend meter (0 = no budget shown). */
  x_monthly_budget: 0,
  linkedin_client_id: "",
  linkedin_client_secret: "",
  /** LinkedIn-Version header (YYYYMM, "" = the built-in default). */
  linkedin_api_version: "",
  /** Google Cloud OAuth client for YouTube. */
  google_client_id: "",
  google_client_secret: "",
  /** Every platform uses the Simulated driver (testing only; DEMO_MODE forces it on). */
  platforms_simulated: false,

  // Custom code
  custom_head_code: "",
  custom_body_code: "",

  // Cookie consent
  cookie_consent_enabled: true,
  cookie_consent_text:
    "We use cookies to keep you signed in and to understand how the site is used. By continuing you agree to our use of cookies.",

  // Language
  default_language: "en",

  // Blog
  blog_enabled: true,

  // Users
  registration_enabled: true,

  // Payments
  currency: "USD",
  stripe_enabled: false,
  stripe_secret_key: "",
  stripe_webhook_secret: "",
  paypal_enabled: false,
  paypal_mode: "sandbox",
  paypal_client_id: "",
  paypal_secret: "",
  razorpay_enabled: false,
  razorpay_key_id: "",
  razorpay_key_secret: "",
  offline_enabled: false,
  offline_instructions:
    "Transfer the amount to the bank account below and enter the transaction reference.\n\nBank: Example Bank\nAccount name: Your Company\nAccount number: 0000000000",

  // Email
  mail_enabled: false,
  smtp_host: "",
  smtp_port: 587,
  smtp_secure: false,
  smtp_user: "",
  smtp_pass: "",
  mail_from_name: "Queuezen",
  mail_from_address: "no-reply@example.com",

  // Contact
  contact_enabled: true,

  // Maintenance
  maintenance_mode: false,
  maintenance_message: "We are performing scheduled maintenance. Please check back soon.",
};

export type Settings = typeof SETTING_DEFAULTS;
export type SettingKey = keyof Settings;

/** Settings that must never be sent to the browser. */
export const SECRET_SETTINGS: SettingKey[] = [
  "stripe_secret_key",
  "stripe_webhook_secret",
  "paypal_secret",
  "razorpay_key_secret",
  "smtp_pass",
  "ai_api_key",
  "ai_anthropic_key",
  "s3_secret_key",
  "blob_token",
  "meta_app_secret",
  "instagram_app_secret",
  "threads_app_secret",
  "x_client_secret",
  "linkedin_client_secret",
  "google_client_secret",
];

const globalForSettings = globalThis as unknown as { __queuezenSettings?: Settings };

function parse<K extends SettingKey>(key: K, raw: string | null): Settings[K] {
  const fallback = SETTING_DEFAULTS[key];
  if (raw === null || raw === undefined) return fallback;
  if (typeof fallback === "boolean") return (raw === "1" || raw === "true") as Settings[K];
  if (typeof fallback === "number") {
    const n = Number(raw);
    return (Number.isFinite(n) ? n : fallback) as Settings[K];
  }
  return raw as Settings[K];
}

export async function getSettings(): Promise<Settings> {
  if (globalForSettings.__queuezenSettings) return globalForSettings.__queuezenSettings;
  const db = await getDb();
  const rows = await db.selectFrom("settings").selectAll().execute();
  const settings: Settings = { ...SETTING_DEFAULTS };
  const record = settings as Record<string, unknown>;
  for (const row of rows) {
    if (row.key in SETTING_DEFAULTS) {
      record[row.key] = parse(row.key as SettingKey, row.value);
    }
  }
  globalForSettings.__queuezenSettings = settings;
  return settings;
}

function serialize(value: unknown): string {
  if (typeof value === "boolean") return value ? "1" : "0";
  return String(value ?? "");
}

export async function updateSettings(values: Partial<Settings>): Promise<void> {
  const db = await getDb();
  await db.transaction().execute(async (trx) => {
    for (const [key, value] of Object.entries(values)) {
      if (!(key in SETTING_DEFAULTS)) continue;
      const serialized = serialize(value);
      const updated = await trx
        .updateTable("settings")
        .set({ value: serialized })
        .where("key", "=", key)
        .executeTakeFirst();
      if (Number(updated.numUpdatedRows) === 0) {
        // MySQL reports 0 changed rows when the value is unchanged, so check existence.
        const exists = await trx
          .selectFrom("settings")
          .select("key")
          .where("key", "=", key)
          .executeTakeFirst();
        if (!exists) await trx.insertInto("settings").values({ key, value: serialized }).execute();
      }
    }
  });
  clearSettingsCache();
}

export function clearSettingsCache(): void {
  globalForSettings.__queuezenSettings = undefined;
}

/** Replace `{site_name}`, `{site_email}` and `{year}` placeholders. */
export function fillPlaceholders(text: string, settings: Settings): string {
  return text
    .replaceAll("{site_name}", settings.site_name)
    .replaceAll("{site_email}", settings.site_email)
    .replaceAll("{year}", String(new Date().getFullYear()));
}
