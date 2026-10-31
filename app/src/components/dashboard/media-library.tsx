"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition, type DragEvent, type ReactNode } from "react";
import { Check, Copy, Film, Folder, FolderPlus, ImageIcon, Lock, Pencil, Search, Trash2, UploadCloud, X } from "lucide-react";
import { createFolderAction, deleteFolderAction, deleteMediaAction, libraryPage, mediaUsage, moveMediaAction, renameFolderAction, updateMediaAction, type LibraryItem } from "@/app/actions/dashboard/media";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/field";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import type { MediaFolder } from "@/lib/media/service";

/**
 * The media library (Media page) and its picker (composer): folders, search, type filter,
 * drag-and-drop upload with progress straight to the storage (presigned URL / local stream),
 * alt text, moving, deleting (locked while an upcoming post uses the item) and multi-select.
 */

export type { LibraryItem };

const EXT_MIME: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm" };

function guessMime(file: File): string {
  if (file.type) return file.type;
  return EXT_MIME[file.name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
}

export class UploadError extends Error {}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new UploadError(data.error || `HTTP ${res.status}`);
  return data;
}

/** init → PUT to the storage with progress → complete. Resolves with the new library item. */
export async function uploadFile(workspaceId: number, file: File, folderId: number | null, onProgress: (ratio: number) => void): Promise<LibraryItem> {
  const init = await postJson<{ token: string; upload: { method: "PUT"; url: string; headers: Record<string, string>; returnsUrl: boolean } }>("/api/media/init", {
    workspaceId,
    filename: file.name,
    mime: guessMime(file),
    size: file.size,
    folderId,
  });
  const responseText = await new Promise<string>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(init.upload.method, init.upload.url);
    for (const [k, v] of Object.entries(init.upload.headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.responseText);
      else {
        let message = `HTTP ${xhr.status}`;
        try {
          message = (JSON.parse(xhr.responseText) as { error?: string }).error || message;
        } catch {
          // S3 answers in XML.
        }
        reject(new UploadError(message));
      }
    };
    xhr.onerror = () => reject(new UploadError("network"));
    xhr.send(file);
  });
  let blobUrl: string | undefined;
  if (init.upload.returnsUrl) {
    try {
      blobUrl = (JSON.parse(responseText) as { url?: string }).url;
    } catch {
      blobUrl = undefined;
    }
  }
  onProgress(1);
  const done = await postJson<{ media: LibraryItem }>("/api/media/complete", { workspaceId, token: init.token, blobUrl });
  return done.media;
}

