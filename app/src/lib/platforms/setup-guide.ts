import type { SettingKey } from "@/lib/settings";
import type { Platform } from "@/social/types";

/**
 * Admin → Platforms setup wizard content: which settings hold the operator's app, the steps in
 * each developer console and the review checklist (from PRODUCT-8-TECH.md, October 2026).
 * Admin pages are English-only, like the rest of the admin panel.
 */

export interface CredentialField {
  key: SettingKey;
  label: string;
  secret?: boolean;
  hint?: string;
  placeholder?: string;
  type?: "text" | "number";
}

export interface SetupGuide {
  /** Settings of the operator's app (shared by facebook + instagram: one Meta app). */
  fields: CredentialField[];
  /** "Shares the Meta app with Facebook" etc. */
  sharedWith?: Platform[];
  steps: string[];
  checklist: string[];
  tips: string[];
  consoles: Array<{ label: string; url: string }>;
}

const META_FIELDS: CredentialField[] = [
  { key: "meta_app_id", label: "Meta app ID", placeholder: "123456789012345", hint: "Meta app dashboard → App settings → Basic." },
  { key: "meta_app_secret", label: "Meta app secret", secret: true },
  { key: "meta_config_id", label: "Facebook Login for Business configuration ID (optional)", hint: "Use case → Facebook Login for Business → Configurations. Empty = the permissions are asked as scopes." },
];

const META_REVIEW = [
  "Your own Pages and Instagram accounts work right away (Standard Access) for people with a role on the app (Admin, Developer or Tester).",
  "To serve other people's accounts, complete Business Verification (registered business, website, privacy policy and data deletion URL).",
  "Submit App Review for Advanced Access to every permission listed above, with one screencast per permission showing it in use in Queuezen.",
  "Screencast tips: log in to Queuezen, open Channels, connect, pick the Page or account, write a post in the composer, publish it, show it live on the network, then show the analytics page. Say in the notes where each permission is used.",
  "Give the reviewers a test login (an account on your Queuezen site) and short step-by-step instructions.",
  "Switch the app to Live when the review is approved.",
];

