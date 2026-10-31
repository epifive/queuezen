"use server";

import { cookies, headers } from "next/headers";
import type { FormState } from "@/app/actions/types";
import { DEMO_MESSAGE } from "@/lib/admin";
import { APPROVAL_COOKIE_PREFIX, checkLinkPassword, decidePost, findApprovalLink, isUnlocked, linkCovers, unlockValue, type Decision } from "@/lib/approvals";
import { isDemoMode } from "@/lib/config";
import { getT } from "@/lib/i18n/server";
import { getPost } from "@/lib/posts";
import { clientIp, rateLimit } from "@/lib/rate-limit";

async function isHttps(): Promise<boolean> {
  const h = await headers();
  const proto = h.get("x-forwarded-proto");
  if (proto) return proto.split(",")[0].trim() === "https";
  return (h.get("origin") ?? h.get("referer") ?? "").startsWith("https://");
}

const str = (v: FormDataEntryValue | null) => (typeof v === "string" ? v : "");

/** Password of a protected client approval link: remembered in a cookie for this link only. */
export async function unlockApprovalAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const t = await getT();
  const ip = await clientIp();
  if (!rateLimit(`approve-unlock:${ip}`, 10, 10 * 60_000)) return { error: t("approve.err.rate") };
  const token = str(formData.get("token"));
  const resolved = await findApprovalLink(token);
  if (!resolved) return { error: t("approve.err.invalid") };
  if (!(await checkLinkPassword(resolved, str(formData.get("password"))))) return { error: t("approve.err.password") };
  const jar = await cookies();
  jar.set(`${APPROVAL_COOKIE_PREFIX}${resolved.link.id}`, await unlockValue(resolved), {
    httpOnly: true,
    sameSite: "lax",
    secure: await isHttps(),
    path: `/approve/${token}`,
    maxAge: Math.max(60, Math.floor((Date.parse(resolved.link.expiresAt) - Date.now()) / 1000)),
  });
  return { success: "ok" };
}

/** A client approves or sends back a post through the link (no account). */
export async function guestDecisionAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const t = await getT();
  if (isDemoMode()) return { error: DEMO_MESSAGE };
  const ip = await clientIp();
  if (!rateLimit(`approve-decide:${ip}`, 30, 10 * 60_000)) return { error: t("approve.err.rate") };
  const token = str(formData.get("token"));
  const resolved = await findApprovalLink(token);
  if (!resolved) return { error: t("approve.err.invalid") };
  const jar = await cookies();
  if (!(await isUnlocked(resolved, jar.get(`${APPROVAL_COOKIE_PREFIX}${resolved.link.id}`)?.value))) return { error: t("approve.err.locked") };
  const postId = Number(str(formData.get("post_id")));
  const post = await getPost(resolved.workspace.id, postId);
  if (!post || !linkCovers(resolved.link, post)) return { error: t("approve.err.notFound") };
  const decision = str(formData.get("decision")) as Decision;
  if (decision !== "approved" && decision !== "rejected") return { error: t("approve.err.state") };
  const name = str(formData.get("name")).replace(/\s+/g, " ").trim().slice(0, 80) || t("approve.guestName");
  const result = await decidePost(resolved.workspace, post.id, decision, { userId: null, name, role: "guest" }, str(formData.get("comment")));
  if (!result.ok) {
    const key = { not_found: "approve.err.notFound", forbidden: "approve.err.state", state: "approve.err.state", quota: "approve.err.quota", comment: "approve.err.comment" } as const;
    return { error: t(key[result.error]) };
  }
  return { success: t(decision === "approved" ? "approve.approved" : "approve.rejected") };
}
