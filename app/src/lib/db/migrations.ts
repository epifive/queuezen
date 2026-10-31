import "server-only";
import { sql, type Kysely } from "kysely";
import type { Migration, MigrationProvider } from "kysely/migration";
import { DEFAULT_PAGES } from "./seed-pages";
import { DEFAULT_POSTS } from "./seed-posts";

/**
 * Versioned schema migrations. They run automatically on first database
 * access after an update, so buyers only need to replace files and restart.
 * Never edit a released migration: add a new one instead.
 *
 * Portable Kysely only (SQLite + MySQL/MariaDB/TiDB): ISO date strings, JSON as text,
 * integers for booleans, varchar lengths that fit utf8mb4 index limits.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = Kysely<any>;

const ts = () => new Date().toISOString();

/** Tables of the initial schema, dropped in reverse order by down(). */
const TABLES = [
  "settings",
  "users",
  "sessions",
  "password_resets",
  "plans",
  "payments",
  "pages",
  "contact_messages",
  "languages",
  "translations",
  "blog_posts",
  "workspaces",
  "workspace_members",
  "workspace_invites",
  "channels",
  "posts",
  "post_targets",
  "media_folders",
  "media",
  "rss_feeds",
  "rss_items",
  "short_links",
  "link_clicks_daily",
  "post_metrics",
  "platform_usage_daily",
  "approval_links",
  "post_comments",
  "api_keys",
  "usage_monthly",
  "notify_channels",
  "alert_log",
];

