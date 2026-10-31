import "server-only";
import { cleanupExpiredSessions } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import type { Job } from "./index";
import { isDue, scheduleNext } from "./shared";

/**
 * housekeeping (hourly): expired sessions and password reset links, expired workspace invites,
 * approval links expired for more than 30 days, and notification log rows older than 90 days.
 */

const INTERVAL_MS = 60 * 60_000;
const ALERT_LOG_DAYS = 90;
const APPROVAL_LINK_GRACE_DAYS = 30;

const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

export const housekeepingJob: Job = {
  name: "housekeeping",
  async run(ctx) {
    if (!(await isDue("housekeeping", ctx))) return 0;
    const db = await getDb();
    await cleanupExpiredSessions();
    const results = await Promise.all([
      db.deleteFrom("alert_log").where("created_at", "<", ago(ALERT_LOG_DAYS)).executeTakeFirst(),
      db.deleteFrom("workspace_invites").where("expires_at", "<", new Date().toISOString()).executeTakeFirst(),
      db.deleteFrom("approval_links").where("expires_at", "<", ago(APPROVAL_LINK_GRACE_DAYS)).executeTakeFirst(),
    ]);
    await scheduleNext("housekeeping", INTERVAL_MS);
    return results.reduce((n, r) => n + Number(r.numDeletedRows ?? 0), 0);
  },
};
