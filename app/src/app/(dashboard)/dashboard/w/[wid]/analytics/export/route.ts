import { NextResponse, type NextRequest } from "next/server";
import { ANALYTICS_PERIODS, getPublications, periodRangeTz, publicationsCsv } from "@/lib/analytics";
import { getCurrentUser } from "@/lib/auth/session";
import { getWorkspaceChannels } from "@/lib/channels";
import { workspaceIdOf } from "@/lib/dashboard";
import { getMembership } from "@/lib/workspaces";

/** CSV export of the analytics page: one row per published post and channel, with its metrics. */

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: { params: Promise<{ wid: string }> }) {
  const user = await getCurrentUser();
  if (!user || user.status !== "active") return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const membership = await getMembership(workspaceIdOf((await params).wid), user.id);
  if (!membership) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const { workspace } = membership;
  const url = request.nextUrl;
  const days = (ANALYTICS_PERIODS as readonly number[]).includes(Number(url.searchParams.get("days"))) ? Number(url.searchParams.get("days")) : 30;
  const channels = await getWorkspaceChannels(workspace.id, { includeDisconnected: true });
  const channelId = channels.some((c) => c.id === Number(url.searchParams.get("channel"))) ? Number(url.searchParams.get("channel")) : undefined;
  const range = periodRangeTz(days, workspace.timezone);
  const rows = await getPublications(workspace.id, range, channelId);
  const csv = publicationsCsv(rows, new Map(channels.map((c) => [c.id, c.name])), workspace.timezone);
  const name = `analytics-${workspace.id}-${range.days[0]}-to-${range.days[range.days.length - 1]}.csv`;
  return new NextResponse(csv, {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store" },
  });
}
