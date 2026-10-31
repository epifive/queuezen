"use client";

import { useActionState, useId, useState } from "react";
import { Check, ExternalLink, Undo2 } from "lucide-react";
import { createApprovalLinkAction, saveBrandingAction, type LinkFormState } from "@/app/actions/dashboard/approvals";
import { initialFormState, type FormState } from "@/app/actions/types";
import { Alert } from "@/components/ui/alert";
import { Button, buttonClass } from "@/components/ui/button";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/field";
import { FormMessage, SubmitButton } from "@/components/ui/form";
import { useT } from "@/lib/i18n/client";
import { HiddenFields, useRefreshingAction, type FormAction } from "./client-kit";
import { CopyField } from "./copy";

/**
 * Approve / send back with a comment. Used by the approvers' inbox and the client approval page
 * (different Server Actions, same form). Sending back requires a comment.
 */
export function DecisionForm({
  action,
  fields,
  labels,
  withName = false,
}: {
  action: FormAction;
  fields: Record<string, string | number>;
  labels: { comment: string; commentHint: string; approve: string; reject: string; name?: string; done?: string };
  /** Client page: ask for the reviewer's name. */
  withName?: boolean;
}) {
  const uid = useId();
  const [state, formAction, pending] = useRefreshingAction(action);
  const [decision, setDecision] = useState<"approved" | "rejected" | null>(null);
  return (
    <form action={formAction} className="space-y-3">
      <HiddenFields fields={fields} />
      {state.error ? <Alert tone="error">{state.error}</Alert> : state.success ? <Alert tone="success">{state.success}</Alert> : null}
      {withName ? (
        <Field label={labels.name} htmlFor={`${uid}-name`}>
          <Input id={`${uid}-name`} name="name" maxLength={120} dir="auto" autoComplete="name" className="max-w-xs" />
        </Field>
      ) : null}
      <Field label={labels.comment} htmlFor={`${uid}-comment`} hint={labels.commentHint}>
        <Textarea id={`${uid}-comment`} name="comment" rows={2} maxLength={5000} dir="auto" className="min-h-16" />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" name="decision" value="approved" size="sm" disabled={pending} aria-busy={pending && decision === "approved"} onClick={() => setDecision("approved")}>
          <Check aria-hidden />
          {labels.approve}
        </Button>
        <Button type="submit" name="decision" value="rejected" size="sm" variant="outline" disabled={pending} aria-busy={pending && decision === "rejected"} onClick={() => setDecision("rejected")}>
          <Undo2 aria-hidden />
          {labels.reject}
        </Button>
      </div>
    </form>
  );
}

/** "Add a note" box under a comment thread. */
export function CommentForm({ action, fields, labels }: { action: FormAction; fields: Record<string, string | number>; labels: { placeholder: string; submit: string; sending: string } }) {
  const [state, formAction] = useRefreshingAction(async (prev: FormState, fd: FormData) => {
    const result = await action(prev, fd);
    if (!result.error) (document.getElementById(`comment-${fields.post_id}`) as HTMLTextAreaElement | null)?.form?.reset();
    return result;
  });
  return (
    <form action={formAction} className="space-y-2">
      <HiddenFields fields={fields} />
      {state.error ? (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {state.error}
        </p>
      ) : null}
      <Textarea id={`comment-${fields.post_id}`} name="body" rows={2} maxLength={5000} required dir="auto" placeholder={labels.placeholder} aria-label={labels.placeholder} className="min-h-16" />
      <SubmitButton size="sm" variant="outline" pendingText={labels.sending}>
        {labels.submit}
      </SubmitButton>
    </form>
  );
}

