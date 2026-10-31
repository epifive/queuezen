"use server";

import { getChannel, getWorkspaceChannels, setQueueSlots } from "@/lib/channels";
import { guardWorkspace } from "@/lib/dashboard";
import { setQueuePaused, shuffleQueue, swapPostTimes } from "@/lib/engine/targets";
import { getT } from "@/lib/i18n/server";
import { rateLimit } from "@/lib/rate-limit";
import { updateWorkspace } from "@/lib/workspaces";
import { normalizeQueueSlots } from "@/social/normalize";
import type { QueueSlot } from "@/social/types";
import type { FormState } from "../types";
import { idOf } from "./helpers";

/**
 * Queue page: weekly posting times per channel, pausing a channel's queue, reordering (swap two
 * posts' times) and shuffling. Times are wall-clock times in the workspace's time zone.
 */

export async function saveQueueSlotsAction(input: { workspaceId: number; channelId: number; slots: QueueSlot[]; applyToAll?: boolean }): Promise<{ ok: boolean; error?: string; message?: string }> {
  const guard = await guardWorkspace(input.workspaceId, { capability: "post.publish", allowInDemo: true });
  if (!guard.ok) return { ok: false, error: guard.error };
  const t = await getT();
  const slots = normalizeQueueSlots(input.slots);
  if (input.applyToAll) {
    const channels = await getWorkspaceChannels(guard.workspace.id);
    for (const c of channels) await setQueueSlots(c.id, slots);
    // Channels connected later start with these times too.
    await updateWorkspace(guard.workspace.id, { settings: { ...guard.workspace.settings, defaultSlots: slots } });
    return { ok: true, message: t("dash.queue.savedAll", { n: channels.length }) };
  }
  const channel = await getChannel(guard.workspace.id, input.channelId);
  if (!channel) return { ok: false, error: t("dash.queue.err.channel") };
  await setQueueSlots(channel.id, slots);
  return { ok: true, message: t("dash.queue.saved") };
}

export async function toggleQueuePauseAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const guard = await guardWorkspace(formData.get("wid"), { capability: "post.publish", allowInDemo: true });
  if (!guard.ok) return { error: guard.error };
  const t = await getT();
  const paused = formData.get("paused") === "1";
  const ok = await setQueuePaused(guard.workspace.id, idOf(formData.get("channel")), paused);
  if (!ok) return { error: t("dash.queue.err.channel") };
  return { success: paused ? t("dash.queue.pausedMsg") : t("dash.queue.resumedMsg") };
}

export async function swapQueueAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const guard = await guardWorkspace(formData.get("wid"), { capability: "post.publish", allowInDemo: true });
  if (!guard.ok) return { error: guard.error };
  const t = await getT();
  if (!rateLimit(`queue:${guard.user.id}`, 60, 60_000)) return { error: t("dash.compose.err.rate") };
  const ok = await swapPostTimes(guard.workspace.id, idOf(formData.get("a")), idOf(formData.get("b")));
  return ok ? { success: t("dash.queue.swapped") } : { error: t("dash.queue.err.swap") };
}

export async function shuffleQueueAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const guard = await guardWorkspace(formData.get("wid"), { capability: "post.publish", allowInDemo: true });
  if (!guard.ok) return { error: guard.error };
  const t = await getT();
  if (!rateLimit(`queue:${guard.user.id}`, 60, 60_000)) return { error: t("dash.compose.err.rate") };
  const n = await shuffleQueue(guard.workspace.id, idOf(formData.get("channel")));
  return n ? { success: t("dash.queue.shuffled", { n }) } : { error: t("dash.queue.err.shuffle") };
}
