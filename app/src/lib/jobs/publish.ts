import "server-only";
import { getDb } from "@/lib/db";
import { runPublishEngine } from "@/lib/engine";
import type { Job } from "./index";
import { isDue, scheduleNext } from "./shared";

/**
 * publish (every tick, first job): publishes due post targets with the engine in
 * src/lib/engine (leases, retries, idempotency). It may use up to 70% of the tick's remaining
 * budget so the other jobs still get time; whatever is left is picked up by the next tick.
 * Once a day it also prunes the attempt history (post_attempts) older than 180 days.
 */

const SHARE = 0.7;
const PRUNE_EVERY_MS = 24 * 3600_000;
const KEEP_ATTEMPTS_DAYS = 180;

export const publishJob: Job = {
  name: "publish",
  async run(ctx) {
    const remaining = Math.max(0, ctx.deadline - Date.now());
    const summary = await runPublishEngine({ deadline: Date.now() + Math.floor(remaining * SHARE) });
    if (await isDue("publish-prune", ctx)) {
      const db = await getDb();
      await db
        .deleteFrom("post_attempts")
        .where("started_at", "<", new Date(Date.now() - KEEP_ATTEMPTS_DAYS * 86_400_000).toISOString())
        .execute();
      await scheduleNext("publish-prune", PRUNE_EVERY_MS);
    }
    return summary.claimed;
  },
};
