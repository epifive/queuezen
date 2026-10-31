import "server-only";
import { housekeepingJob } from "./housekeeping";
import { metricsJob } from "./metrics";
import { publishJob } from "./publish";
import { recycleJob } from "./recycle";
import { rssJob } from "./rss";
import { tokenRefreshJob } from "./token-refresh";

/**
 * Background jobs run by the scheduler (src/lib/scheduler.ts) on every tick, in order,
 * while time is left in the tick's budget. A job does a small, idempotent slice of work
 * and returns how many items it handled; anything it can't finish is picked up next tick.
 * Jobs throttle themselves (settings rows "job_next:<name>", see ./shared.ts).
 */
export interface JobContext {
  /** Epoch ms after which a job should stop starting new work. */
  deadline: number;
  /** Who started the tick. */
  source: "cron" | "worker" | "lazy" | "manual";
}

export interface Job {
  /** Short id shown in Admin → System (e.g. "publish"). */
  name: string;
  run(ctx: JobContext): Promise<number>;
}

/**
 * Registered jobs, in the order they run:
 *   publish        due post_targets (leases, retries, idempotency), first in the list
 *   token-refresh  refresh / re-auth reminders of expiring channels
 *   rss            poll feeds, create posts
 *   recycle        evergreen posts back into the queue
 *   metrics        fetch post analytics
 * housekeeping stays last.
 */
export const JOBS: Job[] = [publishJob, tokenRefreshJob, rssJob, recycleJob, metricsJob, housekeepingJob];
