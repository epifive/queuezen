import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, PageHeader, Table, Td, Th } from "@/components/admin/ui";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { getCurrentUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { countOwnerChannels } from "@/lib/channels";
import { GATEWAY_LABELS } from "@/lib/payments";
import { getAllPlans, getEntitlements, xLimit } from "@/lib/plans";
import { getUsage } from "@/lib/usage";
import { countSeats } from "@/lib/workspaces";
import { formatDate, formatMoney } from "@/lib/utils";
import { UserForm } from "../user-form";

export const metadata = { title: "Edit user" };

export default async function EditUserPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ created?: string }> }) {
  const [{ id }, { created }] = await Promise.all([params, searchParams]);
  const db = await getDb();
  const user = await db.selectFrom("users").selectAll().where("id", "=", Number(id)).executeTakeFirst();
  if (!user) notFound();
  const [me, plans, payments, workspaces, channelsUsed, seats, usage, entitlements] = await Promise.all([
    getCurrentUser(),
    getAllPlans(),
    db.selectFrom("payments").selectAll().where("user_id", "=", user.id).orderBy("id", "desc").limit(20).execute(),
    db
      .selectFrom("workspace_members as m")
      .innerJoin("workspaces as w", "w.id", "m.workspace_id")
      .select(["w.id", "w.name", "w.owner_id", "w.is_personal", "m.role"])
      .where("m.user_id", "=", user.id)
      .orderBy("w.id")
      .limit(100)
      .execute(),
    countOwnerChannels(user.id),
    countSeats(user.id),
    getUsage(user.id),
    getEntitlements(user),
  ]);
  const wsIds = workspaces.map((w) => w.id);
  const [channelCounts, postCounts] = wsIds.length
    ? await Promise.all([
        db.selectFrom("channels").select(["workspace_id", (eb) => eb.fn.countAll<number>().as("n")]).where("workspace_id", "in", wsIds).where("status", "!=", "disconnected").groupBy("workspace_id").execute(),
        db.selectFrom("posts").select(["workspace_id", (eb) => eb.fn.countAll<number>().as("n")]).where("workspace_id", "in", wsIds).groupBy("workspace_id").execute(),
      ])
    : [[], []];
  const channelsIn = new Map(channelCounts.map((r) => [r.workspace_id, Number(r.n)]));
  const postsIn = new Map(postCounts.map((r) => [r.workspace_id, Number(r.n)]));
  const limit = (n: number) => (n ? `/ ${n.toLocaleString("en-US")}` : "· unlimited");
  const x = xLimit(entitlements.maxXPostsMonthly);
  const postsLimit = entitlements.maxScheduledMonthly;

  return (
    <>
      <PageHeader
        title={user.name}
        description={
          <>
            Joined {formatDate(user.created_at)}.{" "}
            <Link href="/admin/users" className="text-primary hover:underline">
              Back to users
            </Link>
          </>
        }
      />
      {created ? <Alert tone="success" className="mb-4">User created.</Alert> : null}
      <UserForm
        isSelf={me?.id === user.id}
        plans={plans.filter((p) => !p.is_free).map((p) => ({ id: p.id, name: p.name }))}
        user={{
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          status: user.status,
          planId: user.plan_id ?? 0,
          planExpires: user.plan_expires_at ? user.plan_expires_at.slice(0, 10) : "",
        }}
      />
      <Card title="Workspaces and usage" className="mt-6 max-w-3xl">
        <dl className="grid gap-4 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-muted">Channels</dt>
            <dd className="mt-1 text-lg font-semibold tabular-nums">
              {channelsUsed.toLocaleString("en-US")} <span className="text-sm font-normal text-muted">{limit(entitlements.maxChannels)}</span>
            </dd>
          </div>
          <div>
            <dt className="text-muted">Posts this month</dt>
            <dd className="mt-1 text-lg font-semibold tabular-nums">
              {usage.postsScheduled.toLocaleString("en-US")} <span className="text-sm font-normal text-muted">{limit(postsLimit)}</span>
            </dd>
            {postsLimit > 0 && usage.postsScheduled >= postsLimit * 0.8 ? (
              <Badge tone={usage.postsScheduled >= postsLimit ? "danger" : "warning"} className="mt-1">
                {Math.floor((usage.postsScheduled / postsLimit) * 100)}% used
              </Badge>
            ) : null}
            <dd className="text-xs text-muted">
              {usage.xPosts.toLocaleString("en-US")} to X{x.allowed ? (x.limit ? ` of ${x.limit.toLocaleString("en-US")}` : "") : " (X not in plan)"} · {usage.aiRequests.toLocaleString("en-US")} AI requests
            </dd>
          </div>
          <div>
            <dt className="text-muted">Team seats</dt>
            <dd className="mt-1 text-lg font-semibold tabular-nums">
              {seats.toLocaleString("en-US")} <span className="text-sm font-normal text-muted">{limit(entitlements.maxMembers)}</span>
            </dd>
          </div>
          <div>
            <dt className="text-muted">Plan</dt>
            <dd className="mt-1 text-lg font-semibold">{user.role === "admin" ? "Administrator" : (entitlements.plan?.name ?? "Free")}</dd>
            <dd className="text-xs text-muted">
              AI: {entitlements.allowAi ? "yes" : "no"} · RSS: {entitlements.allowRss ? "yes" : "no"} · API: {entitlements.allowApi ? "yes" : "no"} · White label: {entitlements.allowWhiteLabel ? "yes" : "no"}
            </dd>
          </div>
        </dl>
        {workspaces.length ? (
          <div className="-mx-5 mt-5 -mb-5 border-t border-line">
            <Table minWidth={560}>
              <thead>
                <tr>
                  <Th>Workspace</Th>
                  <Th>Role</Th>
                  <Th className="text-right">Channels</Th>
                  <Th className="text-right">Posts</Th>
                </tr>
              </thead>
              <tbody>
                {workspaces.map((w) => (
                  <tr key={w.id}>
                    <Td>
                      <span className="font-medium">{w.name}</span>
                      {w.is_personal && w.owner_id === user.id ? <span className="block text-xs text-muted">Personal workspace</span> : null}
                    </Td>
                    <Td className="capitalize">{w.role}</Td>
                    <Td className="text-right tabular-nums">{(channelsIn.get(w.id) ?? 0).toLocaleString("en-US")}</Td>
                    <Td className="text-right tabular-nums">{(postsIn.get(w.id) ?? 0).toLocaleString("en-US")}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        ) : (
          <p className="mt-4 text-sm text-muted">No workspaces yet (one is created on the first dashboard visit).</p>
        )}
      </Card>
      <Card title="Payments" padded={false} className="mt-6 max-w-3xl">
        {payments.length ? (
          <Table minWidth={520}>
            <thead>
              <tr>
                <Th>Date</Th>
                <Th>Method</Th>
                <Th>Amount</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {payments.map((p) => (
                <tr key={p.id}>
                  <Td>{formatDate(p.created_at)}</Td>
                  <Td>{GATEWAY_LABELS[p.provider]}</Td>
                  <Td className="tabular-nums">{formatMoney(p.amount, p.currency)}</Td>
                  <Td>
                    <Badge tone={p.status === "paid" ? "success" : p.status === "pending" ? "warning" : "danger"} className="capitalize">
                      {p.status}
                    </Badge>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <p className="p-5 text-sm text-muted">No payments.</p>
        )}
      </Card>
    </>
  );
}
