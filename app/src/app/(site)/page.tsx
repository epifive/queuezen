import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { AnalyticsShowcase } from "@/components/site/landing/analytics-showcase";
import { ApprovalShowcase } from "@/components/site/landing/approval-showcase";
import { AutomationShowcase } from "@/components/site/landing/automation-showcase";
import { CalendarShowcase } from "@/components/site/landing/calendar-showcase";
import { Faq } from "@/components/site/landing/faq";
import { Features } from "@/components/site/landing/features";
import { FinalCta } from "@/components/site/landing/final-cta";
import { Hero, ProofStrip } from "@/components/site/landing/hero";
import { HowItWorks } from "@/components/site/landing/how-it-works";
import { LandingStyles } from "@/components/site/landing/mock-kit";
import { Networks } from "@/components/site/landing/networks";
import { PricingTeaser, type TeaserPlan } from "@/components/site/landing/pricing-teaser";
import { PostCard } from "@/components/site/post-card";
import { getShowcaseApprovalLink } from "@/lib/approvals";
import { getLatestPosts } from "@/lib/blog";
import { getT, localSetting } from "@/lib/i18n/server";
import { getActivePlans } from "@/lib/plans";
import { absoluteUrl, getSiteContext } from "@/lib/site";

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "example.com";
  }
}

export default async function HomePage() {
  const { settings, user, blogVisible, locale } = await getSiteContext();
  const t = await getT();
  const [heroTitle, heroSubtitle, posts, plans, showcase] = await Promise.all([
    localSetting(settings, "home_hero_title"),
    localSetting(settings, "home_hero_subtitle"),
    blogVisible ? getLatestPosts(3) : Promise.resolve([]),
    getActivePlans(),
    getShowcaseApprovalLink(),
  ]);

  const signedIn = Boolean(user);
  const lc = locale.code;
  const host = hostOf(absoluteUrl(settings));
  const teaserPlans: TeaserPlan[] = plans.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    priceMonthly: p.price_monthly,
    isFree: p.is_free === 1,
    isFeatured: p.is_featured === 1,
    maxChannels: p.max_channels,
    maxScheduledMonthly: p.max_scheduled_monthly,
    maxMembers: p.max_members,
    maxXPostsMonthly: p.max_x_posts_monthly,
    allowWhiteLabel: p.allow_white_label === 1,
    allowAi: p.allow_ai === 1,
  }));
  const mb = (value: number, fallback: number) => (Math.max(1, Number(value) || fallback)).toLocaleString(lc);

  return (
    <>
      <LandingStyles />
      <Hero t={t} title={heroTitle} subtitle={heroSubtitle} signedIn={signedIn} locale={lc} />
      {settings.show_stats_on_home ? <ProofStrip t={t} /> : null}
      <HowItWorks t={t} locale={lc} />
      <Features t={t} />
      <CalendarShowcase t={t} locale={lc} />
      <ApprovalShowcase t={t} locale={lc} host={host} demoHref={showcase ? `/approve/${showcase.token}` : undefined} />
      <AnalyticsShowcase t={t} locale={lc} />
      <AutomationShowcase t={t} locale={lc} host={host} />
      <Networks t={t} site={settings.site_name} />
      <PricingTeaser t={t} plans={teaserPlans} currency={settings.currency || "USD"} locale={lc} />
      <Faq t={t} site={settings.site_name} contact={settings.contact_enabled} imageMb={mb(settings.media_max_image_mb, 20)} videoMb={mb(settings.media_max_video_mb, 500)} />

      {posts.length ? (
        <section aria-labelledby="posts-title" className="mx-auto max-w-7xl px-4 pb-24 sm:px-6">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <h2 id="posts-title" className="text-3xl font-bold tracking-tight">
              {t("home.latestPosts")}
            </h2>
            <Link href="/blog" className="group inline-flex items-center gap-1.5 font-semibold text-primary-text hover:underline">
              {t("home.allPosts")}
              <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5 rtl:rotate-180 rtl:group-hover:-translate-x-0.5" aria-hidden />
            </Link>
          </div>
          <ul className="mt-8 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {posts.map((post) => (
              <li key={post.id}>
                <PostCard post={post} readMore={t("blog.readMore")} locale={lc} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <FinalCta t={t} signedIn={signedIn} />
    </>
  );
}
