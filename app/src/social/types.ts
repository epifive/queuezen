/**
 * The Queuezen contract: shared by the platform drivers (src/lib/platforms), the publishing
 * engine, the composer, the calendar and queue, the media library, the REST API, the background
 * jobs and the notification channels.
 *
 * Keep this file free of imports and runtime dependencies (apart from the DriverError class): it
 * is used on the server, in client components and in the library tests.
 *
 * Conventions:
 * - times are ISO-8601 strings in UTC ("2026-10-20T09:30:00.000Z"); days are "YYYY-MM-DD"
 * - time zones are IANA names ("Europe/Berlin"); local wall-clock times are "HH:MM" (24 h)
 * - weekdays are ISO numbers: 1 = Monday … 7 = Sunday
 * - sizes are bytes, durations seconds, aspect ratios width / height (1.91 = landscape link card)
 * - JSON columns are parsed with parseJson() and always normalised before use (./normalize.ts)
 */

// ── Platforms ──

/**
 * Supported networks. `instagram` = Instagram API with Facebook Login (Page-linked business
 * account); `instagram_login` = Instagram API with Instagram Login (no Page needed). `tiktok` and
 * `pinterest` are planned for v1.1: they are in the registry so data and UI can already name them.
 */
export const PLATFORMS = [
  "facebook",
  "instagram",
  "instagram_login",
  "threads",
  "x",
  "linkedin",
  "youtube",
  "bluesky",
  "mastodon",
  "telegram",
  "discord",
  "tiktok",
  "pinterest",
] as const;
export type Platform = (typeof PLATFORMS)[number];

/** Platforms with a driver in v1 (the connect screen lists these). */
export const V1_PLATFORMS: readonly Platform[] = ["facebook", "instagram", "instagram_login", "threads", "x", "linkedin", "youtube", "bluesky", "mastodon", "telegram", "discord"];

/**
 * How a channel is connected:
 * - oauth2:        authorization code flow with a client secret (Meta, LinkedIn, Google)
 * - oauth2_pkce:   authorization code + PKCE (X; Mastodon registers an app per instance first)
 * - app_password:  handle + app password (Bluesky)
 * - bot_token:     bot token + chat / channel id (Telegram)
 * - webhook:       pasted webhook URL (Discord)
 */
export const AUTH_KINDS = ["oauth2", "oauth2_pkce", "app_password", "bot_token", "webhook"] as const;
export type AuthKind = (typeof AUTH_KINDS)[number];

// ── Workspaces and members ──

/**
 * Roles in a workspace, lowest to highest rank (requireWorkspace(wid, minRole) compares ranks):
 * - viewer:   reads everything, changes nothing
 * - approver: viewer + approves / rejects posts and comments (client or manager)
 * - editor:   creates, edits and schedules posts, uploads media (submits for approval when the
 *             workspace requires it); cannot approve
 * - admin:    editor + approves, manages channels, members (not the owner), settings,
 *             notifications and API keys
 * - owner:    admin + deletes the workspace; the owner's plan sets the workspace's limits
 * Capabilities that don't follow the rank order (approve) are checked with roleCan().
 */
