"use client";

import { useActionState } from "react";
import { initialFormState } from "@/app/actions/types";
import { Checkbox, Field, Input, Switch } from "@/components/ui/field";
import { FormMessage, SubmitButton } from "@/components/ui/form";
import type { CredentialField } from "@/lib/platforms/setup-guide";
import { savePlatformAppAction, setSimulatedPlatformsAction, testPlatformAppAction } from "../actions/platforms";

/** The operator's app credentials of one network. Secrets are never sent back: empty keeps them. */
export function PlatformAppForm({ platform, fields, values, secretsSet }: { platform: string; fields: CredentialField[]; values: Record<string, string>; secretsSet: Record<string, boolean> }) {
  const [state, action] = useActionState(savePlatformAppAction, initialFormState);
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="platform" value={platform} />
      {fields.map((f) => {
        const id = `app-${f.key}`;
        if (f.secret) {
          const set = secretsSet[f.key];
          return (
            <Field key={f.key} label={f.label} htmlFor={id} hint={[set ? "A value is saved. Leave empty to keep it." : null, f.hint].filter(Boolean).join(" ")}>
              <Input id={id} name={f.key} type="password" autoComplete="new-password" placeholder={set ? "••••••••••" : f.placeholder} dir="ltr" />
              {set ? <Checkbox name={`${f.key}__clear`} label="Remove the saved secret" className="mt-2 text-xs" /> : null}
            </Field>
          );
        }
        return (
          <Field key={f.key} label={f.label} htmlFor={id} hint={f.hint}>
            <Input id={id} name={f.key} type={f.type === "number" ? "number" : "text"} min={f.type === "number" ? 0 : undefined} step={f.type === "number" ? "any" : undefined} defaultValue={values[f.key] ?? ""} placeholder={f.placeholder} dir="ltr" autoComplete="off" spellCheck={false} />
          </Field>
        );
      })}
      <FormMessage state={state} />
      <SubmitButton pendingText="Saving…">Save app credentials</SubmitButton>
    </form>
  );
}

export function TestAppForm({ platform, disabled }: { platform: string; disabled?: boolean }) {
  const [state, action] = useActionState(testPlatformAppAction, initialFormState);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="platform" value={platform} />
      <FormMessage state={state} />
      {disabled ? <p className="text-xs text-muted">Save the client id and secret first.</p> : null}
      <SubmitButton variant="outline" size="sm" pendingText="Testing…">
        Test the app credentials
      </SubmitButton>
    </form>
  );
}

export function SimulatedSwitchForm({ on, forced }: { on: boolean; forced: boolean }) {
  const [state, action] = useActionState(setSimulatedPlatformsAction, initialFormState);
  return (
    <form action={action} className="space-y-3">
      <Switch
        name="platforms_simulated"
        defaultChecked={on || forced}
        disabled={forced}
        label="Simulated platforms (testing only)"
        description={
          forced
            ? "DEMO_MODE is on, so every network is simulated."
            : "Every network uses a fake connection: a local consent screen, fake accounts and fake posts with about 3% retryable failures. Never leave this on for real users."
        }
      />
      <FormMessage state={state} />
      {forced ? null : (
        <SubmitButton size="sm" variant="outline" pendingText="Saving…">
          Save
        </SubmitButton>
      )}
    </form>
  );
}
