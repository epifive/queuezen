import { apiJson } from "@/lib/api-guard";
import { toApiChannel } from "@/lib/api-v1";
import { getWorkspaceChannels } from "@/lib/channels";
import { v1Guard } from "../_shared";

/** GET /api/v1/channels — the workspace's connected channels (?include_disconnected=1 for all). */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const guard = await v1Guard(request);
  if (!guard.ok) return guard.response;
  const all = new URL(request.url).searchParams.get("include_disconnected") === "1";
  const channels = await getWorkspaceChannels(guard.workspace.id, { includeDisconnected: all });
  return apiJson({ channels: channels.map(toApiChannel) });
}
