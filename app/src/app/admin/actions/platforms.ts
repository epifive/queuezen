"use server";

import { revalidatePath } from "next/cache";
import { guardAdmin } from "@/lib/admin";
import { testPlatformApp } from "@/lib/platforms/app-test";
import { getDriverContext, setSimulatedFlag } from "@/lib/platforms/runtime";
import { SETUP_GUIDES } from "@/lib/platforms/setup-guide";
import { SETTING_DEFAULTS, updateSettings, type Settings } from "@/lib/settings";
import { isPlatform } from "@/social/normalize";
import { platformName } from "@/social/format";
import type { FormState } from "@/app/actions/types";

/** Admin → Platforms: the operator's app credentials per network, the Test button and the simulated switch. */

export async function savePlatformAppAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const guard = await guardAdmin();
  if (!guard.ok) return { error: guard.error };
  const platform = String(formData.get("platform") ?? "");
  if (!isPlatform(platform) || !SETUP_GUIDES[platform]) return { error: "Unknown platform." };
  const values: Partial<Record<keyof Settings, unknown>> = {};
  for (const field of SETUP_GUIDES[platform]!.fields) {
    const raw = String(formData.get(field.key) ?? "").trim();
    if (field.secret) {
      if (formData.get(`${field.key}__clear`) === "on") values[field.key] = "";
      else if (raw) values[field.key] = raw;
      continue;
    }
    if (typeof SETTING_DEFAULTS[field.key] === "number") {
      const n = Number(raw || 0);
      if (!Number.isFinite(n) || n < 0) return { error: `${field.label} must be a positive number.` };
      values[field.key] = n;
      continue;
    }
    if (raw.length > 500) return { error: `${field.label} is too long.` };
    if (/\s/.test(raw)) return { error: `${field.label} can't contain spaces.` };
    if (field.key === "linkedin_api_version" && raw && !/^\d{6}$/.test(raw)) return { error: "The LinkedIn version is a month like 202610." };
    values[field.key] = raw;
  }
  await updateSettings(values as Partial<Settings>);
  revalidatePath("/admin/platforms");
  return { success: `${platformName(platform)} app saved.` };
}

export async function testPlatformAppAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const guard = await guardAdmin({ allowInDemo: true });
  if (!guard.ok) return { error: guard.error };
  const platform = String(formData.get("platform") ?? "");
  if (!isPlatform(platform)) return { error: "Unknown platform." };
  const result = await testPlatformApp(await getDriverContext(platform), platform);
  return result.ok ? { success: result.message } : { error: result.message };
}

export async function setSimulatedPlatformsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const guard = await guardAdmin();
  if (!guard.ok) return { error: guard.error };
  const on = formData.get("platforms_simulated") === "on";
  await updateSettings({ platforms_simulated: on });
  setSimulatedFlag(on);
  revalidatePath("/admin/platforms");
  return { success: on ? "Simulated platforms are on: every network is faked (testing only)." : "Simulated platforms are off: the real networks are used." };
}
