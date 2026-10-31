"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Copy } from "lucide-react";
import { duplicatePostAction } from "@/app/actions/dashboard/posts";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n/client";

/** Post page helpers: live refresh while publishing, and "Duplicate". */

/** Refreshes the page every few seconds while the post is publishing (stops after 3 minutes). */
export function PostAutoRefresh({ active }: { active: boolean }) {
  const router = useRouter();
  const started = useRef(0);
  useEffect(() => {
    if (!active) return;
    if (!started.current) started.current = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started.current > 3 * 60_000) return clearInterval(timer);
      router.refresh();
    }, 3000);
    return () => clearInterval(timer);
  }, [active, router]);
  return null;
}

export function DuplicateButton({ workspaceId, postId }: { workspaceId: number; postId: number }) {
  const t = useT();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <span className="inline-flex flex-col">
      <Button
        variant="outline"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await duplicatePostAction(workspaceId, postId);
            if (r.ok) router.push(`/dashboard/w/${workspaceId}/compose?post=${r.postId}`);
            else setError(r.error);
          })
        }
      >
        <Copy aria-hidden />
        {t("dash.post.duplicate")}
      </Button>
      {error ? (
        <span role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">
          {error}
        </span>
      ) : null}
    </span>
  );
}
