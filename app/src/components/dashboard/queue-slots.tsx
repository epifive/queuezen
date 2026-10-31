"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { saveQueueSlotsAction } from "@/app/actions/dashboard/queue";
import { Button } from "@/components/ui/button";
import { Checkbox, Input } from "@/components/ui/field";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import { normalizeQueueSlots, normalizeTime } from "@/social/normalize";
import type { QueueSlot } from "@/social/types";

/**
 * Weekly posting times of a channel: a weekday × time grid (rows = times, columns = days in the
 * workspace's week order). Times are wall-clock times in the workspace's time zone.
 */
export function QueueSlotsEditor({ workspaceId, channelId, slots: initial, weekStart, locale }: { workspaceId: number; channelId: number; slots: QueueSlot[]; weekStart: 1 | 7; locale: string }) {
  const t = useT();
  const router = useRouter();
  const [slots, setSlots] = useState<QueueSlot[]>(initial);
  const [extraTimes, setExtraTimes] = useState<string[]>([]);
  const [newTime, setNewTime] = useState("10:00");
  const [applyAll, setApplyAll] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const days = weekStart === 1 ? [1, 2, 3, 4, 5, 6, 7] : [7, 1, 2, 3, 4, 5, 6];
  const times = useMemo(() => [...new Set([...slots.map((s) => s.time), ...extraTimes])].sort(), [slots, extraTimes]);
  const has = (day: number, time: string) => slots.some((s) => s.day === day && s.time === time);
  const toggle = (day: number, time: string) => {
    setMessage(null);
    setSlots((list) => (has(day, time) ? list.filter((s) => !(s.day === day && s.time === time)) : normalizeQueueSlots([...list, { day, time }])));
  };
  const dayName = (day: number) => new Date(Date.UTC(2024, 0, day)).toLocaleDateString(locale, { weekday: "short", timeZone: "UTC" }); // 2024-01-01 = Monday
  const timeLabel = (time: string) => {
    const [h, m] = time.split(":").map(Number);
    return new Date(Date.UTC(2024, 0, 1, h, m)).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
  };

  return (
    <div className="space-y-4">
      <div className="relative overflow-x-auto rounded-lg border border-line">
        <table className="w-full min-w-[30rem] text-sm">
          <thead>
            <tr className="bg-paper text-xs text-muted">
              <th scope="col" className="px-3 py-2 text-start font-medium">
                {t("dash.queue.time")}
              </th>
              {days.map((d) => (
                <th key={d} scope="col" className="px-1 py-2 text-center font-medium">
                  {dayName(d)}
                </th>
              ))}
              <th scope="col" className="w-10">
                <span className="sr-only">{t("dash.queue.remove")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {times.length ? (
              times.map((time) => (
                <tr key={time} className="border-t border-line">
                  <th scope="row" className="px-3 py-1.5 text-start font-semibold tabular-nums">
                    {timeLabel(time)}
                  </th>
                  {days.map((d) => (
                    <td key={d} className="px-1 py-1 text-center">
                      <button
                        type="button"
                        onClick={() => toggle(d, time)}
                        aria-pressed={has(d, time)}
                        aria-label={`${dayName(d)} ${timeLabel(time)}`}
                        className={cn("size-8 rounded-md border text-xs transition-colors", has(d, time) ? "border-primary bg-primary text-white" : "border-line bg-surface text-transparent hover:border-primary-line")}
                      >
                        ✓
                      </button>
                    </td>
                  ))}
                  <td className="px-1 text-center">
                    <button
                      type="button"
                      onClick={() => {
                        setSlots((list) => list.filter((s) => s.time !== time));
                        setExtraTimes((x) => x.filter((v) => v !== time));
                      }}
                      className="rounded p-1 text-muted hover:text-red-600"
                      aria-label={t("dash.queue.removeTime", { time: timeLabel(time) })}
                    >
                      <Trash2 className="size-4" aria-hidden />
                    </button>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={9} className="px-3 py-6 text-center text-muted">
                  {t("dash.queue.noSlots")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-sm">
          <span className="mb-1.5 block font-medium">{t("dash.queue.addTime")}</span>
          <Input type="time" value={newTime} onChange={(e) => setNewTime(e.target.value)} className="w-32!" dir="ltr" />
        </label>
        <Button
          variant="outline"
          onClick={() => {
            const v = normalizeTime(newTime);
            if (!v) return;
            setExtraTimes((x) => (x.includes(v) ? x : [...x, v]));
            // A new time starts on every weekday.
            setSlots((list) => normalizeQueueSlots([...list, ...[1, 2, 3, 4, 5].map((day) => ({ day, time: v }))]));
          }}
        >
          <Plus aria-hidden />
          {t("dash.queue.add")}
        </Button>
        <Button variant="ghost" onClick={() => setSlots(normalizeQueueSlots([1, 2, 3, 4, 5].flatMap((day) => ["09:00", "12:30", "17:00"].map((time) => ({ day, time })))))}>
          {t("dash.queue.preset")}
        </Button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
        <Checkbox label={t("dash.queue.applyAll")} checked={applyAll} onChange={(e) => setApplyAll(e.target.checked)} />
        <div className="flex items-center gap-3">
          {message ? (
            <span role={message.tone === "error" ? "alert" : "status"} className={cn("text-sm", message.tone === "error" ? "text-red-600 dark:text-red-400" : "text-emerald-700 dark:text-emerald-400")}>
              {message.text}
            </span>
          ) : null}
          <Button
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const r = await saveQueueSlotsAction({ workspaceId, channelId, slots, applyToAll: applyAll });
                setMessage(r.ok ? { tone: "ok", text: r.message ?? "" } : { tone: "error", text: r.error ?? "" });
                if (r.ok) router.refresh();
              })
            }
          >
            {t("dash.queue.saveSlots", { n: slots.length })}
          </Button>
        </div>
      </div>
    </div>
  );
}