export const SETUP_GUIDES: Partial<Record<Platform, SetupGuide>> = {
  facebook: {
    fields: META_FIELDS,
    sharedWith: ["instagram"],
    consoles: [
      { label: "Meta for Developers: My Apps", url: "https://developers.facebook.com/apps" },
      { label: "Business Verification", url: "https://business.facebook.com/settings/security" },
    ],
    steps: [
      "Create a Business-type app at developers.facebook.com/apps.",
      "Add the use cases \"Manage everything on your Page\" (Facebook Login for Business) and \"Manage messaging & content on Instagram\".",
      "In Facebook Login for Business → Settings, add the redirect URI shown above to \"Valid OAuth Redirect URIs\".",
      "In App settings → Basic, enter your privacy policy URL, terms URL, an app icon and the data deletion callback URL shown on the Platforms page; in Facebook Login for Business → Settings, enter the Deauthorize callback URL shown there too.",
      "Copy the app ID and app secret here, save, and press Test.",
      "Optional: create a Facebook Login for Business configuration with the permissions above and paste its ID.",
    ],
    checklist: META_REVIEW,
    tips: ["Page tokens obtained through a long-lived user token don't expire: Facebook channels never need a token refresh.", "Reels: at most 30 per Page in a rolling 24 hours."],
  },
  instagram: {
    fields: META_FIELDS,
    sharedWith: ["facebook"],
    consoles: [{ label: "Meta for Developers: My Apps", url: "https://developers.facebook.com/apps" }],
    steps: [
      "Use the same Meta app as Facebook (the credentials are shared).",
      "Add the Instagram use case with \"API setup with Facebook login\".",
      "Add the redirect URI shown above to Facebook Login for Business → Valid OAuth Redirect URIs.",
      "The Instagram account must be a Business or Creator account linked to a Facebook Page the user manages.",
    ],
    checklist: META_REVIEW,
    tips: ["Instagram fetches media from your public media URL: it must be HTTPS without redirects and stay reachable for 24 hours.", "Images must be JPEG. The publishing limit is read at runtime (content_publishing_limit)."],
  },
  instagram_login: {
    fields: [
      { key: "instagram_app_id", label: "Instagram app ID", placeholder: "1234567890123456", hint: "Meta app → Instagram → API setup with Instagram login → Instagram app ID (not the Meta app ID)." },
      { key: "instagram_app_secret", label: "Instagram app secret", secret: true },
    ],
    consoles: [{ label: "Meta for Developers: My Apps", url: "https://developers.facebook.com/apps" }],
    steps: [
      "In your Meta app, add the Instagram use case with \"API setup with Instagram login\".",
      "Under \"Set up Instagram business login\", add the redirect URI shown above, plus the Deauthorize URL (deauthorize callback) and the Data deletion URL (data deletion request) from Admin → Platforms → Meta callbacks.",
      "Copy the Instagram app ID and secret (they differ from the Meta app's) here and save.",
      "Add Instagram testers under App roles until the app is reviewed.",
    ],
    checklist: [...META_REVIEW.slice(0, 3), "Request instagram_business_basic, instagram_business_content_publish, instagram_business_manage_comments and instagram_business_manage_insights."],
    tips: ["Tokens last 60 days; Queuezen refreshes them automatically about 15 days before they expire.", "No Facebook Page is needed with Instagram Login."],
  },
  threads: {
    fields: [
      { key: "threads_app_id", label: "Threads app ID", hint: "Meta app → Use cases → Access the Threads API → Settings." },
      { key: "threads_app_secret", label: "Threads app secret", secret: true },
    ],
    consoles: [{ label: "Meta for Developers: My Apps", url: "https://developers.facebook.com/apps" }],
    steps: [
      "Add the use case \"Access the Threads API\" to your Meta app (or create an app with it).",
      "Enable the permissions threads_basic, threads_content_publish, threads_manage_replies, threads_manage_insights and threads_delete.",
      "Add the redirect URI shown above under Threads → Settings → Redirect callback URLs. As Uninstall callback URL use the Deauthorize URL and as Delete callback URL the Data deletion URL (both under Admin → Platforms → Meta callbacks).",
      "Invite testers (Threads → Roles); each tester accepts in Threads → Settings → Account → Website permissions.",
      "Copy the Threads app ID and secret here and save.",
    ],
    checklist: ["Before App Review only invited testers can connect.", "Submit App Review with a screencast per permission (connect, publish, replies, insights, delete)."],
    tips: ["Tokens last 60 days and are refreshed automatically.", "At most 250 posts per profile in 24 hours."],
  },
  x: {
    fields: [
      { key: "x_client_id", label: "OAuth 2.0 Client ID", hint: "console.x.com → your app → Keys and tokens → OAuth 2.0 Client ID and Client Secret." },
      { key: "x_client_secret", label: "OAuth 2.0 Client Secret", secret: true },
      { key: "x_monthly_budget", label: "Monthly X API budget (USD)", type: "number", hint: "Only for the spend meter below (0 = none). Set the real spend limit at console.x.com." },
    ],
    consoles: [{ label: "X developer console", url: "https://console.x.com" }],
    steps: [
      "At console.x.com create a Project and an App.",
      "Set up User authentication: OAuth 2.0, type \"Web App, Automated App or Bot\" (confidential client), permissions Read and write.",
      "Add the callback URI shown above and your website URL.",
      "Add a payment method, buy API credits and set a spend limit.",
      "Copy the OAuth 2.0 Client ID and Client Secret here and save.",
    ],
    checklist: ["No app review, but there is no free tier: every post costs credits.", "Scopes requested: tweet.read, tweet.write, users.read, media.write, offline.access."],
    tips: ["October 2026 pricing: $0.015 per post, $0.20 per post containing a URL. Plans limit X posts per month (Admin → Plans).", "Access tokens last 2 hours and refresh tokens rotate: Queuezen refreshes them in the background."],
  },
  linkedin: {
    fields: [
      { key: "linkedin_client_id", label: "Client ID" },
      { key: "linkedin_client_secret", label: "Primary client secret", secret: true },
      { key: "linkedin_api_version", label: "LinkedIn-Version (YYYYMM, optional)", placeholder: "202610", hint: "Leave empty to use the version this release was tested with. Versions are retired about a year after release." },
    ],
    consoles: [{ label: "LinkedIn developer apps", url: "https://www.linkedin.com/developers/apps" }],
    steps: [
      "Create an app at linkedin.com/developers (it must be linked to a LinkedIn Company Page you administer; the Page admin verifies the app).",
      "On the Products tab add \"Share on LinkedIn\" and \"Sign In with LinkedIn using OpenID Connect\" (both self-serve).",
      "On the Auth tab add the redirect URL shown above.",
      "Copy the Client ID and Primary Client Secret here and save.",
    ],
    checklist: ["No review is needed for personal profiles.", "Company Pages need the Community Management API on a separate app (planned for v1.1)."],
    tips: ["Tokens last 60 days and can't be refreshed for profiles: users get a reminder 7 days before and must reconnect.", "LinkedIn has no analytics API for personal profile posts."],
  },
  youtube: {
    fields: [
      { key: "google_client_id", label: "OAuth client ID", placeholder: "….apps.googleusercontent.com" },
      { key: "google_client_secret", label: "OAuth client secret", secret: true },
    ],
    consoles: [
      { label: "Google Cloud credentials", url: "https://console.cloud.google.com/apis/credentials" },
      { label: "YouTube Data API v3", url: "https://console.cloud.google.com/apis/library/youtube.googleapis.com" },
      { label: "Quota extension form", url: "https://support.google.com/youtube/contact/yt_api_form" },
    ],
    steps: [
      "Create a Google Cloud project and enable the YouTube Data API v3.",
      "Configure the OAuth consent screen (External) with your app name, logo, privacy policy and the scopes youtube.upload and youtube.readonly.",
      "Create an OAuth client ID of type Web application with the redirect URI shown above.",
      "Copy the client ID and secret here and save.",
      "Publish the consent screen to Production and verify your domain in Search Console.",
    ],
    checklist: [
      "youtube.upload is a sensitive scope: submit the app for Google OAuth verification with a demo video of the upload flow.",
      "While the consent screen is in Testing, at most 100 test users can connect and their refresh tokens expire after 7 days.",
      "Optional: request more quota with the Audit & Quota Extension form.",
    ],
    tips: ["Since 1 June 2026 a Cloud project can upload 100 videos per day (shared by all your users); other calls share 10,000 quota units per day.", "Shorts: vertical or square videos up to 3 minutes are classified automatically."],
  },
};

/** Networks connected without a developer app: what users need instead. */
export const NO_APP_NOTES: Partial<Record<Platform, string>> = {
  bluesky: "Users connect with their handle and an app password (Bluesky → Settings → Privacy and security → App passwords). No developer app or review.",
  mastodon: "Users enter their server (e.g. mastodon.social); Queuezen registers an app on that server automatically the first time. No developer app or review.",
  telegram: "Users create a bot with @BotFather, add it to their channel as an administrator, then paste the bot token and the channel name. No review.",
  discord: "Users paste a webhook URL from Channel settings → Integrations → Webhooks. No developer app or review.",
};
