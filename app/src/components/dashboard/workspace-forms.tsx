"use client";

import { useActionState, useId } from "react";
import { useRouter } from "next/navigation";
import { createWorkspaceAction, deleteWorkspaceAction, inviteMemberAction, saveWorkspaceSettingsAction } from "@/app/actions/dashboard/workspace";
import { initialFormState, type FormState } from "@/app/actions/types";
import { Alert } from "@/components/ui/alert";
import { Field, Input, Select, Switch } from "@/components/ui/field";
import { FormMessage, SubmitButton } from "@/components/ui/form";
import { useT } from "@/lib/i18n/client";
import type { MessageKey } from "@/lib/i18n/messages";
import { canonicalTimeZone } from "@/social/normalize";
import { ASSIGNABLE_ROLES, type AssignableRole } from "@/social/types";
import { useRefreshingAction } from "./client-kit";
import { CopyField } from "./copy";

/** Time zone select; the browser's zone is preselected for new workspaces. */
function TimeZoneSelect({ id, value, zones }: { id: string; value?: string; zones: string[] }) {
  const list = value && !zones.includes(value) ? [value, ...zones] : zones;
  return (
    <Select
      id={id}
      name="timezone"
      defaultValue={value}
      ref={(el) => {
        if (el && !value) {
          const browser = canonicalTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone || "");
          if (browser && list.includes(browser)) el.value = browser;
        }
      }}
      className="max-w-sm"
    >
      {list.map((z) => (
        <option key={z} value={z}>
          {z.replaceAll("_", " ")}
        </option>
      ))}
    </Select>
  );
}

export function NewWorkspaceForm({ zones }: { zones: string[] }) {
  const t = useT();
  const uid = useId();
  const [state, action] = useActionState(createWorkspaceAction, initialFormState);
  return (
    <form action={action} className="space-y-5">
      <FormMessage state={state} />
      <Field label={t("dash.ws.name")} htmlFor={`${uid}-name`} hint={t("dash.ws.nameHint")}>
        <Input id={`${uid}-name`} name="name" required maxLength={120} dir="auto" placeholder={t("dash.ws.namePlaceholder")} autoComplete="off" />
      </Field>
      <Field label={t("dash.ws.timezone")} htmlFor={`${uid}-tz`} hint={t("dash.ws.timezoneHint")}>
        <TimeZoneSelect id={`${uid}-tz`} zones={zones} />
      </Field>
      <SubmitButton pendingText={t("dash.ws.creating")}>{t("dash.ws.create")}</SubmitButton>
    </form>
  );
}

export function WorkspaceSettingsForm({
  workspaceId,
  values,
  zones,
  canEdit,
}: {
  workspaceId: number;
  values: { name: string; timezone: string; approvalRequired: boolean; weekStart: 1 | 7; utm: { enabled: boolean; source: string; medium: string; campaign: string }; shortenLinks: boolean };
  zones: string[];
  canEdit: boolean;
}) {
  const t = useT();
  const uid = useId();
  // Refresh after saving: the form resets to its default values, which must be the saved ones.
  const [state, action] = useRefreshingAction(saveWorkspaceSettingsAction);
  return (
    <form action={action} className="space-y-5">
      <input type="hidden" name="wid" value={workspaceId} />
      <FormMessage state={state} />
      <fieldset disabled={!canEdit} className="space-y-5">
        <Field label={t("dash.ws.name")} htmlFor={`${uid}-name`}>
          <Input id={`${uid}-name`} name="name" required maxLength={120} dir="auto" defaultValue={values.name} className="max-w-sm" />
        </Field>
        <Field label={t("dash.ws.timezone")} htmlFor={`${uid}-tz`} hint={t("dash.ws.timezoneHint")}>
          <TimeZoneSelect id={`${uid}-tz`} value={values.timezone} zones={zones} />
        </Field>
        <Field label={t("dash.settings.weekStart")} htmlFor={`${uid}-week`}>
          <Select id={`${uid}-week`} name="week_start" defaultValue={String(values.weekStart)} className="max-w-xs">
            <option value="1">{t("dash.settings.monday")}</option>
            <option value="7">{t("dash.settings.sunday")}</option>
          </Select>
        </Field>
        <Switch name="approval_required" label={t("dash.settings.approval")} description={t("dash.settings.approvalHint")} defaultChecked={values.approvalRequired} />
        <fieldset className="space-y-4 rounded-lg border border-line p-4">
          <legend className="px-1 text-sm font-medium">{t("dash.settings.links")}</legend>
          <p className="text-xs text-muted">{t("dash.settings.linksText")}</p>
          <Switch name="utm_enabled" label={t("dash.settings.utm")} description={t("dash.settings.utmHint")} defaultChecked={values.utm.enabled} />
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="utm_source" htmlFor={`${uid}-us`}>
              <Input id={`${uid}-us`} name="utm_source" maxLength={100} defaultValue={values.utm.source} dir="ltr" />
            </Field>
            <Field label="utm_medium" htmlFor={`${uid}-um`}>
              <Input id={`${uid}-um`} name="utm_medium" maxLength={100} defaultValue={values.utm.medium} dir="ltr" />
            </Field>
            <Field label="utm_campaign" htmlFor={`${uid}-uc`}>
              <Input id={`${uid}-uc`} name="utm_campaign" maxLength={100} defaultValue={values.utm.campaign} dir="ltr" />
            </Field>
          </div>
          <Switch name="shorten_links" label={t("dash.settings.shorten")} description={t("dash.settings.shortenHint")} defaultChecked={values.shortenLinks} />
        </fieldset>
      </fieldset>
      {canEdit ? <SubmitButton pendingText={t("dash.settings.saving")}>{t("dash.settings.save")}</SubmitButton> : null}
    </form>
  );
}

