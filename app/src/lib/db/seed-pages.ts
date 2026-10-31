/**
 * Default content pages created on install. Buyers edit them from
 * Admin → Pages. `{site_name}` and `{site_email}` are replaced when rendered.
 * They are a starting point, not legal advice: buyers should adapt them to their
 * business and the laws that apply to them.
 */
export const DEFAULT_PAGES = [
  {
    slug: "about",
    title: "About Us",
    metaDescription: "{site_name} helps creators, businesses and agencies plan, approve and publish social media posts across every network from one calendar.",
    content: `## Who we are

{site_name} is a social media scheduler for creators, small businesses, marketing teams and agencies. Write a post once, adapt it for each network, and let it go out at the right time while you get on with your day.

## What {site_name} does

- **One composer for every network.** Facebook Pages, Instagram, Threads, X, LinkedIn, YouTube, Bluesky, Mastodon, Telegram and Discord, with a live preview and a character counter for each.
- **Calendar and queue.** Drag posts around a monthly or weekly calendar, or add them to a queue that fills your favourite posting times automatically.
- **First comments and threads.** Add hashtags or a link as the first comment, or split a long story into a thread on X, Threads, Bluesky and Mastodon.
- **Teamwork.** Invite your team, choose who can write, approve or only look, and send clients an approval link that needs no login.
- **Automation.** Post new articles from RSS feeds, recycle evergreen posts and track every link with UTM parameters and short links.
- **Analytics.** See likes, comments, shares and views where the networks provide them, and find out when your audience is most active.

## How we connect to the networks

We only use the official APIs of each network, with the permissions you grant when you connect an account. We never ask for your social media passwords (Bluesky uses an app password you can revoke at any time), and every access token is stored encrypted.

## What we believe

- **Consistency beats bursts.** A steady, planned schedule grows an audience better than posting when you remember to.
- **Every network is different.** A post should fit the place it appears, not be copied blindly everywhere.
- **Approvals shouldn't need email chains.** Comments and decisions belong next to the post.
- **Your content belongs to you.** Export your analytics as CSV, or read your posts through the REST API, whenever you like.

## Contact

Questions or ideas? [Get in touch](/contact) — we read every message.`,
  },
  {
    slug: "privacy-policy",
    title: "Privacy Policy",
    metaDescription: "How {site_name} handles your account, the social accounts you connect, your posts and media, and the data the social networks share with us.",
    content: `## Overview

This policy explains what data {site_name} collects, why, who processes it on our behalf and what control you have over it. We collect only what is needed to run the service.

## Account data

When you create an account we store your name, email address and a securely hashed password, your language preference and your plan. Payments are handled by our payment provider; we receive the payment status and a reference, never your full card number.

## Workspaces and your content

We store the workspaces you create or join, the members and their roles, the posts you write (text, links, labels, first comments and threads), the media you upload, comments and approval decisions, queue times, RSS feeds, short links and your notification channels (for example an email address, a Slack or Microsoft Teams webhook address, or a Telegram bot token). API keys are stored as a one-way hash; we can't read them back.

**Approval links.** When a workspace sends a client an approval link, we store the link, its expiry date and, if one is set, a hashed password. People who review posts through the link don't need an account: the name and comment they enter are saved with the post's history so the team can see who approved what.

## Social accounts you connect

When you connect a social account, the network asks you to approve the permissions {site_name} needs, and sends us an access token (and, for some networks, a refresh token). **Tokens are stored encrypted** (AES-256-GCM) and are only used to do what you asked: publish and delete your posts, add first comments, read the basic profile of the account and, where available, the statistics of the posts published through {site_name}.

What each network shares with us:

- **Facebook Pages, Instagram and Threads (Meta):** the name, id and picture of the Pages and professional accounts you select, the ids and links of the posts we publish, and their public statistics (such as views, likes, comments and shares).
- **X:** your name, username, picture and id, and the metrics of the posts we publish.
- **LinkedIn:** your name, picture and member id. LinkedIn provides no statistics for personal profiles.
- **YouTube (Google):** your channel's name and id, and the statistics of the videos we upload.
- **Bluesky:** your handle, display name and picture; we store your app password encrypted to keep the connection working.
- **Mastodon:** your instance, username and picture.
- **Telegram and Discord:** the bot token with the chat id, or the webhook address you paste, stored encrypted.

We don't read your private messages, don't follow or unfollow accounts and never post anything you didn't create or schedule.

## Disconnecting and deleting data

When you remove a channel, we delete its tokens and, where the network allows it, revoke our access at the network. Posts already published stay on the network until you delete them there (or from {site_name} before you disconnect). You can also revoke access at any time from the network's own settings, for example Facebook → Settings → Business integrations, or X → Settings → Connected apps.

The sections below explain how to withdraw access at Google and Meta as well.

## YouTube (Google) data

When you connect a YouTube channel, {site_name} uses YouTube API Services. Our use and transfer of information received from Google APIs adheres to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements. We only use YouTube data to upload the videos you schedule, show your channel's name and picture, and show the statistics of the videos uploaded through {site_name}. We don't use it for advertising, don't sell it and don't let people read it except where needed for security, to comply with the law, or with your consent.

By connecting YouTube you also agree to the [YouTube Terms of Service](https://www.youtube.com/t/terms), and Google's handling of your data is described in the [Google Privacy Policy](https://policies.google.com/privacy).

You can revoke {site_name}'s access at any time: disconnect the channel in {site_name} (this deletes the tokens we stored), and/or remove {site_name} in your Google Account's security settings at [myaccount.google.com/permissions](https://myaccount.google.com/permissions).

## Facebook, Instagram and Threads (Meta) data

Our use of data received from Meta follows the [Meta Platform Terms](https://developers.facebook.com/terms/) and Meta's Developer Policies. We only use it to publish the posts you schedule, add first comments, show the Pages and accounts you selected, and show the statistics of posts published through {site_name}.

To remove {site_name}, disconnect the channel here, or remove the app in your Meta settings: on Facebook in Settings & privacy → Settings → Business integrations (or Apps and websites), on Instagram in Settings → Website permissions → Apps and websites, and on Threads in Settings → Account → Website permissions.

**Data deletion.** When you remove {site_name} in your Meta settings, Meta sends us a data deletion request through our data deletion callback at \`/api/meta/data-deletion\`. We then delete the access tokens and the profile data we received from Meta for the accounts concerned, and Meta shows you a confirmation code and a link (\`/api/meta/data-deletion?code=…\`) where you can check the status of the request. You can also ask us to delete your data at {site_email}.

## Publishing and analytics

To publish, we send your post text, links and media to the network you chose, at the time you chose. Some networks, such as Instagram and Threads, fetch media from a web address, so the files in your media library are served from an unlisted address with a random name. We fetch the statistics of published posts for a limited time after publishing (30 days by default) to show them in your analytics.

## Where your media is stored

Depending on how this platform is set up, the images and videos you upload are stored on our own server, on S3-compatible object storage (for example Amazon S3, Cloudflare R2, Wasabi or Backblaze B2) or on Vercel Blob. Uploads go directly from your browser to that storage. When you delete a file from the media library, it is deleted from the storage too.

## Short links and click counts

If you use short links, we count clicks per day for each link. We don't store the IP addresses or identities of the people who click.

## Cookies

We only use cookies that are needed for the service to work:

- **tz_session** keeps you signed in (up to 30 days).
- **tz_lang** remembers the language you chose (1 year).
- **qz_ws** remembers the workspace you used last (1 year).
- **qz_oauth** is a short-lived security value (protection against cross-site request forgery) while you connect a social account. It expires after 15 minutes and is deleted when the connection is finished.
- **qz_al_…** (followed by a number) is set on a password-protected approval link once the password was entered, so it isn't asked again. It only applies to that link's address and expires with the link (after 90 days at most).

Your theme and cookie notice choices are saved in your browser's local storage. We don't use advertising or third-party tracking cookies.

## Sub-processors

We don't sell data and don't share it with advertisers. We share only what is needed with the services that help us run {site_name}:

- **Hosting, database and file storage** providers that store the data and your media.
- **Email delivery** for account emails and notifications.
- **Payment** providers for paid plans.
- **The social networks you connect**, which receive the posts you publish to them.
- **An AI provider**, only when you use the AI assistant: the text and instructions you send it go to the provider chosen by the operator of this platform (for example OpenAI, Anthropic or another OpenAI-compatible service), which processes them to return a suggestion. Nothing is sent to an AI provider unless you use the assistant.
- **Notification channels you configure** (such as Slack, Discord, Microsoft Teams, Telegram or your own webhook) receive the notifications you asked for.

## How long we keep data

Account data, workspaces, posts, media and statistics are kept while your account exists. Notification logs are deleted after 90 days. When you delete a post, a workspace or your account, its data is deleted too; tokens are deleted as soon as you remove a channel.

## Security

Passwords are hashed, connections are encrypted, social media tokens are stored encrypted, API keys are stored as hashes and access to our servers is restricted. No system is perfectly secure, but we work hard to protect your data.

## Your rights

You can see and change your details at any time from your account page, disconnect any social account, export your analytics and ask us to delete your account. Depending on where you live you may have further rights (for example under the GDPR); contact us to use them.

## Changes

We may update this policy. For important changes we will let customers know by email.

## Contact

For privacy questions contact us at {site_email}.`,
  },
  {
    slug: "terms-of-service",
    title: "Terms of Service",
    metaDescription: "The terms that apply when you use {site_name}.",
    content: `## Acceptance

By creating an account or using {site_name} you agree to these terms. If you use {site_name} for a company, you confirm that you may accept these terms on its behalf.

## Your account and your team

Keep your login details and API keys safe. You are responsible for everything done with your account and in the workspaces you own, including by the members you invite and the people you send approval links to.

## Connected social accounts

Only connect accounts that you own or are authorised to manage. When you publish through {site_name} you also agree to the terms and policies of each network you post to (for example Meta's Terms and Community Standards, the X Developer Agreement and Rules, LinkedIn's User Agreement, YouTube's Terms of Service and the rules of your Mastodon instance), and you are responsible for following them.

## Acceptable use

- **No spam.** Don't post the same or nearly the same content over and over, mass-mention or tag people who didn't ask for it, or use {site_name} to send unsolicited messages.
- **No engagement farming or automation abuse.** {site_name} publishes your own posts; don't use it to fake engagement (bought or exchanged likes, follows or comments, engagement pods), run networks of fake or coordinated accounts, get around a network's rate limits, or evade a suspension or ban.
- **Respect each network's rules.** Don't publish anything that breaks the policies of the network you post to, including its rules on automation, duplicate content, misleading links and branded content.
- Don't post anything unlawful, deceptive, hateful, harassing or infringing, or content you don't have the rights to.
- Don't try to break the plan limits, share accounts to avoid them, or automate the service beyond what the REST API offers.

We may pause publishing, disconnect channels or suspend accounts that break these rules or put the service, the networks or other customers at risk. A network may also restrict an account or our access to its API at any time.

## Publishing and availability

We publish at the time you choose and retry when a network is temporarily unavailable, but we depend on the networks' APIs: posts can be delayed or rejected when a network changes its rules, limits the number of posts, or when an access token expires. Some networks require you to reconnect regularly (LinkedIn every 60 days, for example). Statistics are provided by the networks and may be incomplete or delayed.

## Plans, limits and payments

Plan limits — connected channels, scheduled posts per month, team members, posts to X and features such as the AI assistant, RSS and the API — are shown on the pricing page. A post published to several channels counts once per channel. When an account reaches a limit, new posts can't be scheduled until you upgrade or the next month starts. Paid plans renew or expire according to the billing period you chose. You can change or cancel your plan at any time; already paid periods are not refunded unless the law requires it.

## Your content

You keep all rights to your posts and media. You give us permission to store, process and send them to the networks you choose only to provide the service to you.

## Liability

We work hard to keep {site_name} available, but the service is provided "as is", without warranties of any kind. Our liability is limited to the amount you paid us in the last 12 months.

## Changes

We may update these terms. We will let customers know about important changes; continued use after a change means you accept the new terms.

## Contact

Questions about these terms? Write to {site_email}.`,
  },
];
