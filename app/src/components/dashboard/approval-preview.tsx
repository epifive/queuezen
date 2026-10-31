import { CalendarClock, Film } from "lucide-react";
import { PlatformIcon } from "@/components/social/platform-icon";
import { mergeContent } from "@/social/normalize";
import type { MediaInfo, Platform, PostContent, ContentOverride } from "@/social/types";
import { cn } from "@/lib/utils";

/**
 * Read-only preview of a post for approvers and clients: the text, media thumbnails, the channels
 * and the scheduled time, plus the per-channel versions that differ from the main text. Server-safe.
 */

export interface PreviewPost {
  id: number;
  content: PostContent;
  scheduledAt: string | null;
  targets: Array<{ id: number; channelId: number; platform: Platform; override: ContentOverride }>;
}

export interface PreviewChannel {
  name: string;
  platform: Platform;
}

/** Date and time in a time zone and locale ("Oct 21, 2026, 09:30"). */
export function formatInZone(iso: string | null, locale: string, timeZone: string): string {
  if (!iso) return "";
  const options: Intl.DateTimeFormatOptions = { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone };
  try {
    return new Date(iso).toLocaleString(locale, options);
  } catch {
    return new Date(iso).toLocaleString("en", { ...options, timeZone: "UTC" });
  }
}

function Thumbs({ ids, media, size = "md" }: { ids: number[]; media: Map<number, MediaInfo>; size?: "sm" | "md" }) {
  const items = ids.map((id) => media.get(id)).filter((m): m is MediaInfo => Boolean(m));
  if (!items.length) return null;
  const box = size === "sm" ? "size-14" : "size-20 sm:size-24";
  return (
    <ul className="mt-3 flex flex-wrap gap-2">
      {items.slice(0, 10).map((m) => (
        <li key={m.id} className={cn("relative overflow-hidden rounded-lg border border-line bg-paper", box)}>
          {m.kind === "video" ? (
            <span className="grid size-full place-items-center text-muted" title={m.altText || undefined}>
              <Film className="size-6" aria-hidden />
              <span className="sr-only">{m.altText || "video"}</span>
            </span>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element -- user media from the library / storage, any host
            <img src={m.url} alt={m.altText} loading="lazy" className="size-full object-cover" />
          )}
        </li>
      ))}
    </ul>
  );
}

export function PostPreview({
  post,
  channels,
  media,
  locale,
  timeZone,
  labels,
}: {
  post: PreviewPost;
  channels: Map<number, PreviewChannel>;
  media: Map<number, MediaInfo>;
  locale: string;
  timeZone: string;
  labels: { noText: string; noDate: string; versionFor: string; firstComment: string; thread: string };
}) {
  const variants = post.targets
    .map((t) => ({ t, content: mergeContent(post.content, t.override) }))
    .filter(({ content }) => content.text !== post.content.text || content.mediaIds.join() !== post.content.mediaIds.join());
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted">
        <span className="inline-flex items-center gap-1.5">
          <CalendarClock className="size-4" aria-hidden />
          {post.scheduledAt ? <bdi>{formatInZone(post.scheduledAt, locale, timeZone)}</bdi> : labels.noDate}
        </span>
        <span className="flex flex-wrap items-center gap-1.5">
          {post.targets.map((t) => {
            const c = channels.get(t.channelId);
            return (
              <span key={t.id} className="inline-flex max-w-48 items-center gap-1 rounded-full border border-line bg-paper py-0.5 ps-0.5 pe-2">
                <PlatformIcon platform={t.platform} className="size-5 rounded-full" />
                <bdi dir="auto" className="truncate">
                  {c?.name ?? t.platform}
                </bdi>
              </span>
            );
          })}
        </span>
      </div>
      <p dir="auto" className="mt-3 text-sm leading-relaxed break-words whitespace-pre-wrap">
        {post.content.text || <span className="text-muted italic">{labels.noText}</span>}
      </p>
      <Thumbs ids={post.content.mediaIds} media={media} />
      {post.content.thread.length ? (
        <div className="mt-3 border-s-2 border-line ps-3">
          <p className="text-xs font-medium text-muted">{labels.thread}</p>
          {post.content.thread.map((part, i) => (
            <p key={i} dir="auto" className="mt-1 text-sm break-words whitespace-pre-wrap">
              {part}
            </p>
          ))}
        </div>
      ) : null}
      {post.content.firstComment ? (
        <p className="mt-3 text-xs text-muted">
          <span className="font-medium">{labels.firstComment}:</span>{" "}
          <bdi dir="auto" className="break-words">
            {post.content.firstComment}
          </bdi>
        </p>
      ) : null}
      {variants.length ? (
        <ul className="mt-4 space-y-3">
          {variants.map(({ t, content }) => (
            <li key={t.id} className="rounded-lg border border-line bg-paper p-3">
              <p className="flex items-center gap-2 text-xs font-medium text-muted">
                <PlatformIcon platform={t.platform} className="size-4" />
                {labels.versionFor.replace("{channel}", channels.get(t.channelId)?.name ?? t.platform)}
              </p>
              <p dir="auto" className="mt-1.5 text-sm break-words whitespace-pre-wrap">
                {content.text || <span className="text-muted italic">{labels.noText}</span>}
              </p>
              <Thumbs ids={content.mediaIds.join() !== post.content.mediaIds.join() ? content.mediaIds : []} media={media} size="sm" />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
