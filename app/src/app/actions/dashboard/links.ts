"use server";

import { guardWorkspace } from "@/lib/dashboard";
import { getT } from "@/lib/i18n/server";
import { rateLimit } from "@/lib/rate-limit";
import { createShortLink, deleteShortLink, MAX_LINKS_PER_WORKSPACE, shortLinkUrl, updateShortLink } from "@/lib/shortlinks";
import type { FormState } from "../types";
import { idOf, str } from "./helpers";

export type LinkState = FormState & { shortUrl?: string };

const utmOf = (fd: FormData) => ({ source: str(fd.get("utm_source")), medium: str(fd.get("utm_medium")), campaign: str(fd.get("utm_campaign")), term: str(fd.get("utm_term")), content: str(fd.get("utm_content")) });

/** Create (or edit, with link_id) a tracked short link. Editors and up. */
export async function saveLinkAction(_prev: LinkState, formData: FormData): Promise<LinkState> {
  const guard = await guardWorkspace(formData.get("wid"), { capability: "post.create" });
  if (!guard.ok) return { error: guard.error };
  const t = await getT();
  const linkId = idOf(formData.get("link_id"));
  const input = { url: str(formData.get("url")), title: str(formData.get("title")), utm: utmOf(formData) };
  if (Number.isInteger(linkId) && linkId > 0) {
    const result = await updateShortLink(guard.workspace.id, linkId, input);
    if (!result.ok) return { error: t(result.error === "url" ? "dash.links.err.url" : "dash.links.err.notFound") };
    return { success: t("dash.links.saved") };
  }
  if (!rateLimit(`link-create:${guard.user.id}`, 120, 60 * 60_000)) return { error: t("dash.links.err.rate") };
  const result = await createShortLink(guard.workspace.id, input);
  if (!result.ok) return { error: result.error === "limit" ? t("dash.links.err.limit", { n: MAX_LINKS_PER_WORKSPACE }) : t("dash.links.err.url") };
  return { success: t("dash.links.created"), shortUrl: await shortLinkUrl(result.link.code) };
}

export async function deleteLinkAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const guard = await guardWorkspace(formData.get("wid"), { capability: "post.create" });
  if (!guard.ok) return { error: guard.error };
  const t = await getT();
  return (await deleteShortLink(guard.workspace.id, idOf(formData.get("link_id")))) ? { success: t("dash.links.deleted") } : { error: t("dash.links.err.notFound") };
}
