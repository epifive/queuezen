import type { Metadata } from "next";
import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { CheckCircle2, Clock3, Lock, Undo2 } from "lucide-react";
import { DecisionForm, UnlockForm } from "@/components/dashboard/approval-forms";
import { PostPreview } from "@/components/dashboard/approval-preview";
import { CommentThread } from "@/components/dashboard/approval-comments";
import { BrandStyle } from "@/components/site/brand-style";
import { HtmlLang } from "@/components/site/html-lang";
import { BrandMark } from "@/components/site/logo";
import { Badge } from "@/components/ui/badge";
import { APPROVAL_COOKIE_PREFIX, findApprovalLink, getLinkPosts, isUnlocked, touchApprovalLink } from "@/lib/approvals";
import { getWorkspaceChannels } from "@/lib/channels";
import { I18nProvider } from "@/lib/i18n/client";
import { plural, type MessageKey } from "@/lib/i18n/messages";
import { getClientMessages, getLocale, getT } from "@/lib/i18n/server";
import { getMediaInfo, getPostComments } from "@/lib/posts";
import { getSettings } from "@/lib/settings";
import { absoluteUrl, uploadUrl } from "@/lib/site";
import { getWorkspaceEntitlements } from "@/lib/workspaces";
import { guestDecisionAction, unlockApprovalAction } from "./actions";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ token: string }> }): Promise<Metadata> {
  const [t, resolved] = await Promise.all([getT(), findApprovalLink((await params).token)]);
  return {
    title: resolved ? t("approve.title", { workspace: resolved.workspace.name }) : t("approve.invalidTitle"),
    robots: { index: false, follow: false, nocache: true },
    referrer: "no-referrer",
  };
}

const STATUS_TONE = { pending_approval: "warning", approved: "success", scheduled: "success", publishing: "primary", published: "success", partially_failed: "warning", draft: "neutral", failed: "danger" } as const;

/**
 * Client approval page (no login): the posts of a link with their previews; the client approves
 * or sends back each post with a comment. Branded with the workspace's logo, colour and name when
 * the owner's plan includes white label. Never indexed.
 */
