import type { Metadata } from "next";
import Link from "next/link";
import { Composer, type ComposerInitial } from "@/components/dashboard/composer-editor";
import { DashHeader } from "@/components/dashboard/ui";
import { Alert } from "@/components/ui/alert";
import { ButtonLink } from "@/components/ui/button";
import { aiAvailable } from "@/lib/ai";
import { getWorkspaceChannels } from "@/lib/channels";
import { isDemoMode } from "@/lib/config";
import { getDb } from "@/lib/db";
import { requireWorkspace } from "@/lib/dashboard";
import { pausedChannels } from "@/lib/engine/targets";
import { getLocale, getT } from "@/lib/i18n/server";
import { getMediaItems } from "@/lib/media/service";
import { getPost } from "@/lib/posts";
import { shortLinkUrl } from "@/lib/shortlinks";
import { getWorkspaceEntitlements } from "@/lib/workspaces";
import { canPublishDirectly, EMPTY_CONTENT, idList, isEditable, localDay, localTime, parseJsonList } from "@/social/normalize";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("dash.nav.compose") };
}

/** Labels used in the workspace's recent posts (suggestions). */
async function knownLabels(workspaceId: number): Promise<string[]> {
  const db = await getDb();
  const rows = await db.selectFrom("posts").select("labels").where("workspace_id", "=", workspaceId).where("labels", "!=", "[]").orderBy("updated_at", "desc").limit(300).execute();
  return [...new Set(rows.flatMap((r) => parseJsonList(r.labels)))].slice(0, 100);
}

/** The composer: new posts (?date=, ?channel=, ?media= prefill) and editing (?post=ID). */
export default async function ComposePage({ params, searchParams }: { params: Promise<{ wid: string }>; searchParams: Promise<{ post?: string; date?: string; channel?: string; media?: string }> }) {
  const { workspace, role } = await requireWorkspace((await params).wid, "editor");
  const query = await searchParams;
  const [t, locale, channels, entitlements, labels, paused, ai] = await Promise.all([
    getT(),
    getLocale(),
    getWorkspaceChannels(workspace.id),
    getWorkspaceEntitlements(workspace),
    knownLabels(workspace.id),
    pausedChannels(workspace.id),
    aiAvailable(),
  ]);
  const base = `/dashboard/w/${workspace.id}`;
  const post = query.post ? await getPost(workspace.id, Number(query.post)) : undefined;
  const tz = workspace.timezone;

  if (query.post && !post) {
    return (
      <>
        <DashHeader title={t("dash.nav.compose")} />
        <Alert tone="error">{t("dash.compose.err.notFound")}</Alert>
      </>
    );
  }
  if (post && !isEditable(post.status)) {
    return (
      <>
        <DashHeader title={t("dash.compose.editTitle")} />
        <Alert tone="warning" title={t("dash.compose.lockedTitle")}>
          {t("dash.compose.lockedText")}{" "}
          <Link href={`${base}/posts/${post.id}`} className="font-medium text-primary underline">
            {t("dash.compose.openPost")}
          </Link>
        </Alert>
      </>
    );
  }

  const localInput = (iso: string | null) => (iso ? `${localDay(Date.parse(iso), tz)}T${localTime(Date.parse(iso), tz)}` : "");
  const prefillDate = query.date && /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(query.date) ? (query.date.length === 10 ? `${query.date}T09:00` : query.date) : "";
  const prefillChannel = Number(query.channel);
  const prefillMedia = idList(query.media ?? "", 35);
  const initial: ComposerInitial = post
    ? {
        postId: post.id,
        status: post.status,
        content: post.content,
        overrides: Object.fromEntries(post.targets.filter((tg) => tg.status !== "cancelled").map((tg) => [tg.channelId, tg.override])),
        channelIds: post.targets.filter((tg) => tg.status !== "cancelled").map((tg) => tg.channelId),
        labels: post.labels,
        scheduledLocal: localInput(post.scheduledAt),
      }
    : {
        postId: null,
        status: null,
        content: { ...EMPTY_CONTENT, mediaIds: prefillMedia },
        overrides: {},
        channelIds: channels.some((c) => c.id === prefillChannel) ? [prefillChannel] : channels.length === 1 ? [channels[0].id] : [],
        labels: [],
        scheduledLocal: prefillDate,
      };
  const mediaIds = [...new Set([...initial.content.mediaIds, ...Object.values(initial.overrides).flatMap((o) => o.mediaIds ?? [])])];
  const media = (await getMediaItems(workspace.id, mediaIds)).map((m) => ({ id: m.id, kind: m.kind, mime: m.mime, size: m.size, width: m.width, height: m.height, duration: m.duration, altText: m.altText, url: m.url, filename: m.filename }));
  const canPublish = canPublishDirectly(role, workspace.settings);
  const utm = workspace.settings.utm;
  // How links are rewritten when publishing, so the composer can count them in their final form.
  const ownPrefix = await shortLinkUrl("");
  const linkRewrite = { utm, shorten: workspace.settings.shortenLinks, shortUrlSample: `${ownPrefix}xxxxxxx`, ownPrefix };

  return (
    <>
      <DashHeader
        title={post ? t("dash.compose.editTitle") : t("dash.nav.compose")}
        description={post ? t("dash.compose.editing", { status: t(`dash.postStatus.${post.status}`) }) : t("dash.compose.subtitle")}
        actions={
          <ButtonLink href={`${base}/posts/import`} variant="outline">
            {t("dash.posts.import")}
          </ButtonLink>
        }
      />
      <Composer
        workspaceId={workspace.id}
        timezone={tz}
        locale={locale.code}
        channels={channels.map((c) => ({
          id: c.id,
          platform: c.platform,
          name: c.name,
          handle: c.handle,
          avatarUrl: c.avatarUrl,
          status: c.status,
          paused: paused.has(c.id),
          slots: c.queueSlots.length,
          hashtags: c.settings.hashtags,
          defaultFirstComment: c.settings.defaultFirstComment,
          defaults: c.settings.defaults,
          utm: c.settings.utm,
        }))}
        initial={initial}
        initialMedia={media}
        canPublish={canPublish}
        aiEnabled={entitlements.allowAi && ai}
        canUpload={!isDemoMode()}
        knownLabels={labels}
        utm={{ source: utm.source, medium: utm.medium, campaign: utm.campaign }}
        linkRewrite={linkRewrite}
        shortLinks
      />
    </>
  );
}
