"use client";

import { Fragment, type ReactNode } from "react";
import { Bookmark, Eye, Globe2, Heart, MessageCircle, MoreHorizontal, Play, Repeat2, Send, Share2, ThumbsUp } from "lucide-react";
import { PlatformIcon } from "@/components/social/platform-icon";
import { useT } from "@/lib/i18n/client";
import { PLATFORM_STYLES, platformShortName } from "@/social/format";
import type { MediaInfo, Platform, PostContent } from "@/social/types";
import { cn } from "@/lib/utils";

/**
 * Live previews of a post per network: simple, original mockups (not the networks' real UI or
 * logos) that show how long the text is, where it gets cut, how media are laid out and what the
 * first comment / thread look like.
 */

export interface PreviewChannel {
  name: string;
  handle: string;
  avatarUrl: string;
  platform: Platform;
}

const URL_OR_TAG = /(https?:\/\/[^\s]+|#[\p{L}\p{N}_]+|@[A-Za-z0-9_.]+)/gu;

/** Text with links, hashtags and mentions coloured. */
function RichText({ text, color, className, clamp }: { text: string; color: string; className?: string; clamp?: number }) {
  const t = useT();
  const cut = clamp && text.length > clamp ? text.slice(0, clamp).replace(/\s+\S*$/, "") : text;
  const parts = cut.split(URL_OR_TAG);
  return (
    <p dir="auto" className={cn("break-words whitespace-pre-wrap", className)}>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <span key={i} style={{ color }} className={part.startsWith("http") ? "break-all" : undefined}>
            {part}
          </span>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
      {cut !== text ? <span className="text-muted">… {t("dash.preview.more")}</span> : null}
    </p>
  );
}

function Avatar({ channel, size = "size-10", round = true }: { channel: PreviewChannel; size?: string; round?: boolean }) {
  if (channel.avatarUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={channel.avatarUrl} alt="" className={cn(size, round ? "rounded-full" : "rounded-lg", "shrink-0 object-cover")} />;
  }
  return (
    <span className={cn(size, round ? "rounded-full" : "rounded-lg", "grid shrink-0 place-items-center text-sm font-semibold text-white")} style={{ background: PLATFORM_STYLES[channel.platform].color }} aria-hidden>
      {(channel.name.trim() || "?").slice(0, 1).toUpperCase()}
    </span>
  );
}

function MediaBox({ item, className }: { item: MediaInfo; className?: string }) {
  if (item.kind === "video") {
    return (
      <div className={cn("relative overflow-hidden bg-black", className)}>
        <video src={`${item.url}#t=0.1`} preload="metadata" muted playsInline className="size-full object-cover" />
        <span className="absolute inset-0 grid place-items-center">
          <span className="grid size-10 place-items-center rounded-full bg-black/60 text-white">
            <Play className="size-5" aria-hidden />
          </span>
        </span>
      </div>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={item.url} alt={item.altText} className={cn("size-full bg-paper object-cover", className)} />;
}

/** 1–4 items in a grid (X, Bluesky, Mastodon, LinkedIn, Facebook…), "+N" on the last tile. */
function MediaGrid({ media, rounded = "rounded-xl", aspect = "aspect-[16/10]" }: { media: MediaInfo[]; rounded?: string; aspect?: string }) {
  if (!media.length) return null;
  const shown = media.slice(0, 4);
  if (shown.length === 1) {
    const m = shown[0];
    const ratio = m.width && m.height ? Math.min(Math.max(m.width / m.height, 0.6), 2) : 16 / 10;
    return (
      <div className={cn("mt-3 overflow-hidden border border-line", rounded)} style={{ aspectRatio: String(ratio) }}>
        <MediaBox item={m} />
      </div>
    );
  }
  return (
    <div className={cn("mt-3 grid grid-cols-2 gap-0.5 overflow-hidden border border-line", rounded, aspect)}>
      {shown.map((m, i) => (
        <div key={m.id} className={cn("relative min-h-0", shown.length === 3 && i === 0 && "row-span-2")}>
          <MediaBox item={m} />
          {i === 3 && media.length > 4 ? <span className="absolute inset-0 grid place-items-center bg-black/50 text-lg font-semibold text-white">+{media.length - 4}</span> : null}
        </div>
      ))}
    </div>
  );
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function LinkCard({ content, compact = false }: { content: PostContent; compact?: boolean }) {
  if (!content.link) return null;
  const meta = content.linkMeta;
  return (
    <div className={cn("mt-3 overflow-hidden rounded-xl border border-line", compact && "flex")}>
      {meta?.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={meta.imageUrl} alt="" className={cn("bg-paper object-cover", compact ? "size-20 shrink-0" : "aspect-[1.91/1] w-full")} />
      ) : (
        <div className={cn("grid place-items-center bg-paper text-muted", compact ? "size-20 shrink-0" : "aspect-[1.91/1] w-full")}>
          <Globe2 className="size-6" aria-hidden />
        </div>
      )}
      <div className="min-w-0 bg-paper/60 px-3 py-2">
        <p dir="ltr" className="truncate text-[11px] text-muted uppercase">
          {domainOf(content.link)}
        </p>
        <p dir="auto" className="line-clamp-2 text-sm font-semibold">
          {meta?.title || domainOf(content.link)}
        </p>
        {meta?.description && !compact ? (
          <p dir="auto" className="line-clamp-2 text-xs text-muted">
            {meta.description}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function Actions({ items }: { items: Array<{ icon: ReactNode; label?: string }> }) {
  return (
    <div className="mt-3 flex items-center justify-between text-muted [&_svg]:size-4">
      {items.map((it, i) => (
        <span key={i} className="inline-flex items-center gap-1.5 text-xs">
          {it.icon}
          {it.label}
        </span>
      ))}
    </div>
  );
}

/** Replies under a post: thread parts and the first comment (self-reply networks). */
function Replies({ channel, parts, color, label }: { channel: PreviewChannel; parts: string[]; color: string; label: string }) {
  if (!parts.length) return null;
  return (
    <ol className="mt-1 space-y-0">
      {parts.map((part, i) => (
        <li key={i} className="flex gap-3 pt-3">
          <div className="flex flex-col items-center">
            <Avatar channel={channel} size="size-8" />
          </div>
          <div className="min-w-0 flex-1 border-b border-line pb-3">
            <p className="text-xs text-muted">
              <bdi className="font-semibold text-ink">{channel.name}</bdi> · {label}
            </p>
            <RichText text={part} color={color} className="text-sm" />
          </div>
        </li>
      ))}
    </ol>
  );
}

function Frame({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("overflow-hidden rounded-2xl border border-line bg-surface p-4 text-ink shadow-sm", className)}>{children}</div>;
}

export function PostPreview({ channel, content, media, whenLabel }: { channel: PreviewChannel; content: PostContent; media: MediaInfo[]; whenLabel: string }) {
  const t = useT();
  const p = channel.platform;
  const color = PLATFORM_STYLES[p].color === "#101010" || PLATFORM_STYLES[p].color === "#0f1419" || PLATFORM_STYLES[p].color === "#111111" ? "#1d9bf0" : PLATFORM_STYLES[p].color;
  const handle = channel.handle ? (channel.handle.startsWith("@") ? channel.handle : `@${channel.handle}`) : "";
  const empty = !content.text.trim() && !media.length;
  const placeholder = <p className="text-sm text-muted italic">{t("dash.preview.empty")}</p>;
  const replyLabel = t("dash.preview.reply");

  // Short-form networks: X, Threads, Bluesky, Mastodon.
  if (p === "x" || p === "threads" || p === "bluesky" || p === "mastodon") {
    const parts = [...content.thread, ...(content.firstComment.trim() ? [content.firstComment] : [])];
    const mastoCw = p === "mastodon" ? content.options.mastodon?.spoilerText : "";
    return (
      <Frame>
        <div className="flex gap-3">
          <Avatar channel={channel} />
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-baseline gap-x-1 text-sm">
              <bdi className="font-semibold">{channel.name}</bdi>
              <span dir="ltr" className="text-muted">
                {handle}
              </span>
              <span className="text-muted">· {whenLabel}</span>
            </p>
            {mastoCw ? (
              <p dir="auto" className="mt-1 rounded-md bg-paper px-2 py-1 text-sm font-medium">
                {mastoCw} <span className="text-xs text-muted">({t("dash.preview.cw")})</span>
              </p>
            ) : null}
            {empty ? placeholder : <RichText text={content.text} color={color} className="mt-0.5 text-[15px] leading-snug" />}
            <MediaGrid media={media} />
            {!media.length && p !== "mastodon" ? <LinkCard content={content} compact={p === "threads"} /> : null}
            <Actions
              items={
                p === "x"
                  ? [{ icon: <MessageCircle aria-hidden /> }, { icon: <Repeat2 aria-hidden /> }, { icon: <Heart aria-hidden /> }, { icon: <Eye aria-hidden /> }, { icon: <Share2 aria-hidden /> }]
                  : [{ icon: <Heart aria-hidden /> }, { icon: <MessageCircle aria-hidden /> }, { icon: <Repeat2 aria-hidden /> }, { icon: <Send aria-hidden /> }]
              }
            />
          </div>
        </div>
        <Replies channel={channel} parts={parts} color={color} label={replyLabel} />
      </Frame>
    );
  }

  if (p === "instagram" || p === "instagram_login") {
    const type = content.options.instagram?.postType ?? "feed";
    const first = media[0];
    const tall = type === "reel" || type === "story";
    return (
      <Frame className="p-0">
        <div className="flex items-center gap-2.5 px-3 py-2.5">
          <Avatar channel={channel} size="size-8" />
          <bdi className="text-sm font-semibold">{channel.handle.replace(/^@/, "") || channel.name}</bdi>
          <span className="ms-auto rounded-full bg-paper px-2 py-0.5 text-[11px] text-muted">{t(`dash.preview.ig.${type}`)}</span>
          <MoreHorizontal className="size-4 text-muted" aria-hidden />
        </div>
        <div className={cn("relative bg-paper", tall ? "mx-auto aspect-[9/16] max-h-[420px]" : first?.width && first.height && first.width / first.height < 0.95 ? "aspect-[4/5]" : "aspect-square")}>
          {first ? <MediaBox item={first} /> : <p className="grid size-full place-items-center px-6 text-center text-sm text-muted">{t("dash.preview.igNeedsMedia")}</p>}
          {media.length > 1 ? <span className="absolute end-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-[11px] text-white">1/{media.length}</span> : null}
        </div>
        {type !== "story" ? (
          <div className="px-3 pt-2.5 pb-3">
            <div className="flex gap-3.5 [&_svg]:size-5">
              <Heart aria-hidden />
              <MessageCircle aria-hidden />
              <Send aria-hidden />
              <Bookmark className="ms-auto" aria-hidden />
            </div>
            {content.text.trim() ? (
              <div className="mt-2 text-sm">
                <bdi className="me-1 font-semibold rtl:ms-1">{channel.handle.replace(/^@/, "") || channel.name}</bdi>
                <RichText text={content.text} color="#00376b" clamp={125} className="inline" />
              </div>
            ) : null}
            {content.firstComment.trim() ? (
              <p className="mt-1.5 text-xs text-muted">
                <bdi className="font-semibold text-ink">{channel.handle.replace(/^@/, "") || channel.name}</bdi> <bdi>{content.firstComment}</bdi>
              </p>
            ) : null}
            <p className="mt-1 text-[11px] text-muted uppercase">{whenLabel}</p>
          </div>
        ) : null}
      </Frame>
    );
  }

  if (p === "facebook" || p === "linkedin") {
    const fb = p === "facebook";
    return (
      <Frame className="p-0">
        <div className="flex gap-2.5 px-4 pt-3.5">
          <Avatar channel={channel} round={fb} />
          <div className="min-w-0">
            <bdi className="block text-sm font-semibold">{channel.name}</bdi>
            <p className="flex items-center gap-1 text-xs text-muted">
              {whenLabel} · <Globe2 className="size-3" aria-hidden />
            </p>
          </div>
        </div>
        <div className="px-4 pt-2 text-sm">{empty ? placeholder : <RichText text={content.text} color={color} clamp={fb ? 480 : 210} />}</div>
        {media.length ? (
          <div className="mt-2">
            <MediaGrid media={media} rounded="rounded-none border-x-0" />
          </div>
        ) : (
          <div className="px-4">
            <LinkCard content={content} />
          </div>
        )}
        <div className="mx-4 mt-3 border-t border-line py-2">
          <Actions items={[{ icon: <ThumbsUp aria-hidden />, label: t("dash.preview.like") }, { icon: <MessageCircle aria-hidden />, label: t("dash.preview.comment") }, { icon: fb ? <Share2 aria-hidden /> : <Repeat2 aria-hidden />, label: fb ? t("dash.preview.share") : t("dash.preview.repost") }]} />
        </div>
        {content.firstComment.trim() ? (
          <div className="flex gap-2 px-4 pb-3.5">
            <Avatar channel={channel} size="size-7" round={fb} />
            <div className="min-w-0 rounded-2xl bg-paper px-3 py-2 text-sm">
              <bdi className="block text-xs font-semibold">{channel.name}</bdi>
              <RichText text={content.firstComment} color={color} />
            </div>
          </div>
        ) : null}
      </Frame>
    );
  }

  if (p === "youtube") {
    const yt = content.options.youtube;
    const video = media.find((m) => m.kind === "video");
    const short = Boolean(video?.duration && video.duration <= 180 && video.width && video.height && video.height >= video.width);
    return (
      <Frame className="p-0">
        <div className={cn("relative bg-black", short ? "mx-auto aspect-[9/16] max-h-[420px]" : "aspect-video")}>
          {video ? <MediaBox item={video} /> : <p className="grid size-full place-items-center px-6 text-center text-sm text-white/70">{t("dash.preview.ytNeedsVideo")}</p>}
          {short ? <span className="absolute start-2 top-2 rounded bg-red-600 px-1.5 py-0.5 text-[11px] font-semibold text-white">Shorts</span> : null}
        </div>
        <div className="flex gap-3 p-3">
          <Avatar channel={channel} size="size-9" />
          <div className="min-w-0">
            <p dir="auto" className="line-clamp-2 text-sm font-semibold">
              {yt?.title || <span className="text-red-600 dark:text-red-400">{t("dash.preview.ytTitle")}</span>}
            </p>
            <p className="text-xs text-muted">
              <bdi>{channel.name}</bdi> · {t(`dash.preview.yt.${yt?.privacy ?? "public"}`)} · {whenLabel}
            </p>
            {content.text.trim() ? <RichText text={content.text} color={color} clamp={140} className="mt-2 rounded-lg bg-paper p-2 text-xs" /> : null}
          </div>
        </div>
      </Frame>
    );
  }

  if (p === "telegram") {
    return (
      <div className="rounded-2xl bg-[#d9e6c8] p-4 dark:bg-[#1c2733]">
        <div className="max-w-[92%] overflow-hidden rounded-2xl rounded-ss-sm bg-surface text-ink shadow-sm">
          {media.length ? <MediaGrid media={media} rounded="rounded-none border-0" /> : null}
          <div className="px-3 py-2">
            <bdi className="block text-sm font-semibold" style={{ color }}>
              {channel.name}
            </bdi>
            {empty ? placeholder : <RichText text={content.text} color={color} className="text-sm" />}
            {!media.length && content.link && !content.options.telegram?.disablePreview ? <LinkCard content={content} compact /> : null}
            <p className="mt-1 flex items-center justify-end gap-1 text-[11px] text-muted">
              <Eye className="size-3" aria-hidden /> 1 · {whenLabel}
              {content.options.telegram?.silent ? ` · ${t("dash.preview.silent")}` : ""}
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (p === "discord") {
    const d = content.options.discord;
    return (
      <div className="rounded-2xl bg-[#313338] p-4 text-[#dbdee1]">
        {d?.threadName ? <p className="mb-2 text-xs text-[#b5bac1]"># {d.threadName}</p> : null}
        <div className="flex gap-3">
          {d?.avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={d.avatarUrl} alt="" className="size-10 rounded-full object-cover" />
          ) : (
            <Avatar channel={channel} />
          )}
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-1.5 text-sm">
              <bdi className="font-semibold text-white">{d?.username || channel.name}</bdi>
              <span className="rounded bg-[#5865f2] px-1 text-[10px] font-semibold text-white">APP</span>
              <span className="text-xs text-[#949ba4]">{whenLabel}</span>
            </p>
            {empty ? <p className="text-sm text-[#949ba4] italic">{t("dash.preview.empty")}</p> : <RichText text={content.text} color="#00a8fc" className="text-sm" />}
            <MediaGrid media={media} rounded="rounded-lg border-0" />
          </div>
        </div>
      </div>
    );
  }

  // TikTok, Pinterest and anything else: a neutral card.
  return (
    <Frame>
      <div className="flex items-center gap-2">
        <PlatformIcon platform={p} className="size-6" />
        <bdi className="text-sm font-semibold">{channel.name}</bdi>
        <span className="text-xs text-muted">· {platformShortName(p)}</span>
      </div>
      {empty ? placeholder : <RichText text={content.text} color={color} className="mt-2 text-sm" />}
      <MediaGrid media={media} />
    </Frame>
  );
}
