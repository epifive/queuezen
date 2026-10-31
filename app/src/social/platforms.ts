/**
 * Platform capabilities registry: what each network accepts and how it is connected. The single
 * source for composer counters and validation (./normalize.ts), the drivers, the admin
 * "Platform health" wizard and the docs. Facts come from PRODUCT-8-TECH.md (October 2026);
 * values marked in `notes` with "[verify]" are conflicting in the official docs: read them at
 * runtime where the platform offers it (Instagram content_publishing_limit, Mastodon
 * /api/v2/instance) and re-check before each release.
 *
 * Dependency-free (server, client components and tests).
 */

import type { AuthKind, MetricField, Platform } from "./types";

const KB = 1024;
const MB = 1024 * 1024;
const GB = 1024 * MB;

/**
 * How text length is counted:
 * - chars:      Unicode code points (most platforms)
 * - utf16:      UTF-16 code units (Telegram counts like JavaScript's .length)
 * - graphemes:  user-perceived characters (Bluesky counts graphemes)
 * - x_weighted: X's weighted count: URLs = 23, CJK and emoji = 2, the rest = 1
 * - mastodon:   code points, but every URL counts as 23 and "@user@domain" as "@user"
 */
export type TextCounting = "chars" | "utf16" | "graphemes" | "x_weighted" | "mastodon";

export interface ImageRules {
  /** MIME types. */
  types: string[];
  maxBytes: number;
  /** Width / height bounds (inclusive); null = no limit. */
  minAspect: number | null;
  maxAspect: number | null;
  minWidth: number | null;
  maxWidth: number | null;
}

export interface VideoRules {
  types: string[];
  maxBytes: number;
  minBytes: number;
  /** Seconds. */
  minDuration: number;
  maxDuration: number;
  minAspect: number | null;
  maxAspect: number | null;
}

export interface MediaRules {
  /** "none" = text-only is fine; "any" = at least one item; "video" = exactly one video needed. */
  required: "none" | "any" | "image" | "video";
  /** Most items in one post (carousel / album / gallery). */
  maxItems: number;
  /** Fewest items when there is more than one (carousels of 2+). */
  minCarousel: number;
  /** Images and videos in the same post. */
  mixed: boolean;
  /** Videos per post. */
  maxVideos: number;
  image: ImageRules | null;
  /** GIFs (null = not accepted as such; may be accepted as an image type). */
  gif: { maxBytes: number } | null;
  video: VideoRules | null;
  /** How the driver hands media over: the platform pulls a public URL, or we push the bytes. */
  transfer: "url" | "upload" | "both";
}

/** Post types with their own media rules (Instagram / Facebook reels and stories, YouTube Shorts). */
export interface PostTypeRules {
  label: string;
  media: Partial<Omit<MediaRules, "image" | "video">> & { image?: ImageRules | null; video?: VideoRules | null };
  note?: string;
}

export interface PlatformCapabilities {
  id: Platform;
  /** Display name (see ./format.ts for colours and icons). */
  name: string;
  release: "v1" | "v1.1";
  text: {
    /** Limit of the main text (caption / description). */
    max: number;
    counting: TextCounting;
    /** Characters a URL counts for (X, Mastodon), null = counted as typed. */
    urlLength: number | null;
    /** Limit of the caption when media is attached (Telegram 1,024), null = same as max. */
    maxWithMedia: number | null;
    /** True when a post can't be text-only (the media rules say what is needed instead). */
    required: boolean;
    maxHashtags: number | null;
    maxMentions: number | null;
    /** Links in the text (Threads allows 5), null = no limit. */
    maxLinks: number | null;
  };
  media: MediaRules;
  postTypes: Record<string, PostTypeRules> | null;
  /**
   * Links:
   * - auto:       the platform builds a preview from the URL in the text
   * - attachment: a link is attached to the post and previewed by the platform (Facebook, Threads)
   * - card:       we build the card (title, description, thumbnail): LinkedIn article, Bluesky embed
   * - none:       links aren't clickable (Instagram) or not supported
   */
  links: "auto" | "attachment" | "card" | "none";
  /** First comment: a comment on the post, a self-reply, or not possible. */
  firstComment: "comment" | "reply" | "none";
  threads: { supported: boolean; maxParts: number };
  /** The platform can schedule natively. We never use it (one code path), it's informational. */
  nativeScheduling: { supported: boolean; note: string };
  analytics: { supported: boolean; fields: MetricField[]; note: string };
  auth: {
    kind: AuthKind;
    /** Human summary of token lifetimes. */
    tokenLifetime: string;
    /** Access token lifetime in seconds (null = doesn't expire). */
    accessTtl: number | null;
    /**
     * - rotating:   refresh token is single-use; save the new pair atomically
     * - refresh:    a long-lived refresh token gets new access tokens
     * - exchange:   the long-lived token itself is exchanged for a new one (Meta IG Login, Threads)
     * - session:    a stored session is refreshed (Bluesky)
     * - reauth:     no refresh possible: remind the user to reconnect before expiry (LinkedIn)
     * - none:       tokens don't expire
     */
    refresh: "rotating" | "refresh" | "exchange" | "session" | "reauth" | "none";
    /** Refresh / remind this many days before expiry (0 = on demand). */
    refreshLeadDays: number;
    scopes: string[];
    /** Review needed before other people's accounts can connect. */
    reviewRequired: boolean;
    review: string;
    /** Where the operator creates the app. */
    console: string;
  };
  limits: { note: string; perAccount: Array<{ count: number; windowHours: number }> };
  /** X API price per post (USD), null = free. */
  cost: { perPost: number; perPostWithUrl: number } | null;
  docs: string[];
  /** Caveats shown in the wizard / docs. "[verify]" = conflicting official docs. */
  notes: string[];
}