export default async function ApprovePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const [t, locale, messages, settings, resolved] = await Promise.all([getT(), getLocale(), getClientMessages(), getSettings(), findApprovalLink(token)]);
  const lc = locale.code;

  let brandName = settings.site_name;
  let brandLogo = uploadUrl(settings.logo);
  let brandColor = settings.primary_color;
  let showPowered = true;
  if (resolved) {
    const entitlements = await getWorkspaceEntitlements(resolved.workspace);
    const b = resolved.workspace.settings.branding;
    if (entitlements.allowWhiteLabel) {
      brandName = b.companyName || resolved.workspace.name;
      brandLogo = b.logo ? uploadUrl(b.logo) : "";
      if (b.color) brandColor = b.color;
    }
    showPowered = !entitlements.removeBranding && Boolean(settings.branding_text);
  }

  const shell = (body: ReactNode) => (
    <I18nProvider messages={messages}>
      <HtmlLang code={lc} dir={locale.dir} />
      <BrandStyle color={brandColor} />
      <div dir={locale.dir} lang={lc} className="min-h-dvh bg-paper">
        <header className="border-b border-line bg-surface">
          <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-4 sm:px-6">
            {brandLogo ? (
              // eslint-disable-next-line @next/next/no-img-element -- customer logo of unknown size
              <img src={brandLogo} alt={brandName} className="h-8 w-auto max-w-48 object-contain" />
            ) : (
              <BrandMark className="size-8 shrink-0" />
            )}
            {!brandLogo ? (
              <bdi dir="auto" className="truncate font-display text-lg font-bold">
                {brandName}
              </bdi>
            ) : null}
          </div>
        </header>
        <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6">{body}</main>
        {showPowered ? (
          <footer className="pb-8 text-center text-xs text-muted">
            <a href={settings.branding_url || absoluteUrl(settings, "/")} className="hover:text-ink" rel="noopener">
              {settings.branding_text}
            </a>
          </footer>
        ) : null}
      </div>
    </I18nProvider>
  );

  if (!resolved) {
    return shell(
      <div className="rounded-xl border border-line bg-surface p-8 text-center">
        <Clock3 className="mx-auto size-10 text-muted" aria-hidden />
        <h1 className="mt-4 text-xl font-bold">{t("approve.invalidTitle")}</h1>
        <p className="mt-2 text-sm text-muted">{t("approve.invalidText")}</p>
      </div>,
    );
  }

  const jar = await cookies();
  if (!(await isUnlocked(resolved, jar.get(`${APPROVAL_COOKIE_PREFIX}${resolved.link.id}`)?.value))) {
    return shell(
      <div className="mx-auto max-w-sm rounded-xl border border-line bg-surface p-6">
        <Lock className="size-8 text-primary" aria-hidden />
        <h1 className="mt-3 text-xl font-bold">{t("approve.lockedTitle")}</h1>
        <p className="mt-1 mb-5 text-sm text-muted">{t("approve.lockedText", { workspace: brandName })}</p>
        <UnlockForm action={unlockApprovalAction} token={token} labels={{ password: t("approve.password"), submit: t("approve.unlock") }} />
      </div>,
    );
  }

  await touchApprovalLink(resolved.link);
  const { link, workspace } = resolved;
  const [posts, channels] = await Promise.all([getLinkPosts(link), getWorkspaceChannels(workspace.id, { includeDisconnected: true })]);
  const media = new Map((await getMediaInfo(workspace.id, posts.flatMap((p) => [...p.content.mediaIds, ...p.targets.flatMap((tg) => tg.override.mediaIds ?? [])]))).map((m) => [m.id, m]));
  const comments = new Map(await Promise.all(posts.map(async (p) => [p.id, (await getPostComments(workspace.id, p.id)).filter((c) => c.kind !== "note")] as const)));
  const channelMap = new Map(channels.map((c) => [c.id, { name: c.name, platform: c.platform }]));
  const pendingCount = posts.filter((p) => p.status === "pending_approval").length;
  const previewLabels = { noText: t("dash.home.noText"), noDate: t("dash.approvals.noDate"), versionFor: t("dash.approvals.versionFor"), firstComment: t("dash.approvals.firstComment"), thread: t("dash.approvals.thread") };
  const threadLabels = { empty: "", approved: t("dash.comments.kind.approved"), rejected: t("dash.comments.kind.rejected"), system: t("dash.comments.kind.system"), guest: t("dash.comments.guest") };

  return shell(
    <>
      <div className="mb-6">
        <h1 dir="auto" className="text-2xl font-bold">
          {link.label || t("approve.heading")}
        </h1>
        <p className="mt-1 text-sm text-muted">
          {pendingCount ? plural(t, "approve.intro", pendingCount, { workspace: brandName }) : t("approve.allDone")}
          <span className="block text-xs">{t("approve.timezone", { tz: workspace.timezone.replaceAll("_", " ") })}</span>
        </p>
      </div>
      {posts.length ? (
        <ul className="space-y-5">
          {posts.map((post) => {
            const thread = comments.get(post.id) ?? [];
            return (
              <li key={post.id} className="rounded-xl border border-line bg-surface">
                <div className="p-5">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <Badge tone={STATUS_TONE[post.status]}>
                      {post.status === "pending_approval" ? <Clock3 className="size-3.5" aria-hidden /> : post.status === "draft" ? <Undo2 className="size-3.5" aria-hidden /> : <CheckCircle2 className="size-3.5" aria-hidden />}
                      {t(`approve.status.${post.status}` as MessageKey)}
                    </Badge>
                  </div>
                  <PostPreview post={post} channels={channelMap} media={media} locale={lc} timeZone={workspace.timezone} labels={previewLabels} />
                  {thread.length ? (
                    <div className="mt-4 border-t border-line pt-4">
                      <CommentThread comments={thread} locale={lc} labels={threadLabels} />
                    </div>
                  ) : null}
                </div>
                {post.status === "pending_approval" ? (
                  <div className="border-t border-line bg-paper/60 p-5">
                    <DecisionForm
                      action={guestDecisionAction}
                      fields={{ token, post_id: post.id }}
                      withName
                      labels={{ name: t("approve.yourName"), comment: t("approve.comment"), commentHint: t("approve.commentHint"), approve: t("dash.approvals.approve"), reject: t("dash.approvals.reject") }}
                    />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="rounded-xl border border-line bg-surface p-8 text-center">
          <CheckCircle2 className="mx-auto size-10 text-emerald-500" aria-hidden />
          <p className="mt-3 font-medium">{t("approve.emptyTitle")}</p>
          <p className="mt-1 text-sm text-muted">{t("approve.emptyText")}</p>
        </div>
      )}
    </>,
  );
}
