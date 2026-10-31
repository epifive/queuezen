"use server";

import { createApprovalLink, decidePost, deleteApprovalLink, revokeApprovalLink, type Decision } from "@/lib/approvals";
import { guardWorkspace } from "@/lib/dashboard";
import { getT } from "@/lib/i18n/server";
import { addPostComment, getPost } from "@/lib/posts";
import { rateLimit } from "@/lib/rate-limit";
import { getSettings } from "@/lib/settings";
import { absoluteUrl } from "@/lib/site";
import { updateWorkspace } from "@/lib/workspaces";
import { parseLocalDateTime } from "@/social/normalize";
import type { FormState } from "../types";
import { idOf, ids, intOf, str } from "./helpers";

/** Approve or send back a post waiting for approval (approvers, admins, owner), with a comment. */
export async function decideApprovalAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const guard = await guardWorkspace(formData.get("wid"), { capability: "approve" });
  if (!guard.ok) return { error: guard.error };
  const t = await getT();
  const decision = str(formData.get("decision")) as Decision;
  if (decision !== "approved" && decision !== "rejected") return { error: t("dash.approvals.err.state") };
  const result = await decidePost(guard.workspace, idOf(formData.get("post_id")), decision, { userId: guard.user.id, name: guard.user.name, role: guard.role }, str(formData.get("comment")));
  if (!result.ok) {
    const key = { not_found: "dash.approvals.err.notFound", forbidden: "dash.team.err.role", state: "dash.approvals.err.state", quota: "dash.approvals.err.quota", comment: "dash.approvals.err.comment" } as const;
    return { error: t(key[result.error]) };
  }
  return { success: t(decision === "approved" ? (result.status === "scheduled" ? "dash.approvals.approvedScheduled" : "dash.approvals.approvedReady") : "dash.approvals.rejected") };
}

/** Internal note on a post (any member who can comment: approvers, editors, admins, owner). */
export async function addCommentAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const guard = await guardWorkspace(formData.get("wid"), { capability: "comment" });
  if (!guard.ok) return { error: guard.error };
  const t = await getT();
  const body = str(formData.get("body")).trim();
  if (!body || body.length > 5000) return { error: t("dash.comments.err.body") };
  if (!rateLimit(`comment:${guard.user.id}`, 60, 60 * 60_000)) return { error: t("dash.comments.err.rate") };
  const post = await getPost(guard.workspace.id, idOf(formData.get("post_id")));
  if (!post) return { error: t("dash.approvals.err.notFound") };
  await addPostComment(post, { userId: guard.user.id, name: guard.user.name }, "note", body);
  return { success: t("dash.comments.added") };
}

export type LinkFormState = FormState & { link?: string };

/** Creates a client approval link (admins, owner, approvers can share posts with a client). */
export async function createApprovalLinkAction(_prev: LinkFormState, formData: FormData): Promise<LinkFormState> {
  const guard = await guardWorkspace(formData.get("wid"), { capability: "approve" });
  if (!guard.ok) return { error: guard.error };
  const t = await getT();
  if (!rateLimit(`approval-link:${guard.user.id}`, 30, 60 * 60_000)) return { error: t("dash.approvals.err.rate") };
  const scope = str(formData.get("scope"));
  const days = intOf(formData.get("expires_days"), 1, 90);
  if (!Number.isFinite(days)) return { error: t("dash.approvals.err.expiry") };
  const tz = guard.workspace.timezone;
  const toIso = (v: string, endOfDay: boolean) => {
    if (!v) return null;
    const ms = parseLocalDateTime(/T/.test(v) ? v : `${v}T${endOfDay ? "23:59" : "00:00"}`, tz);
    return Number.isFinite(ms) ? new Date(ms + (endOfDay ? 60_000 : 0)).toISOString() : null;
  };
  const result = await createApprovalLink(guard.workspace, {
    label: str(formData.get("label")),
    postIds: scope === "posts" ? ids(formData.getAll("post_ids")) : null,
    rangeFrom: scope === "range" ? toIso(str(formData.get("from")), false) : null,
    rangeTo: scope === "range" ? toIso(str(formData.get("to")), true) : null,
    expiresInDays: days,
    password: str(formData.get("password")),
    createdBy: guard.user.id,
  });
  if (!result.ok) {
    const key = { posts: "dash.approvals.err.posts", range: "dash.approvals.err.range", limit: "dash.approvals.err.limit", password: "dash.approvals.err.password" } as const;
    return { error: t(key[result.error]) };
  }
  const link = absoluteUrl(await getSettings(), `/approve/${result.token}`);
  return { success: t("dash.approvals.linkCreated"), link };
}

export async function revokeApprovalLinkAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const guard = await guardWorkspace(formData.get("wid"), { capability: "approve" });
  if (!guard.ok) return { error: guard.error };
  const t = await getT();
  const id = idOf(formData.get("link_id"));
  const ok = str(formData.get("delete")) === "1" ? await deleteApprovalLink(guard.workspace.id, id) : await revokeApprovalLink(guard.workspace.id, id);
  return ok ? { success: t("dash.approvals.linkRevoked") } : { error: t("dash.approvals.err.notFound") };
}

/** Client branding of approval links (white label): company name, logo URL, colour. Admins and owner. */
export async function saveBrandingAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const guard = await guardWorkspace(formData.get("wid"), { capability: "settings.manage" });
  if (!guard.ok) return { error: guard.error };
  const t = await getT();
  const logo = str(formData.get("logo")).trim();
  if (logo && !/^https:\/\/[^\s"'<>]+$/i.test(logo)) return { error: t("dash.branding.err.logo") };
  const color = str(formData.get("color")).trim();
  if (color && !/^#[0-9a-f]{6}$/i.test(color)) return { error: t("dash.branding.err.color") };
  await updateWorkspace(guard.workspace.id, {
    settings: { ...guard.workspace.settings, branding: { companyName: str(formData.get("company")).trim().slice(0, 120), logo: logo.slice(0, 500), color: formData.get("use_color") === "on" ? color : "" } },
  });
  return { success: t("dash.branding.saved") };
}
