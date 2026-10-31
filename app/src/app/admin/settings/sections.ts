import type { SettingKey } from "@/lib/settings";

/**
 * Declarative description of every settings screen. The admin UI renders forms
 * from this list and the save action uses it to validate which keys a section
 * may change, so adding a setting only takes one entry here plus a default in
 * lib/settings.ts.
 */

export type FieldType = "text" | "textarea" | "code" | "switch" | "number" | "select" | "color" | "image" | "password" | "email" | "url";

export interface SettingField {
  key: SettingKey;
  label: string;
  type: FieldType;
  hint?: string;
  placeholder?: string;
  options?: Array<{ value: string; label: string }>;
  /** Visually group fields under a sub-heading. */
  group?: string;
  /** Non-empty values must match this regular expression (checked when saving). */
  pattern?: string;
  patternError?: string;
}

export interface SettingSection {
  slug: string;
  title: string;
  description: string;
  fields: SettingField[];
}

const CURRENCIES = ["USD", "EUR", "GBP", "INR", "AUD", "CAD", "SGD", "AED", "BRL", "JPY", "TRY", "IDR", "PKR", "BDT", "NGN", "ZAR", "MXN"];

export const SETTING_SECTIONS: SettingSection[] = [
  {
    slug: "general",
    title: "General",
    description: "Your site's name, address, logo and footer.",
    fields: [
      { key: "site_name", label: "Site name", type: "text" },
      { key: "site_tagline", label: "Tagline", type: "text" },
      { key: "site_url", label: "Site URL", type: "url", hint: "Full address without a trailing slash, e.g. https://social.example.com. OAuth redirect URIs of the social networks are built from it." },
      { key: "site_email", label: "Contact email", type: "email", hint: "Shown on the contact page and receives contact-form messages." },
      { key: "logo", label: "Logo", type: "image", hint: "PNG, SVG or WebP, about 160 × 40 px. Leave empty to show the site name.", group: "Branding" },
      { key: "logo_dark", label: "Logo for dark mode", type: "image", hint: "Optional light-coloured version of your logo.", group: "Branding" },
      { key: "favicon", label: "Favicon", type: "image", hint: "Square PNG or ICO, at least 48 × 48 px.", group: "Branding" },
      { key: "footer_text", label: "Footer text", type: "textarea", group: "Footer" },
      { key: "copyright_text", label: "Copyright line", type: "text", hint: "{year} and {site_name} are replaced automatically.", group: "Footer" },
      { key: "blog_enabled", label: "Show the blog", type: "switch", hint: "Adds /blog, a Blog link in the header and footer, and the latest posts on the home page.", group: "Blog" },
    ],
  },
  {
    slug: "appearance",
    title: "Appearance",
    description: "Brand colour, theme and home page text.",
    fields: [
      { key: "primary_color", label: "Brand colour", type: "color", hint: "Used for buttons, links and highlights." },
      {
        key: "default_theme",
        label: "Default theme",
        type: "select",
        options: [
          { value: "system", label: "Follow the visitor's device" },
          { value: "light", label: "Light" },
          { value: "dark", label: "Dark" },
        ],
      },
      { key: "home_hero_title", label: "Home page headline", type: "text", group: "Home page" },
      { key: "home_hero_subtitle", label: "Home page introduction", type: "textarea", group: "Home page" },
      { key: "show_stats_on_home", label: "Show the benefits strip under the hero", type: "switch", group: "Home page" },
    ],
  },
  {
    slug: "seo",
    title: "SEO",
    description: "Search engine titles, descriptions and verification.",
    fields: [
      { key: "meta_title", label: "Home page title", type: "text", hint: "50–60 characters works best." },
      { key: "meta_description", label: "Home page description", type: "textarea", hint: "120–160 characters works best." },
      { key: "title_separator", label: "Title separator", type: "text", hint: "Placed between page and site name, e.g. \" | \" or \" – \"." },
      { key: "og_image", label: "Social sharing image", type: "image", hint: "1200 × 630 px. Shown when links are shared on social media." },
      { key: "google_site_verification", label: "Google site verification code", type: "text", group: "Verification", placeholder: "Content value of the meta tag" },
      { key: "bing_site_verification", label: "Bing Webmaster code", type: "text", group: "Verification" },
      {
        key: "robots_extra",
        label: "Extra disallowed paths",
        type: "textarea",
        group: "Robots.txt",
        hint: "One rule per line, e.g. \"Disallow: /private\". Admin and account pages are always blocked.",
      },
    ],
  },
  {
    slug: "scheduler",
    title: "Scheduler",
    description: "Background jobs and the branding on client approval links and notification emails.",
    fields: [
      {
        key: "lazy_scheduler",
        label: "Run background jobs on visits (no cron needed)",
        type: "switch",
        group: "Scheduler",
        hint: "Publishing scheduled posts, token refresh, RSS feeds and analytics run in the background. When no cron job or worker has run them for a minute, the next visit runs them. Posts only go out on time when something runs the jobs every minute: set up the cron URL or the worker (Admin → System) for production.",
      },
      { key: "branding_text", label: "Branding text", type: "text", group: "Branding", hint: "Shown at the bottom of client approval links and notification emails, e.g. \"Powered by Queuezen\". Plans with \"Remove branding\" hide it." },
      { key: "branding_url", label: "Branding link", type: "url", group: "Branding", hint: "Where the branding link goes. Leave empty to use your site URL." },
    ],
  },
  {
    slug: "ai",
    title: "AI",
    description: "The AI assistant in the composer: rewrite for a network, shorten, hashtags, translate and first-comment ideas. Your key, your costs.",
    fields: [
      {
        key: "ai_provider",
        label: "Provider",
        type: "select",
        options: [
          { value: "none", label: "Off" },
          { value: "openai", label: "OpenAI-compatible (OpenAI, Groq, OpenRouter, Together, Ollama…)" },
          { value: "anthropic", label: "Anthropic (Claude)" },
        ],
        hint: "Plans also need \"AI assistant\" switched on (Admin → Plans), with an optional monthly request limit.",
      },
      {
        key: "ai_base_url",
        label: "API base URL",
        type: "url",
        group: "OpenAI-compatible",
        placeholder: "https://api.openai.com/v1",
        hint: "OpenAI: https://api.openai.com/v1 · Groq: https://api.groq.com/openai/v1 · OpenRouter: https://openrouter.ai/api/v1 · Ollama: http://localhost:11434/v1. The /chat/completions endpoint is used.",
      },
      { key: "ai_api_key", label: "API key", type: "password", group: "OpenAI-compatible", hint: "Stored on the server only; never sent to browsers. Ollama needs no key." },
      { key: "ai_model", label: "Model", type: "text", group: "OpenAI-compatible", placeholder: "e.g. gpt-4.1-mini, llama-3.3-70b-versatile, llama3.2", pattern: "^[A-Za-z0-9_./:@-]{1,120}$", patternError: "Enter a model id like gpt-4.1-mini." },
      { key: "ai_anthropic_key", label: "API key", type: "password", group: "Anthropic", placeholder: "sk-ant-…", hint: "From console.anthropic.com → API keys. Uses the Messages API." },
      { key: "ai_anthropic_model", label: "Model", type: "text", group: "Anthropic", placeholder: "claude-opus-5-5", pattern: "^[A-Za-z0-9_./:@-]{1,120}$", patternError: "Enter a model id like claude-opus-5-5." },
      { key: "ai_max_tokens", label: "Max output tokens", type: "number", group: "Limits", hint: "Upper bound of one answer (captions are short; 1024 is plenty)." },
      { key: "ai_rate_per_minute", label: "Requests per member per minute", type: "number", group: "Limits", hint: "Protects your key from bursts. Monthly limits are set per plan." },
    ],
  },
  {
    slug: "automation",
    title: "Automation",
    description: "RSS auto-posting, evergreen recycling and analytics collection.",
    fields: [
      { key: "rss_min_interval_minutes", label: "Shortest RSS check interval (minutes)", type: "number", group: "RSS feeds", hint: "Customers can't check feeds more often than this. 15 or more is polite to publishers." },
      { key: "rss_max_items_per_run", label: "Most new items per check", type: "number", group: "RSS feeds", hint: "Upper limit for the per-feed setting, so a burst of articles never floods a queue." },
      { key: "rss_max_feeds", label: "Feeds per workspace", type: "number", group: "RSS feeds" },
      { key: "recycle_enabled", label: "Evergreen recycling", type: "switch", group: "Recycling", hint: "Published evergreen posts go back into the queue as new posts, following each workspace's recycling settings." },
      { key: "metrics_enabled", label: "Collect post analytics", type: "switch", group: "Analytics", hint: "Fetches likes, comments, shares and views of published posts from the networks that provide them: hourly during a post's first day, then daily." },
      { key: "metrics_days", label: "Track posts for (days)", type: "number", group: "Analytics", hint: "Posts older than this keep their last numbers." },
      { key: "metrics_batch_size", label: "Posts per channel per run", type: "number", group: "Analytics", hint: "Lower it if a network reports rate limits." },
    ],
  },
  {
    slug: "media",
    title: "Media storage",
    description: "Where images and videos of the media library are stored. Browsers upload straight to the storage, so big videos never pass through your server's request limits.",
    fields: [
      {
        key: "storage_driver",
        label: "Storage",
        type: "select",
        options: [
          { value: "local", label: "This server (storage/uploads/media) — VPS, cPanel, Docker" },
          { value: "s3", label: "S3-compatible — AWS S3, Cloudflare R2, MinIO, Wasabi, Backblaze B2" },
          { value: "blob", label: "Vercel Blob" },
        ],
        hint: "Local disk needs a persistent disk (not Vercel). Instagram, Threads and Facebook download media from its public URL, so the site (or the bucket's public URL) must be reachable over HTTPS. Environment variables (STORAGE_DRIVER, S3_*, BLOB_READ_WRITE_TOKEN) override these settings.",
      },
      { key: "s3_endpoint", label: "Endpoint", type: "url", group: "S3-compatible", placeholder: "https://<account-id>.r2.cloudflarestorage.com", hint: "Leave empty for AWS S3. R2: https://<account-id>.r2.cloudflarestorage.com · MinIO: http(s)://your-minio:9000 · Wasabi: https://s3.<region>.wasabisys.com" },
      { key: "s3_region", label: "Region", type: "text", group: "S3-compatible", placeholder: "us-east-1", hint: "R2 uses \"auto\"." },
      { key: "s3_bucket", label: "Bucket", type: "text", group: "S3-compatible", pattern: "^[a-z0-9][a-z0-9.-]{1,62}$", patternError: "Bucket names use lowercase letters, digits, dots and hyphens." },
      { key: "s3_access_key", label: "Access key ID", type: "text", group: "S3-compatible" },
      { key: "s3_secret_key", label: "Secret access key", type: "password", group: "S3-compatible" },
      { key: "s3_public_url", label: "Public URL", type: "url", group: "S3-compatible", placeholder: "https://media.example.com", hint: "The public address of the bucket (custom domain, r2.dev subdomain or CDN). Networks fetch media from here. Leave empty when the bucket itself is public." },
      { key: "s3_path_style", label: "Path-style URLs (endpoint/bucket/key)", type: "switch", group: "S3-compatible", hint: "Needed for MinIO and most self-hosted S3. The bucket also needs a CORS rule allowing PUT from your site's origin with the Content-Type header." },
      { key: "blob_token", label: "Read-write token", type: "password", group: "Vercel Blob", placeholder: "vercel_blob_rw_…", hint: "Vercel → Storage → your Blob store → .env.local (BLOB_READ_WRITE_TOKEN). Files are public." },
      { key: "media_max_image_mb", label: "Largest image (MB)", type: "number", group: "Limits" },
      { key: "media_max_video_mb", label: "Largest video (MB)", type: "number", group: "Limits", hint: "Networks have their own limits (e.g. X 512 MB, Instagram 300 MB, YouTube 256 GB); the composer checks them per post." },
      { key: "media_quota_mb", label: "Library size per account (MB)", type: "number", group: "Limits", hint: "Total of every workspace an owner owns. 0 = unlimited." },
    ],
  },
  {
    slug: "payments",
    title: "Payments",
    description: "Accept payments for paid plans. Enable one or more gateways.",
    fields: [
      { key: "currency", label: "Currency", type: "select", options: CURRENCIES.map((c) => ({ value: c, label: c })), hint: "Must be supported by every gateway you enable." },
      { key: "stripe_enabled", label: "Enable Stripe (cards, Apple Pay, Google Pay)", type: "switch", group: "Stripe" },
      { key: "stripe_secret_key", label: "Secret key", type: "password", group: "Stripe", placeholder: "sk_live_…" },
      {
        key: "stripe_webhook_secret",
        label: "Webhook signing secret",
        type: "password",
        group: "Stripe",
        placeholder: "whsec_…",
        hint: "Create a webhook for {site_url}/api/payments/stripe/webhook with events invoice.paid, checkout.session.completed and customer.subscription.deleted.",
      },
      { key: "paypal_enabled", label: "Enable PayPal", type: "switch", group: "PayPal" },
      {
        key: "paypal_mode",
        label: "Mode",
        type: "select",
        group: "PayPal",
        options: [
          { value: "sandbox", label: "Sandbox (testing)" },
          { value: "live", label: "Live" },
        ],
      },
      { key: "paypal_client_id", label: "Client ID", type: "text", group: "PayPal" },
      { key: "paypal_secret", label: "Secret", type: "password", group: "PayPal" },
      { key: "razorpay_enabled", label: "Enable Razorpay", type: "switch", group: "Razorpay" },
      { key: "razorpay_key_id", label: "Key ID", type: "text", group: "Razorpay", placeholder: "rzp_live_…" },
      { key: "razorpay_key_secret", label: "Key secret", type: "password", group: "Razorpay" },
      { key: "offline_enabled", label: "Enable bank transfer", type: "switch", group: "Bank transfer", hint: "You approve each transfer manually in Admin → Payments." },
      { key: "offline_instructions", label: "Payment instructions", type: "textarea", group: "Bank transfer" },
    ],
  },
  {
    slug: "email",
    title: "Email",
    description: "SMTP server used for notifications, team invites, password resets and contact-form messages.",
    fields: [
      { key: "mail_enabled", label: "Send emails", type: "switch" },
      { key: "smtp_host", label: "SMTP host", type: "text", placeholder: "smtp.example.com" },
      { key: "smtp_port", label: "SMTP port", type: "number", hint: "Usually 587 (STARTTLS) or 465 (SSL)." },
      { key: "smtp_secure", label: "Use SSL (port 465)", type: "switch" },
      { key: "smtp_user", label: "Username", type: "text" },
      { key: "smtp_pass", label: "Password", type: "password" },
      { key: "mail_from_name", label: "Sender name", type: "text" },
      { key: "mail_from_address", label: "Sender email", type: "email" },
    ],
  },
  {
    slug: "users",
    title: "Users",
    description: "Registration and access rules.",
    fields: [
      { key: "registration_enabled", label: "Allow new registrations", type: "switch" },
      { key: "contact_enabled", label: "Show the contact page", type: "switch" },
      { key: "cookie_consent_enabled", label: "Show the cookie notice", type: "switch", group: "Cookie notice" },
      { key: "cookie_consent_text", label: "Cookie notice text", type: "textarea", group: "Cookie notice" },
    ],
  },
  {
    slug: "advanced",
    title: "Advanced",
    description: "Maintenance mode and custom code.",
    fields: [
      { key: "maintenance_mode", label: "Maintenance mode", type: "switch", hint: "Only administrators can see the site while this is on." },
      { key: "maintenance_message", label: "Maintenance message", type: "textarea" },
      { key: "custom_head_code", label: "Extra code in <head>", type: "code", group: "Custom code", hint: "Added to the <head> of every public page, e.g. a verification meta tag or a font." },
      { key: "custom_body_code", label: "Additional code", type: "code", group: "Custom code", hint: "E.g. a live chat widget." },
    ],
  },
];

export function getSection(slug: string): SettingSection | undefined {
  return SETTING_SECTIONS.find((s) => s.slug === slug);
}
