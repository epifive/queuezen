"use client";

import { useActionState, useId } from "react";
import { previewFeedAction, saveFeedAction, saveRecycleAction, type PreviewState } from "@/app/actions/dashboard/automation";
import { initialFormState } from "@/app/actions/types";
import { PlatformIcon } from "@/components/social/platform-icon";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Select, Switch, Textarea } from "@/components/ui/field";
import { FormMessage, SubmitButton } from "@/components/ui/form";
import { useT } from "@/lib/i18n/client";
import type { Platform } from "@/social/types";
import { HiddenFields, useRefreshingAction } from "./client-kit";

export interface ChannelOption {
  id: number;
  name: string;
  platform: Platform;
  /** False for networks that need media (Instagram, YouTube): RSS can't post there. */
  textOk: boolean;
}

export interface FeedDefaults {
  id: number;
  url: string;
  title: string;
  channelIds: number[];
  template: string;
  mode: "draft" | "queue" | "publish";
  intervalMinutes: number;
  maxItems: number;
  backfill: boolean;
  hashtags: string;
  shortenLinks: boolean;
  utm: { enabled: boolean; source: string; medium: string; campaign: string };
}

const INTERVALS = [15, 30, 60, 120, 360, 720, 1440];

function ChannelPicker({ channels, selected, name, filter }: { channels: ChannelOption[]; selected: number[]; name: string; filter?: (c: ChannelOption) => boolean }) {
  return (
    <ul className="grid gap-1.5 sm:grid-cols-2">
      {channels.map((c) => {
        const disabled = filter ? !filter(c) : false;
        return (
          <li key={c.id}>
            <label className={`flex items-center gap-2 rounded-lg border border-line px-2.5 py-2 text-sm ${disabled ? "opacity-50" : "cursor-pointer hover:border-primary-line"}`}>
              <input type="checkbox" name={name} value={c.id} defaultChecked={selected.includes(c.id)} disabled={disabled} className="size-4 shrink-0 accent-[var(--primary)]" />
              <PlatformIcon platform={c.platform} className="size-5" />
              <bdi dir="auto" className="min-w-0 truncate">
                {c.name}
              </bdi>
            </label>
          </li>
        );
      })}
    </ul>
  );
}

