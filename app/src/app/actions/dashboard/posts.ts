"use server";

import { redirect } from "next/navigation";
import { after } from "next/server";
import { getWorkspaceChannels } from "@/lib/channels";
import { guardWorkspace } from "@/lib/dashboard";
import { importCsv, type CsvImportReport } from "@/lib/engine/csv-import";
import { deleteRemoteTarget, failedTargetIds, nextFreeSlot, publishTargetsNow, reschedulePost, retryTargets } from "@/lib/engine/targets";
import { notifyApprovalRequested } from "@/lib/approvals";
import { formatNumber } from "@/lib/dash-format";
import { getT } from "@/lib/i18n/server";
import type { Translator } from "@/lib/i18n/messages";
import { getMediaItems } from "@/lib/media/service";
import { deletePost, getPost, savePost, type SaveIntent, type SavePostResult } from "@/lib/posts";
import { rateLimit } from "@/lib/rate-limit";
import { shortenUrl } from "@/lib/shortlinks";
import { canPublishDirectly, normalizeLabels, normalizeOverride, normalizePostContent, parseLocalDateTime } from "@/social/normalize";
import type { ContentOverride, MediaInfo, PostContent, PostStatus, ValidationResult } from "@/social/types";
import type { FormState } from "../types";
import { idOf, ids, str } from "./helpers";

/**
 * Posts: the composer (save draft, submit, schedule, add to queue, post now, autosave), calendar
 * drag, the posts list bulk actions, the post page (retry, delete on the network) and CSV import.
 * The demo lets visitors use the composer and calendar (publishing is simulated there); file
 * imports stay blocked.
 */

export type ComposerIntent = "draft" | "submit" | "schedule" | "queue" | "publish_now";

export interface ComposerSaveInput {
  workspaceId: number;
  postId?: number | null;
  content: PostContent;
  /** channel id → override of that channel's tab. */
  overrides: Record<number, ContentOverride>;
  channelIds: number[];
  labels: string[];
  /** "YYYY-MM-DDTHH:MM" in the workspace's time zone (schedule). */
  scheduledLocal?: string | null;
  intent: ComposerIntent;
  /** Background autosave: quieter, never leaves the draft state. */
  autosave?: boolean;
}

export type ComposerSaveResult =
  | { ok: true; postId: number; status: PostStatus; scheduledAt: string | null; message: string }
  | { ok: false; error: string; issues?: Record<number, ValidationResult>; postId?: number };

function saveErrorText(t: Translator, result: Exclude<SavePostResult, { ok: true }>, locale = "en"): string {
  switch (result.code) {
    case "not_found":
      return t("dash.compose.err.notFound");
    case "forbidden":
      return t("dash.compose.err.forbidden");
    case "not_editable":
      return t("dash.compose.err.notEditable");
    case "no_channels":
      return t("dash.compose.err.noChannels");
    case "date_required":
      return t("dash.compose.err.date");
    case "date_past":
      return t("dash.compose.err.datePast");
    case "approval_required":
      return t("dash.compose.err.approval");
    case "invalid":
      return t("dash.compose.err.invalid");
    case "quota":
      return result.reason === "x"
        ? result.limit
          ? t("dash.compose.err.quotaX", { limit: formatNumber(result.limit, locale) })
          : t("dash.compose.err.noX")
        : t("dash.compose.err.quota", { limit: formatNumber(result.limit, locale) });
  }
}