const IMG_JPEG_PNG = ["image/jpeg", "image/png"];
const IMG_COMMON = ["image/jpeg", "image/png", "image/webp"];
const VIDEO_MP4_MOV = ["video/mp4", "video/quicktime"];

/** Instagram rules are shared by both Instagram APIs. */
const INSTAGRAM_MEDIA: MediaRules = {
  required: "any",
  maxItems: 10,
  minCarousel: 2,
  mixed: true,
  maxVideos: 10,
  image: { types: ["image/jpeg"], maxBytes: 8 * MB, minAspect: 4 / 5, maxAspect: 1.91, minWidth: 320, maxWidth: 1440 },
  gif: null,
  video: { types: VIDEO_MP4_MOV, maxBytes: 300 * MB, minBytes: 0, minDuration: 3, maxDuration: 15 * 60, minAspect: 0.01, maxAspect: 10 },
  transfer: "url",
};

const INSTAGRAM_POST_TYPES: Record<string, PostTypeRules> = {
  feed: { label: "Feed post / carousel", media: {}, note: "Carousels hold up to 10 images and videos and are cropped to the first item's ratio. A carousel counts as one post." },
  reel: {
    label: "Reel",
    media: { required: "video", maxItems: 1, maxVideos: 1, image: null },
    note: "MP4 or MOV (H.264 / HEVC), 3 s to 15 min, up to 300 MB. 9:16 is recommended.",
  },
  story: {
    label: "Story",
    media: {
      required: "any",
      maxItems: 1,
      video: { types: VIDEO_MP4_MOV, maxBytes: 100 * MB, minBytes: 0, minDuration: 3, maxDuration: 60, minAspect: 0.01, maxAspect: 10 },
      image: { types: ["image/jpeg"], maxBytes: 8 * MB, minAspect: null, maxAspect: null, minWidth: 320, maxWidth: null },
    },
    note: "One image or a video of up to 60 s / 100 MB. Captions and link stickers aren't supported.",
  },
};

const META_IG_FB_SCOPES = ["instagram_basic", "instagram_content_publish", "instagram_manage_comments", "instagram_manage_insights", "pages_show_list", "pages_read_engagement"];