/** Add or edit an RSS feed, with a "Test feed" preview. */
export function FeedForm({ workspaceId, channels, feed, maxItemsCap, minInterval, draftOnly }: { workspaceId: number; channels: ChannelOption[]; feed?: FeedDefaults; maxItemsCap: number; minInterval: number; draftOnly: boolean }) {
  const t = useT();
  const uid = useId();
  const [state, action] = useRefreshingAction(saveFeedAction);
  const [preview, previewAction, previewing] = useActionState<PreviewState, FormData>(previewFeedAction, initialFormState);
  const intervals = INTERVALS.filter((m) => m >= minInterval);
  const label = (m: number) => (m < 60 ? t("dash.rss.everyMinutes", { n: m }) : m < 1440 ? t("dash.rss.everyHours", { n: m / 60 }) : t("dash.rss.everyDay"));
  return (
    <form action={action} className="space-y-5">
      <HiddenFields fields={{ wid: workspaceId, ...(feed ? { feed_id: feed.id } : {}) }} />
      <FormMessage state={state} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("dash.rss.url")} htmlFor={`${uid}-url`} className="sm:col-span-2">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input id={`${uid}-url`} name="url" type="url" required maxLength={1000} defaultValue={feed?.url} placeholder="https://example.com/feed.xml" dir="ltr" className="min-w-0 flex-1" />
            <Button type="submit" variant="outline" formAction={previewAction} formNoValidate disabled={previewing} aria-busy={previewing}>
              {t("dash.rss.test")}
            </Button>
          </div>
        </Field>
        {preview.error ? <p className="text-sm text-red-600 sm:col-span-2 dark:text-red-400">{preview.error}</p> : null}
        {preview.preview ? (
          <div className="rounded-lg border border-line bg-paper p-3 text-sm sm:col-span-2" role="status">
            <p className="font-medium">
              <bdi dir="auto">{preview.preview.title || "—"}</bdi> · <span className="text-muted">{preview.success}</span>
            </p>
            <ul className="mt-2 space-y-1 text-xs text-muted">
              {preview.preview.items.map((i, n) => (
                <li key={n} dir="auto" className="truncate">
                  {i.title || i.link}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <Field label={t("dash.rss.name")} htmlFor={`${uid}-title`} hint={t("dash.rss.nameHint")}>
          <Input id={`${uid}-title`} name="title" maxLength={255} defaultValue={feed?.title} dir="auto" />
        </Field>
        <Field label={t("dash.rss.mode")} htmlFor={`${uid}-mode`} hint={draftOnly ? t("dash.rss.modeApproval") : t("dash.rss.modeHint")}>
          <Select id={`${uid}-mode`} name="mode" defaultValue={draftOnly ? "draft" : (feed?.mode ?? "queue")}>
            <option value="draft">{t("dash.rss.modeDraft")}</option>
            <option value="queue" disabled={draftOnly}>
              {t("dash.rss.modeQueue")}
            </option>
            <option value="publish" disabled={draftOnly}>
              {t("dash.rss.modePublish")}
            </option>
          </Select>
        </Field>
        <fieldset className="sm:col-span-2">
          <legend className="mb-1.5 text-sm font-medium">{t("dash.rss.channels")}</legend>
          {channels.length ? <ChannelPicker channels={channels} selected={feed?.channelIds ?? []} name="channel_ids" filter={(c) => c.textOk} /> : <p className="text-sm text-muted">{t("dash.rss.noChannels")}</p>}
          <p className="mt-1.5 text-xs text-muted">{t("dash.rss.channelsHint")}</p>
        </fieldset>
        <Field label={t("dash.rss.template")} htmlFor={`${uid}-tpl`} hint={t("dash.rss.templateHint")} className="sm:col-span-2">
          <Textarea id={`${uid}-tpl`} name="template" rows={4} maxLength={2000} defaultValue={feed?.template ?? "{title}\n\n{link}"} dir="auto" className="font-mono text-[13px]" />
        </Field>
        <Field label={t("dash.rss.hashtags")} htmlFor={`${uid}-tags`} hint={t("dash.rss.hashtagsHint")}>
          <Input id={`${uid}-tags`} name="hashtags" maxLength={500} defaultValue={feed?.hashtags} placeholder="#news #blog" dir="auto" />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label={t("dash.rss.interval")} htmlFor={`${uid}-int`}>
            <Select id={`${uid}-int`} name="interval" defaultValue={String(feed && intervals.includes(feed.intervalMinutes) ? feed.intervalMinutes : (intervals.find((m) => m >= 60) ?? intervals[0]))}>
              {intervals.map((m) => (
                <option key={m} value={m}>
                  {label(m)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("dash.rss.maxItems")} htmlFor={`${uid}-max`}>
            <Input id={`${uid}-max`} name="max_items" type="number" min={1} max={maxItemsCap} defaultValue={feed?.maxItems ?? Math.min(3, maxItemsCap)} />
          </Field>
        </div>
      </div>
      <details className="rounded-lg border border-line p-4" open={feed?.utm.enabled}>
        <summary className="cursor-pointer text-sm font-medium">{t("dash.rss.tracking")}</summary>
        <div className="mt-4 space-y-4">
          <Switch name="utm_enabled" label={t("dash.rss.utm")} description={t("dash.rss.utmHint")} defaultChecked={feed?.utm.enabled} />
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="utm_source" htmlFor={`${uid}-us`}>
              <Input id={`${uid}-us`} name="utm_source" defaultValue={feed?.utm.source ?? "{platform}"} dir="ltr" />
            </Field>
            <Field label="utm_medium" htmlFor={`${uid}-um`}>
              <Input id={`${uid}-um`} name="utm_medium" defaultValue={feed?.utm.medium ?? "social"} dir="ltr" />
            </Field>
            <Field label="utm_campaign" htmlFor={`${uid}-uc`}>
              <Input id={`${uid}-uc`} name="utm_campaign" defaultValue={feed?.utm.campaign ?? "rss"} dir="ltr" />
            </Field>
          </div>
          <Switch name="shorten_links" label={t("dash.rss.shorten")} description={t("dash.rss.shortenHint")} defaultChecked={feed?.shortenLinks} />
        </div>
      </details>
      {!feed ? (
        <div>
          <Checkbox name="backfill" label={t("dash.rss.backfill")} />
        </div>
      ) : null}
      <SubmitButton pendingText={t("dash.rss.saving")}>{feed ? t("dash.rss.save") : t("dash.rss.add")}</SubmitButton>
    </form>
  );
}

/** Evergreen recycling settings of the workspace. */
export function RecycleForm({
  workspaceId,
  channels,
  values,
  canEdit,
}: {
  workspaceId: number;
  channels: ChannelOption[];
  values: { enabled: boolean; intervalDays: number; maxRecycles: number; perRun: number; randomize: boolean; channelIds: number[] };
  canEdit: boolean;
}) {
  const t = useT();
  const uid = useId();
  const [state, action] = useRefreshingAction(saveRecycleAction);
  return (
    <form action={action} className="space-y-5">
      <HiddenFields fields={{ wid: workspaceId }} />
      <FormMessage state={state} />
      <fieldset disabled={!canEdit} className="space-y-5">
        <Switch name="enabled" label={t("dash.recycle.enabled")} description={t("dash.recycle.enabledHint")} defaultChecked={values.enabled} />
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label={t("dash.recycle.interval")} htmlFor={`${uid}-days`} hint={t("dash.recycle.intervalHint")}>
            <Input id={`${uid}-days`} name="interval_days" type="number" min={1} max={365} defaultValue={values.intervalDays} />
          </Field>
          <Field label={t("dash.recycle.max")} htmlFor={`${uid}-max`} hint={t("dash.recycle.maxHint")}>
            <Input id={`${uid}-max`} name="max_recycles" type="number" min={0} max={100} defaultValue={values.maxRecycles} />
          </Field>
          <Field label={t("dash.recycle.perRun")} htmlFor={`${uid}-run`} hint={t("dash.recycle.perRunHint")}>
            <Input id={`${uid}-run`} name="per_run" type="number" min={1} max={20} defaultValue={values.perRun} />
          </Field>
        </div>
        <Switch name="randomize" label={t("dash.recycle.randomize")} description={t("dash.recycle.randomizeHint")} defaultChecked={values.randomize} />
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium">{t("dash.recycle.channels")}</legend>
          <ChannelPicker channels={channels} selected={values.channelIds} name="channel_ids" />
          <p className="mt-1.5 text-xs text-muted">{t("dash.recycle.channelsHint")}</p>
        </fieldset>
      </fieldset>
      {canEdit ? <SubmitButton pendingText={t("dash.settings.saving")}>{t("dash.settings.save")}</SubmitButton> : null}
    </form>
  );
}