export async function saveComposerPost(input: ComposerSaveInput): Promise<ComposerSaveResult> {
  const guard = await guardWorkspace(input.workspaceId, { capability: "post.create", allowInDemo: true });
  if (!guard.ok) return { ok: false, error: guard.error };
  const t = await getT();
  if (!rateLimit(`compose:${guard.user.id}`, input.autosave ? 120 : 60, 60_000)) return { ok: false, error: t("dash.compose.err.rate") };
  const { workspace, role, user } = guard;

  const wantsPublish = input.intent === "schedule" || input.intent === "queue" || input.intent === "publish_now";
  if (wantsPublish && !canPublishDirectly(role, workspace.settings)) return { ok: false, error: t("dash.compose.err.approval") };

  const channels = await getWorkspaceChannels(workspace.id);
  const channelIds = [...new Set(input.channelIds)].filter((id) => channels.some((c) => c.id === id));
  let scheduledAt: string | null = null;
  if (input.intent === "queue") {
    const selected = channels.filter((c) => channelIds.includes(c.id));
    if (!selected.length) return { ok: false, error: t("dash.compose.err.noChannels") };
    scheduledAt = await nextFreeSlot(selected, workspace.timezone);
    if (!scheduledAt) return { ok: false, error: t("dash.compose.err.noSlots") };
  } else if (input.scheduledLocal) {
    const ms = parseLocalDateTime(input.scheduledLocal, workspace.timezone);
    if (!Number.isFinite(ms)) return { ok: false, error: t("dash.compose.err.date") };
    scheduledAt = new Date(ms).toISOString();
  }

  const intent: SaveIntent = input.intent === "queue" ? "schedule" : input.intent;
  const overrides: Record<number, unknown> = {};
  for (const id of channelIds) overrides[id] = normalizeOverride(input.overrides?.[id] ?? {});
  const result = await savePost({
    workspace,
    actor: { userId: user.id, role },
    postId: input.postId ?? undefined,
    content: normalizePostContent(input.content),
    overrides,
    channelIds,
    labels: normalizeLabels(input.labels),
    scheduledAt: intent === "draft" || intent === "submit" ? (scheduledAt ?? (input.scheduledLocal === "" ? null : undefined)) : scheduledAt,
    intent,
  });
  if (!result.ok) {
    return {
      ok: false,
      error: saveErrorText(t, result),
      issues: result.code === "invalid" ? Object.fromEntries(result.issues) : undefined,
      postId: input.postId ?? undefined,
    };
  }
  const post = result.post;
  if (intent === "submit") {
    after(() => notifyApprovalRequested(workspace, post, { userId: user.id, name: user.name }));
  }
  if (intent === "publish_now") {
    const targetIds = post.targets.filter((tg) => tg.status === "scheduled").map((tg) => tg.id);
    after(() => publishTargetsNow(targetIds));
  }
  const message =
    input.intent === "draft"
      ? input.autosave
        ? t("dash.compose.autosaved")
        : t("dash.compose.savedDraft")
      : input.intent === "submit"
        ? t("dash.compose.submitted")
        : input.intent === "publish_now"
          ? t("dash.compose.publishing")
          : t("dash.compose.scheduled");
  return { ok: true, postId: post.id, status: post.status, scheduledAt: post.scheduledAt, message };
}

/** Media facts of library items for the composer's validation and previews. */
export async function composerMedia(workspaceId: number, mediaIds: number[]): Promise<Array<MediaInfo & { filename: string }>> {
  const guard = await guardWorkspace(workspaceId, { allowInDemo: true });
  if (!guard.ok) return [];
  const items = await getMediaItems(guard.workspace.id, mediaIds.slice(0, 100));
  return items.map((m) => ({ id: m.id, kind: m.kind, mime: m.mime, size: m.size, width: m.width, height: m.height, duration: m.duration, altText: m.altText, url: m.url, filename: m.filename }));
}

/** The next free queue time of a set of channels (shown next to "Add to queue"). */
export async function previewQueueSlot(workspaceId: number, channelIds: number[]): Promise<string | null> {
  const guard = await guardWorkspace(workspaceId, { allowInDemo: true });
  if (!guard.ok) return null;
  const channels = (await getWorkspaceChannels(guard.workspace.id)).filter((c) => channelIds.includes(c.id));
  return channels.length ? nextFreeSlot(channels, guard.workspace.timezone) : null;
}

