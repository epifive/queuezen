import "server-only";
import { claimFeed, dueFeeds, processFeed } from "@/lib/rss";
import type { Job } from "./index";

/**
 * rss (every tick): checks the feeds whose next check is due, a few per tick within the tick's
 * time budget. Each feed is claimed first (next_check_at moved forward conditionally), so
 * overlapping ticks never process the same feed twice.
 */

const FEEDS_PER_TICK = 10;

export const rssJob: Job = {
  name: "rss",
  async run(ctx) {
    let created = 0;
    for (const feed of await dueFeeds(FEEDS_PER_TICK)) {
      if (Date.now() > ctx.deadline) break;
      if (!(await claimFeed(feed))) continue;
      try {
        const result = await processFeed(feed);
        created += result.created;
      } catch (error) {
        console.error(`[queuezen] rss feed ${feed.id} failed:`, error);
      }
    }
    return created;
  },
};