export function formatBytes(bytes: number, locale: string): string {
  const units = ["B", "KB", "MB", "GB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toLocaleString(locale, { maximumFractionDigits: i ? 1 : 0 })} ${units[i]}`;
}

export function formatDuration(seconds: number): string {
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

/** Image or first video frame of a library item. */
export function MediaThumb({ item, className }: { item: Pick<LibraryItem, "kind" | "url" | "altText">; className?: string }) {
  if (item.kind === "video") {
    return <video src={`${item.url}#t=0.1`} preload="metadata" muted playsInline className={cn("size-full bg-black object-cover", className)} aria-label={item.altText || undefined} />;
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={item.url} alt={item.altText} loading="lazy" className={cn("size-full object-cover", className)} />;
}

interface Upload {
  id: string;
  name: string;
  progress: number;
  error: string | null;
}

/** Drop zone + file input; uploads run in parallel (3 at a time) with a progress bar each. */
export function UploadZone({ workspaceId, folderId, onUploaded, compact = false, disabled = false }: { workspaceId: number; folderId: number | null; onUploaded: (item: LibraryItem) => void; compact?: boolean; disabled?: boolean }) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [over, setOver] = useState(false);

  const start = useCallback(
    async (files: File[]) => {
      const queue = files.map((file) => ({ file, id: `${file.name}-${file.size}-${Math.random().toString(36).slice(2)}` }));
      setUploads((u) => [...queue.map((q) => ({ id: q.id, name: q.file.name, progress: 0, error: null })), ...u].slice(0, 30));
      const set = (id: string, patch: Partial<Upload>) => setUploads((u) => u.map((x) => (x.id === id ? { ...x, ...patch } : x)));
      const worker = async () => {
        for (;;) {
          const next = queue.shift();
          if (!next) return;
          try {
            const item = await uploadFile(workspaceId, next.file, folderId, (p) => set(next.id, { progress: p }));
            set(next.id, { progress: 1 });
            onUploaded(item);
            setTimeout(() => setUploads((u) => u.filter((x) => x.id !== next.id)), 1500);
          } catch (error) {
            set(next.id, { error: error instanceof Error && error.message !== "network" ? error.message : t("dash.media.err.upload") });
          }
        }
      };
      await Promise.all([worker(), worker(), worker()]);
    },
    [workspaceId, folderId, onUploaded, t],
  );

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    if (disabled) return;
    const files = Array.from(e.dataTransfer.files);
    if (files.length) void start(files);
  };

  return (
    <div>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        className={cn(
          "flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 text-center transition-colors",
          compact ? "py-4" : "py-8",
          over ? "border-primary bg-primary-soft" : "border-line bg-paper",
          disabled && "opacity-60",
        )}
      >
        <UploadCloud className="size-6 text-primary" aria-hidden />
        <p className="text-sm">
          {t("dash.media.drop")}{" "}
          <button type="button" disabled={disabled} onClick={() => input.current?.click()} className="font-medium text-primary hover:underline disabled:no-underline">
            {t("dash.media.browse")}
          </button>
        </p>
        <p className="text-xs text-muted">{t("dash.media.dropHint")}</p>
        <input
          ref={input}
          type="file"
          multiple
          accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime,video/webm"
          className="sr-only"
          tabIndex={-1}
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            if (files.length) void start(files);
          }}
        />
      </div>
      {uploads.length ? (
        <ul className="mt-3 space-y-2" aria-live="polite">
          {uploads.map((u) => (
            <li key={u.id} className="rounded-lg border border-line bg-surface px-3 py-2 text-sm">
              <div className="flex items-center justify-between gap-3">
                <bdi className="min-w-0 truncate">{u.name}</bdi>
                {u.error ? (
                  <button type="button" onClick={() => setUploads((x) => x.filter((y) => y.id !== u.id))} aria-label={t("dash.media.dismiss")} className="text-muted hover:text-ink">
                    <X className="size-4" aria-hidden />
                  </button>
                ) : (
                  <span className="shrink-0 text-xs text-muted tabular-nums">{Math.round(u.progress * 100)}%</span>
                )}
              </div>
              {u.error ? (
                <p role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">
                  {u.error}
                </p>
              ) : (
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-line/70" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(u.progress * 100)} aria-label={u.name}>
                  <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${Math.max(2, u.progress * 100)}%` }} />
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

interface LibraryState {
  items: LibraryItem[];
  total: number;
  folders: MediaFolder[];
}

/**
 * The library itself. `mode="page"`: manage items. `mode="picker"`: choose items for a post
 * (`onPick` gets them in the order they were clicked; `max` limits the selection).
 */
export function MediaLibrary({
  workspaceId,
  initial,
  canManage,
  canUpload,
  mode = "page",
  onPick,
  max = 35,
  locale,
}: {
  workspaceId: number;
  initial?: LibraryState;
  canManage: boolean;
  /** Uploads allowed (false in demo mode). */
  canUpload: boolean;
  mode?: "page" | "picker";
  onPick?: (items: LibraryItem[]) => void;
  max?: number;
  locale: string;
}) {
  const t = useT();
  const [data, setData] = useState<LibraryState>(initial ?? { items: [], total: 0, folders: [] });
  const [folder, setFolder] = useState<number | null | undefined>(undefined);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<"" | "image" | "video">("");
  const [selected, setSelected] = useState<number[]>([]);
  const [detail, setDetail] = useState<LibraryItem | null>(null);
  const [usage, setUsage] = useState<Record<number, number[]>>({});
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const [loaded, setLoaded] = useState(Boolean(initial));

  const reload = useCallback(
    (offset = 0) => {
      startTransition(async () => {
        const page = await libraryPage(workspaceId, { folderId: folder, q, kind, offset });
        setData((d) => (offset ? { ...page, items: [...d.items, ...page.items] } : page));
        setLoaded(true);
        if (mode === "page") setUsage(await mediaUsage(workspaceId, page.items.map((i) => i.id)));
      });
    },
    [workspaceId, folder, q, kind, mode],
  );

  // Refetch when the filters change (debounced for the search box).
  const first = useRef(Boolean(initial));
  useEffect(() => {
    if (first.current) {
      first.current = false;
      if (mode === "page" && initial) void mediaUsage(workspaceId, initial.items.map((i) => i.id)).then(setUsage);
      return;
    }
    const timer = setTimeout(() => reload(0), q ? 300 : 0);
    return () => clearTimeout(timer);
  }, [folder, q, kind, reload, mode, workspaceId, initial]);

  const onUploaded = useCallback(
    (item: LibraryItem) => {
      setData((d) => ({ ...d, items: [item, ...d.items.filter((x) => x.id !== item.id)], total: d.total + 1 }));
      if (mode === "picker") setSelected((s) => (s.length < max && !s.includes(item.id) ? [...s, item.id] : s));
    },
    [mode, max],
  );

  const toggle = (id: number) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : mode === "picker" && s.length >= max ? s : [...s, id]));

  const runForm = (action: (prev: { error?: string; success?: string }, fd: FormData) => Promise<{ error?: string; success?: string }>, fields: Record<string, string | number | Array<string | number>>, after?: () => void) => {
    startTransition(async () => {
      const fd = new FormData();
      fd.set("wid", String(workspaceId));
      for (const [k, v] of Object.entries(fields)) {
        if (Array.isArray(v)) v.forEach((x) => fd.append(k, String(x)));
        else fd.set(k, String(v));
      }
      const result = await action({}, fd);
      setMessage(result.error ? { tone: "error", text: result.error } : result.success ? { tone: "ok", text: result.success } : null);
      if (!result.error) {
        after?.();
        reload(0);
      }
    });
  };

  const folderName = (id: number | null) => data.folders.find((f) => f.id === id)?.name ?? t("dash.media.root");
  const pickedItems = useMemo(() => selected.map((id) => data.items.find((i) => i.id === id)).filter((x): x is LibraryItem => Boolean(x)), [selected, data.items]);

  return (
    <div className={cn("grid grid-cols-[minmax(0,1fr)] gap-5", mode === "page" ? "lg:grid-cols-[220px_minmax(0,1fr)]" : "md:grid-cols-[180px_minmax(0,1fr)]")}>
      {/* Folders */}
      <nav aria-label={t("dash.media.folders")} className="min-w-0">
        <ul className="flex gap-1 overflow-x-auto pb-1 md:flex-col md:overflow-visible">
          <FolderButton active={folder === undefined} onClick={() => setFolder(undefined)} icon={<ImageIcon className="size-4" aria-hidden />}>
            {t("dash.media.all")}
          </FolderButton>
          <FolderButton active={folder === null} onClick={() => setFolder(null)} icon={<Folder className="size-4" aria-hidden />}>
            {t("dash.media.root")}
          </FolderButton>
          {data.folders.map((f) => (
            <FolderButton key={f.id} active={folder === f.id} onClick={() => setFolder(f.id)} icon={<Folder className="size-4" aria-hidden />} count={f.count}>
              <bdi>{f.name}</bdi>
            </FolderButton>
          ))}
        </ul>
        {canManage && mode === "page" ? (
          <form
            className="mt-3 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const name = new FormData(e.currentTarget).get("name");
              const form = e.currentTarget;
              runForm(createFolderAction, { name: String(name ?? "") }, () => form.reset());
            }}
          >
            <Input name="name" placeholder={t("dash.media.newFolder")} aria-label={t("dash.media.newFolder")} maxLength={120} dir="auto" className="h-8! text-xs" required />
            <Button type="submit" variant="outline" size="sm" aria-label={t("dash.media.createFolder")} title={t("dash.media.createFolder")} disabled={pending}>
              <FolderPlus aria-hidden />
            </Button>
          </form>
        ) : null}
        {canManage && mode === "page" && typeof folder === "number" ? (
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                const name = window.prompt(t("dash.media.renameFolder"), folderName(folder));
                if (name) runForm(renameFolderAction, { folder, name });
              }}
            >
              <Pencil aria-hidden />
              {t("dash.media.rename")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                if (window.confirm(t("dash.media.deleteFolderConfirm", { name: folderName(folder) }))) runForm(deleteFolderAction, { folder }, () => setFolder(undefined));
              }}
            >
              <Trash2 aria-hidden />
              {t("dash.media.delete")}
            </Button>
          </div>
        ) : null}
      </nav>

      <div className="min-w-0 space-y-4">
        {canUpload ? <UploadZone workspaceId={workspaceId} folderId={typeof folder === "number" ? folder : null} onUploaded={onUploaded} compact={mode === "picker"} /> : null}

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1 basis-48">
            <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("dash.media.search")} aria-label={t("dash.media.search")} className="ps-9" dir="auto" />
          </div>
          <Select value={kind} onChange={(e) => setKind(e.target.value as "" | "image" | "video")} aria-label={t("dash.media.type")} className="w-auto!">
            <option value="">{t("dash.media.typeAll")}</option>
            <option value="image">{t("dash.media.typeImage")}</option>
            <option value="video">{t("dash.media.typeVideo")}</option>
          </Select>
        </div>

        {message ? (
          <p role={message.tone === "error" ? "alert" : "status"} className={cn("text-sm", message.tone === "error" ? "text-red-600 dark:text-red-400" : "text-emerald-700 dark:text-emerald-400")}>
            {message.text}
          </p>
        ) : null}

        {selected.length && mode === "page" && canManage ? (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-paper px-3 py-2 text-sm">
            <span className="font-medium">{t("dash.media.selected", { n: selected.length })}</span>
            <Select aria-label={t("dash.media.moveTo")} className="h-8! w-auto! text-xs" defaultValue="" onChange={(e) => {
              const v = e.target.value;
              if (v === "") return;
              runForm(moveMediaAction, { media: selected, folder: v === "root" ? "" : v }, () => setSelected([]));
              e.target.value = "";
            }}>
              <option value="">{t("dash.media.moveTo")}</option>
              <option value="root">{t("dash.media.root")}</option>
              {data.folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </Select>
            <Button
              variant="danger"
              size="sm"
              disabled={pending}
              onClick={() => {
                if (window.confirm(t("dash.media.deleteConfirm", { n: selected.length }))) runForm(deleteMediaAction, { media: selected }, () => setSelected([]));
              }}
            >
              <Trash2 aria-hidden />
              {t("dash.media.delete")}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setSelected([])}>
              {t("dash.media.clear")}
            </Button>
          </div>
        ) : null}

        {!loaded ? (
          <p className="py-10 text-center text-sm text-muted">{t("dash.media.loading")}</p>
        ) : data.items.length ? (
          <ul className={cn("grid gap-3", mode === "page" ? "grid-cols-2 sm:grid-cols-3 xl:grid-cols-5" : "grid-cols-3 sm:grid-cols-4")} aria-busy={pending}>
            {data.items.map((item) => {
              const isSelected = selected.includes(item.id);
              const order = selected.indexOf(item.id) + 1;
              const locked = Boolean(usage[item.id]?.length);
              return (
                <li key={item.id} className={cn("group relative overflow-hidden rounded-xl border bg-surface", isSelected ? "border-primary ring-2 ring-primary/40" : "border-line")}>
                  <button type="button" onClick={() => (mode === "picker" ? toggle(item.id) : setDetail(item))} className="block aspect-square w-full bg-paper" aria-label={item.altText || item.filename} aria-pressed={mode === "picker" ? isSelected : undefined}>
                    <MediaThumb item={item} />
                  </button>
                  {mode === "page" && canManage ? (
                    <label className="absolute start-2 top-2 grid size-6 cursor-pointer place-items-center rounded-md bg-surface/90 shadow-sm">
                      <input type="checkbox" checked={isSelected} onChange={() => toggle(item.id)} className="size-4 accent-[var(--primary)]" aria-label={t("dash.media.select", { name: item.filename })} />
                    </label>
                  ) : isSelected ? (
                    <span className="absolute start-2 top-2 grid size-6 place-items-center rounded-full bg-primary text-xs font-bold text-white">{order}</span>
                  ) : null}
                  <span className="absolute end-2 top-2 flex gap-1">
                    {item.kind === "video" ? (
                      <span className="inline-flex items-center gap-1 rounded-md bg-black/70 px-1.5 py-0.5 text-[11px] font-medium text-white">
                        <Film className="size-3" aria-hidden />
                        {item.duration ? formatDuration(item.duration) : t("dash.media.typeVideo")}
                      </span>
                    ) : item.kind === "gif" ? (
                      <span className="rounded-md bg-black/70 px-1.5 py-0.5 text-[11px] font-medium text-white">GIF</span>
                    ) : null}
                    {locked ? (
                      <span className="rounded-md bg-amber-500 px-1 py-0.5 text-white" title={t("dash.media.inUse")}>
                        <Lock className="size-3" aria-label={t("dash.media.inUse")} />
                      </span>
                    ) : null}
                  </span>
                  <div className="px-2.5 py-2 text-xs">
                    <bdi className="block truncate font-medium">{item.filename}</bdi>
                    <span className="text-muted tabular-nums">
                      {item.width && item.height ? `${item.width}×${item.height} · ` : ""}
                      {formatBytes(item.size, locale)}
                    </span>
                    {!item.altText && item.kind !== "video" ? <span className="ms-1 text-amber-600 dark:text-amber-400">· {t("dash.media.noAlt")}</span> : null}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="rounded-xl border border-line bg-surface px-6 py-12 text-center">
            <ImageIcon className="mx-auto size-8 text-primary" aria-hidden />
            <p className="mt-3 font-medium">{q || kind ? t("dash.media.noMatch") : t("dash.media.empty")}</p>
            <p className="mt-1 text-sm text-muted">{t("dash.media.emptyText")}</p>
          </div>
        )}
        {data.items.length < data.total ? (
          <div className="flex justify-center">
            <Button variant="outline" size="sm" disabled={pending} onClick={() => reload(data.items.length)}>
              {t("dash.media.more", { n: data.total - data.items.length })}
            </Button>
          </div>
        ) : null}

        {mode === "picker" ? (
          <div className="sticky bottom-0 flex flex-wrap items-center justify-between gap-3 border-t border-line bg-surface py-3">
            <span className="text-sm text-muted">{t("dash.media.pickedCount", { n: selected.length, max })}</span>
            <Button onClick={() => onPick?.(pickedItems)} disabled={!selected.length}>
              <Check aria-hidden />
              {t("dash.media.attach")}
            </Button>
          </div>
        ) : null}
      </div>

      {detail ? (
        <MediaDetail
          item={detail}
          folders={data.folders}
          locked={Boolean(usage[detail.id]?.length)}
          canManage={canManage}
          workspaceId={workspaceId}
          locale={locale}
          onClose={() => setDetail(null)}
          onSaved={(patch) => {
            setData((d) => ({ ...d, items: d.items.map((i) => (i.id === detail.id ? { ...i, ...patch } : i)) }));
            setDetail((x) => (x ? { ...x, ...patch } : x));
          }}
          onDelete={() => runForm(deleteMediaAction, { media: [detail.id] }, () => setDetail(null))}
        />
      ) : null}
    </div>
  );
}

function FolderButton({ active, onClick, icon, children, count }: { active: boolean; onClick: () => void; icon: ReactNode; children: ReactNode; count?: number }) {
  return (
    <li className="shrink-0">
      <button
        type="button"
        onClick={onClick}
        aria-current={active ? "true" : undefined}
        className={cn("flex w-full items-center gap-2 rounded-lg px-3 py-2 text-start text-sm font-medium whitespace-nowrap", active ? "bg-surface text-primary ring-1 ring-line" : "text-muted hover:text-ink")}
      >
        {icon}
        <span className="min-w-0 flex-1 truncate">{children}</span>
        {count !== undefined ? <span className="rounded-full bg-line/70 px-1.5 text-[11px] tabular-nums">{count}</span> : null}
      </button>
    </li>
  );
}

function MediaDetail({
  item,
  folders,
  locked,
  canManage,
  workspaceId,
  locale,
  onClose,
  onSaved,
  onDelete,
}: {
  item: LibraryItem;
  folders: MediaFolder[];
  locked: boolean;
  canManage: boolean;
  workspaceId: number;
  locale: string;
  onClose: () => void;
  onSaved: (patch: Partial<LibraryItem>) => void;
  onDelete: () => void;
}) {
  const t = useT();
  const [alt, setAlt] = useState(item.altText);
  const [folderId, setFolderId] = useState<string>(item.folderId ? String(item.folderId) : "");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [copied, setCopied] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  return (
    <dialog ref={dialog} onClose={onClose} className="m-auto w-[min(56rem,calc(100vw-1.5rem))] rounded-2xl border border-line bg-surface p-0 text-ink shadow-2xl backdrop:bg-black/50">
      <div className="grid max-h-[90vh] overflow-y-auto md:grid-cols-[minmax(0,1fr)_320px]">
        <div className="grid min-h-64 place-items-center bg-paper p-3">
          {item.kind === "video" ? (
            <video src={item.url} controls preload="metadata" className="max-h-[70vh] w-full rounded-lg bg-black" />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={item.url} alt={item.altText} className="max-h-[70vh] w-auto rounded-lg object-contain" />
          )}
        </div>
        <div className="space-y-4 p-5">
          <div className="flex items-start justify-between gap-3">
            <h2 className="min-w-0 font-sans text-base font-semibold tracking-normal">
              <bdi className="break-all">{item.filename}</bdi>
            </h2>
            <button type="button" onClick={() => dialog.current?.close()} aria-label={t("dash.media.close")} className="rounded-md p-1 text-muted hover:text-ink">
              <X className="size-5" aria-hidden />
            </button>
          </div>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted">{t("dash.media.type")}</dt>
            <dd dir="ltr" className="text-end">{item.mime}</dd>
            <dt className="text-muted">{t("dash.media.size")}</dt>
            <dd className="text-end tabular-nums">{formatBytes(item.size, locale)}</dd>
            {item.width && item.height ? (
              <>
                <dt className="text-muted">{t("dash.media.dimensions")}</dt>
                <dd className="text-end tabular-nums" dir="ltr">
                  {item.width} × {item.height}
                </dd>
              </>
            ) : null}
            {item.duration ? (
              <>
                <dt className="text-muted">{t("dash.media.duration")}</dt>
                <dd className="text-end tabular-nums">{formatDuration(item.duration)}</dd>
              </>
            ) : null}
          </dl>
          <div>
            <label htmlFor={`alt-${item.id}`} className="mb-1.5 block text-sm font-medium">
              {t("dash.media.alt")}
            </label>
            <Textarea id={`alt-${item.id}`} value={alt} onChange={(e) => setAlt(e.target.value)} maxLength={1500} rows={3} dir="auto" disabled={!canManage} placeholder={t("dash.media.altPlaceholder")} className="min-h-20" />
            <p className="mt-1 text-xs text-muted">{t("dash.media.altHint")}</p>
          </div>
          {canManage ? (
            <div>
              <label htmlFor={`folder-${item.id}`} className="mb-1.5 block text-sm font-medium">
                {t("dash.media.folder")}
              </label>
              <Select id={`folder-${item.id}`} value={folderId} onChange={(e) => setFolderId(e.target.value)}>
                <option value="">{t("dash.media.root")}</option>
                {folders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </Select>
            </div>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {error}
            </p>
          ) : status ? (
            <p role="status" className="text-sm text-emerald-700 dark:text-emerald-400">
              {status}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {canManage ? (
              <Button
                size="sm"
                disabled={pending}
                onClick={() =>
                  startTransition(async () => {
                    const folder = folderId ? Number(folderId) : null;
                    const r = await updateMediaAction({ workspaceId, mediaId: item.id, altText: alt, folderId: folder });
                    if (r.ok) {
                      setError(null);
                      setStatus(t("dash.media.saved"));
                      onSaved({ altText: alt.trim(), folderId: folder });
                    } else setError(r.error ?? t("dash.media.err.storage"));
                  })
                }
              >
                {t("dash.media.save")}
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void navigator.clipboard?.writeText(item.url).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
              {copied ? t("ui.copied") : t("dash.media.copyUrl")}
            </Button>
            {canManage ? (
              <Button
                variant="danger"
                size="sm"
                disabled={locked || pending}
                title={locked ? t("dash.media.inUse") : undefined}
                onClick={() => {
                  if (window.confirm(t("dash.media.deleteConfirm", { n: 1 }))) onDelete();
                }}
              >
                {locked ? <Lock aria-hidden /> : <Trash2 aria-hidden />}
                {t("dash.media.delete")}
              </Button>
            ) : null}
          </div>
          {locked ? <p className="text-xs text-amber-700 dark:text-amber-400">{t("dash.media.lockedHint")}</p> : null}
        </div>
      </div>
    </dialog>
  );
}
