"use server";

import { guardWorkspace } from "@/lib/dashboard";
import { getT } from "@/lib/i18n/server";
import { mediaErrorMessage } from "@/lib/media/http";
import { createFolder, deleteFolder, deleteMedia, listFolders, listMedia, mediaInUse, renameFolder, updateMediaItem, type MediaFolder } from "@/lib/media/service";
import type { MediaKind } from "@/social/types";
import type { FormState } from "../types";
import { idOf, ids, str } from "./helpers";

/** Media library: folders, alt text, moving and deleting items, and the composer's picker. */

export interface LibraryItem {
  id: number;
  kind: MediaKind;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  duration: number | null;
  altText: string;
  url: string;
  filename: string;
  folderId: number | null;
  createdAt: string;
}

/** A page of the library for the composer's picker (JSON). */
export async function libraryPage(
  workspaceId: number,
  filter: { folderId?: number | null; q?: string; kind?: "image" | "video" | ""; offset?: number },
): Promise<{ items: LibraryItem[]; total: number; folders: MediaFolder[] }> {
  const guard = await guardWorkspace(workspaceId, { allowInDemo: true });
  if (!guard.ok) return { items: [], total: 0, folders: [] };
  const [page, folders] = await Promise.all([
    listMedia(guard.workspace.id, { folderId: filter.folderId === undefined ? undefined : filter.folderId, q: filter.q, kind: filter.kind, limit: 48, offset: Math.max(0, filter.offset ?? 0) }),
    listFolders(guard.workspace.id),
  ]);
  return {
    total: page.total,
    folders,
    items: page.items.map((m) => ({ id: m.id, kind: m.kind, mime: m.mime, size: m.size, width: m.width, height: m.height, duration: m.duration, altText: m.altText, url: m.url, filename: m.filename, folderId: m.folderId, createdAt: m.createdAt })),
  };
}

export async function createFolderAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const guard = await guardWorkspace(formData.get("wid"), { capability: "media.manage" });
  if (!guard.ok) return { error: guard.error };
  const t = await getT();
  try {
    await createFolder(guard.workspace.id, str(formData.get("name")));
  } catch (error) {
    return { error: await mediaErrorMessage(error) };
  }
  return { success: t("dash.media.folderCreated") };
}

export async function renameFolderAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const guard = await guardWorkspace(formData.get("wid"), { capability: "media.manage" });
  if (!guard.ok) return { error: guard.error };
  const t = await getT();
  const ok = await renameFolder(guard.workspace.id, idOf(formData.get("folder")), str(formData.get("name")));
  return ok ? { success: t("dash.media.folderRenamed") } : { error: t("dash.media.err.folder") };
}

export async function deleteFolderAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const guard = await guardWorkspace(formData.get("wid"), { capability: "media.manage" });
  if (!guard.ok) return { error: guard.error };
  const t = await getT();
  const ok = await deleteFolder(guard.workspace.id, idOf(formData.get("folder")));
  return ok ? { success: t("dash.media.folderDeleted") } : { error: t("dash.media.err.folder") };
}

export async function updateMediaAction(input: { workspaceId: number; mediaId: number; altText?: string; folderId?: number | null; filename?: string }): Promise<{ ok: boolean; error?: string }> {
  const guard = await guardWorkspace(input.workspaceId, { capability: "media.manage" });
  if (!guard.ok) return { ok: false, error: guard.error };
  try {
    const ok = await updateMediaItem(guard.workspace.id, input.mediaId, { altText: input.altText, folderId: input.folderId, filename: input.filename });
    return ok ? { ok: true } : { ok: false, error: (await getT())("dash.media.err.not_found") };
  } catch (error) {
    return { ok: false, error: await mediaErrorMessage(error) };
  }
}

export async function moveMediaAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const guard = await guardWorkspace(formData.get("wid"), { capability: "media.manage" });
  if (!guard.ok) return { error: guard.error };
  const t = await getT();
  const mediaIds = ids(formData.getAll("media"));
  if (!mediaIds.length) return { error: t("dash.media.err.select") };
  const folderValue = str(formData.get("folder"));
  const folderId = folderValue ? idOf(formData.get("folder")) : null;
  try {
    for (const id of mediaIds) await updateMediaItem(guard.workspace.id, id, { folderId });
  } catch (error) {
    return { error: await mediaErrorMessage(error) };
  }
  return { success: t("dash.media.moved", { n: mediaIds.length }) };
}

export async function deleteMediaAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const guard = await guardWorkspace(formData.get("wid"), { capability: "media.manage" });
  if (!guard.ok) return { error: guard.error };
  const t = await getT();
  const mediaIds = ids(formData.getAll("media"));
  if (!mediaIds.length) return { error: t("dash.media.err.select") };
  const result = await deleteMedia(guard.workspace.id, mediaIds);
  if (result.blocked.length && !result.deleted) return { error: t("dash.media.err.in_use") };
  if (result.blocked.length) return { success: t("dash.media.deletedSome", { n: result.deleted, blocked: result.blocked.length }) };
  return { success: t("dash.media.deleted", { n: result.deleted }) };
}

/** Which of these items are used by upcoming posts (the library shows a lock). */
export async function mediaUsage(workspaceId: number, mediaIds: number[]): Promise<Record<number, number[]>> {
  const guard = await guardWorkspace(workspaceId, { allowInDemo: true });
  if (!guard.ok) return {};
  return Object.fromEntries(await mediaInUse(guard.workspace.id, mediaIds));
}
