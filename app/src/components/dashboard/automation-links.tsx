"use client";

import { useId } from "react";
import { saveLinkAction, type LinkState } from "@/app/actions/dashboard/links";
import { initialFormState } from "@/app/actions/types";
import { Alert } from "@/components/ui/alert";
import { Field, Input } from "@/components/ui/field";
import { FormMessage, SubmitButton } from "@/components/ui/form";
import { useT } from "@/lib/i18n/client";
import { HiddenFields, useRefreshingAction } from "./client-kit";
import { CopyField } from "./copy";

export interface LinkDefaults {
  id: number;
  url: string;
  title: string;
  utm: { source: string; medium: string; campaign: string; term: string; content: string };
}

/** Create or edit a tracked short link with UTM parameters. */
export function LinkForm({ workspaceId, link }: { workspaceId: number; link?: LinkDefaults }) {
  const t = useT();
  const uid = useId();
  const [state, action] = useRefreshingAction<LinkState>(saveLinkAction, initialFormState);
  return (
    <div className="space-y-4">
      {!link && state.shortUrl ? (
        <Alert tone="success" title={state.success}>
          <CopyField value={state.shortUrl} label={t("dash.links.short")} />
        </Alert>
      ) : (
        <FormMessage state={state} />
      )}
      <form action={action} className="space-y-4">
        <HiddenFields fields={{ wid: workspaceId, ...(link ? { link_id: link.id } : {}) }} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("dash.links.url")} htmlFor={`${uid}-url`} className="sm:col-span-2">
            <Input id={`${uid}-url`} name="url" type="url" required maxLength={2000} defaultValue={link?.url} placeholder="https://example.com/page" dir="ltr" />
          </Field>
          <Field label={t("dash.links.name")} htmlFor={`${uid}-title`} hint={t("dash.links.titleHint")} className="sm:col-span-2">
            <Input id={`${uid}-title`} name="title" maxLength={255} defaultValue={link?.title} dir="auto" />
          </Field>
        </div>
        <fieldset className="rounded-lg border border-line p-4">
          <legend className="px-1 text-sm font-medium">{t("dash.links.utm")}</legend>
          <p className="mb-3 text-xs text-muted">{t("dash.links.utmHint")}</p>
          <div className="grid gap-3 sm:grid-cols-3">
            {(["source", "medium", "campaign", "term", "content"] as const).map((k) => (
              <Field key={k} label={`utm_${k}`} htmlFor={`${uid}-${k}`}>
                <Input id={`${uid}-${k}`} name={`utm_${k}`} maxLength={100} defaultValue={link?.utm[k] ?? ""} dir="ltr" placeholder={k === "source" ? "newsletter" : k === "medium" ? "social" : ""} />
              </Field>
            ))}
          </div>
        </fieldset>
        <SubmitButton pendingText={t("dash.links.saving")}>{link ? t("dash.links.save") : t("dash.links.create")}</SubmitButton>
      </form>
    </div>
  );
}
