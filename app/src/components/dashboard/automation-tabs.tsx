import { LinkTabs } from "./ui";

/** Tabs of the Automation section: RSS feeds, evergreen recycling and short links. Server-safe. */
export function AutomationTabs({ workspaceId, active, labels }: { workspaceId: number; active: "rss" | "recycle" | "links"; labels: { rss: string; recycle: string; links: string; nav: string } }) {
  const base = `/dashboard/w/${workspaceId}`;
  return (
    <LinkTabs
      label={labels.nav}
      items={[
        { href: `${base}/automation`, label: labels.rss, active: active === "rss" },
        { href: `${base}/automation?tab=recycle`, label: labels.recycle, active: active === "recycle" },
        { href: `${base}/links`, label: labels.links, active: active === "links" },
      ]}
    />
  );
}