/** Replaces a link with a tracked short link of the workspace (/l/<code>). */
export async function shortenLinkAction(workspaceId: number, url: string): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const guard = await guardWorkspace(workspaceId, { capability: "post.create", allowInDemo: true });
  if (!guard.ok) return { ok: false, error: guard.error };
  const t = await getT();
  if (!rateLimit(`shorten:${guard.user.id}`, 30, 60_000)) return { ok: false, error: t("dash.compose.err.rate") };
  const result = await shortenUrl(guard.workspace.id, url, null, { title: "" });
  if (!result.code) return { ok: false, error: t("dash.compose.err.shorten") };
  return { ok: true, url: result.shortUrl };
}

// ── Calendar ──

export async function reschedulePostAction(workspaceId: number, postId: number, whenIso: string): Promise<{ ok: boolean; error?: string }> {
  const guard = await guardWorkspace(workspaceId, { capability: "post.create", allowInDemo: true });
  if (!guard.ok) return { ok: false, error: guard.error };
  const t = await getT();
  const post = await getPost(guard.workspace.id, postId);
  if (post?.status === "scheduled" && !canPublishDirectly(guard.role, guard.workspace.settings)) return { ok: false, error: t("dash.compose.err.approval") };
  const result = await reschedulePost(guard.workspace.id, postId, whenIso);
  if (result.ok) return { ok: true };
  return { ok: false, error: result.error === "date_past" ? t("dash.compose.err.datePast") : result.error === "state" ? t("dash.calendar.err.locked") : t("dash.compose.err.notFound") };
}

// ── Posts list (bulk) ──

export async function deletePostsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const guard = await guardWorkspace(formData.get("wid"), { capability: "post.create", allowInDemo: true });
  if (!guard.ok) return { error: guard.error };
  const t = await getT();
  const postIds = ids(formData.getAll("post")).slice(0, 200);
  if (!postIds.length) return { error: t("dash.posts.err.select") };
  let deleted = 0;
  for (const id of postIds) if (await deletePost(guard.workspace, id)) deleted += 1;
  if (!deleted) return { error: t("dash.posts.err.deleteNone") };
  return { success: t("dash.posts.deleted", { n: deleted }) };
}

export async function retryPostsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const guard = await guardWorkspace(formData.get("wid"), { capability: "post.publish", allowInDemo: true });
  if (!guard.ok) return { error: guard.error };
  const t = await getT();
  const postIds = ids(formData.getAll("post")).slice(0, 200);
  const targetIds = ids(formData.getAll("target"));
  const toRetry = [...targetIds, ...(await failedTargetIds(guard.workspace.id, postIds))];
  if (!toRetry.length) return { error: t("dash.posts.err.noFailed") };
  const retried = await retryTargets(guard.workspace.id, toRetry);
  if (!retried.length) return { error: t("dash.posts.err.noFailed") };
  after(() => publishTargetsNow(retried));
  return { success: t("dash.posts.retrying", { n: retried.length }) };
}

export async function reschedulePostsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const guard = await guardWorkspace(formData.get("wid"), { capability: "post.create", allowInDemo: true });
  if (!guard.ok) return { error: guard.error };
  const t = await getT();
  const postIds = ids(formData.getAll("post")).slice(0, 200);
  if (!postIds.length) return { error: t("dash.posts.err.select") };
  const ms = parseLocalDateTime(str(formData.get("when")), guard.workspace.timezone);
  if (!Number.isFinite(ms)) return { error: t("dash.compose.err.date") };
  const direct = canPublishDirectly(guard.role, guard.workspace.settings);
  let moved = 0;
  let past = false;
  for (const id of postIds) {
    if (!direct && (await getPost(guard.workspace.id, id))?.status === "scheduled") continue;
    const r = await reschedulePost(guard.workspace.id, id, new Date(ms).toISOString());
    if (r.ok) moved += 1;
    else if (r.error === "date_past") past = true;
  }
  if (!moved) return { error: past ? t("dash.compose.err.datePast") : t("dash.posts.err.rescheduleNone") };
  return { success: t("dash.posts.rescheduled", { n: moved }) };
}

