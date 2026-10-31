import "server-only";
import { recycleWorkspace, recyclingWorkspaces } from "@/lib/recycle";
import type { Job } from "./index";
import { isDue, scheduleNext } from "./shared";

/**
 * recycle (hourly): puts due evergreen posts of every workspace with recycling turned on back
 * into the queue as new posts (see src/lib/recycle.ts).
 */

const INTERVAL_MS = 60 * 60_000;

export const recycleJob: Job = {
  name: "recycle",
  async run(ctx) {
    if (!(await isDue("recycle", ctx))) return 0;
    let created = 0;
    let finished = true;
    for (const { workspace, settings } of await recyclingWorkspaces()) {
      if (Date.now() > ctx.deadline) {
        finished = false;
        break;
      }
      try {
        created += (await recycleWorkspace(workspace, settings)).created;
      } catch (error) {
        console.error(`[queuezen] recycling failed in workspace ${workspace.id}:`, error);
      }
    }
    await scheduleNext("recycle", finished ? INTERVAL_MS : 0);
    return created;
  },
};