/** Creates a client approval link: pending posts (optionally within dates) or chosen posts. */
export function ApprovalLinkForm({ workspaceId, posts }: { workspaceId: number; posts: Array<{ id: number; label: string }> }) {
  const t = useT();
  const uid = useId();
  const [scope, setScope] = useState<"pending" | "range" | "posts">("pending");
  const [state, action] = useActionState<LinkFormState, FormData>(async (prev, fd) => createApprovalLinkAction(prev, fd), initialFormState);
  return (
    <div className="space-y-4">
      {state.link ? (
        <Alert tone="success" title={state.success}>
          <p className="mb-3">{t("dash.approvals.linkOnce")}</p>
          <CopyField value={state.link} label={t("dash.approvals.linkLabel")} />
          <a href={state.link} target="_blank" rel="noopener" className={buttonClass("outline", "sm", "mt-2")}>
            <ExternalLink aria-hidden />
            {t("dash.approvals.openLink")}
          </a>
        </Alert>
      ) : (
        <FormMessage state={state} />
      )}
      <form action={action} className="space-y-4">
        <HiddenFields fields={{ wid: workspaceId }} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("dash.approvals.linkName")} htmlFor={`${uid}-label`} hint={t("dash.approvals.linkNameHint")}>
            <Input id={`${uid}-label`} name="label" maxLength={120} dir="auto" placeholder={t("dash.approvals.linkNamePlaceholder")} />
          </Field>
          <Field label={t("dash.approvals.scope")} htmlFor={`${uid}-scope`}>
            <Select id={`${uid}-scope`} name="scope" value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
              <option value="pending">{t("dash.approvals.scopePending")}</option>
              <option value="range">{t("dash.approvals.scopeRange")}</option>
              <option value="posts" disabled={!posts.length}>
                {t("dash.approvals.scopePosts")}
              </option>
            </Select>
          </Field>
          {scope === "range" ? (
            <>
              <Field label={t("dash.approvals.from")} htmlFor={`${uid}-from`}>
                <Input id={`${uid}-from`} name="from" type="date" required dir="ltr" />
              </Field>
              <Field label={t("dash.approvals.to")} htmlFor={`${uid}-to`}>
                <Input id={`${uid}-to`} name="to" type="date" required dir="ltr" />
              </Field>
            </>
          ) : null}
          {scope === "posts" ? (
            <fieldset className="sm:col-span-2">
              <legend className="mb-1.5 text-sm font-medium">{t("dash.approvals.pickPosts")}</legend>
              <ul className="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-line p-2">
                {posts.map((p) => (
                  <li key={p.id}>
                    <label className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-paper">
                      <input type="checkbox" name="post_ids" value={p.id} className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]" />
                      <span dir="auto" className="line-clamp-2 min-w-0">
                        {p.label}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>
          ) : null}
          <Field label={t("dash.approvals.expires")} htmlFor={`${uid}-exp`}>
            <Select id={`${uid}-exp`} name="expires_days" defaultValue="14">
              {[1, 3, 7, 14, 30, 60, 90].map((d) => (
                <option key={d} value={d}>
                  {t("dash.approvals.days", { n: d })}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("dash.approvals.password")} htmlFor={`${uid}-pw`} hint={t("dash.approvals.passwordHint")}>
            <Input id={`${uid}-pw`} name="password" type="text" autoComplete="off" minLength={4} maxLength={200} dir="ltr" />
          </Field>
        </div>
        <SubmitButton pendingText={t("dash.approvals.creating")}>{t("dash.approvals.createLink")}</SubmitButton>
      </form>
    </div>
  );
}

/** Password prompt of a protected client approval link. */
export function UnlockForm({ action, token, labels }: { action: FormAction; token: string; labels: { password: string; submit: string } }) {
  const uid = useId();
  const [state, formAction] = useRefreshingAction(action);
  return (
    <form action={formAction} className="space-y-4">
      <HiddenFields fields={{ token }} />
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      <Field label={labels.password} htmlFor={`${uid}-pw`}>
        <Input id={`${uid}-pw`} name="password" type="password" required autoFocus autoComplete="off" dir="ltr" />
      </Field>
      <SubmitButton className="w-full">{labels.submit}</SubmitButton>
    </form>
  );
}

/** Workspace branding shown on client approval links (needs the plan's white label). */
export function BrandingForm({ workspaceId, values, canEdit }: { workspaceId: number; values: { companyName: string; logo: string; color: string }; canEdit: boolean }) {
  const t = useT();
  const uid = useId();
  const [state, action] = useRefreshingAction(saveBrandingAction);
  return (
    <form action={action} className="space-y-4">
      <HiddenFields fields={{ wid: workspaceId }} />
      <FormMessage state={state} />
      <fieldset disabled={!canEdit} className="grid gap-4 sm:grid-cols-2">
        <Field label={t("dash.branding.company")} htmlFor={`${uid}-company`} hint={t("dash.branding.companyHint")}>
          <Input id={`${uid}-company`} name="company" maxLength={120} defaultValue={values.companyName} dir="auto" />
        </Field>
        <Field label={t("dash.branding.logo")} htmlFor={`${uid}-logo`} hint={t("dash.branding.logoHint")}>
          <Input id={`${uid}-logo`} name="logo" type="url" maxLength={500} defaultValue={values.logo} placeholder="https://…/logo.png" dir="ltr" />
        </Field>
        <div className="sm:col-span-2">
          <Checkbox name="use_color" label={t("dash.branding.useColor")} defaultChecked={Boolean(values.color)} />
          <div className="mt-2 flex items-center gap-3">
            <input type="color" name="color" defaultValue={values.color || "#4338ca"} aria-label={t("dash.branding.color")} className="h-9 w-14 cursor-pointer rounded-lg border border-line bg-surface p-1" />
            <span className="text-xs text-muted">{t("dash.branding.colorHint")}</span>
          </div>
        </div>
      </fieldset>
      {canEdit ? <SubmitButton pendingText={t("dash.settings.saving")}>{t("dash.settings.save")}</SubmitButton> : null}
    </form>
  );
}
