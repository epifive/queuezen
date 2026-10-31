import { PLATFORM_STYLES, platformName } from "@/social/format";
import type { Platform } from "@/social/types";
import { cn } from "@/lib/utils";

/**
 * A platform's tile (brand colour + original glyph). Server-safe. `plain` draws only the glyph in
 * the current text colour (for inline use next to text).
 */
export function PlatformIcon({ platform, className, plain = false, title }: { platform: Platform; className?: string; plain?: boolean; title?: string }) {
  const style = PLATFORM_STYLES[platform];
  const label = title ?? platformName(platform);
  return (
    <svg viewBox="0 0 24 24" className={cn(/(^|\s)size-/.test(className ?? "") ? "shrink-0" : "size-6 shrink-0", className)} role="img" aria-label={label}>
      <title>{label}</title>
      {plain ? null : <rect width="24" height="24" rx="6" fill={style.color} />}
      <g fill="none" stroke={plain ? "currentColor" : style.onColor} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        {style.glyph.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>
    </svg>
  );
}
