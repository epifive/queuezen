"use client";

import Link from "next/link";
import { CalendarClock, ExternalLink, PlugZap, RefreshCw, Settings2, Unplug } from "lucide-react";
import { disconnectChannelAction, saveChannelSettingsAction, testChannelAction } from "@/app/actions/dashboard/channels";
import { ActionButton } from "@/components/dashboard/actions";
import { PopoverForm } from "@/components/dashboard/client-kit";
import { PlatformIcon } from "@/components/social/platform-icon";
import { buttonClass } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import { platformName } from "@/social/format";
import type { ConnectField, Platform } from "@/social/types";
import { ConnectForm } from "./channel-connect";

export type ChannelDisplayStatus = "active" | "expiring" | "expired" | "error";

export interface ChannelCardData {
  id: number;
  platform: Platform;
  name: string;
  handle: string;
  avatarUrl: string;
  profileUrl: string;
  status: ChannelDisplayStatus;
  lastError: string | null;
  /** Localised "Token expires …" / reconnect hint, or "". */
  expiryText: string;
  checkedText: string;
  firstComment: string;
  hashtags: string;
  /** UTM tags of the channel's links: the workspace's, its own, or none. */
  utm: { mode: "workspace" | "custom" | "off"; source: string; medium: string; campaign: string };
  simulated: boolean;
  reconnect: { kind: "link"; href: string } | { kind: "form"; fields: ConnectField[] } | null;
}

const TONE: Record<ChannelDisplayStatus, string> = {
  active: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  expiring: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  expired: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  error: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
};