/** The posts list's bulk bar: one form, the clicked button's "op" picks the action. */
export async function bulkPostsAction(prev: FormState, formData: FormData): Promise<FormState> {
  const op = str(formData.get("op"));
  if (op === "delete") return deletePostsAction(prev, formData);
  if (op === "retry") return retryPostsAction(prev, formData);
  if (op === "reschedule") return reschedulePostsAction(prev, formData);
  return { error: (await getT())("dash.posts.err.select") };
}

// ── Post page ──

/** Deletes one post from Queuezen (post page) and goes back to the list. */
export async function deletePostAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const guard = await guardWorkspace(formData.get("wid"), { capability: "post.create", allowInDemo: true });
  if (!guard.ok) return { error: guard.error };
  const t = await getT();
  if (!(await deletePost(guard.workspace, idOf(formData.get("post"))))) return { error: t("dash.posts.err.deleteNone") };
  redirect(`/dashboard/w/${guard.workspace.id}/posts`);
}

export async function retryTargetAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const guard = await guardWorkspace(formData.get("wid"), { capability: "post.publish", allowInDemo: true });
  if (!guard.ok) return { error: guard.error };
  const t = await getT();
  const retried = await retryTargets(guard.workspace.id, [idOf(formData.get("target"))]);
  if (!retried.length) return { error: t("dash.posts.err.noFailed") };
  after(() => publishTargetsNow(retried));
  return { success: t("dash.posts.retrying", { n: 1 }) };
}

export async function deleteRemoteAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const guard = await guardWorkspace(formData.get("wid"), { capability: "post.publish", allowInDemo: true });
  if (!guard.ok) return { error: guard.error };
  const t = await getT();
  const result = await deleteRemoteTarget(guard.workspace.id, idOf(formData.get("target")));
  if (result.ok) return { success: t("dash.post.remoteDeleted") };
  if (result.error === "network") return { error: t("dash.post.err.remote", { error: result.message ?? "" }) };
  if (result.error === "channel") return { error: t("dash.post.err.channel") };
  if (result.error === "driver") return { error: t("dash.post.err.driver") };
  if (result.error === "unsupported") return { error: t("dash.post.err.unsupported") };
  return { error: t("dash.post.err.state") };
}

/** Copies a post into a new draft and returns its id (the client opens it in the composer). */
export async function duplicatePostAction(workspaceId: number, postId: number): Promise<{ ok: true; postId: number } | { ok: false; error: string }> {
  const guard = await guardWorkspace(workspaceId, { capability: "post.create", allowInDemo: true });
  if (!guard.ok) return { ok: false, error: guard.error };
  const t = await getT();
  const post = await getPost(guard.workspace.id, postId);
  if (!post) return { ok: false, error: t("dash.compose.err.notFound") };
  const result = await savePost({
    workspace: guard.workspace,
    actor: { userId: guard.user.id, role: guard.role },
    content: post.content,
    overrides: Object.fromEntries(post.targets.filter((tg) => tg.status !== "cancelled").map((tg) => [tg.channelId, tg.override])),
    channelIds: post.targets.filter((tg) => tg.status !== "cancelled").map((tg) => tg.channelId),
    labels: post.labels,
    scheduledAt: null,
    intent: "draft",
  });
  return result.ok ? { ok: true, postId: result.post.id } : { ok: false, error: saveErrorText(t, result) };
}

// ── CSV import ──

export async function importCsvAction(workspaceId: number, csv: string, dryRun: boolean): Promise<{ ok: true; report: CsvImportReport } | { ok: false; error: string }> {
  const guard = await guardWorkspace(workspaceId, { capability: "post.create", allowInDemo: dryRun });
  if (!guard.ok) return { ok: false, error: guard.error };
  const t = await getT();
  if (!rateLimit(`csv:${guard.user.id}`, dryRun ? 30 : 6, 60_000)) return { ok: false, error: t("dash.compose.err.rate") };
  const report = await importCsv({ workspace: guard.workspace, actor: { userId: guard.user.id, role: guard.role }, csv, dryRun });
  return { ok: true, report };
}