/** Danger zone of the Settings page: type the name, then the workspace and everything in it is deleted. */
export function DeleteWorkspaceForm({ workspaceId, name }: { workspaceId: number; name: string }) {
  const t = useT();
  const uid = useId();
  const [state, action] = useActionState(deleteWorkspaceAction, initialFormState);
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!window.confirm(t("dash.settings.deleteText"))) e.preventDefault();
      }}
      className="space-y-4"
    >
      <input type="hidden" name="wid" value={workspaceId} />
      <FormMessage state={state} />
      <Field label={t("dash.settings.deleteConfirm")} htmlFor={`${uid}-confirm`}>
        <Input id={`${uid}-confirm`} name="confirm" required maxLength={120} dir="auto" autoComplete="off" placeholder={name} className="max-w-sm" />
      </Field>
      <SubmitButton variant="danger" pendingText={t("dash.settings.deleting")}>
        {t("dash.settings.delete")}
      </SubmitButton>
    </form>
  );
}

export function InviteForm({ workspaceId, roles, disabled }: { workspaceId: number; roles: readonly AssignableRole[]; disabled: boolean }) {
  const t = useT();
  const uid = useId();
  const router = useRouter();
  const [state, action] = useActionState(async (prev: FormState & { link?: string }, fd: FormData) => {
    const result = await inviteMemberAction(prev, fd);
    // Show the new invite in the "Pending invites" list.
    if (result.link) router.refresh();
    return result;
  }, initialFormState as FormState & { link?: string });
  return (
    <div className="space-y-4">
      {state.link ? (
        <Alert tone="success" title={state.success}>
          <p className="mb-3">{t("dash.team.linkHint")}</p>
          <CopyField value={state.link} label={t("dash.team.link")} />
        </Alert>
      ) : (
        <FormMessage state={state} />
      )}
      <form action={action}>
        <input type="hidden" name="wid" value={workspaceId} />
        <fieldset disabled={disabled} className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <Field label={t("dash.team.email")} htmlFor={`${uid}-email`} className="min-w-0 flex-1">
            <Input id={`${uid}-email`} name="email" type="email" required placeholder="name@example.com" dir="ltr" />
          </Field>
          <Field label={t("dash.team.role")} htmlFor={`${uid}-role`}>
            <Select id={`${uid}-role`} name="role" defaultValue="editor">
              {ASSIGNABLE_ROLES.filter((r) => roles.includes(r)).map((r) => (
                <option key={r} value={r}>
                  {t(`dash.role.${r}` as MessageKey)}
                </option>
              ))}
            </Select>
          </Field>
          <SubmitButton pendingText={t("dash.team.inviting")}>{t("dash.team.invite")}</SubmitButton>
        </fieldset>
      </form>
    </div>
  );
}