/** One connected channel: status, profile, last error and its actions. */
export function ChannelCard({ channel: c, workspaceId, canManage, queueHref }: { channel: ChannelCardData; workspaceId: number; canManage: boolean; queueHref: string }) {
  const t = useT();
  const fields = { wid: workspaceId, channel_id: c.id };
  const statusLabel =
    c.status === "active" ? t("dash.channels.status.active") : c.status === "expiring" ? t("dash.channels.status.expiring") : c.status === "expired" ? t("dash.channels.status.expired") : t("dash.channels.status.error");
  const needsReconnect = c.status === "expired" || c.status === "expiring";
  return (
    <li className={cn("flex h-full flex-col rounded-xl border bg-surface p-4", needsReconnect || c.status === "error" ? "border-amber-300 dark:border-amber-800" : "border-line")} data-channel={c.id}>
      <div className="flex items-start gap-3">
        <span className="relative shrink-0">
          {c.avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- avatars come from the networks
            <img src={c.avatarUrl} alt="" width={44} height={44} className="size-11 rounded-full border border-line object-cover" />
          ) : (
            <span className="grid size-11 place-items-center rounded-full bg-primary-soft text-lg font-semibold text-primary">{(c.name || "?").slice(0, 1).toUpperCase()}</span>
          )}
          <PlatformIcon platform={c.platform} className="absolute -end-1 -bottom-1 size-5 rounded-md ring-2 ring-surface" />
        </span>
        <div className="min-w-0 flex-1">
          <p dir="auto" className="truncate font-semibold">
            {c.name}
          </p>
          <p dir="ltr" className="truncate text-xs text-muted rtl:text-end">
            {platformName(c.platform)}
            {c.handle ? ` · ${c.handle}` : ""}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className={cn("inline-flex rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap", TONE[c.status])}>{statusLabel}</span>
          {c.profileUrl && /^https?:\/\//.test(c.profileUrl) ? (
            <a href={c.profileUrl} target="_blank" rel="noopener noreferrer" className="grid size-7 place-items-center rounded-md text-muted hover:bg-paper hover:text-primary" title={t("dash.channels.viewProfile")} aria-label={t("dash.channels.viewProfile")}>
              <ExternalLink className="size-4" aria-hidden />
            </a>
          ) : null}
        </div>
      </div>

      <div className="mt-3 space-y-1 text-xs text-muted">
        {c.expiryText ? (
          <p className={cn("flex items-center gap-1.5", c.status === "expiring" && "text-amber-700 dark:text-amber-400")}>
            <CalendarClock className="size-3.5 shrink-0" aria-hidden />
            {c.expiryText}
          </p>
        ) : null}
        {c.checkedText ? <p>{c.checkedText}</p> : null}
        {c.simulated ? <p className="text-amber-700 dark:text-amber-400">{t("dash.channels.simulatedChannel")}</p> : null}
        {c.lastError && c.status !== "active" ? (
          <p role="status" className="line-clamp-3 text-red-600 dark:text-red-400">
            {c.lastError}
          </p>
        ) : null}
      </div>

      {canManage ? (
        <div className="mt-auto flex flex-wrap items-start gap-2 pt-4">
          {needsReconnect && c.reconnect?.kind === "link" ? (
            <a href={c.reconnect.href} className={buttonClass("primary", "sm")}>
              <RefreshCw aria-hidden />
              {t("dash.channels.reconnect")}
            </a>
          ) : null}
          <ActionButton action={testChannelAction} fields={fields} showSuccess label={t("dash.channels.test")}>
            <PlugZap aria-hidden />
            {t("dash.channels.test")}
          </ActionButton>
          <PopoverForm
            action={saveChannelSettingsAction}
            fields={fields}
            trigger={
              <>
                <Settings2 aria-hidden />
                {t("dash.channels.settings")}
              </>
            }
            title={t("dash.channels.settings.title")}
            submitLabel={t("dash.channels.settings.save")}
          >
            <Field label={t("dash.channels.settings.firstComment")} htmlFor={`fc-${c.id}`}>
              <Textarea id={`fc-${c.id}`} name="defaultFirstComment" defaultValue={c.firstComment} maxLength={2000} className="min-h-20" dir="auto" />
            </Field>
            <Field label={t("dash.channels.settings.hashtags")} htmlFor={`ht-${c.id}`} hint={t("dash.channels.settings.hashtagsHint")}>
              <Input id={`ht-${c.id}`} name="hashtags" defaultValue={c.hashtags} maxLength={1000} dir="auto" />
            </Field>
            <Field label={t("dash.channels.settings.utm")} htmlFor={`utm-${c.id}`} hint={t("dash.channels.settings.utmHint")}>
              <Select id={`utm-${c.id}`} name="utm_mode" defaultValue={c.utm.mode}>
                <option value="workspace">{t("dash.channels.settings.utmWorkspace")}</option>
                <option value="custom">{t("dash.channels.settings.utmCustom")}</option>
                <option value="off">{t("dash.channels.settings.utmOff")}</option>
              </Select>
            </Field>
            <div className="grid gap-2 sm:grid-cols-3">
              {(["source", "medium", "campaign"] as const).map((k) => (
                <Field key={k} label={`utm_${k}`} htmlFor={`utm-${k}-${c.id}`}>
                  <Input id={`utm-${k}-${c.id}`} name={`utm_${k}`} defaultValue={c.utm[k]} maxLength={100} dir="ltr" className="h-8 text-xs" />
                </Field>
              ))}
            </div>
            <p className="text-xs text-muted">
              {t("dash.channels.settings.slots")}{" "}
              <Link href={queueHref} className="font-medium text-primary hover:underline">
                {t("dash.channels.settings.queueLink")}
              </Link>
            </p>
          </PopoverForm>
          <ActionButton action={disconnectChannelAction} fields={fields} variant="ghost" confirmText={t("dash.channels.disconnect.confirm")} label={t("dash.channels.disconnect")}>
            <Unplug aria-hidden />
            {t("dash.channels.disconnect")}
          </ActionButton>
          {needsReconnect && c.reconnect?.kind === "form" ? (
            <ConnectForm workspaceId={workspaceId} platform={c.platform} fields={c.reconnect.fields} channelId={c.id} triggerLabel={t("dash.channels.reconnect")} />
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
