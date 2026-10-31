"use client";

import { useActionState, useEffect, useRef } from "react";
import { Plug } from "lucide-react";
import { connectFormAction, pickAccountsAction } from "@/app/actions/dashboard/channels";
import { initialFormState } from "@/app/actions/types";
import { buttonClass } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { useT } from "@/lib/i18n/client";
import { MESSAGES, type MessageKey } from "@/lib/i18n/messages";
import { cn } from "@/lib/utils";
import type { ConnectField } from "@/social/types";

/** Driver field labels are message keys (or plain English). */
function useLabel() {
  const t = useT();
  return (label: string | undefined) => (label && label in MESSAGES ? t(label as MessageKey) : (label ?? ""));
}

/**
 * The connect form of a non-OAuth network (Bluesky app password, Telegram bot, Discord webhook,
 * Mastodon server), unfolded in its tile. Fields come from the driver's connectStart().
 */
export function ConnectForm({
  workspaceId,
  platform,
  fields,
  channelId,
  defaultOpen = false,
  triggerLabel,
  variant = "primary",
}: {
  workspaceId: number;
  platform: string;
  fields: ConnectField[];
  channelId?: number;
  defaultOpen?: boolean;
  triggerLabel: string;
  variant?: "primary" | "outline";
}) {
  const t = useT();
  const label = useLabel();
  const [state, action, pending] = useActionState(connectFormAction, initialFormState);
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (defaultOpen && ref.current) {
      ref.current.open = true;
      ref.current.scrollIntoView({ block: "nearest" });
    }
  }, [defaultOpen]);
  const oauthNext = fields.length === 1 && fields[0].name === "instance";
  return (
    <details ref={ref} className="group w-full">
      <summary className={cn(buttonClass(variant, "sm"), "cursor-pointer list-none group-open:hidden [&::-webkit-details-marker]:hidden")}>
        <Plug aria-hidden />
        {triggerLabel}
      </summary>
      <form action={action} className="mt-1 space-y-3 rounded-lg border border-line bg-paper p-3">
        <input type="hidden" name="wid" value={workspaceId} />
        <input type="hidden" name="platform" value={platform} />
        {channelId ? <input type="hidden" name="channel_id" value={channelId} /> : null}
        {fields.map((f) => {
          const id = `cf-${platform}-${channelId ?? 0}-${f.name}`;
          return (
            <Field key={f.name} label={label(f.label)} htmlFor={id} hint={f.hint ? label(f.hint) : undefined}>
              <Input
                id={id}
                name={f.name}
                type={f.type === "url" ? "url" : f.type}
                required={f.required}
                placeholder={f.placeholder}
                autoComplete={f.type === "password" ? "new-password" : "off"}
                dir="ltr"
                spellCheck={false}
              />
            </Field>
          );
        })}
        {state.error ? (
          <p role="alert" className="text-xs text-red-600 dark:text-red-400">
            {state.error}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <button type="submit" disabled={pending} aria-busy={pending} className={buttonClass("primary", "sm")}>
            {oauthNext ? t("dash.channels.form.continue") : t("dash.channels.form.submit")}
          </button>
          <button
            type="button"
            className={buttonClass("ghost", "sm")}
            onClick={() => {
              if (ref.current) ref.current.open = false;
            }}
          >
            {t("dash.channels.form.cancel")}
          </button>
        </div>
      </form>
    </details>
  );
}

export interface PickAccount {
  externalId: string;
  name: string;
  handle: string;
  avatarUrl: string;
  connected: boolean;
}

/** The account picker after a connect that returned several accounts (Facebook Pages, Instagram accounts). */
export function AccountPicker({ workspaceId, token, accounts, remaining }: { workspaceId: number; token: string; accounts: PickAccount[]; remaining: number | null }) {
  const t = useT();
  const [state, action, pending] = useActionState(pickAccountsAction, initialFormState);
  const ref = useRef<HTMLFormElement>(null);
  // Tick already connected accounts and as many new ones as the plan allows.
  const preselected = new Set<string>();
  let budget = remaining ?? Infinity;
  for (const a of accounts) {
    if (a.connected) preselected.add(a.externalId);
    else if (budget > 0) {
      preselected.add(a.externalId);
      budget -= 1;
    }
  }
  return (
    <form
      ref={ref}
      action={action}
      onSubmit={(e) => {
        const form = e.currentTarget;
        const fresh = Array.from(form.querySelectorAll<HTMLInputElement>('input[name="account"]:checked')).filter((i) => i.dataset.connected !== "1").length;
        if (remaining !== null && fresh > remaining) {
          e.preventDefault();
          alert(t("dash.channels.pick.over", { n: remaining }));
        }
      }}
      className="space-y-4"
    >
      <input type="hidden" name="wid" value={workspaceId} />
      <input type="hidden" name="s" value={token} />
      <ul className="divide-y divide-line rounded-xl border border-line">
        {accounts.map((a) => {
          return (
            <li key={a.externalId}>
              <label className="flex cursor-pointer items-center gap-3 px-4 py-3 hover:bg-paper">
                <input type="checkbox" name="account" value={a.externalId} defaultChecked={preselected.has(a.externalId)} data-connected={a.connected ? "1" : "0"} className="size-4 accent-[var(--primary)]" />
                {a.avatarUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- remote avatars of the networks
                  <img src={a.avatarUrl} alt="" width={40} height={40} className="size-10 rounded-full object-cover" />
                ) : (
                  <span className="grid size-10 place-items-center rounded-full bg-primary-soft font-semibold text-primary">{a.name.slice(0, 1).toUpperCase()}</span>
                )}
                <span className="min-w-0 flex-1">
                  <span dir="auto" className="block truncate font-medium">
                    {a.name}
                  </span>
                  <span dir="ltr" className="block truncate text-xs text-muted">
                    {a.handle || a.externalId}
                  </span>
                </span>
                {a.connected ? <span className="rounded-full bg-line/70 px-2 py-0.5 text-xs text-muted">{t("dash.channels.pick.already")}</span> : null}
              </label>
            </li>
          );
        })}
      </ul>
      {state.error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {state.error}
        </p>
      ) : null}
      <button type="submit" disabled={pending} aria-busy={pending} className={buttonClass("primary", "md")}>
        {t("dash.channels.pick.add")}
      </button>
    </form>
  );
}
