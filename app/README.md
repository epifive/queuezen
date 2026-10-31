# Queuezen

Social media scheduler SaaS (Buffer / Hootsuite / Publer style), built with **Next.js 16**,
**React 19** and **Tailwind CSS 4**. Customers create workspaces (one per brand or client),
connect their social accounts (Facebook Pages, Instagram with Facebook Login or Instagram Login,
Threads, X, LinkedIn profiles, YouTube, Bluesky, Mastodon, Telegram, Discord), write a post once,
adapt it per network, get it approved and let the queue publish it on time. Includes queue slots,
a calendar, first comments and threads, bulk CSV import, RSS auto-posting, evergreen recycling,
tracked short links with UTM tags, analytics with a best-time heatmap, an AI assistant (bring your
own OpenAI-compatible or Anthropic key), teams with roles and client approval links, notification
channels (email, signed webhook, Slack, Discord, Microsoft Teams, Telegram), a REST API, paid plans
with limits, four payment gateways, a blog, multi-language/RTL and a full admin panel.

Every network is reached through its official API with the operator's own developer apps
(Admin → Platforms has a setup wizard per network). No scraping, no browser automation, no SDKs.

The complete guide is in [`documentation/index.html`](../documentation/index.html) (open it in a browser).

## Quick start (local)

```bash
npm install
npm run dev
```

Open http://localhost:3000. You are redirected to the web installer at `/install`.
Choose **SQLite** for a zero-setup local database (Node.js 22.13+), or **MySQL** for production.

Meta, X, LinkedIn and Google only accept public `https://` redirect URIs, and Instagram/Threads
download media from a public URL, so on `localhost` switch on **Admin → Platforms → Simulated
platforms** (fake consent screens and publishing) or use an HTTPS tunnel as the Site URL.
Bluesky, Mastodon, Telegram and Discord work for real from localhost.

Background jobs run in "lazy mode" by default (after page views, at most once a minute). Scheduled
posts only go out on time when something runs the jobs every minute: start the worker in a second
terminal with the secret from Admin → System → Scheduler, or call the cron URL from a cron job:

```bash
CRON_SECRET=the-secret-from-admin npm run worker
```

## Production

```bash
npm install
npm run build
npm start            # or: node server.js  (cPanel / Passenger / PM2)
```

Requirements: Node.js 20.9+ (22.13+ for the SQLite option), MySQL 5.7+/MariaDB 10.3+ (recommended)
or the built-in SQLite option, **HTTPS on a public domain** (OAuth redirect URIs, media fetched by
Meta), a **1-minute scheduler** (cron URL or worker), media storage (local disk, S3-compatible or
Vercel Blob), outbound HTTPS to the networks' APIs, and SMTP for emails. Behind Nginx set
`client_max_body_size` above the largest video size (the default 1 MB breaks uploads).

### Secrets

| Variable | Why |
| -------- | --- |
| `CRON_SECRET` | Protects the cron URL `/api/cron/tick` and is used by the worker. **12+ random characters** (e.g. `openssl rand -hex 24`); shorter values and the example `change-me-to-a-long-random-string` are ignored (the app then uses a secret stored in the database, so the worker gets `401`). Without it, a secret is generated and shown in Admin → System → Scheduler. |
| `APP_SECRET` | 16+ characters. Encrypts the credentials of connected channels (AES-256-GCM, key = HKDF(secret, purpose)) and signs OAuth state, upload tokens and approval-link cookies. Without it, one is generated in `storage/config.json` (or a `settings` row on read-only disks). **Set it on Vercel and whenever several servers/containers run the app**, and never change it afterwards: stored tokens can't be decrypted with another secret (customers must reconnect every channel). |

### Background jobs and the worker

Every "tick" (`src/lib/scheduler.ts`) runs the jobs of `src/lib/jobs/index.ts` in order, within a
time budget (cron URL 45 s, lazy 8 s, "Run jobs now" 25 s), with a lock so ticks never overlap:

