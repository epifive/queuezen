"use client";

import { CalendarClock, RotateCcw, Trash2 } from "lucide-react";
import { bulkPostsAction } from "@/app/actions/dashboard/posts";
import { BulkForm } from "@/components/dashboard/client-kit";
import { buttonClass } from "@/components/ui/button";
import { useT } from "@/lib/i18n/client";

/** Bulk bar of the posts list: delete, reschedule, retry failed (rows join with form="posts-bulk"). */
export function PostBulkBar({ workspaceId, canRetry, canReschedule }: { workspaceId: number; canRetry: boolean; canReschedule: boolean }) {
  const t = useT();
  return (
    <BulkForm id="posts-bulk" action={bulkPostsAction} fields={{ wid: workspaceId }} className="rounded-lg border border-line bg-paper px-3 py-2">
      <span className="text-xs font-medium text-muted">{t("dash.posts.bulk")}</span>
      {canReschedule ? (
        <span className="flex flex-wrap items-center gap-1.5">
          <input type="datetime-local" name="when" aria-label={t("dash.posts.newTime")} dir="ltr" className="h-8 rounded-lg border border-line bg-surface px-2 text-xs" />
          <button type="submit" name="op" value="reschedule" className={buttonClass("outline", "sm")}>
            <CalendarClock aria-hidden />
            {t("dash.posts.reschedule")}
          </button>
        </span>
      ) : null}
      {canRetry ? (
        <button type="submit" name="op" value="retry" className={buttonClass("outline", "sm")}>
          <RotateCcw aria-hidden />
          {t("dash.posts.retry")}
        </button>
      ) : null}
      <button
        type="submit"
        name="op"
        value="delete"
        className={buttonClass("ghost", "sm", "text-red-600 hover:text-red-700 dark:text-red-400")}
        onClick={(e) => {
          if (!window.confirm(t("dash.posts.deleteConfirm"))) e.preventDefault();
        }}
      >
        <Trash2 aria-hidden />
        {t("dash.posts.delete")}
      </button>
    </BulkForm>
  );
}
