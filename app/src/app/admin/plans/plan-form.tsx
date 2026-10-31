"use client";

import { useActionState, useState, useTransition } from "react";
import { initialFormState } from "@/app/actions/types";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, Input, Switch, Textarea } from "@/components/ui/field";
import { FormMessage, SubmitButton } from "@/components/ui/form";
import { deletePlan, savePlan } from "../actions/plans";

export interface EditablePlan {
  id: number | null;
  name: string;
  description: string;
  priceMonthly: string;
  priceYearly: string;
  features: string;
  maxChannels: number;
  maxScheduledMonthly: number;
  maxMembers: number;
  maxXPostsMonthly: number;
  maxAiMonthly: number;
  allowAi: boolean;
  allowRss: boolean;
  allowApi: boolean;
  allowWhiteLabel: boolean;
  removeBranding: boolean;
  isFree: boolean;
  isActive: boolean;
  isFeatured: boolean;
  sortOrder: number;
}

export function PlanForm({ plan, currency }: { plan: EditablePlan; currency: string }) {
  const [state, action] = useActionState(savePlan, initialFormState);
  const [deleting, startDelete] = useTransition();
  const [deleteError, setDeleteError] = useState("");

  return (
    <div className="max-w-3xl space-y-6">
      <form action={action} className="space-y-6 rounded-xl border border-line bg-surface p-6">
        <FormMessage state={state} />
        <input type="hidden" name="id" value={plan.id ?? ""} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" htmlFor="name">
            <Input id="name" name="name" defaultValue={plan.name} required maxLength={100} />
          </Field>
          <Field label="Sort order" htmlFor="sort_order" hint="Lower numbers appear first.">
            <Input id="sort_order" name="sort_order" type="number" min={0} max={999} defaultValue={plan.sortOrder} />
          </Field>
          <Field label="Short description" htmlFor="description" className="sm:col-span-2">
            <Input id="description" name="description" defaultValue={plan.description} maxLength={255} />
          </Field>
          <Field label={`Monthly price (${currency})`} htmlFor="price_monthly" hint="0 hides the monthly option.">
            <Input id="price_monthly" name="price_monthly" type="number" min={0} step="0.01" defaultValue={plan.priceMonthly} />
          </Field>
          <Field label={`Yearly price (${currency})`} htmlFor="price_yearly" hint="0 hides the yearly option.">
            <Input id="price_yearly" name="price_yearly" type="number" min={0} step="0.01" defaultValue={plan.priceYearly} />
          </Field>
          <Field label="Social channels" htmlFor="max_channels" hint="Connected accounts across all workspaces the customer owns. 0 = unlimited.">
            <Input id="max_channels" name="max_channels" type="number" min={0} max={100000} defaultValue={plan.maxChannels} required />
          </Field>
          <Field label="Scheduled posts per month" htmlFor="max_scheduled_monthly" hint="A post published to 3 channels counts 3. Resets on the 1st of each month (UTC). 0 = unlimited.">
            <Input id="max_scheduled_monthly" name="max_scheduled_monthly" type="number" min={0} max={10000000} defaultValue={plan.maxScheduledMonthly} required />
          </Field>
          <Field label="Team members" htmlFor="max_members" hint="People across the customer's workspaces, the customer included (1 = no team). Pending invites count. 0 = unlimited.">
            <Input id="max_members" name="max_members" type="number" min={0} max={100000} defaultValue={plan.maxMembers} required />
          </Field>
          <Field label="Posts to X per month" htmlFor="max_x_posts_monthly" hint="Each post costs you X API credits ($0.015, or $0.20 with a link). 0 = X not allowed, -1 = unlimited.">
            <Input id="max_x_posts_monthly" name="max_x_posts_monthly" type="number" min={-1} max={10000000} defaultValue={plan.maxXPostsMonthly} required />
          </Field>
          <Field label="AI requests per month" htmlFor="max_ai_monthly" hint="AI assistant requests (rewrite, hashtags, translate…) per calendar month across the customer's workspaces. 0 = unlimited. Only used when the AI assistant is on.">
            <Input id="max_ai_monthly" name="max_ai_monthly" type="number" min={0} max={10000000} defaultValue={plan.maxAiMonthly} required />
          </Field>
          <div className="space-y-4 sm:col-span-2">
            <Switch name="allow_ai" label="AI assistant" description="Customers can rewrite captions, suggest hashtags and translate posts with your AI provider." defaultChecked={plan.allowAi} />
            <Switch name="allow_rss" label="RSS auto-posting" description="Customers can turn new items of RSS feeds into posts automatically." defaultChecked={plan.allowRss} />
            <Switch name="allow_api" label="REST API" description="Customers can create API keys to create, schedule and read posts and channels over the REST API." defaultChecked={plan.allowApi} />
            <Switch name="allow_white_label" label="White label" description="Client branding: approval links show the customer's own logo, colour and company name instead of yours. Client approval links themselves work on every plan." defaultChecked={plan.allowWhiteLabel} />
          </div>
          <Field label="Features" htmlFor="features" hint="One per line. Shown with a tick on the pricing page." className="sm:col-span-2">
            <Textarea id="features" name="features" defaultValue={plan.features} rows={5} />
          </Field>
        </div>
        <div className="space-y-4 border-t border-line pt-6">
          <Switch name="remove_branding" label="Remove branding" description='Hide the "Powered by" line on client approval links and in notification emails.' defaultChecked={plan.removeBranding} />
          <Switch name="is_featured" label="Recommended" description="Highlight this plan on the pricing page." defaultChecked={plan.isFeatured} />
          <Switch name="is_active" label="Show on pricing page" defaultChecked={plan.isActive} />
          <Switch
            name="is_free"
            label="This is the free plan"
            description="Its limits apply to visitors and free accounts. Only one plan can be the free plan."
            defaultChecked={plan.isFree}
          />
        </div>
        <div className="flex justify-end">
          <SubmitButton>{plan.id ? "Save plan" : "Create plan"}</SubmitButton>
        </div>
      </form>

      {plan.id ? (
        <section className="rounded-xl border border-red-200 bg-surface p-6 dark:border-red-900">
          <h2 className="font-sans text-sm font-semibold tracking-normal">Delete plan</h2>
          <p className="mt-1 text-sm text-muted">Plans with active users can&apos;t be deleted. Hide them instead.</p>
          {deleteError ? <Alert tone="error" className="mt-3">{deleteError}</Alert> : null}
          <Button
            variant="danger"
            size="sm"
            className="mt-4"
            disabled={deleting}
            onClick={() => {
              if (!confirm(`Delete the ${plan.name} plan?`)) return;
              startDelete(async () => {
                const result = await deletePlan(plan.id!);
                if (result?.error) setDeleteError(result.error);
              });
            }}
          >
            {deleting ? "Deleting…" : "Delete plan"}
          </Button>
        </section>
      ) : null}
    </div>
  );
}