| Job | What it does |
| --- | --- |
| `publish` | The publishing engine (`src/lib/engine`): claims due `post_targets` (batches of 8, 3-min lease, max 3 per channel per tick, 4 channels in parallel, up to 70 % of the budget), retries after 1/5/15/60 min (max 5 attempts), per-account limits, `findExisting()` before retries. Every tick. Prunes `post_attempts` > 180 days daily. |
| `token-refresh` | X (2 h) / YouTube (1 h) within 30 min of expiry, Instagram Login / Threads 15 days before; LinkedIn re-auth reminder 7 days before the 60-day end; marks revoked channels `expired`. Every 10 min. |
| `rss` | Up to 10 due feeds per tick (conditional GET, dedupe by guid hash). Every tick. |
| `recycle` | Evergreen posts back into the queue as new posts. Hourly. |
| `metrics` | Post analytics: hourly during day 1, then daily until `metrics_days` (30). Every 10 min. |
| `housekeeping` | Sessions, reset links, invites, approval links expired > 30 days, alert log > 90 days. Hourly. |

Something must start ticks:

| Method | How | Notes |
| ------ | --- | ----- |
| Cron URL | `curl -fsS -m 70 "https://your-site/api/cron/tick?key=SECRET"` **every minute** | cPanel, shared hosting, Vercel (external cron service; Vercel Hobby cron runs only daily). Also accepts `Authorization: Bearer SECRET` (as sent by Vercel Cron). |
| Worker | `CRON_SECRET=… npm run worker` (calls the cron URL every 15 s) | VPS / Docker. `WORKER_URL` (default `SITE_URL`, else `http://localhost:$PORT`), `WORKER_INTERVAL_SEC` (default 15, min 5). |
| Lazy mode | On by default (Admin → Settings → Scheduler) | Only while there is activity. Not for production. |

- **PM2:** `ecosystem.config.cjs` starts the app (`queuezen`) and the worker (`queuezen-worker`).
  Export `CRON_SECRET` before `pm2 start ecosystem.config.cjs` (both processes read it).
- **Docker:** `docker-compose.yml` runs `app`, `worker` and MySQL 8.4; it refuses to start without
  `CRON_SECRET` in a `.env` file next to it.

### Media storage

`src/lib/media/storage.ts`: `local` (`storage/uploads/media`, served by `/api/media/f/<key>` with
ranges; uploads streamed by `PUT /api/media/upload?token=…`, which is excluded from `src/proxy.ts`
so Next.js doesn't buffer it), `s3` (AWS S3, Cloudflare R2, MinIO, Wasabi, B2; SigV4 presigned PUT,
needs a bucket CORS rule and a public URL) and `blob` (Vercel Blob client uploads). Admin →
Settings → Media storage, overridden by `STORAGE_DRIVER`, `S3_*` and `BLOB_READ_WRITE_TOKEN`.
Facebook, Instagram, Threads (and Telegram for small files) fetch media from its public URL; the
other drivers stream the bytes from storage.

## Architecture

