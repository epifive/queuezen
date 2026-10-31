import { LinkTabs } from "./ui";

/** Tabs of the Team section: members and the approvals inbox. Server-safe. */
export function TeamTabs({ workspaceId, active, pending, labels }: { workspaceId: number; active: "members" | "approvals"; pending: number; labels: { members: string; approvals: string; nav: string } }) {
  const base = `/dashboard/w/${workspaceId}/team`;
  return (
    <LinkTabs
      label={labels.nav}
      items={[
        { href: base, label: labels.members, active: active === "members" },
        { href: `${base}/approvals`, label: labels.approvals, active: active === "approvals", count: pending },
      ]}
    />
  );
}
