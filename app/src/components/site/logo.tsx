import Link from "next/link";
import { cn } from "@/lib/utils";

/** Default brand mark: stacked queue cards (posts waiting in line) with a clock on the front card. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("size-8", className)} aria-hidden>
      <rect width="32" height="32" rx="8" fill="var(--primary)" />
      <rect x="10" y="5.5" width="12" height="4" rx="1.6" fill="white" opacity="0.45" />
      <rect x="8" y="8.5" width="16" height="4.5" rx="1.8" fill="white" opacity="0.72" />
      <rect x="6" y="12" width="20" height="14.5" rx="3" fill="white" />
      <circle cx="16" cy="19.25" r="4.6" fill="none" stroke="var(--primary)" strokeWidth="2" />
      <path d="M16 16.8v2.7l1.9 1.3" fill="none" stroke="#f59e0b" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Logo({
  siteName,
  logo,
  logoDark,
  href = "/",
  className,
}: {
  siteName: string;
  logo?: string;
  logoDark?: string;
  href?: string;
  className?: string;
}) {
  return (
    <Link href={href} className={cn("inline-flex items-center gap-2.5", className)} aria-label={`${siteName} home`}>
      {logo ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element -- admin-uploaded logo of unknown size */}
          <img src={logo} alt={siteName} className={cn("h-8 w-auto max-w-full object-contain object-left rtl:object-right", logoDark && "dark:hidden")} />
          {logoDark ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoDark} alt={siteName} className="hidden h-8 w-auto max-w-full object-contain object-left dark:block rtl:object-right" />
          ) : null}
        </>
      ) : (
        <>
          <BrandMark className="shrink-0" />
          <span className="truncate font-display text-xl font-bold tracking-tight text-ink">{siteName}</span>
        </>
      )}
    </Link>
  );
}
