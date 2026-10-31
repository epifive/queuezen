import type { Generated, Insertable, Selectable, Updateable } from "kysely";

/**
 * Database schema shared by the MySQL and SQLite drivers.
 *
 * Portability rules used across the project:
 * - booleans are stored as 0 / 1 integers
 * - timestamps are ISO-8601 strings (see `now()` in ./index.ts), so string comparison = time order
 * - money is stored in the smallest currency unit (cents)
 * - JSON is stored as text (parse with parseJson() from src/social/normalize.ts and normalise)
 * - days are "YYYY-MM-DD" strings (UTC unless stated otherwise), months "YYYY-MM"
 */

export interface SettingsTable {
  key: string;
  value: string | null;
}

export interface UsersTable {
  id: Generated<number>;
  name: string;
  email: string;
  password_hash: string;
  role: "user" | "admin";
  status: "active" | "banned";
  plan_id: number | null;
  plan_expires_at: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface SessionsTable {
  id: string;
  user_id: number;
  expires_at: string;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
}

export interface PasswordResetsTable {
  token_hash: string;
  user_id: number;
  expires_at: string;
  created_at: string;
}

export interface PlansTable {
  id: Generated<number>;
  name: string;
  description: string | null;
  price_monthly: number;
  price_yearly: number;
  features: string | null;
  /** Connected social accounts across all workspaces the user owns; 0 = unlimited. */
  max_channels: number;
  /** Posts scheduled per calendar month (one post on 3 channels counts 3); 0 = unlimited. */
  max_scheduled_monthly: number;
  /** Team seats across the owner's workspaces, the owner included; 0 = unlimited. */
  max_members: number;
  /** Posts to X per calendar month (each costs the operator API credits); 0 = none allowed, -1 = unlimited. */
  max_x_posts_monthly: number;
  /** AI assistant (captions, hashtags, rewrites). */
  allow_ai: number;
  /** RSS auto-posting. */
  allow_rss: number;
  /** REST API access (/api/v1). */
  allow_api: number;
  /** Client branding of approval links (white label); the approval links work on every plan. */
  allow_white_label: number;
  /** Hide the "Powered by" line on approval links and emails. */
  remove_branding: number;
  /** AI assistant requests per calendar month (0 = unlimited when allow_ai is on). */
  max_ai_monthly: number;
  is_free: number;
  is_active: number;
  is_featured: number;
  sort_order: number;
  created_at: string;
}

export interface PaymentsTable {
  id: Generated<number>;
  user_id: number;
  plan_id: number;
  amount: number;
  currency: string;
  billing_cycle: "monthly" | "yearly";
  provider: "stripe" | "paypal" | "razorpay" | "offline";
  provider_ref: string;
  status: "pending" | "paid" | "rejected" | "refunded";
  note: string | null;
  created_at: string;
}

export interface PagesTable {
  id: Generated<number>;
  slug: string;
  title: string;
  content: string;
  meta_description: string | null;
  is_published: number;
  show_in_footer: number;
  created_at: string;
  updated_at: string;
}

export interface ContactMessagesTable {
  id: Generated<number>;
  name: string;
  email: string;
  subject: string;
  message: string;
  ip: string | null;
  is_read: number;
  created_at: string;
}

export interface LanguagesTable {
  code: string;
  name: string;
  native_name: string;
  direction: "ltr" | "rtl";
  is_active: number;
  sort_order: number;
}

export interface TranslationsTable {
  lang: string;
  key: string;
  value: string;
}

/** Articles of the public blog (/blog). Social posts are in `posts`. */
export interface BlogPostsTable {
  id: Generated<number>;
  slug: string;
  title: string;
  excerpt: string | null;
  content: string;
  cover_image: string | null;
  meta_description: string | null;
  status: "draft" | "published";
  published_at: string | null;
  views: number;
  created_at: string;
  updated_at: string;
}

// ── Workspaces and team ──

export interface WorkspacesTable {
  id: Generated<number>;
  /** The owner; their plan sets the workspace's limits. */
  owner_id: number;
  name: string;
  /** IANA time zone of the calendar and the queue. */
  timezone: string;
  /** JSON WorkspaceSettings (src/social/types.ts), read through normalizeWorkspaceSettings(). */
  settings: string;
  /** 1 = the workspace created automatically for the owner (can't be deleted). */
  is_personal: number;
  /** JSON RecycleSettings (src/lib/recycle.ts), null = evergreen recycling off. */
  recycle_settings: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceMembersTable {
  id: Generated<number>;
  workspace_id: number;
  user_id: number;
  role: "owner" | "admin" | "editor" | "approver" | "viewer";
  created_at: string;
}

export interface WorkspaceInvitesTable {
  id: Generated<number>;
  workspace_id: number;
  email: string;
  role: "admin" | "editor" | "approver" | "viewer";
  /** sha256 of the invite token (the token is only in the invite link). */
  token_hash: string;
  invited_by: number;
  expires_at: string;
  created_at: string;
}

// ── Channels (connected social accounts) ──

export interface ChannelsTable {
  id: Generated<number>;
  workspace_id: number;
  /** Platform id (src/social/types.ts). */
  platform: string;
  /** Account / page / chat id on the platform (unique per workspace and platform). */
  external_id: string;
  name: string;
  /** "@handle" or "" */
  handle: string;
  avatar_url: string | null;
  profile_url: string | null;
  /** AES-256-GCM encrypted JSON ChannelCredentials (src/lib/crypto.ts, purpose "channel-credentials"). */
  credentials: string;
  /** Access token expiry (ISO), null = doesn't expire. Indexed for the token refresh job. */
  token_expires_at: string | null;
  status: "active" | "expired" | "error" | "disconnected";
  last_error: string | null;
  last_checked_at: string | null;
  /** JSON ChannelSettings, read through normalizeChannelSettings(). */
  settings: string;
  /** JSON QueueSlot[]: the channel's weekly posting times (queue slots live on the channel, see README). */
  queue_slots: string;
  /** JSON: non-secret platform data (page id, IG user id, instance, followers…). */
  meta: string;
  connected_by: number | null;
  /** 1 = the queue is paused: scheduled posts stay but the engine doesn't publish them. */
  queue_paused: Generated<number>;
  created_at: string;
  updated_at: string;
}

// ── Posts and their publications ──

export interface PostsTable {
  id: Generated<number>;
  workspace_id: number;
  author_id: number | null;
  status: "draft" | "pending_approval" | "approved" | "scheduled" | "publishing" | "published" | "partially_failed" | "failed";
  /** When to publish (ISO, UTC); null for drafts without a date. */
  scheduled_at: string | null;
  /** JSON PostContent (the base content), read through normalizePostContent(). */
  content: string;
  /** JSON string[] of labels. */
  labels: string;
  source: "manual" | "rss" | "csv" | "api" | "recycle";
  /** Origin id: rss_items.id, the recycled post id, the CSV import id… */
  source_ref: string | null;
  /** Evergreen: may be recycled back into the queue. */
  is_evergreen: number;
  recycle_count: number;
  last_recycled_at: string | null;
  approved_by: number | null;
  approved_at: string | null;
  /** When the last target finished (published / failed). */
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

/** One publication of a post on one channel; the engine works on these rows. */
export interface PostTargetsTable {
  id: Generated<number>;
  post_id: number;
  /** Denormalised from the post / channel for the engine's and analytics' queries. */
  workspace_id: number;
  channel_id: number;
  platform: string;
  /** JSON ContentOverride for this channel ({} = the base content). */
  override: string;
  status: "pending" | "scheduled" | "claimed" | "uploading" | "container_created" | "publishing" | "published" | "failed" | "needs_reauth" | "cancelled";
  /** Copy of the post's scheduled_at while scheduled. */
  scheduled_at: string | null;
  /** When the engine may (re)try: scheduled_at at first, later the backoff time. Indexed with status. */
  next_attempt_at: string | null;
  attempts: number;
  /** A tick owns the row until then (idempotent claims across concurrent ticks). */
  lease_until: string | null;
  /** Random token of the tick holding the lease. */
  lease_token: string | null;
  /** Post id on the network once published. */
  external_id: string | null;
  /** Platform container / upload id saved BEFORE publishing (Instagram / Threads containers, X media id…). */
  container_id: string | null;
  /** JSON UploadState: resumable progress (chunk offsets, ETags, session URIs, child containers). */
  upload_state: string;
  permalink: string | null;
  published_at: string | null;
  error: string | null;
  /** DriverErrorKind of the last error. */
  error_kind: string | null;
  /** "YYYY-MM" when this publication was counted against the owner's monthly quota (null = not counted). */
  quota_month: string | null;
  created_at: string;
  updated_at: string;
}

// ── Media library ──

export interface MediaFoldersTable {
  id: Generated<number>;
  workspace_id: number;
  parent_id: number | null;
  name: string;
  created_at: string;
}

export interface MediaTable {
  id: Generated<number>;
  workspace_id: number;
  folder_id: number | null;
  uploaded_by: number | null;
  /** Storage adapter: "local", "s3", "blob". */
  storage: string;
  /** Key / path inside the storage. */
  storage_key: string;
  /** Public HTTPS URL. */
  url: string;
  filename: string;
  mime: string;
  kind: "image" | "gif" | "video";
  size: number;
  width: number | null;
  height: number | null;
  /** Seconds (videos). */
  duration: number | null;
  alt_text: string;
  thumbnail_url: string | null;
  created_at: string;
}

// ── Automation ──

export interface RssFeedsTable {
  id: Generated<number>;
  workspace_id: number;
  url: string;
  title: string;
  /** JSON number[]: channels that get the new items. */
  channel_ids: string;
  /** Post template ("{title} {url}"). */
  template: string;
  /** What happens with new items: a draft, the next queue slot, or publish right away. */
  mode: "draft" | "queue" | "publish";
  ai_rewrite: number;
  interval_minutes: number;
  status: "active" | "paused" | "error";
  last_checked_at: string | null;
  next_check_at: string;
  /** Conditional GET headers of the last fetch. */
  etag: string | null;
  last_modified: string | null;
  last_error: string | null;
  /** JSON RssFeedOptions (src/lib/rss.ts): max items per run, UTM, backfill, hashtags. */
  options: string | null;
  /** Posts created from this feed so far. */
  items_posted: number;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

/** Items seen in a feed (dedupe: unique per feed and guid hash). */
export interface RssItemsTable {
  id: Generated<number>;
  feed_id: number;
  /** sha256 of the item's guid (or link). */
  guid_hash: string;
  guid: string;
  url: string | null;
  title: string | null;
  published_at: string | null;
  /** Post created from the item (null = skipped). */
  post_id: number | null;
  created_at: string;
}

export interface ShortLinksTable {
  id: Generated<number>;
  workspace_id: number;
  /** /l/<code> */
  code: string;
  /** Name shown in the links list ("" = the URL). */
  title: string;
  /** Target URL including the UTM parameters. */
  url: string;
  /** JSON {source, medium, campaign, term, content} used to build `url`. */
  utm: string;
  post_id: number | null;
  channel_id: number | null;
  clicks: number;
  last_clicked_at: string | null;
  created_at: string;
}

export interface LinkClicksDailyTable {
  link_id: number;
  day: string;
  clicks: number;
}

// ── Analytics ──

/** Latest metrics of one publication (one row per target, updated in place). */
export interface PostMetricsTable {
  id: Generated<number>;
  target_id: number;
  post_id: number;
  channel_id: number;
  workspace_id: number;
  fetched_at: string;
  views: number | null;
  impressions: number | null;
  reach: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  clicks: number | null;
  quotes: number | null;
}

/** App-wide platform usage per UTC day (Admin → Platforms quota meters: YouTube uploads, X spend). */
export interface PlatformUsageDailyTable {
  platform: string;
  day: string;
  posts: number;
  uploads: number;
  api_calls: number;
  errors: number;
  /** Cost in micro-dollars (X API credits). */
  cost_micros: number;
}

// ── Approvals and comments ──

/** Client approval link (/approve/<token>, no login). */
export interface ApprovalLinksTable {
  id: Generated<number>;
  workspace_id: number;
  /** sha256 of the token. */
  token_hash: string;
  /** JSON number[] of posts, null = every post waiting for approval in the workspace (within range_from / range_to). */
  post_ids: string | null;
  /** Scheduled-time range (ISO) of the posts shown, when post_ids is null. */
  range_from: string | null;
  range_to: string | null;
  /** scrypt hash of the optional password (src/lib/auth/password.ts), null = none. */
  password_hash: string | null;
  label: string;
  created_by: number | null;
  expires_at: string;
  revoked_at: string | null;
  last_viewed_at: string | null;
  created_at: string;
}

export interface PostCommentsTable {
  id: Generated<number>;
  post_id: number;
  workspace_id: number;
  /** null for guests of an approval link. */
  user_id: number | null;
  author_name: string;
  kind: "note" | "approved" | "rejected" | "system";
  body: string;
  created_at: string;
}

// ── Account level ──

/** One publishing attempt of a post target (attempt history on the post page). */
export interface PostAttemptsTable {
  id: Generated<number>;
  target_id: number;
  post_id: number;
  workspace_id: number;
  channel_id: number;
  attempt: number;
  /** published, retry, failed, needs_reauth, deferred, found_existing, skipped. */
  outcome: string;
  error: string | null;
  error_kind: string | null;
  started_at: string;
  duration_ms: number;
}

export interface ApiKeysTable {
  id: Generated<number>;
  /** The workspace the key acts in. */
  workspace_id: number;
  /** Who created it (must still be a member for the key to work). */
  user_id: number;
  name: string;
  /** sha256 of the key; the key itself is shown once. */
  key_hash: string;
  /** First characters, to recognise the key in the list. */
  prefix: string;
  last_used_at: string | null;
  created_at: string;
}

/** Monthly usage per account (the workspace OWNER's plan quota), UTC month. */
export interface UsageMonthlyTable {
  user_id: number;
  /** YYYY-MM (UTC) */
  month: string;
  /** Publications scheduled this month across the owner's workspaces (max_scheduled_monthly). */
  posts_scheduled: number;
  /** Of which on X (max_x_posts_monthly). */
  x_posts: number;
  /** AI assistant requests. */
  ai_requests: number;
  /** Comma-separated quota alerts sent this month ("posts:quota_warning,x:quota_reached"), see src/lib/notify/quota.ts. */
  quota_alerts: string | null;
}

/** Where workspace notifications go (email, Slack… — not social channels). */
export interface NotifyChannelsTable {
  id: Generated<number>;
  workspace_id: number;
  created_by: number | null;
  type: "email" | "webhook" | "slack" | "discord" | "telegram" | "teams";
  name: string;
  /** JSON: NotifyConfigByType[type]. */
  config: string;
  /** JSON NotifyEvent[] this channel receives. */
  events: string;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface AlertLogTable {
  id: Generated<number>;
  workspace_id: number | null;
  post_id: number | null;
  /** notify_channels.id (null = account email or no channel). */
  channel_id: number | null;
  event: string;
  ok: number;
  error: string | null;
  created_at: string;
}

// ── Platform connections ──

/** Accounts from one OAuth connect waiting in the picker (Facebook Pages, Instagram accounts). */
export interface ConnectSessionsTable {
  id: Generated<number>;
  /** sha256 of the picker token (the token is only in the picker URL). */
  token_hash: string;
  user_id: number;
  workspace_id: number;
  platform: string;
  /** AES-256-GCM encrypted JSON ConnectedAccount[] (purpose "connect-session"). */
  payload: string;
  expires_at: string;
  created_at: string;
}

/** Mastodon app registered on an instance for one redirect URI (client secret encrypted). */
export interface MastodonAppsTable {
  id: Generated<number>;
  /** Lower-case origin, e.g. "https://mastodon.social". */
  instance: string;
  /** sha256 of the redirect URI the app was registered with. */
  redirect_hash: string;
  client_id: string;
  client_secret: string;
  created_at: string;
}

/** Meta data deletion callback requests (status page by confirmation code). */
export interface DataDeletionRequestsTable {
  id: Generated<number>;
  code: string;
  platform: string;
  external_user_id: string;
  channels_deleted: number;
  status: "received" | "completed";
  created_at: string;
  completed_at: string | null;
}

export interface Database {
  settings: SettingsTable;
  users: UsersTable;
  sessions: SessionsTable;
  password_resets: PasswordResetsTable;
  plans: PlansTable;
  payments: PaymentsTable;
  pages: PagesTable;
  contact_messages: ContactMessagesTable;
  languages: LanguagesTable;
  translations: TranslationsTable;
  blog_posts: BlogPostsTable;
  workspaces: WorkspacesTable;
  workspace_members: WorkspaceMembersTable;
  workspace_invites: WorkspaceInvitesTable;
  channels: ChannelsTable;
  posts: PostsTable;
  post_targets: PostTargetsTable;
  media_folders: MediaFoldersTable;
  media: MediaTable;
  rss_feeds: RssFeedsTable;
  rss_items: RssItemsTable;
  short_links: ShortLinksTable;
  link_clicks_daily: LinkClicksDailyTable;
  post_metrics: PostMetricsTable;
  platform_usage_daily: PlatformUsageDailyTable;
  approval_links: ApprovalLinksTable;
  post_comments: PostCommentsTable;
  post_attempts: PostAttemptsTable;
  api_keys: ApiKeysTable;
  usage_monthly: UsageMonthlyTable;
  notify_channels: NotifyChannelsTable;
  alert_log: AlertLogTable;
  connect_sessions: ConnectSessionsTable;
  mastodon_apps: MastodonAppsTable;
  data_deletion_requests: DataDeletionRequestsTable;
}

export type User = Selectable<UsersTable>;
export type NewUser = Insertable<UsersTable>;
export type UserUpdate = Updateable<UsersTable>;
export type Plan = Selectable<PlansTable>;
export type Payment = Selectable<PaymentsTable>;
export type Page = Selectable<PagesTable>;
export type ContactMessage = Selectable<ContactMessagesTable>;
export type Language = Selectable<LanguagesTable>;
export type BlogPost = Selectable<BlogPostsTable>;
export type WorkspaceRow = Selectable<WorkspacesTable>;
export type WorkspaceMemberRow = Selectable<WorkspaceMembersTable>;
export type WorkspaceInviteRow = Selectable<WorkspaceInvitesTable>;
export type ChannelRow = Selectable<ChannelsTable>;
export type PostRow = Selectable<PostsTable>;
export type PostTargetRow = Selectable<PostTargetsTable>;
export type MediaRow = Selectable<MediaTable>;
export type MediaFolderRow = Selectable<MediaFoldersTable>;
export type RssFeedRow = Selectable<RssFeedsTable>;
export type ShortLinkRow = Selectable<ShortLinksTable>;
export type PostMetricsRow = Selectable<PostMetricsTable>;
export type ApprovalLinkRow = Selectable<ApprovalLinksTable>;
export type PostCommentRow = Selectable<PostCommentsTable>;
export type ApiKey = Selectable<ApiKeysTable>;
export type NotifyChannelRow = Selectable<NotifyChannelsTable>;
