"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Select } from "@/components/ui/field";

/** Channel filter of the analytics page: changes the ?channel= query (keeps the other filters). */
export function AnalyticsChannelFilter({ channels, value, label, allLabel }: { channels: Array<{ id: number; name: string }>; value: number; label: string; allLabel: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  return (
    <div className="w-full sm:w-72">
      <Select
        aria-label={label}
        value={String(value || "")}
        onChange={(e) => {
          const next = new URLSearchParams(params.toString());
          if (e.target.value) next.set("channel", e.target.value);
          else next.delete("channel");
          router.push(`${pathname}?${next.toString()}`, { scroll: false });
        }}
        className="h-9"
      >
        <option value="">{allLabel}</option>
        {channels.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </Select>
    </div>
  );
}
