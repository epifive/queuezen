import type { SocialDriver } from "@/social/types";
import { blueskyDriver } from "./bluesky";
import { discordDriver } from "./discord";
import { linkedinDriver } from "./linkedin";
import { mastodonDriver } from "./mastodon";
import { facebookDriver, instagramDriver, instagramLoginDriver } from "./meta";
import { telegramDriver } from "./telegram";
import { threadsDriver } from "./threads";
import { xDriver } from "./x";
import { youtubeDriver } from "./youtube";

/**
 * The real platform drivers (v1). The registry (./index.ts) registers them on the first
 * getDriver() call; this module doesn't import the registry, so there is no import cycle.
 */
export const BUILTIN_DRIVERS: SocialDriver[] = [
  facebookDriver,
  instagramDriver,
  instagramLoginDriver,
  threadsDriver,
  xDriver,
  linkedinDriver,
  youtubeDriver,
  blueskyDriver,
  mastodonDriver,
  telegramDriver,
  discordDriver,
];