export const WORKSPACE_ROLES = ["viewer", "approver", "editor", "admin", "owner"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

/** Roles that can be given to a member or an invite (there is exactly one owner). */
export const ASSIGNABLE_ROLES = ["admin", "editor", "approver", "viewer"] as const satisfies readonly WorkspaceRole[];
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

export const WORKSPACE_CAPABILITIES = [
  "view",
  "comment",
  "approve",
  "post.create",
  "post.publish",
  "media.manage",
  "channels.manage",
  "members.manage",
  "settings.manage",
  "workspace.delete",
] as const;
export type WorkspaceCapability = (typeof WORKSPACE_CAPABILITIES)[number];

/** A weekly posting time of a channel's queue, in the workspace's time zone. */
export interface QueueSlot {
  /** ISO weekday: 1 = Monday … 7 = Sunday. */
  day: number;
  /** Local time "HH:MM" (24 h). */
  time: string;
}

export interface UtmSettings {
  enabled: boolean;
  /** "{platform}" is replaced with the platform id (facebook, x …). */
  source: string;
  medium: string;
  campaign: string;
}

/** Client branding on approval links (needs the plan's white-label option). */
export interface WorkspaceBranding {
  /** "" = the workspace name. */
  companyName: string;
  /** Logo URL or upload path ("" = none). */
  logo: string;
  /** #rrggbb ("" = the platform colour). */
  color: string;
}

/** Stored as JSON in workspaces.settings; always read through normalizeWorkspaceSettings(). */
export interface WorkspaceSettings {
  /** Posts by editors need an approval before they can be scheduled. */
  approvalRequired: boolean;
  /** Queue slots given to newly connected channels. */
  defaultSlots: QueueSlot[];
  /** First day of the week in the calendar (1 = Monday, 7 = Sunday). */
  weekStart: 1 | 7;
  /** UTM parameters added to links in posts (per-channel settings can override them). */
  utm: UtmSettings;
  /** Replace links in posts with tracked short links (/l/<code>). */
  shortenLinks: boolean;
  branding: WorkspaceBranding;
}

// ── Channels (connected social accounts) ──

export const CHANNEL_STATUSES = ["active", "expired", "error", "disconnected"] as const;
/**
 * - active:       publishing works
 * - expired:      the token expired or was revoked: the user must reconnect (re-auth reminder)
 * - error:        the last test / publish failed for another reason (see last_error)
 * - disconnected: removed by the user; kept for the post history, not counted in plan limits
 */
export type ChannelStatus = (typeof CHANNEL_STATUSES)[number];

/** Stored as JSON in channels.settings; always read through normalizeChannelSettings(). */
export interface ChannelSettings {
  /** First comment added to new posts for this channel ("" = none). */
  defaultFirstComment: string;
  /** Hashtag group appended to new posts ("#a #b", "" = none). */
  hashtags: string;
  /** UTM override for this channel (null = the workspace's settings). */
  utm: UtmSettings | null;
  /** Default platform options for new posts (e.g. Mastodon visibility, YouTube privacy). */
  defaults: PlatformOptions;
}

/**
 * Secrets of a connected channel. Stored encrypted (AES-256-GCM, src/lib/crypto.ts) in
 * channels.credentials and only decrypted inside the drivers / engine. Never sent to the browser.
 */
export interface ChannelCredentials {
  accessToken?: string;
  refreshToken?: string;
  /** ISO expiry of the access token (null / missing = doesn't expire). */
  expiresAt?: string | null;
  /** ISO expiry of the refresh token, when the platform tells (TikTok, Pinterest, Bluesky OAuth). */
  refreshExpiresAt?: string | null;
  tokenType?: string;
  scopes?: string[];
  /** Bluesky: handle + app password, and the persisted session (createSession is rate limited). */
  identifier?: string;
  appPassword?: string;
  session?: { accessJwt: string; refreshJwt: string; did: string; pds?: string };
  /** Telegram: bot token + target chat (channel username "@name" or numeric id). */
  botToken?: string;
  chatId?: string;
  /** Discord: the channel webhook URL (it is the secret). */
  webhookUrl?: string;
  /** Mastodon: the instance and the app registered on it. */
  instanceUrl?: string;
  clientId?: string;
  clientSecret?: string;
  /** Anything else a driver needs to keep secret. */
  extra?: Record<string, string>;
}

/** What a driver works with: a channel row with its credentials decrypted. */
export interface DriverChannel {
  id: number;
  workspaceId: number;
  platform: Platform;
  /** The account / page / chat id on the platform. */
  externalId: string;
  name: string;
  handle: string;
  credentials: ChannelCredentials;
  settings: ChannelSettings;
  /** Non-secret platform data saved at connect time (page id, IG user id, instance, followers…). */
  meta: Record<string, unknown>;
}

// ── Posts ──

export const POST_STATUSES = ["draft", "pending_approval", "approved", "scheduled", "publishing", "published", "partially_failed", "failed"] as const;
export type PostStatus = (typeof POST_STATUSES)[number];

export const POST_SOURCES = ["manual", "rss", "csv", "api", "recycle"] as const;
export type PostSource = (typeof POST_SOURCES)[number];

/**
 * One publication of a post on one channel (post_targets row). Life cycle used by the engine:
 *   pending (post is a draft / waiting for approval) → scheduled → claimed → uploading →
 *   container_created → publishing → published | failed | needs_reauth; cancelled = removed
 *   from the post before it was published.
 */
export const TARGET_STATUSES = ["pending", "scheduled", "claimed", "uploading", "container_created", "publishing", "published", "failed", "needs_reauth", "cancelled"] as const;
export type TargetStatus = (typeof TARGET_STATUSES)[number];

/** Target states the engine is working on (a lease protects them). */
export const IN_FLIGHT_TARGET_STATUSES: readonly TargetStatus[] = ["claimed", "uploading", "container_created", "publishing"];

export const IG_POST_TYPES = ["feed", "reel", "story"] as const;
export type InstagramPostType = (typeof IG_POST_TYPES)[number];
export const FB_POST_TYPES = ["feed", "reel", "story"] as const;
export type FacebookPostType = (typeof FB_POST_TYPES)[number];
export const YOUTUBE_PRIVACY = ["public", "unlisted", "private"] as const;
export type YoutubePrivacy = (typeof YOUTUBE_PRIVACY)[number];
export const MASTODON_VISIBILITY = ["public", "unlisted", "private", "direct"] as const;
export type MastodonVisibility = (typeof MASTODON_VISIBILITY)[number];
export const TIKTOK_PRIVACY = ["", "PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"] as const;
export type TiktokPrivacy = (typeof TIKTOK_PRIVACY)[number];

/** Per-platform options of a post (only the current platform's block is used). */
export interface PlatformOptions {
  facebook?: { postType: FacebookPostType };
  instagram?: {
    postType: InstagramPostType;
    /** Reels: also show in the main feed. */
    shareToFeed: boolean;
    /** Up to 3 usernames invited as collaborators. */
    collaborators: string[];
    /** Reels cover: a media id from the library (0 = the platform picks a frame). */
    coverMediaId: number;
  };
  threads?: { replyControl: "everyone" | "accounts_you_follow" | "mentioned_only"; topicTag: string };
  x?: { replySettings: "everyone" | "following" | "mentionedUsers" };
  linkedin?: { visibility: "PUBLIC" | "CONNECTIONS" };
  youtube?: {
    /** Video title (required, ≤ 100 characters). The post text is the description. */
    title: string;
    privacy: YoutubePrivacy;
    tags: string[];
    /** YouTube category id ("22" = People & Blogs). */
    categoryId: string;
    madeForKids: boolean;
    notifySubscribers: boolean;
    /** Custom thumbnail: a media id from the library (0 = none). */
    thumbnailMediaId: number;
  };
  bluesky?: { langs: string[] };
  mastodon?: { visibility: MastodonVisibility; spoilerText: string; language: string };
  telegram?: { silent: boolean; disablePreview: boolean };
  discord?: { username: string; avatarUrl: string; threadName: string };
  tiktok?: { privacy: TiktokPrivacy; allowComment: boolean; allowDuet: boolean; allowStitch: boolean; brandedContent: boolean };
  pinterest?: { boardId: string; title: string; link: string };
}

/** Article / link card details (LinkedIn needs them; Bluesky builds its card from them). */
export interface LinkMeta {
  title: string;
  description: string;
  /** Thumbnail URL ("" = none). */
  imageUrl: string;
}

/**
 * The content of a post. posts.content holds the base content; post_targets.override holds a
 * partial PostContent per channel (merged with mergeContent()). Always normalised with
 * normalizePostContent().
 */
export interface PostContent {
  /** The caption / text of the post (the first part of a thread). */
  text: string;
  /** Media library ids, in order. */
  mediaIds: number[];
  /** Link to attach as a link card / article ("" = none). */
  link: string;
  linkMeta: LinkMeta | null;
  /** Posted right after the post: a comment (Facebook, Instagram, LinkedIn) or a self-reply (X, Threads, Bluesky, Mastodon). */
  firstComment: string;
  /** Further parts of a thread, posted as replies in order (X, Threads, Bluesky, Mastodon). */
  thread: string[];
  options: PlatformOptions;
}

/** Fields a channel tab of the composer may override. */
export type ContentOverride = Partial<Pick<PostContent, "text" | "mediaIds" | "link" | "linkMeta" | "firstComment" | "thread">> & { options?: PlatformOptions };

// ── Media ──

export const MEDIA_KINDS = ["image", "gif", "video"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

/** What validation and the drivers know about a media item (from the media table). */
export interface MediaInfo {
  id: number;
  kind: MediaKind;
  mime: string;
  /** Bytes. */
  size: number;
  width: number | null;
  height: number | null;
  /** Seconds (videos), null when unknown. */
  duration: number | null;
  altText: string;
  /** Public HTTPS URL (URL-pull platforms fetch it). */
  url: string;
}

// ── Validation ──

export interface ValidationIssue {
  /** Stable code for translations / tests ("text_too_long", "media_type"…). */
  code: string;
  /** English message (the composer can translate `code` with `params`). */
  message: string;
  params?: Record<string, string | number>;
  /** Which part is affected: "text", "thread:2", "first_comment", "media:<id>", "option:title"… */
  field?: string;
}

export interface ValidationResult {
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  /** Counted length of the main text and the platform's limit (composer counter). */
  length: { used: number; limit: number };
}

// ── Drivers ──

export const DRIVER_ERROR_KINDS = ["auth", "rate_limit", "validation", "media", "network", "quota", "unknown"] as const;
export type DriverErrorKind = (typeof DRIVER_ERROR_KINDS)[number];

/** Default retry behaviour per kind (a driver can override it per error). */
export const RETRYABLE_BY_DEFAULT: Record<DriverErrorKind, boolean> = {
  auth: false,
  rate_limit: true,
  validation: false,
  media: false,
  network: true,
  quota: true,
  unknown: true,
};

/**
 * The only error drivers throw. `retryable` tells the engine to try again later (with backoff,
 * or after `retryAfterMs` when the platform said so); non-retryable errors fail the target and
 * show `message` to the user. kind "auth" also marks the channel "expired" (reconnect needed).
 */
export class DriverError extends Error {
  readonly kind: DriverErrorKind;
  readonly retryable: boolean;
  /** HTTP status of the platform's answer (0 = none). */
  readonly status: number;
  /** Platform error code / subcode, for logs and support. */
  readonly code: string;
  readonly retryAfterMs: number | null;
  readonly platform: Platform | null;

  constructor(
    message: string,
    kind: DriverErrorKind,
    options: { retryable?: boolean; status?: number; code?: string; retryAfterMs?: number | null; platform?: Platform | null; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "DriverError";
    this.kind = kind;
    this.retryable = options.retryable ?? RETRYABLE_BY_DEFAULT[kind];
    this.status = options.status ?? 0;
    this.code = options.code ?? "";
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.platform = options.platform ?? null;
  }
}

/** App credentials of a platform (Admin → Platforms): client id / secret, extra keys. */
export interface PlatformAppConfig {
  clientId: string;
  clientSecret: string;
  /** Platform-specific extras (Meta config id, LinkedIn API version, X spend limit…). */
  extra: Record<string, string>;
}

export interface DriverContext {
  /** The operator's app credentials for the platform (null when not configured). */
  app: PlatformAppConfig | null;
  /** OAuth redirect URI of the platform: {site}/api/oauth/{platform}/callback. */
  redirectUri: string;
  /** fetch to use (tests inject a fake one; drivers must not call the global fetch directly). */
  fetch: typeof fetch;
  /** Clock (epoch ms); tests freeze it. */
  now: () => number;
}

/** A field of the connect form for non-OAuth channels (Bluesky, Telegram, Discord, Mastodon instance). */
export interface ConnectField {
  name: string;
  /** Message key or plain English label. */
  label: string;
  type: "text" | "password" | "url";
  placeholder?: string;
  hint?: string;
  required: boolean;
}

export interface ConnectStartInput {
  workspaceId: number;
  userId: number;
  /** Signed OAuth state (src/lib/oauth-state.ts); drivers pass it through unchanged. */
  state: string;
  /** PKCE verifier created by the caller (oauth2_pkce); the challenge is derived by the driver. */
  codeVerifier: string;
  /** Values of the connect form (e.g. the Mastodon instance) when the flow starts with one. */
  form: Record<string, string>;
}

export type ConnectStartResult =
  /** Send the user to the platform's consent screen. `carry` is kept (encrypted) until the callback. */
  | { kind: "redirect"; url: string; carry?: Record<string, string> }
  /** Show a form (app password, bot token, webhook URL), then call connectFinish with its values. */
  | { kind: "form"; fields: ConnectField[] };

export interface ConnectFinishInput {
  workspaceId: number;
  userId: number;
  /** Callback query (code, state, error…) for OAuth flows; {} otherwise. */
  query: Record<string, string>;
  codeVerifier: string;
  /** Form values (non-OAuth) or the values carried from connectStart. */
  form: Record<string, string>;
  carry: Record<string, string>;
}

/** An account the user can add as a channel (Facebook returns one per Page). */
export interface ConnectedAccount {
  externalId: string;
  name: string;
  handle: string;
  avatarUrl: string;
  profileUrl: string;
  credentials: ChannelCredentials;
  /** ISO expiry of the access token (null = doesn't expire). */
  tokenExpiresAt: string | null;
  meta: Record<string, unknown>;
}

export interface RefreshResult {
  credentials: ChannelCredentials;
  tokenExpiresAt: string | null;
}

export type TestResult = { ok: true; account?: Partial<Pick<ConnectedAccount, "name" | "handle" | "avatarUrl" | "profileUrl" | "meta">> } | { ok: false; error: DriverError };

/**
 * Resumable progress of a publication (post_targets.upload_state, JSON). Drivers save it through
 * PublishInput.saveState() BEFORE each irreversible step, so a retry after a timeout continues
 * instead of uploading or publishing twice. Keys are driver-specific, e.g.
 *   { containerId, children: [..], mediaIds: [..], segment: 3, uploadUrl, etags: [..], published: { id } }
 */
export type UploadState = Record<string, unknown>;

/** One media item handed to a driver (MediaInfo plus a way to read the bytes). */
export interface MediaAsset extends MediaInfo {
  /** Streams the file (byte-push platforms); `range` reads a part (chunked uploads). */
  open(range?: { start: number; end: number }): Promise<ReadableStream<Uint8Array>>;
}

export interface PublishInput {
  channel: DriverChannel;
  /** The effective content for this channel (base merged with the override, UTM applied). */
  content: PostContent;
  media: MediaAsset[];
  target: {
    id: number;
    postId: number;
    /** 1 for the first try. */
    attempt: number;
    /** What earlier attempts saved (see UploadState). */
    uploadState: UploadState;
    /** Stable per target: use it where the platform supports idempotency keys (Mastodon). */
    idempotencyKey: string;
  };
  /** Persist progress now (merged into post_targets.upload_state). */
  saveState(state: UploadState): Promise<void>;
}

export interface PublishResult {
  externalId: string;
  permalink: string;
  /** ISO time the platform reports (defaults to now). */
  publishedAt?: string;
  /** Ids of the self-replies / thread parts and of the first comment, when posted. */
  threadIds?: string[];
  firstCommentId?: string;
  /** Non-fatal problems (e.g. "first comment failed: …"). */
  warnings?: string[];
}

export interface FindExistingInput {
  channel: DriverChannel;
  content: PostContent;
  uploadState: UploadState;
  /** Only posts created after this ISO time can match (the first attempt's start). */
  since: string;
}

export const METRIC_FIELDS = ["views", "impressions", "reach", "likes", "comments", "shares", "saves", "clicks", "quotes"] as const;
export type MetricField = (typeof METRIC_FIELDS)[number];
/** Metrics of one published post; missing fields = the platform doesn't report them. */
export type PostMetrics = Partial<Record<MetricField, number>>;

export interface MetricsRequest {
  externalId: string;
  publishedAt: string;
}

export interface MetricsResult {
  externalId: string;
  metrics: PostMetrics;
}

/**
 * Every platform driver implements this (src/lib/platforms/<platform>.ts), and the Simulated
 * driver implements it for all platforms in DEMO_MODE. Drivers are stateless: everything they
 * need comes in through the arguments and the DriverContext; they throw DriverError only.
 */
export interface SocialDriver {
  readonly platform: Platform;
  /** Begin connecting: an OAuth redirect or a form to fill in. */
  connectStart(ctx: DriverContext, input: ConnectStartInput): Promise<ConnectStartResult>;
  /** Finish connecting: exchange the code / check the form values; one or more accounts to add. */
  connectFinish(ctx: DriverContext, input: ConnectFinishInput): Promise<ConnectedAccount[]>;
  /** New credentials before the token expires; null when nothing needs refreshing. */
  refresh(ctx: DriverContext, channel: DriverChannel): Promise<RefreshResult | null>;
  /** Cheap authenticated call proving the credentials work (also refreshes profile data). */
  testConnection(ctx: DriverContext, channel: DriverChannel): Promise<TestResult>;
  publish(ctx: DriverContext, input: PublishInput): Promise<PublishResult>;
  /** Delete a published post on the network (best effort; throws DriverError when it can't). */
  deleteRemote(ctx: DriverContext, channel: DriverChannel, externalId: string): Promise<void>;
  /** Metrics of published posts (empty list when the platform has no analytics API). */
  fetchMetrics(ctx: DriverContext, channel: DriverChannel, items: MetricsRequest[]): Promise<MetricsResult[]>;
  /**
   * Idempotency check before a retry: the post this target already created, if it exists (X,
   * Facebook Reels and LinkedIn have no idempotency key). null = not found / can't tell.
   */
  findExisting(ctx: DriverContext, input: FindExistingInput): Promise<{ externalId: string; permalink: string } | null>;
}

// ── Notification channels (where workspace notifications go; not social channels) ──

export const NOTIFY_CHANNEL_TYPES = ["email", "webhook", "slack", "discord", "telegram", "teams"] as const;
export type NotifyChannelType = (typeof NOTIFY_CHANNEL_TYPES)[number];

export interface NotifyConfigByType {
  /** Comma-separated addresses. */
  email: { to: string };
  /** Payload signed with HMAC-SHA256 of `secret` in the X-Queuezen-Signature header. */
  webhook: { url: string; secret: string };
  slack: { webhookUrl: string };
  discord: { webhookUrl: string };
  teams: { webhookUrl: string };
  telegram: { botToken: string; chatId: string };
}
export type NotifyConfig<T extends NotifyChannelType = NotifyChannelType> = NotifyConfigByType[T];

/** Events sent to notification channels. */
export const NOTIFY_EVENTS = [
  "post_failed",
  "post_published",
  "approval_requested",
  "approval_decided",
  "channel_expiring",
  "channel_disconnected",
  "rss_failed",
  "quota_warning",
  "quota_reached",
  "test",
] as const;
export type NotifyEvent = (typeof NOTIFY_EVENTS)[number];

/** Events a new notification channel receives (post_published is noisy, so it's opt-in). */
export const DEFAULT_NOTIFY_EVENTS: readonly NotifyEvent[] = ["post_failed", "approval_requested", "approval_decided", "channel_expiring", "channel_disconnected", "rss_failed", "quota_warning", "quota_reached"];

/** What every notification channel receives (also the JSON body of webhooks). Keys are snake_case, like the REST API's, `data` keys included. */
export interface NotifyPayload {
  event: NotifyEvent;
  workspace: { id: number; name: string } | null;
  /** Human-readable one-line summary. */
  message: string;
  /** Facts behind the notification (post, channel, platform, error, used, limit…). */
  data: Record<string, number | string>;
  /** Link to the relevant dashboard page. */
  url: string;
  /** ISO time the notification was sent. */
  sent_at: string;
}

// ── REST API (/api/v1, API key of a workspace) ──

export interface ApiChannel {
  id: number;
  platform: Platform;
  name: string;
  handle: string;
  status: ChannelStatus;
  avatar_url: string;
}

/** PostContent as the REST API shows it (snake_case keys, also inside `options`). */
export interface ApiPostContent {
  text: string;
  media_ids: number[];
  link: string;
  link_meta: { title: string; description: string; image_url: string } | null;
  first_comment: string;
  thread: string[];
  options: Record<string, unknown>;
}

export interface ApiPost {
  id: number;
  status: PostStatus;
  scheduled_at: string | null;
  content: ApiPostContent;
  labels: string[];
  targets: Array<{ id: number; channel_id: number; platform: Platform; status: TargetStatus; permalink: string | null; published_at: string | null; error: string | null }>;
  created_at: string;
}
