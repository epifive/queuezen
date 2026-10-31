import type { Metadata } from "next";
import { MediaLibrary } from "@/components/dashboard/media-library";
import { DashHeader } from "@/components/dashboard/ui";
import { Alert } from "@/components/ui/alert";
import { isDemoMode } from "@/lib/config";
import { formatNumber } from "@/lib/dash-format";
import { requireWorkspace } from "@/lib/dashboard";
import { getLocale, getT } from "@/lib/i18n/server";
import { getMediaLimits, listFolders, listMedia, mediaBytesUsed } from "@/lib/media/service";
import { getStorageConfig } from "@/lib/media/storage";
import { roleCan } from "@/social/normalize";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("dash.nav.media") };
}

/** Media library: images and videos for posts, in folders, with alt text. */
export default async function MediaPage({ params }: { params: Promise<{ wid: string }> }) {
  const { workspace, role } = await requireWorkspace((await params).wid, "viewer");
  const [t, locale, page, folders, limits, storage] = await Promise.all([getT(), getLocale(), listMedia(workspace.id, { limit: 48 }), listFolders(workspace.id), getMediaLimits(), getStorageConfig()]);
  const canManage = roleCan(role, "media.manage");
  const demo = isDemoMode();
  const used = limits.quotaBytes ? await mediaBytesUsed(workspace.ownerId) : 0;
  const mb = (bytes: number) => formatNumber(Math.round(bytes / 1048576), locale.code);
  const localOnVercel = storage.driver === "local" && Boolean(process.env.VERCEL);

  return (
    <>
      <DashHeader
        title={t("dash.nav.media")}
        description={
          limits.quotaBytes
            ? t("dash.media.quota", { used: mb(used), limit: mb(limits.quotaBytes) })
            : t("dash.media.subtitleLimits", { image: mb(limits.maxImageBytes), video: mb(limits.maxVideoBytes) })
        }
      />
      {demo ? <Alert className="mb-5">{t("dash.media.demo")}</Alert> : null}
      {localOnVercel ? <Alert tone="warning" className="mb-5">{t("dash.media.localOnVercel")}</Alert> : null}
      <MediaLibrary
        workspaceId={workspace.id}
        initial={{ items: page.items.map((m) => ({ id: m.id, kind: m.kind, mime: m.mime, size: m.size, width: m.width, height: m.height, duration: m.duration, altText: m.altText, url: m.url, filename: m.filename, folderId: m.folderId, createdAt: m.createdAt })), total: page.total, folders }}
        canManage={canManage && !demo}
        canUpload={canManage && !demo && !localOnVercel}
        locale={locale.code}
      />
    </>
  );
}