const migrations: Record<string, Migration> = {
  "2026_10_20_000001_initial_schema": {
    async up(db: AnyDb) {
      // ── Platform: settings, accounts, billing, content ──
      await db.schema
        .createTable("settings")
        .addColumn("key", "varchar(100)", (c) => c.primaryKey())
        .addColumn("value", "text")
        .execute();

      await db.schema
        .createTable("users")
        .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
        .addColumn("name", "varchar(120)", (c) => c.notNull())
        .addColumn("email", "varchar(190)", (c) => c.notNull().unique())
        .addColumn("password_hash", "varchar(255)", (c) => c.notNull())
        .addColumn("role", "varchar(20)", (c) => c.notNull().defaultTo("user"))
        .addColumn("status", "varchar(20)", (c) => c.notNull().defaultTo("active"))
        .addColumn("plan_id", "integer")
        .addColumn("plan_expires_at", "varchar(32)")
        .addColumn("stripe_customer_id", "varchar(100)")
        .addColumn("stripe_subscription_id", "varchar(100)")
        .addColumn("created_at", "varchar(32)", (c) => c.notNull())
        .addColumn("updated_at", "varchar(32)", (c) => c.notNull())
        .execute();

      await db.schema
        .createTable("sessions")
        .addColumn("id", "varchar(64)", (c) => c.primaryKey())
        .addColumn("user_id", "integer", (c) => c.notNull())
        .addColumn("expires_at", "varchar(32)", (c) => c.notNull())
        .addColumn("ip", "varchar(64)")
        .addColumn("user_agent", "varchar(255)")
        .addColumn("created_at", "varchar(32)", (c) => c.notNull())
        .execute();
      await db.schema.createIndex("sessions_user_id_idx").on("sessions").column("user_id").execute();

      await db.schema
        .createTable("password_resets")
        .addColumn("token_hash", "varchar(64)", (c) => c.primaryKey())
        .addColumn("user_id", "integer", (c) => c.notNull())
        .addColumn("expires_at", "varchar(32)", (c) => c.notNull())
        .addColumn("created_at", "varchar(32)", (c) => c.notNull())
        .execute();

      await db.schema
        .createTable("plans")
        .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
        .addColumn("name", "varchar(100)", (c) => c.notNull())
        .addColumn("description", "varchar(255)")
        .addColumn("price_monthly", "integer", (c) => c.notNull().defaultTo(0))
        .addColumn("price_yearly", "integer", (c) => c.notNull().defaultTo(0))
        .addColumn("features", "text")
        // 0 means unlimited for these limits, except max_x_posts_monthly (0 = none, -1 = unlimited).
        .addColumn("max_channels", "integer", (c) => c.notNull().defaultTo(3))
        .addColumn("max_scheduled_monthly", "integer", (c) => c.notNull().defaultTo(30))
        .addColumn("max_members", "integer", (c) => c.notNull().defaultTo(1))
        .addColumn("max_x_posts_monthly", "integer", (c) => c.notNull().defaultTo(0))
        .addColumn("allow_ai", "integer", (c) => c.notNull().defaultTo(0))
        .addColumn("allow_rss", "integer", (c) => c.notNull().defaultTo(0))
        .addColumn("allow_api", "integer", (c) => c.notNull().defaultTo(0))
        .addColumn("allow_white_label", "integer", (c) => c.notNull().defaultTo(0))
        .addColumn("remove_branding", "integer", (c) => c.notNull().defaultTo(0))
        .addColumn("is_free", "integer", (c) => c.notNull().defaultTo(0))
        .addColumn("is_active", "integer", (c) => c.notNull().defaultTo(1))
        .addColumn("is_featured", "integer", (c) => c.notNull().defaultTo(0))
        .addColumn("sort_order", "integer", (c) => c.notNull().defaultTo(0))
        .addColumn("created_at", "varchar(32)", (c) => c.notNull())
        .execute();

      await db.schema
        .createTable("payments")
        .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
        .addColumn("user_id", "integer", (c) => c.notNull())
        .addColumn("plan_id", "integer", (c) => c.notNull())
        .addColumn("amount", "integer", (c) => c.notNull())
        .addColumn("currency", "varchar(10)", (c) => c.notNull())
        .addColumn("billing_cycle", "varchar(10)", (c) => c.notNull())
        .addColumn("provider", "varchar(20)", (c) => c.notNull())
        .addColumn("provider_ref", "varchar(190)", (c) => c.notNull().unique())
        .addColumn("status", "varchar(20)", (c) => c.notNull())
        .addColumn("note", "text")
        .addColumn("created_at", "varchar(32)", (c) => c.notNull())
        .execute();
      await db.schema.createIndex("payments_user_id_idx").on("payments").column("user_id").execute();

      await db.schema
        .createTable("pages")
        .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
        .addColumn("slug", "varchar(120)", (c) => c.notNull().unique())
        .addColumn("title", "varchar(255)", (c) => c.notNull())
        .addColumn("content", "text", (c) => c.notNull())
        .addColumn("meta_description", "varchar(255)")
        .addColumn("is_published", "integer", (c) => c.notNull().defaultTo(1))
        .addColumn("show_in_footer", "integer", (c) => c.notNull().defaultTo(1))
        .addColumn("created_at", "varchar(32)", (c) => c.notNull())
        .addColumn("updated_at", "varchar(32)", (c) => c.notNull())
        .execute();

      await db.schema
        .createTable("contact_messages")
        .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
        .addColumn("name", "varchar(120)", (c) => c.notNull())
        .addColumn("email", "varchar(190)", (c) => c.notNull())
        .addColumn("subject", "varchar(255)", (c) => c.notNull())
        .addColumn("message", "text", (c) => c.notNull())
        .addColumn("ip", "varchar(64)")
        .addColumn("is_read", "integer", (c) => c.notNull().defaultTo(0))
        .addColumn("created_at", "varchar(32)", (c) => c.notNull())
        .execute();

      await db.schema
        .createTable("languages")
        .addColumn("code", "varchar(12)", (c) => c.primaryKey())
        .addColumn("name", "varchar(60)", (c) => c.notNull())
        .addColumn("native_name", "varchar(60)", (c) => c.notNull())
        .addColumn("direction", "varchar(3)", (c) => c.notNull().defaultTo("ltr"))
        .addColumn("is_active", "integer", (c) => c.notNull().defaultTo(1))
        .addColumn("sort_order", "integer", (c) => c.notNull().defaultTo(0))
        .execute();

      await db.schema
        .createTable("translations")
        .addColumn("lang", "varchar(12)", (c) => c.notNull())
        .addColumn("key", "varchar(190)", (c) => c.notNull())
        .addColumn("value", "text", (c) => c.notNull())
        .addPrimaryKeyConstraint("translations_pk", ["lang", "key"])
        .execute();

      await db.schema
        .createTable("blog_posts")
        .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
        .addColumn("slug", "varchar(160)", (c) => c.notNull().unique())
        .addColumn("title", "varchar(255)", (c) => c.notNull())
        .addColumn("excerpt", "varchar(500)")
        .addColumn("content", "text", (c) => c.notNull())
        .addColumn("cover_image", "varchar(500)")
        .addColumn("meta_description", "varchar(255)")
        .addColumn("status", "varchar(12)", (c) => c.notNull().defaultTo("draft"))
        .addColumn("published_at", "varchar(32)")
        .addColumn("views", "integer", (c) => c.notNull().defaultTo(0))
        .addColumn("created_at", "varchar(32)", (c) => c.notNull())
        .addColumn("updated_at", "varchar(32)", (c) => c.notNull())
        .execute();
      await db.schema.createIndex("blog_posts_status_published_idx").on("blog_posts").columns(["status", "published_at"]).execute();

      // ── Workspaces and team ──
      await db.schema
        .createTable("workspaces")
        .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
        .addColumn("owner_id", "integer", (c) => c.notNull())
        .addColumn("name", "varchar(120)", (c) => c.notNull())
        .addColumn("timezone", "varchar(64)", (c) => c.notNull().defaultTo("UTC"))
        .addColumn("settings", "text", (c) => c.notNull())
        .addColumn("is_personal", "integer", (c) => c.notNull().defaultTo(0))
        .addColumn("created_at", "varchar(32)", (c) => c.notNull())
        .addColumn("updated_at", "varchar(32)", (c) => c.notNull())
        .execute();
      await db.schema.createIndex("workspaces_owner_idx").on("workspaces").columns(["owner_id", "is_personal"]).execute();

      await db.schema
        .createTable("workspace_members")
        .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
        .addColumn("workspace_id", "integer", (c) => c.notNull())
        .addColumn("user_id", "integer", (c) => c.notNull())
        .addColumn("role", "varchar(12)", (c) => c.notNull())
        .addColumn("created_at", "varchar(32)", (c) => c.notNull())
        .addUniqueConstraint("workspace_members_ws_user_uq", ["workspace_id", "user_id"])
        .execute();
      await db.schema.createIndex("workspace_members_user_idx").on("workspace_members").column("user_id").execute();

      await db.schema
        .createTable("workspace_invites")
        .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
        .addColumn("workspace_id", "integer", (c) => c.notNull())
        .addColumn("email", "varchar(190)", (c) => c.notNull())
        .addColumn("role", "varchar(12)", (c) => c.notNull())
        .addColumn("token_hash", "varchar(64)", (c) => c.notNull().unique())
        .addColumn("invited_by", "integer", (c) => c.notNull())
        .addColumn("expires_at", "varchar(32)", (c) => c.notNull())
        .addColumn("created_at", "varchar(32)", (c) => c.notNull())
        .addUniqueConstraint("workspace_invites_ws_email_uq", ["workspace_id", "email"])
        .execute();

      // ── Channels ──
      await db.schema
        .createTable("channels")
        .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
        .addColumn("workspace_id", "integer", (c) => c.notNull())
        .addColumn("platform", "varchar(20)", (c) => c.notNull())
        .addColumn("external_id", "varchar(190)", (c) => c.notNull())
        .addColumn("name", "varchar(190)", (c) => c.notNull())
        .addColumn("handle", "varchar(190)", (c) => c.notNull().defaultTo(""))
        .addColumn("avatar_url", "varchar(1000)")
        .addColumn("profile_url", "varchar(1000)")
        .addColumn("credentials", "text", (c) => c.notNull())
        .addColumn("token_expires_at", "varchar(32)")
        .addColumn("status", "varchar(16)", (c) => c.notNull().defaultTo("active"))
        .addColumn("last_error", "varchar(1000)")
        .addColumn("last_checked_at", "varchar(32)")
        .addColumn("settings", "text", (c) => c.notNull())
        .addColumn("queue_slots", "text", (c) => c.notNull())
        .addColumn("meta", "text", (c) => c.notNull())
        .addColumn("connected_by", "integer")
        .addColumn("created_at", "varchar(32)", (c) => c.notNull())
        .addColumn("updated_at", "varchar(32)", (c) => c.notNull())
        .addUniqueConstraint("channels_ws_platform_ext_uq", ["workspace_id", "platform", "external_id"])
        .execute();
      await db.schema.createIndex("channels_ws_status_idx").on("channels").columns(["workspace_id", "status"]).execute();
      // Token refresh job: WHERE status = 'active' AND token_expires_at < soon.
      await db.schema.createIndex("channels_expiry_idx").on("channels").columns(["status", "token_expires_at"]).execute();

      // ── Posts ──
      await db.schema
        .createTable("posts")
        .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
        .addColumn("workspace_id", "integer", (c) => c.notNull())
        .addColumn("author_id", "integer")
        .addColumn("status", "varchar(20)", (c) => c.notNull().defaultTo("draft"))
        .addColumn("scheduled_at", "varchar(32)")
        .addColumn("content", "text", (c) => c.notNull())
        .addColumn("labels", "text", (c) => c.notNull())
        .addColumn("source", "varchar(10)", (c) => c.notNull().defaultTo("manual"))
        .addColumn("source_ref", "varchar(64)")
        .addColumn("is_evergreen", "integer", (c) => c.notNull().defaultTo(0))
        .addColumn("recycle_count", "integer", (c) => c.notNull().defaultTo(0))
        .addColumn("last_recycled_at", "varchar(32)")
        .addColumn("approved_by", "integer")
        .addColumn("approved_at", "varchar(32)")
        .addColumn("published_at", "varchar(32)")
        .addColumn("created_at", "varchar(32)", (c) => c.notNull())
        .addColumn("updated_at", "varchar(32)", (c) => c.notNull())
        .execute();
      // Calendar / lists: WHERE workspace_id = ? AND scheduled_at BETWEEN … (and by status).
      await db.schema.createIndex("posts_ws_scheduled_idx").on("posts").columns(["workspace_id", "scheduled_at"]).execute();
      await db.schema.createIndex("posts_ws_status_idx").on("posts").columns(["workspace_id", "status", "scheduled_at"]).execute();
      await db.schema.createIndex("posts_evergreen_idx").on("posts").columns(["workspace_id", "is_evergreen", "last_recycled_at"]).execute();

      await db.schema
        .createTable("post_targets")
        .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
        .addColumn("post_id", "integer", (c) => c.notNull())
        .addColumn("workspace_id", "integer", (c) => c.notNull())
        .addColumn("channel_id", "integer", (c) => c.notNull())
        .addColumn("platform", "varchar(20)", (c) => c.notNull())
        .addColumn("override", "text", (c) => c.notNull())
        .addColumn("status", "varchar(20)", (c) => c.notNull().defaultTo("pending"))
        .addColumn("scheduled_at", "varchar(32)")
        .addColumn("next_attempt_at", "varchar(32)")
        .addColumn("attempts", "integer", (c) => c.notNull().defaultTo(0))
        .addColumn("lease_until", "varchar(32)")
        .addColumn("lease_token", "varchar(64)")
        .addColumn("external_id", "varchar(190)")
        .addColumn("container_id", "varchar(190)")
        .addColumn("upload_state", "text", (c) => c.notNull())
        .addColumn("permalink", "varchar(1000)")
        .addColumn("published_at", "varchar(32)")
        .addColumn("error", "varchar(1000)")
        .addColumn("error_kind", "varchar(20)")
        .addColumn("quota_month", "varchar(7)")
        .addColumn("created_at", "varchar(32)", (c) => c.notNull())
        .addColumn("updated_at", "varchar(32)", (c) => c.notNull())
        .addUniqueConstraint("post_targets_post_channel_uq", ["post_id", "channel_id"])
        .execute();
      // The engine: WHERE status = 'scheduled' AND next_attempt_at <= now ORDER BY next_attempt_at.
      await db.schema.createIndex("post_targets_due_idx").on("post_targets").columns(["status", "next_attempt_at"]).execute();
      // Expired leases of in-flight rows: WHERE status IN (…) AND lease_until < now.
      await db.schema.createIndex("post_targets_lease_idx").on("post_targets").columns(["status", "lease_until"]).execute();
      // Queue slots taken on a channel; analytics per channel.
      await db.schema.createIndex("post_targets_channel_sched_idx").on("post_targets").columns(["channel_id", "scheduled_at"]).execute();
      await db.schema.createIndex("post_targets_channel_pub_idx").on("post_targets").columns(["channel_id", "published_at"]).execute();
      await db.schema.createIndex("post_targets_ws_status_idx").on("post_targets").columns(["workspace_id", "status", "published_at"]).execute();

      // ── Media library ──
      await db.schema
        .createTable("media_folders")
        .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
        .addColumn("workspace_id", "integer", (c) => c.notNull())
        .addColumn("parent_id", "integer")
        .addColumn("name", "varchar(120)", (c) => c.notNull())
        .addColumn("created_at", "varchar(32)", (c) => c.notNull())
        .execute();
      await db.schema.createIndex("media_folders_ws_idx").on("media_folders").columns(["workspace_id", "parent_id"]).execute();

      await db.schema
        .createTable("media")
        .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
        .addColumn("workspace_id", "integer", (c) => c.notNull())
        .addColumn("folder_id", "integer")
        .addColumn("uploaded_by", "integer")
        .addColumn("storage", "varchar(10)", (c) => c.notNull())
        .addColumn("storage_key", "varchar(500)", (c) => c.notNull())
        .addColumn("url", "varchar(1000)", (c) => c.notNull())
        .addColumn("filename", "varchar(255)", (c) => c.notNull())
        .addColumn("mime", "varchar(100)", (c) => c.notNull())
        .addColumn("kind", "varchar(10)", (c) => c.notNull())
        .addColumn("size", "bigint", (c) => c.notNull().defaultTo(0))
        .addColumn("width", "integer")
        .addColumn("height", "integer")
        .addColumn("duration", "double precision")
        .addColumn("alt_text", "varchar(1500)", (c) => c.notNull().defaultTo(""))
        .addColumn("thumbnail_url", "varchar(1000)")
        .addColumn("created_at", "varchar(32)", (c) => c.notNull())
        .execute();
      await db.schema.createIndex("media_ws_folder_idx").on("media").columns(["workspace_id", "folder_id", "created_at"]).execute();

      // ── Automation: RSS and short links ──
      await db.schema
        .createTable("rss_feeds")
        .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
        .addColumn("workspace_id", "integer", (c) => c.notNull())
        .addColumn("url", "varchar(1000)", (c) => c.notNull())
        .addColumn("title", "varchar(255)", (c) => c.notNull().defaultTo(""))
        .addColumn("channel_ids", "text", (c) => c.notNull())
        .addColumn("template", "text", (c) => c.notNull())
        .addColumn("mode", "varchar(10)", (c) => c.notNull().defaultTo("draft"))
        .addColumn("ai_rewrite", "integer", (c) => c.notNull().defaultTo(0))
        .addColumn("interval_minutes", "integer", (c) => c.notNull().defaultTo(60))
        .addColumn("status", "varchar(10)", (c) => c.notNull().defaultTo("active"))
        .addColumn("last_checked_at", "varchar(32)")
        .addColumn("next_check_at", "varchar(32)", (c) => c.notNull())
        .addColumn("etag", "varchar(255)")
        .addColumn("last_modified", "varchar(100)")
        .addColumn("last_error", "varchar(1000)")
        .addColumn("created_by", "integer")
        .addColumn("created_at", "varchar(32)", (c) => c.notNull())
        .addColumn("updated_at", "varchar(32)", (c) => c.notNull())
        .execute();
      await db.schema.createIndex("rss_feeds_due_idx").on("rss_feeds").columns(["status", "next_check_at"]).execute();
      await db.schema.createIndex("rss_feeds_ws_idx").on("rss_feeds").column("workspace_id").execute();

      await db.schema
        .createTable("rss_items")
        .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
        .addColumn("feed_id", "integer", (c) => c.notNull())
        .addColumn("guid_hash", "varchar(64)", (c) => c.notNull())
        .addColumn("guid", "varchar(1000)", (c) => c.notNull())
        .addColumn("url", "varchar(1000)")
        .addColumn("title", "varchar(500)")
        .addColumn("published_at", "varchar(32)")
        .addColumn("post_id", "integer")
        .addColumn("created_at", "varchar(32)", (c) => c.notNull())
        .addUniqueConstraint("rss_items_feed_guid_uq", ["feed_id", "guid_hash"])
        .execute();

      await db.schema
        .createTable("short_links")
        .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
        .addColumn("workspace_id", "integer", (c) => c.notNull())
        .addColumn("code", "varchar(32)", (c) => c.notNull().unique())
        .addColumn("url", "varchar(2000)", (c) => c.notNull())
        .addColumn("utm", "text", (c) => c.notNull())
        .addColumn("post_id", "integer")
        .addColumn("channel_id", "integer")
        .addColumn("clicks", "integer", (c) => c.notNull().defaultTo(0))
        .addColumn("last_clicked_at", "varchar(32)")
        .addColumn("created_at", "varchar(32)", (c) => c.notNull())
        .execute();
      await db.schema.createIndex("short_links_ws_idx").on("short_links").columns(["workspace_id", "created_at"]).execute();
      await db.schema.createIndex("short_links_post_idx").on("short_links").column("post_id").execute();

      await db.schema
        .createTable("link_clicks_daily")
        .addColumn("link_id", "integer", (c) => c.notNull())
        .addColumn("day", "varchar(10)", (c) => c.notNull())
        .addColumn("clicks", "integer", (c) => c.notNull().defaultTo(0))
        .addPrimaryKeyConstraint("link_clicks_daily_pk", ["link_id", "day"])
        .execute();

      // ── Analytics ──
      await db.schema
        .createTable("post_metrics")
        .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
        .addColumn("target_id", "integer", (c) => c.notNull().unique())
        .addColumn("post_id", "integer", (c) => c.notNull())
        .addColumn("channel_id", "integer", (c) => c.notNull())
        .addColumn("workspace_id", "integer", (c) => c.notNull())
        .addColumn("fetched_at", "varchar(32)", (c) => c.notNull())
        .addColumn("views", "integer")
        .addColumn("impressions", "integer")
        .addColumn("reach", "integer")
        .addColumn("likes", "integer")
        .addColumn("comments", "integer")
        .addColumn("shares", "integer")
        .addColumn("saves", "integer")
        .addColumn("clicks", "integer")
        .addColumn("quotes", "integer")
        .execute();
      await db.schema.createIndex("post_metrics_ws_idx").on("post_metrics").columns(["workspace_id", "channel_id"]).execute();
      await db.schema.createIndex("post_metrics_fetched_idx").on("post_metrics").column("fetched_at").execute();

      await db.schema
        .createTable("platform_usage_daily")
        .addColumn("platform", "varchar(20)", (c) => c.notNull())
        .addColumn("day", "varchar(10)", (c) => c.notNull())
        .addColumn("posts", "integer", (c) => c.notNull().defaultTo(0))
        .addColumn("uploads", "integer", (c) => c.notNull().defaultTo(0))
        .addColumn("api_calls", "integer", (c) => c.notNull().defaultTo(0))
        .addColumn("errors", "integer", (c) => c.notNull().defaultTo(0))
        .addColumn("cost_micros", "bigint", (c) => c.notNull().defaultTo(0))
        .addPrimaryKeyConstraint("platform_usage_daily_pk", ["platform", "day"])
        .execute();

      // ── Approvals and comments ──
      await db.schema
        .createTable("approval_links")
        .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
        .addColumn("workspace_id", "integer", (c) => c.notNull())
        .addColumn("token_hash", "varchar(64)", (c) => c.notNull().unique())
        .addColumn("post_ids", "text")
        .addColumn("label", "varchar(120)", (c) => c.notNull().defaultTo(""))
        .addColumn("created_by", "integer")
        .addColumn("expires_at", "varchar(32)", (c) => c.notNull())
        .addColumn("revoked_at", "varchar(32)")
        .addColumn("last_viewed_at", "varchar(32)")
        .addColumn("created_at", "varchar(32)", (c) => c.notNull())
        .execute();
      await db.schema.createIndex("approval_links_ws_idx").on("approval_links").column("workspace_id").execute();

      await db.schema
        .createTable("post_comments")
        .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
        .addColumn("post_id", "integer", (c) => c.notNull())
        .addColumn("workspace_id", "integer", (c) => c.notNull())
        .addColumn("user_id", "integer")
        .addColumn("author_name", "varchar(120)", (c) => c.notNull())
        .addColumn("kind", "varchar(10)", (c) => c.notNull().defaultTo("note"))
        .addColumn("body", "text", (c) => c.notNull())
        .addColumn("created_at", "varchar(32)", (c) => c.notNull())
        .execute();
      await db.schema.createIndex("post_comments_post_idx").on("post_comments").columns(["post_id", "created_at"]).execute();

      // ── Account level: API keys, usage, notifications ──
      await db.schema
        .createTable("api_keys")
        .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
        .addColumn("workspace_id", "integer", (c) => c.notNull())
        .addColumn("user_id", "integer", (c) => c.notNull())
        .addColumn("name", "varchar(120)", (c) => c.notNull())
        .addColumn("key_hash", "varchar(64)", (c) => c.notNull().unique())
        .addColumn("prefix", "varchar(12)", (c) => c.notNull())
        .addColumn("last_used_at", "varchar(32)")
        .addColumn("created_at", "varchar(32)", (c) => c.notNull())
        .execute();
      await db.schema.createIndex("api_keys_ws_idx").on("api_keys").column("workspace_id").execute();

      await db.schema
        .createTable("usage_monthly")
        .addColumn("user_id", "integer", (c) => c.notNull())
        .addColumn("month", "varchar(7)", (c) => c.notNull())
        .addColumn("posts_scheduled", "integer", (c) => c.notNull().defaultTo(0))
        .addColumn("x_posts", "integer", (c) => c.notNull().defaultTo(0))
        .addColumn("ai_requests", "integer", (c) => c.notNull().defaultTo(0))
        .addColumn("quota_alerts", "varchar(255)")
        .addPrimaryKeyConstraint("usage_monthly_pk", ["user_id", "month"])
        .execute();

      await db.schema
        .createTable("notify_channels")
        .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
        .addColumn("workspace_id", "integer", (c) => c.notNull())
        .addColumn("created_by", "integer")
        .addColumn("type", "varchar(12)", (c) => c.notNull())
        .addColumn("name", "varchar(120)", (c) => c.notNull())
        .addColumn("config", "text", (c) => c.notNull())
        .addColumn("events", "text", (c) => c.notNull())
        .addColumn("is_active", "integer", (c) => c.notNull().defaultTo(1))
        .addColumn("created_at", "varchar(32)", (c) => c.notNull())
        .addColumn("updated_at", "varchar(32)", (c) => c.notNull())
        .execute();
      await db.schema.createIndex("notify_channels_ws_idx").on("notify_channels").column("workspace_id").execute();

      await db.schema
        .createTable("alert_log")
        .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
        .addColumn("workspace_id", "integer")
        .addColumn("post_id", "integer")
        .addColumn("channel_id", "integer")
        .addColumn("event", "varchar(30)", (c) => c.notNull())
        .addColumn("ok", "integer", (c) => c.notNull())
        .addColumn("error", "varchar(500)")
        .addColumn("created_at", "varchar(32)", (c) => c.notNull())
        .execute();
      await db.schema.createIndex("alert_log_ws_idx").on("alert_log").columns(["workspace_id", "created_at"]).execute();
      await db.schema.createIndex("alert_log_created_idx").on("alert_log").column("created_at").execute();
    },
    async down(db: AnyDb) {
      for (const table of [...TABLES].reverse()) await db.schema.dropTable(table).ifExists().execute();
    },
  },

  "2026_10_20_000002_seed_defaults": {
    async up(db: AnyDb) {
      const now = ts();
      await db
        .insertInto("plans")
        .values([
          {
            name: "Free",
            description: "Plan and publish for a few accounts, free.",
            price_monthly: 0,
            price_yearly: 0,
            // Display text only (see Admin → Plans). Keep it in line with the limits below.
            features: ["Calendar, queue and first comments", "Media library", "Notifications by email, Slack and more"].join("\n"),
            max_channels: 3,
            max_scheduled_monthly: 30,
            max_members: 1,
            max_x_posts_monthly: 0,
            allow_ai: 0,
            allow_rss: 0,
            allow_api: 0,
            allow_white_label: 0,
            remove_branding: 0,
            is_free: 1,
            is_active: 1,
            is_featured: 0,
            sort_order: 1,
            created_at: now,
          },
          {
            name: "Pro",
            description: "For creators and small teams posting every day.",
            price_monthly: 1900,
            price_yearly: 19000,
            features: ["Everything in Free", "Team roles and approvals", "AI assistant", "RSS auto-posting", "REST API"].join("\n"),
            max_channels: 15,
            max_scheduled_monthly: 500,
            max_members: 3,
            max_x_posts_monthly: 100,
            allow_ai: 1,
            allow_rss: 1,
            allow_api: 1,
            allow_white_label: 0,
            remove_branding: 0,
            is_free: 0,
            is_active: 1,
            is_featured: 1,
            sort_order: 2,
            created_at: now,
          },
          {
            name: "Agency",
            description: "For agencies managing many brands and clients.",
            price_monthly: 4900,
            price_yearly: 49000,
            features: ["Everything in Pro", "Client approval links with your branding"].join("\n"),
            max_channels: 60,
            max_scheduled_monthly: 3000,
            max_members: 10,
            max_x_posts_monthly: 500,
            allow_ai: 1,
            allow_rss: 1,
            allow_api: 1,
            allow_white_label: 1,
            remove_branding: 1,
            is_free: 0,
            is_active: 1,
            is_featured: 0,
            sort_order: 3,
            created_at: now,
          },
        ])
        .execute();

      await db
        .insertInto("pages")
        .values(
          DEFAULT_PAGES.map((p) => ({
            slug: p.slug,
            title: p.title,
            content: p.content,
            meta_description: p.metaDescription,
            is_published: 1,
            show_in_footer: 1,
            created_at: now,
            updated_at: now,
          })),
        )
        .execute();

      await db.insertInto("languages").values({ code: "en", name: "English", native_name: "English", direction: "ltr", is_active: 1, sort_order: 0 }).execute();
      await db
        .insertInto("blog_posts")
        .values(
          DEFAULT_POSTS.map((p, i) => ({
            slug: p.slug,
            title: p.title,
            excerpt: p.excerpt,
            content: p.content,
            cover_image: null,
            meta_description: p.metaDescription,
            status: "published",
            published_at: new Date(Date.now() - (DEFAULT_POSTS.length - i) * 86_400_000).toISOString(),
            views: 0,
            created_at: now,
            updated_at: now,
          })),
        )
        .execute();
    },
    async down(db: AnyDb) {
      for (const table of ["blog_posts", "languages", "pages", "plans"]) await sql`DELETE FROM ${sql.table(table)}`.execute(db);
    },
  },
  "2026_10_21_000010_platforms": {
    async up(db: AnyDb) {
      // Accounts returned by one OAuth connect (Facebook Pages, Instagram accounts) waiting in the picker.
      await db.schema
        .createTable("connect_sessions")
        .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
        .addColumn("token_hash", "varchar(64)", (c) => c.notNull().unique())
        .addColumn("user_id", "integer", (c) => c.notNull())
        .addColumn("workspace_id", "integer", (c) => c.notNull())
        .addColumn("platform", "varchar(20)", (c) => c.notNull())
        .addColumn("payload", "text", (c) => c.notNull())
        .addColumn("expires_at", "varchar(32)", (c) => c.notNull())
        .addColumn("created_at", "varchar(32)", (c) => c.notNull())
        .execute();
      await db.schema.createIndex("connect_sessions_expires_idx").on("connect_sessions").column("expires_at").execute();

      // Mastodon: the app registered on each instance (per redirect URI), client secret encrypted.
      await db.schema
        .createTable("mastodon_apps")
        .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
        .addColumn("instance", "varchar(190)", (c) => c.notNull())
        .addColumn("redirect_hash", "varchar(64)", (c) => c.notNull())
        .addColumn("client_id", "varchar(255)", (c) => c.notNull())
        .addColumn("client_secret", "text", (c) => c.notNull())
        .addColumn("created_at", "varchar(32)", (c) => c.notNull())
        .execute();
      await db.schema.createIndex("mastodon_apps_instance_idx").on("mastodon_apps").columns(["instance", "redirect_hash"]).unique().execute();

      // Meta data deletion callbacks (status page /api/meta/data-deletion?code=…).
      await db.schema
        .createTable("data_deletion_requests")
        .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
        .addColumn("code", "varchar(40)", (c) => c.notNull().unique())
        .addColumn("platform", "varchar(20)", (c) => c.notNull())
        .addColumn("external_user_id", "varchar(190)", (c) => c.notNull())
        .addColumn("channels_deleted", "integer", (c) => c.notNull().defaultTo(0))
        .addColumn("status", "varchar(20)", (c) => c.notNull())
        .addColumn("created_at", "varchar(32)", (c) => c.notNull())
        .addColumn("completed_at", "varchar(32)")
        .execute();
    },
    async down(db: AnyDb) {
      await db.schema.dropTable("data_deletion_requests").ifExists().execute();
      await db.schema.dropTable("mastodon_apps").ifExists().execute();
      await db.schema.dropTable("connect_sessions").ifExists().execute();
    },
  },
  "2026_10_21_000020_publishing_engine": {
    async up(db: AnyDb) {
      // Queue page: a paused channel keeps its scheduled posts but the engine doesn't publish them.
      await db.schema.alterTable("channels").addColumn("queue_paused", "integer", (c) => c.notNull().defaultTo(0)).execute();

      // Attempt history of each publication (post detail page, support).
      await db.schema
        .createTable("post_attempts")
        .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
        .addColumn("target_id", "integer", (c) => c.notNull())
        .addColumn("post_id", "integer", (c) => c.notNull())
        .addColumn("workspace_id", "integer", (c) => c.notNull())
        .addColumn("channel_id", "integer", (c) => c.notNull())
        .addColumn("attempt", "integer", (c) => c.notNull())
        .addColumn("outcome", "varchar(20)", (c) => c.notNull())
        .addColumn("error", "varchar(1000)")
        .addColumn("error_kind", "varchar(20)")
        .addColumn("started_at", "varchar(32)", (c) => c.notNull())
        .addColumn("duration_ms", "integer", (c) => c.notNull().defaultTo(0))
        .execute();
      await db.schema.createIndex("post_attempts_target_idx").on("post_attempts").columns(["target_id", "id"]).execute();
      await db.schema.createIndex("post_attempts_started_idx").on("post_attempts").column("started_at").execute();
    },
    async down(db: AnyDb) {
      await db.schema.dropTable("post_attempts").ifExists().execute();
      await db.schema.alterTable("channels").dropColumn("queue_paused").execute();
    },
  },
  "2026_10_21_000030_teams_automation_analytics": {
    async up(db: AnyDb) {
      // Monthly AI assistant requests per plan (0 = unlimited when allow_ai is on).
      await db.schema.alterTable("plans").addColumn("max_ai_monthly", "integer", (c) => c.notNull().defaultTo(0)).execute();
      await db.updateTable("plans").set({ max_ai_monthly: 300 }).where("name", "=", "Pro").execute();
      await db.updateTable("plans").set({ max_ai_monthly: 2000 }).where("name", "=", "Agency").execute();

      // Client approval links: optional password and a date range instead of a fixed post list.
      await db.schema.alterTable("approval_links").addColumn("password_hash", "varchar(255)").execute();
      await db.schema.alterTable("approval_links").addColumn("range_from", "varchar(32)").execute();
      await db.schema.alterTable("approval_links").addColumn("range_to", "varchar(32)").execute();

      // RSS feed options (JSON: max items per run, UTM, backfill, hashtags) and counters.
      await db.schema.alterTable("rss_feeds").addColumn("options", "text").execute();
      await db.schema.alterTable("rss_feeds").addColumn("items_posted", "integer", (c) => c.notNull().defaultTo(0)).execute();

      // Evergreen recycling settings of a workspace (JSON), null = off.
      await db.schema.alterTable("workspaces").addColumn("recycle_settings", "text").execute();

      // Short link title for the links list.
      await db.schema.alterTable("short_links").addColumn("title", "varchar(255)", (c) => c.notNull().defaultTo("")).execute();

      // Metrics job: published targets by publication time.
      await db.schema.createIndex("post_targets_status_pub_idx").on("post_targets").columns(["status", "published_at"]).execute();
      await db.schema.createIndex("rss_items_post_idx").on("rss_items").column("post_id").execute();
    },
    async down(db: AnyDb) {
      await db.schema.dropIndex("rss_items_post_idx").on("rss_items").execute();
      await db.schema.dropIndex("post_targets_status_pub_idx").on("post_targets").execute();
      await db.schema.alterTable("short_links").dropColumn("title").execute();
      await db.schema.alterTable("workspaces").dropColumn("recycle_settings").execute();
      await db.schema.alterTable("rss_feeds").dropColumn("items_posted").execute();
      await db.schema.alterTable("rss_feeds").dropColumn("options").execute();
      await db.schema.alterTable("approval_links").dropColumn("range_to").execute();
      await db.schema.alterTable("approval_links").dropColumn("range_from").execute();
      await db.schema.alterTable("approval_links").dropColumn("password_hash").execute();
      await db.schema.alterTable("plans").dropColumn("max_ai_monthly").execute();
    },
  },
};

export const migrationProvider: MigrationProvider = {
  async getMigrations() {
    return migrations;
  },
};
