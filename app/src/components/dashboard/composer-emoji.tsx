"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Hash, Smile } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

/** Lightweight emoji picker and hashtag helper of the composer toolbar (no dependencies). */

const EMOJI: Array<{ key: "smileys" | "gestures" | "objects" | "symbols"; list: string[] }> = [
  { key: "smileys", list: ["😀", "😁", "😂", "🤣", "😊", "😍", "🥰", "😘", "😎", "🤩", "🤔", "🙃", "😉", "😇", "🥳", "😅", "😮", "😢", "😭", "😡", "🤯", "😴", "🤗", "🙌"] },
  { key: "gestures", list: ["👍", "👎", "👏", "🙏", "💪", "👋", "🤝", "✌️", "🤞", "👉", "👇", "☝️", "🫶", "❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "💯", "🔥", "✨", "⭐"] },
  { key: "objects", list: ["🎉", "🎁", "📣", "📢", "📸", "🎥", "💡", "📌", "📈", "📊", "🗓️", "⏰", "🚀", "🛒", "💰", "🏆", "🎯", "📝", "💻", "📱", "☕", "🍕", "🌍", "🌞"] },
  { key: "symbols", list: ["✅", "❌", "⚡", "❗", "❓", "➡️", "⬆️", "⬇️", "🔗", "🆕", "🆓", "💬", "🔔", "♻️", "⚠️", "🔴", "🟢", "🔵", "⭕", "➕", "✔️", "©️", "®️", "™️"] },
];

/** A toolbar button with a small popover. */
function Popover({ label, icon, children, open, setOpen }: { label: string; icon: ReactNode; children: ReactNode; open: boolean; setOpen: (v: boolean) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, setOpen]);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-label={label}
        title={label}
        className={cn("grid size-8 place-items-center rounded-md text-muted hover:bg-primary-soft hover:text-ink", open && "bg-primary-soft text-ink")}
      >
        {icon}
      </button>
      {open ? <div className="absolute start-0 top-9 z-40 w-[min(19rem,calc(100vw-2rem))] rounded-xl border border-line bg-surface p-3 shadow-xl">{children}</div> : null}
    </div>
  );
}

export function EmojiButton({ onPick }: { onPick: (emoji: string) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState(0);
  return (
    <Popover label={t("dash.compose.emoji")} icon={<Smile className="size-4" aria-hidden />} open={open} setOpen={setOpen}>
      <div role="tablist" className="mb-2 flex gap-1">
        {EMOJI.map((g, i) => (
          <button key={g.key} type="button" role="tab" aria-selected={tab === i} onClick={() => setTab(i)} className={cn("rounded-md px-2 py-1 text-xs font-medium", tab === i ? "bg-primary-soft text-primary" : "text-muted hover:text-ink")}>
            {t(`dash.compose.emoji.${g.key}`)}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-8 gap-1" role="tabpanel">
        {EMOJI[tab].list.map((e) => (
          <button key={e} type="button" onClick={() => onPick(e)} className="grid size-8 place-items-center rounded-md text-lg hover:bg-paper" aria-label={e}>
            {e}
          </button>
        ))}
      </div>
    </Popover>
  );
}

/** Hashtag groups of the selected channels plus the tags already in the text. */
export function HashtagButton({ groups, used, onInsert, limit }: { groups: Array<{ label: string; tags: string }>; used: string[]; onInsert: (text: string) => void; limit: number | null }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState("");
  const add = (raw: string) => {
    const tags = raw
      .split(/[\s,]+/)
      .map((x) => x.replace(/^#*/, "").trim())
      .filter((x) => /^[\p{L}\p{N}_]+$/u.test(x))
      .map((x) => `#${x}`);
    if (tags.length) onInsert(tags.join(" "));
  };
  return (
    <Popover label={t("dash.compose.hashtags")} icon={<Hash className="size-4" aria-hidden />} open={open} setOpen={setOpen}>
      <p className="text-xs text-muted">
        {t("dash.compose.hashtagsUsed", { n: used.length })}
        {limit ? ` · ${t("dash.compose.hashtagsLimit", { n: limit })}` : ""}
      </p>
      {groups.length ? (
        <ul className="mt-2 space-y-1.5">
          {groups.map((g) => (
            <li key={g.label}>
              <button type="button" onClick={() => add(g.tags)} className="w-full rounded-md border border-line px-2 py-1.5 text-start text-xs hover:border-primary-line">
                <bdi className="block font-medium">{g.label}</bdi>
                <span dir="auto" className="line-clamp-2 text-muted">
                  {g.tags}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-xs text-muted">{t("dash.compose.hashtagsNone")}</p>
      )}
      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          add(custom);
          setCustom("");
        }}
      >
        <input value={custom} onChange={(e) => setCustom(e.target.value)} dir="auto" placeholder={t("dash.compose.hashtagsAdd")} aria-label={t("dash.compose.hashtagsAdd")} className="h-8 min-w-0 flex-1 rounded-md border border-line bg-surface px-2 text-sm" />
        <button type="submit" className="rounded-md bg-primary px-2.5 text-xs font-medium text-white">
          {t("dash.compose.insert")}
        </button>
      </form>
    </Popover>
  );
}