```
src/social/                The contract (dependency-free; server, client and tests)
  types.ts                 Platform ids, workspace roles/capabilities, PostContent, PlatformOptions,
                           ChannelCredentials, SocialDriver interface, DriverError (kinds +
                           retryable), notification events, REST API shapes
  platforms.ts             Capabilities registry per platform: text limits and counting, media rules,
                           post types (reels, stories), links, first comment, threads, analytics,
                           auth kind, token lifetimes, scopes, review notes, per-account limits,
                           X pricing, docs
  normalize.ts             validatePostForChannel(), countChars() (X weighting, graphemes…),
                           nextQueueSlot() (time zones, DST), buildUtmUrl(), roles, status
                           transitions, retryDelayMs(), settings normalisers, input helpers
  format.ts                Platform names, colours and original icon glyphs, status tones, money
src/lib/
  platforms/               One driver per network (meta.ts = Facebook + Instagram ×2, threads, x,
                           linkedin, youtube, bluesky, mastodon, telegram, discord), drivers.ts
                           (registry), runtime.ts (app credentials from settings, driver context,
                           SSRF-guarded fetch, token refresh, platform_usage_daily meters, connect
                           picker sessions), connect.ts (OAuth/form connect flow), setup-guide.ts
                           (Admin → Platforms wizard), app-test.ts (credential tests),
                           data-deletion.ts (Meta signed_request), simulated.ts (demo / testing)
  engine/                  Publishing engine (claims, leases, saveState, findExisting, retries,
                           per-account limits), targets.ts (retry, delete on network, reschedule,
                           queue swap/shuffle/pause, Post now), csv-import.ts, test-driver.ts
  media/                   Media library service (upload tokens, probing, folders, in-use lock),
                           storage adapters, SigV4, remote imports
  rss/, recycle.ts         RSS/Atom parser and auto-posting; evergreen recycling + queue placement
  approvals.ts             Approval decisions, client approval links, approval notifications
  analytics/               Publications, totals, per channel, top posts, heatmap math
  shortlinks.ts, ai.ts     Tracked short links (/l/<code>); AI assistant providers and prompts
  workspaces.ts, channels.ts, posts.ts, usage.ts, plans.ts
                           Workspaces/members/invites; channels (encrypted credentials, limits,
                           queue slots); posts + post_targets (validation, quota, status rules);
                           monthly usage of the owner; plan entitlements
  oauth-state.ts, crypto.ts Signed OAuth state + PKCE + sealed cookie; app secret, AES-GCM, HMAC
  notify/, notify-channels.ts   Notification channels and senders, quota notifications
  jobs/, scheduler.ts, lazy-tick.ts   Background jobs (tick lock, lazy mode, cron URL, worker)
  api-keys.ts, api-guard.ts, api-v1.ts   REST API keys, auth + rate limits, helpers
  db/                      Kysely (MySQL + SQLite), migrations (schema, default plans), seeds,
                           demo seed
  i18n/messages.ts         Every interface string in English (source for translations)
app/(dashboard)/dashboard/w/[wid]/   Workspace dashboard (compose, calendar, queue, posts, media,
                           analytics, automation, links, channels, team, notifications, API keys,
                           settings)
app/admin/                 Admin panel (incl. Platforms and System → Scheduler)
app/approve/[token]/       Client approval links
app/l/[code]/              Short link redirect
app/api/oauth/[platform]/  start, callback ({SITE_URL}/api/oauth/<platform>/callback), simulate
app/api/meta/data-deletion/   Meta data deletion callback + status page
app/api/media/             init, upload (local), complete, f/<key> (local files)
app/api/v1/                REST API: channels, posts (+ approve/reject), media, analytics
app/api/ai/                Composer AI assistant
app/api/cron/tick/         Cron URL: runs one scheduler tick (secret required)
app/api/payments/          Payment gateway callbacks for the platform's own plans
scripts/worker.mjs         Worker: calls /api/cron/tick every WORKER_INTERVAL_SEC (15 s)
languages/                 Complete Arabic and Hindi language packs (import in Admin → Languages)
storage/                   Created at runtime: config.json (+ appSecret), SQLite database, uploads
```

### Workspaces and routing

Every dashboard page lives under `/dashboard/w/<workspace id>/…`. `/dashboard` creates the user's
personal workspace on the first visit and redirects to the workspace used last (cookie `qz_ws`,
only a hint) or the personal one. Pages call `requireWorkspace(wid, minRole)` (404 for
non-members); Server Actions call `guardWorkspace(wid, { capability })`. Roles, lowest to highest:
viewer, approver, editor, admin, owner (`roleCan()` covers capabilities such as "approve").

Plan limits belong to the workspace **owner** and count across every workspace they own:
channels (`max_channels`), scheduled posts per month (`max_scheduled_monthly`, one post on three
channels counts three), team seats (`max_members`, pending invites included), posts to X
(`max_x_posts_monthly`, 0 = none, -1 = unlimited) and AI requests (`max_ai_monthly`, 0 =
unlimited). Other limits: 0 = unlimited.

### Publishing life cycle

`post_targets` (one row per post × channel): `pending → scheduled → claimed → uploading →
container_created → publishing → published | failed | needs_reauth` (`cancelled` when removed).
Claims are conditional UPDATEs (safe across lazy tick, cron and worker on MySQL and SQLite);
drivers call `saveState()` before each irreversible step (persisted to `upload_state`, guarded by
the lease token); retries and resumed runs call `driver.findExisting()` first. Post status is
aggregated from its targets (`published`, `partially_failed`, `failed`, `publishing`).

