/**
 * Starter blog posts created on install (Admin → Blog). Markdown.
 * Written without the product name, so they fit any brand ({site_name}, {site_email} and {year} would be replaced).
 */
export const DEFAULT_POSTS = [
  {
    slug: "best-times-to-post-on-each-network",
    title: "Best times to post on each network (and how to find yours)",
    excerpt: "Generic \"best time to post\" charts are a starting point, not an answer. Here is where to start on each network, and how to find the hours that work for your own audience.",
    metaDescription: "Best times to post on Instagram, Facebook, LinkedIn, X, Threads, Bluesky, Mastodon, YouTube, Telegram and Discord, and how to use a best-time heatmap to find your own.",
    content: `## Why "the best time to post" depends on you

Every year someone publishes a chart of the best times to post on each network. They are averages over millions of accounts in every time zone and industry. Your audience is not average: a bakery, a B2B software company and a gaming community are online at very different moments.

So treat the general advice below as a **starting schedule**, then let your own numbers take over.

## Starting points per network

All times are in your audience's local time. If most of your followers live in another time zone, plan in theirs.

- **Instagram:** weekday mornings (8:00–10:00) and early evenings (18:00–20:00). Reels and Stories are less sensitive to timing than feed posts.
- **Facebook Pages:** mid-morning to early afternoon on weekdays (9:00–13:00).
- **LinkedIn:** working hours, Tuesday to Thursday, especially 8:00–10:00 and around lunch. Weekends are quiet.
- **X:** mornings and lunchtime on weekdays. Conversation moves fast, so posting more often matters more than one perfect slot.
- **Threads and Bluesky:** similar to X; mornings and evenings work well for conversational posts.
- **Mastodon:** depends on your instance; a community instance follows its members' time zone.
- **YouTube:** publish a few hours before your viewers' evening peak, so the video is processed and starts collecting views when they arrive.
- **Telegram and Discord:** your community's habits rule. Look at when members are active and avoid posting at night, when notifications annoy more than they help.

## Turn the guesses into a queue

Instead of choosing a time for every post, set a few weekly **queue slots** per channel, for example Monday, Wednesday and Friday at 9:00 for Instagram and Tuesday and Thursday at 8:30 for LinkedIn. Each post you add to the queue takes the next free slot of its channels, in your workspace's time zone, and daylight saving time is handled for you.

Tip: spread your first month's slots over different hours on purpose. If you always post at 9:00, you will never learn whether 18:00 is better.

## Find your own best times with the heatmap

After a few weeks of publishing, open **Analytics** and look at the **best times** heatmap. It works like this:

- Every published post adds its engagement (likes, comments, shares, saves and quotes, as reported by the network) to the cell of the **weekday and hour** it was published, in your workspace's time zone.
- Each cell shows the **average engagement per post**, not the total. Posting ten times at 9:00 doesn't make 9:00 look better by itself.
- The heatmap uses at least the last 90 days of published posts, and you can filter it by channel, because Instagram and LinkedIn audiences rarely peak at the same time.
- The top cells are highlighted as your best times. A cell needs at least two posts before it can be ranked, so one lucky post doesn't mislead you.

Networks whose APIs don't provide post statistics (LinkedIn personal profiles, Telegram and Discord) can't contribute to the heatmap. For those, use short links: their daily click counts show when your audience acts on what you post.

## Adjust, then repeat

1. Move one or two queue slots towards the darkest cells of the heatmap.
2. Keep one "experimental" slot at a time you haven't tried yet.
3. Check again after a month.

Timing won't save a weak post, but the same good post published when your audience is around simply gets seen by more people. A few minutes with the heatmap each month is enough to keep your schedule tuned.`,
  },
  {
    slug: "client-approval-workflow",
    title: "How to set up a client approval workflow",
    excerpt: "Screenshots in email, feedback in chat and a final version nobody can find. Here is a lighter way to get posts approved by managers and clients, step by step.",
    metaDescription: "Set up a social media approval workflow: roles for writers and approvers, approval required for editors, and client approval links that need no login.",
    content: `## The problem with approvals by email

Most teams approve social posts the same way: someone writes a draft, takes a screenshot, emails it, waits, and copies the corrected text back. Feedback gets lost, the wrong version goes out and the post misses its slot. A good workflow keeps the post, the comments and the decision in one place.

## Step 1: one workspace per client

Create a workspace for each brand or client. It has its own channels, calendar, queue, media and team, so nothing from one client ever ends up on another client's account.

## Step 2: give everyone the right role

Each member of a workspace has a role:

- **Owner and admins** manage channels, members and settings, publish directly and can approve.
- **Editors** write, schedule and upload media. When the workspace requires approval, their posts go to review first.
- **Approvers** read everything, comment, and approve or send back posts, without editing or publishing. The right role for a manager or a client who wants an account.
- **Viewers** can see everything (posts, calendar, analytics) but change nothing.

## Step 3: turn on "approval required"

In the workspace settings, require approval. From then on, an editor who schedules a post sends it for approval instead. Admins and approvers see it in their **pending approval** list, with a preview for each network, and approve it or send it back with a comment that says what to change. An approved post takes its planned time; a post sent back returns to the editor as a draft, with the comment attached.

## Step 4: send clients an approval link

Most clients don't want another login. Create an **approval link** instead:

1. Choose what it shows: everything waiting for approval, the posts planned between two dates, or a hand-picked selection.
2. Give it a name (it becomes the page title, for example "November posts for Acme").
3. Choose how long it stays valid (90 days at most) and, if you like, a password to share separately.

Your client opens the link and sees each post as it will be published, with its networks, media, first comment and planned time in your time zone. They type their name, add a comment if needed, and click **Approve** or **Send back**. Their decision and comment appear in the post's history and the team is notified.

Copy the link when you create it: for security it is shown only once. You can see when it was last opened and revoke it at any time. On plans with white label, the page carries your own logo, colour and company name.

## Step 5: get notified

Connect a notification channel (email, Slack, Microsoft Teams, Discord, Telegram or a webhook) so the right people hear about it when a post is waiting for approval and when a decision is made. Nobody has to keep checking.

## Plan for review time

- Write posts at least a few days before they're due, so there is time for one round of changes.
- Agree on a weekly review moment with each client and send one link with that week's posts.
- When the same feedback comes up again and again, turn it into a short brand guideline for the team.

The goal is fewer rounds, not more rules. With roles, approval required and client links, a week of posts can be reviewed in minutes, and everyone can answer "who signed this off?" months later.`,
  },
  {
    slug: "evergreen-content-recycling",
    title: "Evergreen content: recycling posts without annoying your audience",
    excerpt: "Your best posts were seen by a fraction of your followers. Recycling them is smart, as long as you do it with care. Here is how.",
    metaDescription: "How to recycle evergreen social media posts: what to reuse, how often, how to avoid duplicates on X, and how to keep the queue full without spamming followers.",
    content: `## Most of your audience missed your best post

A post is seen by a small share of your followers, mostly in the first hours after publishing. New followers never saw it at all. If a post was useful a month ago and is still true today, publishing it again isn't lazy: it's a service to the people who missed it.

## What counts as evergreen

Good candidates stay accurate and relevant for months:

- How-to tips, checklists and guides
- Answers to questions customers ask again and again
- Your best-performing educational posts
- Links to cornerstone articles or product pages that don't change often

Bad candidates are anything with a date: events, launches, limited offers, news, holiday greetings and posts that reply to something happening that week.

## Mark posts as evergreen

Mark a post as evergreen in the composer, or later from the list of recently published posts on the recycling page. Only published evergreen posts are recycled, and each copy goes back into the **next free queue slot** of its channels as a new post, so it fits your normal rhythm instead of jumping the line.

## Choose the rhythm

The recycling settings decide how it behaves:

- **Wait (days):** how long to wait before the same post goes out again. 30 days is a sensible default; for fast networks such as X or Threads, 14 days can work, while LinkedIn and Facebook usually deserve longer gaps.
- **Times per post:** how often one post may be recycled (3 by default). Retire posts once they've had their run.
- **Posts per hour:** how many posts are recycled each hour at most, so the queue never floods.
- **Random order:** off means the posts that waited longest go first; on mixes things up.
- **Channels for the copies:** the original post's channels, or a selection, for example only X and Threads.

Copies count towards the monthly post limit like any scheduled post.

## Avoid looking like a bot

- **Vary the copies.** X rejects posts identical to a recent one, so copies for X get a small variation automatically (their hashtags are rotated). Still, refreshing the first line or the image now and then helps on every network.
- **Mix recycled and new posts.** A good rule of thumb: no more than one recycled post for every three or four new ones.
- **Watch the numbers.** If a recycled post performs much worse than the original, retire it.
- **Keep it accurate.** Before a post goes out again, make sure prices, links and facts are still right.

## Combine it with RSS

Recycling keeps your best posts alive; RSS auto-posting keeps new content flowing. Connect your blog's feed and each new article becomes a draft, a queued post or an instant post. Together they keep the queue full, so your accounts stay active even in the weeks you have no time to write.`,
  },
];
