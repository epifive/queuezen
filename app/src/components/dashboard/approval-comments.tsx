import { CheckCircle2, MessageSquare, Undo2, Info } from "lucide-react";
import { addCommentAction } from "@/app/actions/dashboard/approvals";
import { formatRelative } from "@/lib/dash-format";
import { getLocale, getT } from "@/lib/i18n/server";
import { getPostComments, type CommentRecord } from "@/lib/posts";
import { cn } from "@/lib/utils";
import { CommentForm } from "./approval-forms";
import { Initial } from "./kit";

/**
 * Comment thread of a post: internal notes, approval decisions (with their comment) and system
 * entries, oldest first, plus a box to add a note. A Server Component, so any workspace page can
 * mount it (posts detail, approvals inbox):
 *
 *   <ApprovalComments workspaceId={workspace.id} postId={post.id} canComment={roleCan(role, "comment")} />
 */
export async function ApprovalComments({ workspaceId, postId, canComment, compact = false }: { workspaceId: number; postId: number; canComment: boolean; compact?: boolean }) {
  const [t, locale, comments] = await Promise.all([getT(), getLocale(), getPostComments(workspaceId, postId)]);
  return (
    <section aria-label={t("dash.comments.title")} className="space-y-3">
      {!compact ? <h3 className="font-sans text-sm font-semibold tracking-normal">{t("dash.comments.title")}</h3> : null}
      <CommentThread comments={comments} locale={locale.code} labels={{ empty: t("dash.comments.empty"), approved: t("dash.comments.kind.approved"), rejected: t("dash.comments.kind.rejected"), system: t("dash.comments.kind.system"), guest: t("dash.comments.guest") }} />
      {canComment ? <CommentForm action={addCommentAction} fields={{ wid: workspaceId, post_id: postId }} labels={{ placeholder: t("dash.comments.placeholder"), submit: t("dash.comments.add"), sending: t("dash.comments.adding") }} /> : null}
    </section>
  );
}

const KIND_STYLE: Record<CommentRecord["kind"], { icon: typeof MessageSquare; className: string }> = {
  note: { icon: MessageSquare, className: "text-muted" },
  approved: { icon: CheckCircle2, className: "text-emerald-600 dark:text-emerald-400" },
  rejected: { icon: Undo2, className: "text-amber-600 dark:text-amber-400" },
  system: { icon: Info, className: "text-muted" },
};

/** Presentational thread (server-safe, no data loading). */
export function CommentThread({ comments, locale, labels }: { comments: CommentRecord[]; locale: string; labels: { empty: string; approved: string; rejected: string; system: string; guest: string } }) {
  if (!comments.length) return <p className="text-xs text-muted">{labels.empty}</p>;
  return (
    <ol className="space-y-3">
      {comments.map((c) => {
        const style = KIND_STYLE[c.kind];
        const Icon = style.icon;
        return (
          <li key={c.id} className="flex gap-3">
            <Initial name={c.authorName} className="size-7" />
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                <bdi dir="auto" className="font-medium text-ink">
                  {c.authorName}
                </bdi>
                {c.userId === null && c.kind !== "system" ? <span className="text-muted">({labels.guest})</span> : null}
                {c.kind !== "note" ? (
                  <span className={cn("inline-flex items-center gap-1 font-medium", style.className)}>
                    <Icon className="size-3.5" aria-hidden />
                    {c.kind === "approved" ? labels.approved : c.kind === "rejected" ? labels.rejected : labels.system}
                  </span>
                ) : null}
                <time dateTime={c.createdAt} className="text-muted">
                  {formatRelative(c.createdAt, locale)}
                </time>
              </p>
              {c.body ? (
                <p dir="auto" className="mt-1 text-sm break-words whitespace-pre-wrap">
                  {c.body}
                </p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