export const PLATFORM_CAPABILITIES: Record<Platform, PlatformCapabilities> = {
  facebook: {
    id: "facebook",
    name: "Facebook",
    release: "v1",
    text: { max: 63_206, counting: "chars", urlLength: null, maxWithMedia: null, required: false, maxHashtags: null, maxMentions: null, maxLinks: null },
    media: {
      required: "none",
      maxItems: 10,
      minCarousel: 2,
      mixed: false,
      maxVideos: 1,
      image: { types: ["image/jpeg", "image/png", "image/gif", "image/webp"], maxBytes: 10 * MB, minAspect: null, maxAspect: null, minWidth: null, maxWidth: null },
      gif: { maxBytes: 10 * MB },
      video: { types: VIDEO_MP4_MOV, maxBytes: 1 * GB, minBytes: 0, minDuration: 1, maxDuration: 240 * 60, minAspect: null, maxAspect: null },
      transfer: "both",
    },
    postTypes: {
      feed: { label: "Feed post", media: {}, note: "Text, a link, up to 10 photos (multi-photo post) or one video." },
      reel: {
        label: "Reel",
        media: {
          required: "video",
          maxItems: 1,
          image: null,
          video: { types: ["video/mp4"], maxBytes: 1 * GB, minBytes: 0, minDuration: 3, maxDuration: 90, minAspect: 0.5, maxAspect: 0.6 },
        },
        note: "Vertical 9:16 MP4, 3 to 90 s. At most 30 Reels per Page in a rolling 24 h. Finishing an upload returns no post id and has no idempotency key, so a blind retry can duplicate the Reel.",
      },
      story: { label: "Story", media: { required: "any", maxItems: 1 }, note: "One photo or video." },
    },
    links: "attachment",
    firstComment: "comment",
    threads: { supported: false, maxParts: 1 },
    nativeScheduling: { supported: true, note: "Feed posts: published=false + scheduled_publish_time, 10 min to 30 days ahead (not used)." },
    analytics: { supported: true, fields: ["views", "likes", "comments", "shares", "clicks"], note: "Impressions and Page fans were removed on 15 Nov 2025 in favour of views; more field changes on 30 Jun 2026." },
    auth: {
      kind: "oauth2",
      tokenLifetime: "Long-lived user token 60 days; Page tokens derived from it don't expire.",
      accessTtl: null,
      refresh: "none",
      refreshLeadDays: 0,
      scopes: ["pages_show_list", "pages_manage_posts", "pages_read_engagement", "pages_manage_engagement", "publish_video", "read_insights"],
      reviewRequired: true,
      review:
        "Standard Access works right away for people with a role on the app (enough for your own Pages). Serving other people's Pages needs Advanced Access: App Review (a screencast per permission) and Business Verification (registered business, privacy and data-deletion URLs). Days to weeks; scopes not shown in use are rejected.",
      console: "https://developers.facebook.com/apps",
    },
    limits: { note: "Reels: 30 per Page per rolling 24 h.", perAccount: [] },
    cost: null,
    docs: ["https://developers.facebook.com/docs/pages-api/posts", "https://developers.facebook.com/docs/video-api/guides/reels-publishing/", "https://developers.facebook.com/blog/post/2025/08/15/page-insights-api-updates/"],
    notes: [
      "Pages only: personal profiles and Groups can't be posted to.",
      "The connecting user needs the CREATE_CONTENT, MANAGE and MODERATE tasks on the Page.",
      "Reels native scheduling is disputed [verify]; we publish at the time ourselves.",
    ],
  },

  instagram: {
    id: "instagram",
    name: "Instagram",
    release: "v1",
    text: { max: 2200, counting: "chars", urlLength: null, maxWithMedia: null, required: false, maxHashtags: 30, maxMentions: 20, maxLinks: null },
    media: { ...INSTAGRAM_MEDIA, transfer: "both" },
    postTypes: INSTAGRAM_POST_TYPES,
    links: "none",
    firstComment: "comment",
    threads: { supported: false, maxParts: 1 },
    nativeScheduling: { supported: false, note: "No native scheduling." },
    analytics: { supported: true, fields: ["views", "reach", "likes", "comments", "saves", "shares"], note: "Impressions and plays were removed in April 2025 (Graph API v22)." },
    auth: {
      kind: "oauth2",
      tokenLifetime: "Page-derived token, doesn't expire.",
      accessTtl: null,
      refresh: "none",
      refreshLeadDays: 0,
      scopes: META_IG_FB_SCOPES,
      reviewRequired: true,
      review: "Same Meta App Review and Business Verification as Facebook. Business or Creator accounts linked to a Facebook Page only (personal Instagram accounts are not supported).",
      console: "https://developers.facebook.com/apps",
    },
    limits: { note: "100 published posts per rolling 24 h (a carousel counts as 1; the same page also says 50: read content_publishing_limit). 400 containers per 24 h; containers expire after 24 h.", perAccount: [{ count: 100, windowHours: 24 }] },
    cost: null,
    docs: [
      "https://developers.facebook.com/docs/instagram-platform/content-publishing",
      "https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media",
      "https://docs.emplifi.io/platform/latest/home/instagram-insights-metrics-deprecation-april-2025",
    ],
    notes: [
      "Images must be JPEG, 4:5 to 1.91:1, 320 to 1440 px wide, up to 8 MB.",
      "Daily publishing limit 100 vs 50 [verify]: read content_publishing_limit at runtime.",
      "Links in captions are not clickable.",
    ],
  },

  instagram_login: {
    id: "instagram_login",
    name: "Instagram (Instagram Login)",
    release: "v1",
    text: { max: 2200, counting: "chars", urlLength: null, maxWithMedia: null, required: false, maxHashtags: 30, maxMentions: 20, maxLinks: null },
    media: INSTAGRAM_MEDIA,
    postTypes: INSTAGRAM_POST_TYPES,
    links: "none",
    firstComment: "comment",
    threads: { supported: false, maxParts: 1 },
    nativeScheduling: { supported: false, note: "No native scheduling." },
    analytics: { supported: true, fields: ["views", "reach", "likes", "comments", "saves", "shares"], note: "Impressions and plays were removed in April 2025 (Graph API v22)." },
    auth: {
      kind: "oauth2",
      tokenLifetime: "Long-lived token 60 days, refreshed with ig_refresh_token once it is at least 24 h old; dead if not refreshed within 60 days.",
      accessTtl: 60 * 86_400,
      refresh: "exchange",
      refreshLeadDays: 15,
      scopes: ["instagram_business_basic", "instagram_business_content_publish", "instagram_business_manage_comments", "instagram_business_manage_insights"],
      reviewRequired: true,
      review: "Meta App Review and Business Verification, like Facebook. Business or Creator accounts; no Facebook Page needed.",
      console: "https://developers.facebook.com/apps",
    },
    limits: { note: "100 published posts per rolling 24 h (read content_publishing_limit).", perAccount: [{ count: 100, windowHours: 24 }] },
    cost: null,
    docs: ["https://developers.facebook.com/docs/instagram-platform/content-publishing", "https://developers.facebook.com/docs/instagram-platform/reference/refresh_access_token/"],
    notes: ["Media is passed by public URL only (no byte upload).", "Links in captions are not clickable."],
  },

  threads: {
    id: "threads",
    name: "Threads",
    release: "v1",
    text: { max: 500, counting: "chars", urlLength: null, maxWithMedia: null, required: false, maxHashtags: null, maxMentions: null, maxLinks: 5 },
    media: {
      required: "none",
      maxItems: 20,
      minCarousel: 2,
      mixed: true,
      maxVideos: 20,
      image: { types: IMG_JPEG_PNG, maxBytes: 8 * MB, minAspect: null, maxAspect: null, minWidth: null, maxWidth: null },
      gif: null,
      video: { types: VIDEO_MP4_MOV, maxBytes: 1 * GB, minBytes: 0, minDuration: 0, maxDuration: 5 * 60, minAspect: null, maxAspect: null },
      transfer: "url",
    },
    postTypes: null,
    links: "attachment",
    firstComment: "reply",
    threads: { supported: true, maxParts: 20 },
    nativeScheduling: { supported: false, note: "No native scheduling." },
    analytics: { supported: true, fields: ["views", "likes", "comments", "shares", "quotes"], note: "views, likes, replies, reposts and quotes (replies → comments, reposts → shares)." },
    auth: {
      kind: "oauth2",
      tokenLifetime: "Short-lived 1 h → long-lived 60 days, refreshed with th_refresh_token once at least 24 h old.",
      accessTtl: 60 * 86_400,
      refresh: "exchange",
      refreshLeadDays: 15,
      scopes: ["threads_basic", "threads_content_publish", "threads_manage_replies", "threads_manage_insights", "threads_delete"],
      reviewRequired: true,
      review:
        "Before App Review only invited testers can connect (they accept in Threads → Settings → Account → Website permissions). Any profile works, personal ones included; permissions of private profiles lapse after 90 days.",
      console: "https://developers.facebook.com/apps",
    },
    limits: { note: "250 posts per 24 h per profile. Containers need ~30 s before publishing.", perAccount: [{ count: 250, windowHours: 24 }] },
    cost: null,
    docs: ["https://developers.facebook.com/docs/threads/posts", "https://developers.facebook.com/documentation/threads/get-started/long-lived-tokens"],
    notes: ["Carousels hold 2 to 20 items.", "At most 5 links per post (since 22 Dec 2025) and 1 topic tag."],
  },

  x: {
    id: "x",
    name: "X",
    release: "v1",
    text: { max: 280, counting: "x_weighted", urlLength: 23, maxWithMedia: null, required: false, maxHashtags: null, maxMentions: null, maxLinks: null },
    media: {
      required: "none",
      maxItems: 4,
      minCarousel: 2,
      mixed: false,
      maxVideos: 1,
      image: { types: IMG_COMMON, maxBytes: 5 * MB, minAspect: null, maxAspect: null, minWidth: null, maxWidth: null },
      gif: { maxBytes: 15 * MB },
      video: { types: VIDEO_MP4_MOV, maxBytes: 512 * MB, minBytes: 0, minDuration: 0.5, maxDuration: 140, minAspect: 1 / 3, maxAspect: 3 },
      transfer: "upload",
    },
    postTypes: null,
    links: "auto",
    firstComment: "reply",
    threads: { supported: true, maxParts: 25 },
    nativeScheduling: { supported: false, note: "No native scheduling." },
    analytics: { supported: true, fields: ["impressions", "likes", "comments", "shares", "quotes"], note: "public_metrics (likes, reposts, replies, quotes, impressions), billed as owned reads ($0.001 each)." },
    auth: {
      kind: "oauth2_pkce",
      tokenLifetime: "Access token 2 h; the refresh token is single-use and rotates (save both atomically).",
      accessTtl: 2 * 3600,
      refresh: "rotating",
      refreshLeadDays: 0,
      scopes: ["tweet.read", "tweet.write", "users.read", "media.write", "offline.access"],
      reviewRequired: false,
      review: "No review, but no free tier: the operator buys prepaid API credits at console.x.com (Free was retired on 6 Feb 2026) and should set a spend limit.",
      console: "https://console.x.com",
    },
    limits: { note: "POST /2/tweets: 100 per 15 min per user, 10,000 per 24 h per app. Media uploads 1,875 per 15 min.", perAccount: [{ count: 100, windowHours: 0.25 }] },
    cost: { perPost: 0.015, perPostWithUrl: 0.2 },
    docs: ["https://docs.x.com/x-api/getting-started/pricing", "https://docs.x.com/x-api/fundamentals/rate-limits", "https://docs.x.com/x-api/media/quickstart/media-upload-chunked"],
    notes: [
      "A post containing a URL costs $0.20 instead of $0.015 (October 2026 pricing).",
      "Without the media.write scope uploads fail with 403.",
      "Video limits for Premium users are longer; the docs conflict [verify]. We use 140 s / 512 MB.",
    ],
  },

  linkedin: {
    id: "linkedin",
    name: "LinkedIn",
    release: "v1",
    text: { max: 3000, counting: "chars", urlLength: null, maxWithMedia: null, required: false, maxHashtags: null, maxMentions: null, maxLinks: null },
    media: {
      required: "none",
      maxItems: 20,
      minCarousel: 2,
      mixed: false,
      maxVideos: 1,
      image: { types: ["image/jpeg", "image/png", "image/gif"], maxBytes: 8 * MB, minAspect: null, maxAspect: null, minWidth: null, maxWidth: null },
      gif: { maxBytes: 8 * MB },
      video: { types: ["video/mp4"], maxBytes: 500 * MB, minBytes: 75 * KB, minDuration: 3, maxDuration: 30 * 60, minAspect: null, maxAspect: null },
      transfer: "upload",
    },
    postTypes: null,
    links: "card",
    firstComment: "comment",
    threads: { supported: false, maxParts: 1 },
    nativeScheduling: { supported: false, note: "No native scheduling." },
    analytics: { supported: false, fields: [], note: "r_member_social is closed, so personal profile posts have no analytics API (company pages need the Community Management API)." },
    auth: {
      kind: "oauth2",
      tokenLifetime: "60 days. Refresh tokens are only for approved partners, so profiles reconnect every 60 days.",
      accessTtl: 60 * 86_400,
      refresh: "reauth",
      // Re-auth reminder (token-refresh job), "Expires soon" on the Channels page and the home dashboard.
      refreshLeadDays: 7,
      scopes: ["openid", "profile", "w_member_social"],
      reviewRequired: false,
      review: "\"Share on LinkedIn\" + \"Sign In with LinkedIn using OpenID Connect\" are self-serve: no review for personal profiles. Company Pages need the Community Management API on a separate app (planned for v1.1).",
      console: "https://www.linkedin.com/developers/apps",
    },
    limits: { note: "About 150 requests per member per day, 100k per app per day.", perAccount: [] },
    cost: null,
    docs: ["https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api", "https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api"],
    notes: [
      "Send the LinkedIn-Version header (YYYYMM); versions sunset after about a year (202511 sunsets on 16 Nov 2026).",
      "Article links need our own title, description and thumbnail: LinkedIn doesn't scrape URLs.",
      "Videos upload in 4 MB parts (initializeUpload → PUT parts → finalizeUpload with the ETags).",
      "Image size limit isn't documented clearly [verify]; we use 8 MB.",
    ],
  },

  youtube: {
    id: "youtube",
    name: "YouTube",
    release: "v1",
    text: { max: 5000, counting: "chars", urlLength: null, maxWithMedia: null, required: false, maxHashtags: null, maxMentions: null, maxLinks: null },
    media: {
      required: "video",
      maxItems: 1,
      minCarousel: 1,
      mixed: false,
      maxVideos: 1,
      image: null,
      gif: null,
      video: { types: ["video/mp4", "video/quicktime", "video/webm", "video/x-msvideo", "video/mpeg"], maxBytes: 256 * GB, minBytes: 0, minDuration: 1, maxDuration: 12 * 3600, minAspect: null, maxAspect: null },
      transfer: "upload",
    },
    postTypes: null,
    links: "none",
    firstComment: "none",
    threads: { supported: false, maxParts: 1 },
    nativeScheduling: { supported: true, note: "privacyStatus=private + status.publishAt (not used)." },
    analytics: { supported: true, fields: ["views", "likes", "comments"], note: "videos.list?part=statistics." },
    auth: {
      kind: "oauth2",
      tokenLifetime: "Access token 1 h with a refresh token. While the consent screen is in Testing, refresh tokens die after 7 days.",
      accessTtl: 3600,
      refresh: "refresh",
      refreshLeadDays: 0,
      scopes: ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.readonly"],
      reviewRequired: true,
      review: "youtube.upload is a sensitive scope: Google OAuth verification is required (demo video). In Testing mode at most 100 users and 7-day refresh tokens. Optional quota audit for more uploads.",
      console: "https://console.cloud.google.com/apis/credentials",
    },
    limits: { note: "Since 1 Jun 2026: 100 uploads per day per Cloud project, shared by every tenant (raise it with the Audit & Quota Extension form).", perAccount: [] },
    cost: null,
    docs: ["https://developers.google.com/youtube/v3/docs/videos/insert", "https://developers.google.com/youtube/data/determine_quota_cost"],
    notes: [
      "The post text is the video description; the title is required (options.youtube.title, ≤ 100 characters).",
      "Shorts: vertical or square videos up to 3 minutes are classified automatically.",
      "Whether unverified projects can only upload private videos is disputed [verify]: complete the audit anyway.",
      "Videos longer than 15 minutes need a verified YouTube account.",
    ],
  },

  bluesky: {
    id: "bluesky",
    name: "Bluesky",
    release: "v1",
    text: { max: 300, counting: "graphemes", urlLength: null, maxWithMedia: null, required: false, maxHashtags: null, maxMentions: null, maxLinks: null },
    media: {
      required: "none",
      maxItems: 4,
      minCarousel: 2,
      mixed: false,
      maxVideos: 1,
      image: { types: ["image/jpeg", "image/png", "image/webp", "image/gif"], maxBytes: 2 * MB, minAspect: null, maxAspect: null, minWidth: null, maxWidth: null },
      gif: { maxBytes: 2 * MB },
      video: { types: ["video/mp4", "video/quicktime", "video/webm"], maxBytes: 300 * MB, minBytes: 0, minDuration: 0, maxDuration: 10 * 60, minAspect: null, maxAspect: null },
      transfer: "upload",
    },
    postTypes: null,
    links: "card",
    firstComment: "reply",
    threads: { supported: true, maxParts: 25 },
    nativeScheduling: { supported: false, note: "No native scheduling." },
    analytics: { supported: true, fields: ["likes", "comments", "shares", "quotes"], note: "likes, reposts, replies and quotes; no impressions." },
    auth: {
      kind: "app_password",
      tokenLifetime: "App password; the session (access + refresh JWT) is stored and refreshed. atproto OAuth (refresh ≤ 180 days, rotating) is planned for v1.1.",
      accessTtl: null,
      refresh: "session",
      refreshLeadDays: 0,
      scopes: [],
      reviewRequired: false,
      review: "No review. Users create an app password in Bluesky → Settings → Privacy and security → App passwords.",
      console: "https://bsky.app/settings/app-passwords",
    },
    limits: { note: "createSession: 30 per 5 min and 300 per day (persist the session). Writes: 5,000 points per hour.", perAccount: [] },
    cost: null,
    docs: ["https://docs.bsky.app/docs/advanced-guides/rate-limits", "https://docs.bsky.app/docs/tutorials/video", "https://docs.bsky.app/docs/advanced-guides/oauth-client"],
    notes: ["Links and mentions need byte-offset facets.", "Link cards are built by us (Open Graph fetch + thumbnail upload).", "Videos go through video.bsky.app."],
  },

  mastodon: {
    id: "mastodon",
    name: "Mastodon",
    release: "v1",
    text: { max: 500, counting: "mastodon", urlLength: 23, maxWithMedia: null, required: false, maxHashtags: null, maxMentions: null, maxLinks: null },
    media: {
      required: "none",
      maxItems: 4,
      minCarousel: 2,
      mixed: false,
      maxVideos: 1,
      image: { types: ["image/jpeg", "image/png", "image/webp", "image/gif"], maxBytes: 16 * MB, minAspect: null, maxAspect: null, minWidth: null, maxWidth: null },
      gif: { maxBytes: 16 * MB },
      video: { types: ["video/mp4", "video/quicktime", "video/webm"], maxBytes: 99 * MB, minBytes: 0, minDuration: 0, maxDuration: 3600, minAspect: null, maxAspect: null },
      transfer: "upload",
    },
    postTypes: null,
    links: "auto",
    firstComment: "reply",
    threads: { supported: true, maxParts: 25 },
    nativeScheduling: { supported: true, note: "scheduled_at at least 5 min ahead, 25 per day (not used)." },
    analytics: { supported: true, fields: ["likes", "comments", "shares"], note: "favourites, reblogs and replies counts." },
    auth: {
      kind: "oauth2_pkce",
      tokenLifetime: "Tokens never expire.",
      accessTtl: null,
      refresh: "none",
      refreshLeadDays: 0,
      scopes: ["write:statuses", "write:media", "read:statuses", "profile"],
      reviewRequired: false,
      review: "No review. An app is registered automatically on each instance the first time someone connects from it.",
      console: "",
    },
    limits: { note: "300 requests per 5 min. Limits are per instance: read /api/v2/instance (characters, media, sizes).", perAccount: [] },
    cost: null,
    docs: ["https://docs.joinmastodon.org/methods/statuses/", "https://docs.joinmastodon.org/methods/scheduled_statuses/"],
    notes: ["500 characters and 4 media are the defaults; instances may allow more.", "Supports Idempotency-Key on POST /api/v1/statuses.", "Videos are processed asynchronously."],
  },

  telegram: {
    id: "telegram",
    name: "Telegram",
    release: "v1",
    text: { max: 4096, counting: "utf16", urlLength: null, maxWithMedia: 1024, required: false, maxHashtags: null, maxMentions: null, maxLinks: null },
    media: {
      required: "none",
      maxItems: 10,
      minCarousel: 2,
      mixed: true,
      maxVideos: 10,
      image: { types: ["image/jpeg", "image/png", "image/webp"], maxBytes: 10 * MB, minAspect: null, maxAspect: null, minWidth: null, maxWidth: null },
      gif: { maxBytes: 50 * MB },
      video: { types: ["video/mp4"], maxBytes: 50 * MB, minBytes: 0, minDuration: 0, maxDuration: 24 * 3600, minAspect: null, maxAspect: null },
      transfer: "both",
    },
    postTypes: null,
    links: "auto",
    firstComment: "none",
    threads: { supported: false, maxParts: 1 },
    nativeScheduling: { supported: false, note: "No native scheduling through the Bot API." },
    analytics: { supported: false, fields: [], note: "The Bot API has no view counts." },
    auth: {
      kind: "bot_token",
      tokenLifetime: "Bot tokens never expire.",
      accessTtl: null,
      refresh: "none",
      refreshLeadDays: 0,
      scopes: [],
      reviewRequired: false,
      review: "No review. Create a bot with @BotFather and add it to the channel as an administrator with permission to post.",
      console: "https://t.me/BotFather",
    },
    limits: { note: "About 1 message per second per chat. Uploads: photos 10 MB, other files 50 MB; by URL 5 MB / 20 MB.", perAccount: [] },
    cost: null,
    docs: ["https://core.telegram.org/bots/api", "https://core.telegram.org/bots/faq"],
    notes: ["Captions with media are limited to 1,024 characters; longer text is sent as a separate message.", "Albums (sendMediaGroup) hold 2 to 10 items."],
  },

  discord: {
    id: "discord",
    name: "Discord",
    release: "v1",
    text: { max: 2000, counting: "chars", urlLength: null, maxWithMedia: null, required: false, maxHashtags: null, maxMentions: null, maxLinks: null },
    media: {
      required: "none",
      maxItems: 10,
      minCarousel: 2,
      mixed: true,
      maxVideos: 10,
      // Webhook uploads: 10 MB per file on servers without boosts (Discord's default limit).
      image: { types: ["image/jpeg", "image/png", "image/webp", "image/gif"], maxBytes: 10 * MB, minAspect: null, maxAspect: null, minWidth: null, maxWidth: null },
      gif: { maxBytes: 10 * MB },
      video: { types: ["video/mp4", "video/quicktime", "video/webm"], maxBytes: 10 * MB, minBytes: 0, minDuration: 0, maxDuration: 24 * 3600, minAspect: null, maxAspect: null },
      transfer: "upload",
    },
    postTypes: null,
    links: "auto",
    firstComment: "none",
    threads: { supported: false, maxParts: 1 },
    nativeScheduling: { supported: false, note: "No native scheduling." },
    analytics: { supported: false, fields: [], note: "Webhooks have no analytics." },
    auth: {
      kind: "webhook",
      tokenLifetime: "Webhook URLs never expire (until deleted in Discord).",
      accessTtl: null,
      refresh: "none",
      refreshLeadDays: 0,
      scopes: [],
      reviewRequired: false,
      review: "No review. Channel settings → Integrations → Webhooks → New webhook → Copy URL.",
      console: "",
    },
    limits: { note: "Files about 20 MiB in total per message; 10 embeds.", perAccount: [] },
    cost: null,
    docs: ["https://docs.discord.com/developers/resources/webhook"],
    notes: ["Forum channels need a thread name (options.discord.threadName).", "Files are limited to 10 MB each: Discord's upload limit for webhooks on servers without boosts."],
  },

  tiktok: {
    id: "tiktok",
    name: "TikTok",
    release: "v1.1",
    text: { max: 2200, counting: "utf16", urlLength: null, maxWithMedia: null, required: false, maxHashtags: null, maxMentions: null, maxLinks: null },
    media: {
      required: "any",
      maxItems: 35,
      minCarousel: 2,
      mixed: false,
      maxVideos: 1,
      image: { types: ["image/jpeg", "image/webp"], maxBytes: 20 * MB, minAspect: null, maxAspect: null, minWidth: null, maxWidth: null },
      gif: null,
      video: { types: ["video/mp4", "video/quicktime", "video/webm"], maxBytes: 4 * GB, minBytes: 0, minDuration: 3, maxDuration: 10 * 60, minAspect: null, maxAspect: null },
      transfer: "both",
    },
    postTypes: null,
    links: "none",
    firstComment: "none",
    threads: { supported: false, maxParts: 1 },
    nativeScheduling: { supported: false, note: "No native scheduling." },
    analytics: { supported: true, fields: ["views", "likes", "comments", "shares"], note: "Display API video.list counts [verify exact fields]." },
    auth: {
      kind: "oauth2",
      tokenLifetime: "Access 24 h; refresh token 365 days, rotating.",
      accessTtl: 24 * 3600,
      refresh: "rotating",
      refreshLeadDays: 0,
      scopes: ["user.info.basic", "video.publish", "video.upload"],
      reviewRequired: true,
      review: "Unaudited apps post SELF_ONLY to private accounts, max 5 posting users per 24 h. The audit (days to 2 weeks) checks the creator_info UI: nickname, a privacy selector without a default, interaction toggles.",
      console: "https://developers.tiktok.com/apps",
    },
    limits: { note: "6 upload inits per minute per token; about 15 posts per creator per day.", perAccount: [{ count: 15, windowHours: 24 }] },
    cost: null,
    docs: ["https://developers.tiktok.com/doc/content-posting-api-reference-direct-post", "https://developers.tiktok.com/doc/content-sharing-guidelines"],
    notes: ["Planned for v1.1.", "PULL_FROM_URL needs a verified domain or URL prefix (HTTPS, no redirects)."],
  },

  pinterest: {
    id: "pinterest",
    name: "Pinterest",
    release: "v1.1",
    text: { max: 500, counting: "chars", urlLength: null, maxWithMedia: null, required: false, maxHashtags: null, maxMentions: null, maxLinks: null },
    media: {
      required: "any",
      maxItems: 5,
      minCarousel: 2,
      mixed: false,
      maxVideos: 1,
      image: { types: ["image/jpeg", "image/png", "image/webp"], maxBytes: 20 * MB, minAspect: null, maxAspect: null, minWidth: null, maxWidth: null },
      gif: null,
      video: { types: VIDEO_MP4_MOV, maxBytes: 2 * GB, minBytes: 0, minDuration: 4, maxDuration: 15 * 60, minAspect: null, maxAspect: null },
      transfer: "both",
    },
    postTypes: null,
    links: "attachment",
    firstComment: "none",
    threads: { supported: false, maxParts: 1 },
    nativeScheduling: { supported: false, note: "No native scheduling." },
    analytics: { supported: true, fields: ["impressions", "saves", "clicks"], note: "Pin analytics: impressions, saves, outbound clicks." },
    auth: {
      kind: "oauth2",
      tokenLifetime: "Access 30 days; continuous refresh token 60 days, rotating.",
      accessTtl: 30 * 86_400,
      refresh: "rotating",
      refreshLeadDays: 5,
      scopes: ["boards:read", "boards:write", "pins:read", "pins:write", "user_accounts:read"],
      reviewRequired: true,
      review: "Trial access: pins are sandbox-only and visible only to their creator although the API returns 201. Standard access needs an upgrade request with a demo video. Apps created after 14 Sep 2026 may get 403 PINNER_DATA_ACCESS_DENIED for non-business users.",
      console: "https://developers.pinterest.com/apps/",
    },
    limits: { note: "Trial: 1,000 calls per day per app.", perAccount: [] },
    cost: null,
    docs: ["https://developers.pinterest.com/docs/key-concepts/access-tiers/", "https://developers.pinterest.com/docs/reference/rate-limits/"],
    notes: ["Planned for v1.1.", "A board is required (options.pinterest.boardId)."],
  },
};

export function getCapabilities(platform: Platform): PlatformCapabilities {
  return PLATFORM_CAPABILITIES[platform];
}

/** Media rules of a post type merged over the platform's defaults. */
export function mediaRulesFor(platform: Platform, postType?: string | null): MediaRules {
  const caps = PLATFORM_CAPABILITIES[platform];
  const variant = postType ? caps.postTypes?.[postType] : undefined;
  if (!variant) return caps.media;
  const { image, video, ...rest } = variant.media;
  return { ...caps.media, ...rest, image: image === undefined ? caps.media.image : image, video: video === undefined ? caps.media.video : video };
}

/** OAuth callback path of a platform (the admin wizard shows the full URL to copy). */
export function oauthCallbackPath(platform: Platform): string {
  return `/api/oauth/${platform}/callback`;
}

/** Platforms whose connection goes through the operator's own developer app (Admin → Platforms). */
export function needsOperatorApp(platform: Platform): boolean {
  const kind = PLATFORM_CAPABILITIES[platform].auth.kind;
  return (kind === "oauth2" || kind === "oauth2_pkce") && platform !== "mastodon";
}
