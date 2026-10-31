"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { guardAdmin } from "@/lib/admin";
import { getDb, now } from "@/lib/db";
import type { FormState } from "@/app/actions/types";

const money = z.coerce.number().min(0, "Prices can't be negative.").max(1_000_000).transform((v) => Math.round(v * 100));

const planSchema = z.object({
  name: z.string().trim().min(2, "Enter a plan name.").max(100),
  description: z.string().trim().max(255),
  price_monthly: money,
  price_yearly: money,
  features: z.string().max(5000),
  max_channels: z.coerce.number().int().min(0, "Channels: 0 or more.").max(100_000),
  max_scheduled_monthly: z.coerce.number().int().min(0, "Posts per month: 0 or more.").max(10_000_000),
  max_members: z.coerce.number().int().min(0, "Team members: 0 or more.").max(100_000),
  // 0 = no posting to X, -1 = unlimited.
  max_x_posts_monthly: z.coerce.number().int().min(-1, "Posts to X: -1 (unlimited), 0 (none) or more.").max(10_000_000),
  max_ai_monthly: z.coerce.number().int().min(0, "AI requests per month: 0 (unlimited) or more.").max(10_000_000),
  allow_ai: z.literal("on").optional().transform((v) => (v ? 1 : 0)),
  allow_rss: z.literal("on").optional().transform((v) => (v ? 1 : 0)),
  allow_api: z.literal("on").optional().transform((v) => (v ? 1 : 0)),
  allow_white_label: z.literal("on").optional().transform((v) => (v ? 1 : 0)),
  sort_order: z.coerce.number().int().min(0).max(999),
});

export async function savePlan(_prev: FormState, formData: FormData): Promise<FormState> {
  const rawId = Number(formData.get("id"));
  const planId = Number.isInteger(rawId) && rawId > 0 ? rawId : null;
  const guard = await guardAdmin();
  if (!guard.ok) return { error: guard.error };
  const parsed = planSchema.safeParse({
    name: formData.get("name"),
    description: formData.get("description") ?? "",
    price_monthly: formData.get("price_monthly") || 0,
    price_yearly: formData.get("price_yearly") || 0,
    features: formData.get("features") ?? "",
    max_channels: formData.get("max_channels"),
    max_scheduled_monthly: formData.get("max_scheduled_monthly"),
    max_members: formData.get("max_members"),
    max_x_posts_monthly: formData.get("max_x_posts_monthly"),
    max_ai_monthly: formData.get("max_ai_monthly") || 0,
    allow_ai: formData.get("allow_ai") ?? undefined,
    allow_rss: formData.get("allow_rss") ?? undefined,
    allow_api: formData.get("allow_api") ?? undefined,
    allow_white_label: formData.get("allow_white_label") ?? undefined,
    sort_order: formData.get("sort_order") || 0,
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const isFree = formData.get("is_free") === "on";
  if (!isFree && parsed.data.price_monthly === 0 && parsed.data.price_yearly === 0) {
    return { error: "Set a monthly or yearly price, or mark the plan as the free plan." };
  }

  const values = {
    ...parsed.data,
    description: parsed.data.description || null,
    price_monthly: isFree ? 0 : parsed.data.price_monthly,
    price_yearly: isFree ? 0 : parsed.data.price_yearly,
    remove_branding: formData.get("remove_branding") === "on" ? 1 : 0,
    is_free: isFree ? 1 : 0,
    is_active: formData.get("is_active") === "on" ? 1 : 0,
    is_featured: formData.get("is_featured") === "on" ? 1 : 0,
  };

  const db = await getDb();
  await db.transaction().execute(async (trx) => {
    // Only one plan can be the free plan (its limits apply to visitors and free users).
    if (isFree) {
      await trx
        .updateTable("plans")
        .set({ is_free: 0 })
        .$if(planId !== null, (qb) => qb.where("id", "!=", planId!))
        .execute();
    }
    if (planId) await trx.updateTable("plans").set(values).where("id", "=", planId).execute();
    else await trx.insertInto("plans").values({ ...values, created_at: now() }).execute();
  });
  redirect("/admin/plans?saved=1");
}

export async function deletePlan(planId: number): Promise<FormState> {
  const guard = await guardAdmin();
  if (!guard.ok) return { error: guard.error };
  const db = await getDb();
  const inUse = await db
    .selectFrom("users")
    .select((eb) => eb.fn.countAll<number>().as("n"))
    .where("plan_id", "=", planId)
    .where("plan_expires_at", ">", now())
    .executeTakeFirst();
  if (Number(inUse?.n) > 0) {
    return { error: `${inUse?.n} user(s) are on this plan. Hide it instead by switching off "Show on pricing page".` };
  }
  await db.deleteFrom("plans").where("id", "=", planId).execute();
  redirect("/admin/plans?deleted=1");
}