## REST API

`/api/v1`, `Authorization: Bearer qz_…` (keys in Dashboard → API keys; one workspace per key; the
owner's plan needs API access). `GET /channels`, `GET|POST /posts`, `GET|PATCH|DELETE /posts/{id}`,
`POST /posts/{id}/approve`, `POST /posts/{id}/reject`, `GET|POST /media`, `POST /media/complete`,
`GET /analytics`. Errors are `{ "error": "…" }` with 401/403/404/409/413/422/429. 600 requests/min
per key, 120 writes/min. See the documentation for request and response examples.

## Scripts

| Command                | Description                                            |
| ---------------------- | ------------------------------------------------------ |
| `npm run dev`          | Start the development server                           |
| `npm run build`        | Build the production app                               |
| `npm start`            | Start the production server                            |
| `npm run start:server` | Start via `server.js` (hosting panels, PM2)            |
| `npm run worker`       | Run a scheduler tick every 15 s (needs `CRON_SECRET`)  |
| `npm run lint`         | ESLint                                                 |
| `npm run typecheck`    | TypeScript check                                       |

## Extending

- **Platform driver:** add the id to `PLATFORMS` / `V1_PLATFORMS` (`src/social/types.ts`) and its
  entry to `PLATFORM_CAPABILITIES` (`src/social/platforms.ts`), its style in `src/social/format.ts`;
  implement `SocialDriver` in `src/lib/platforms/<platform>.ts` (throw `DriverError` only, use
  `ctx.fetch`, call `saveState()` before each irreversible step, implement `findExisting()`, return
  a `usage` block) and add it to `BUILTIN_DRIVERS` (`drivers.ts`). Operator app: settings keys in
  `SETTING_DEFAULTS`/`SECRET_SETTINGS`, a case in `appConfigFor()` (`runtime.ts`), a `SetupGuide`
  in `setup-guide.ts`, optionally a test in `app-test.ts`. The Simulated driver covers every id.
- **Notification channel:** `NOTIFY_CHANNEL_TYPES`/`NotifyConfigByType` in `src/social/types.ts`,
  `normalizeNotifyConfig`/`notifyConfigProblem` in `src/social/normalize.ts`, a sender in
  `src/lib/notify/` using `describeNotification()` and `deliver()`, a case in `sendNotification()`,
  the form in `src/components/dashboard/notify-forms.tsx` and `dash.notify.*` messages.
- **Background job:** implement `Job` (`src/lib/jobs/index.ts`), throttle it with
  `isDue()`/`scheduleNext()` from `jobs/shared.ts`, and add it to `JOBS`.

Run `npm run typecheck && npm run build` and restart the app and the worker after changes.

## Environment variables

Optional; the web installer writes `storage/config.json`. `.env.example` lists every variable the
code reads: database (`DATABASE_URL` or `DB_*`), `APP_INSTALLED`, `ADMIN_*`, `SITE_URL`,
`STORAGE_DIR`, `PORT`/`HOST`, `TRUSTED_PROXY_HOPS`, `CRON_SECRET`, `APP_SECRET`, `WORKER_URL`,
`WORKER_INTERVAL_SEC`, media storage (`STORAGE_DRIVER`, `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`,
`S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_PUBLIC_URL`, `S3_PATH_STYLE`,
`BLOB_READ_WRITE_TOKEN`), `DEMO_MODE`, `DEMO_SEED` and `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`.

Testing / single-company only, never on a public platform: `ALLOW_PRIVATE_WEBHOOKS`,
`ALLOW_PRIVATE_FEEDS` (private addresses for webhooks / RSS feeds), `QZ_TEST_DRIVER` (deterministic
test driver for every network), `QZ_TEST_METRICS` (fake analytics), `QUEUEZEN_TEST_API_OVERRIDES`
(send API prefixes to mock servers), `AI_ANTHROPIC_BASE_URL` (mock Anthropic API), `NEXT_DIST_DIR`.
