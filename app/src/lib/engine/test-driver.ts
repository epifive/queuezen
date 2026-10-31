import "server-only";
import fs from "node:fs";
import path from "node:path";
import { storagePath } from "@/lib/config";
import { setDriverOverride } from "@/lib/platforms";
import type { PlatformDriver } from "@/lib/platforms/extras";
import { DriverError, type Platform, type SocialDriver, type UploadState } from "@/social/types";

/**
 * TESTING ONLY. A deterministic driver for the publishing engine's end-to-end tests, installed
 * for every platform when the server runs with QZ_TEST_DRIVER=1 (off by default, never on a real
 * site; demo sites use the Simulated driver instead).
 *
 * "Posts" are appended to storage/test-driver/remote.jsonl (shared by every process using the same
 * storage), so tests can count how often each target was really published. Markers in the post
 * text inject behaviour:
 *   [fail:network:N]       retryable network error on the first N attempts, then success
 *   [fail:rate]            rate limited once (Retry-After 2 min), then success
 *   [fail:auth]            token revoked (needs a reconnect)
 *   [fail:validation]      the platform rejects the post (not retried)
 *   [timeout-after-create] attempt 1 creates the post, then times out: findExisting must find it
 *   [resume]               attempt 1 saves an upload id and fails mid-upload; attempt 2 must continue it
 *   [slow:MS]              takes MS milliseconds before creating the post
 *   [pending:N]            the platform reports "still processing" N times
 *   [find-error]           findExisting() always fails (the engine must not publish blindly)
 * revoke() (Disconnect, workspace deletion) is logged in storage/test-driver/revoked.jsonl.
 */

interface RemotePost {
  id: string;
  key: string;
  channelId: number;
  platform: Platform;
  text: string;
  at: string;
  attempt: number;
  resumedUpload: string | null;
  media: number;
}

function storeDir(): string {
  const dir = storagePath("test-driver");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
const storeFile = () => path.join(storeDir(), "remote.jsonl");
const revokedFile = () => path.join(storeDir(), "revoked.jsonl");

export function readRemotePosts(): RemotePost[] {
  try {
    return fs
      .readFileSync(storeFile(), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as RemotePost);
  } catch {
    return [];
  }
}

function createRemote(post: Omit<RemotePost, "id" | "at">): RemotePost {
  const full: RemotePost = { ...post, id: `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`, at: new Date().toISOString() };
  fs.appendFileSync(storeFile(), `${JSON.stringify(full)}\n`);
  return full;
}

const marker = (text: string, name: string) => new RegExp(`\\[${name}(?::([^\\]]+))?\\]`).exec(text);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function testDriver(platform: Platform): PlatformDriver {
  const unsupported = async (): Promise<never> => {
    throw new DriverError("The test driver can't connect accounts.", "validation", { platform });
  };
  return {
    platform,
    connectStart: unsupported,
    connectFinish: unsupported,
    async refresh() {
      return null;
    },
    async testConnection() {
      return { ok: true };
    },
    async publish(_ctx, input) {
      const { content, target } = input;
      const text = content.text;
      const attempt = target.attempt;
      const state: UploadState = target.uploadState;

      const net = marker(text, "fail:network");
      if (net && attempt <= Number(net[1] ?? 1)) throw new DriverError(`Simulated network error (attempt ${attempt}).`, "network", { platform });
      if (marker(text, "fail:rate") && attempt === 1) throw new DriverError("Simulated rate limit.", "rate_limit", { platform, status: 429, retryAfterMs: 120_000 });
      if (marker(text, "fail:auth")) throw new DriverError("Simulated: the access token was revoked.", "auth", { platform, status: 401 });
      if (marker(text, "fail:validation")) throw new DriverError("Simulated: the platform rejected this post.", "validation", { platform, status: 400 });
      const pending = marker(text, "pending");
      if (pending) {
        const seen = Number(state.pendingSeen ?? 0);
        if (seen < Number(pending[1] ?? 1)) {
          await input.saveState({ pendingSeen: seen + 1 });
          throw new DriverError("Simulated: video still processing.", "network", { platform, code: "pending", retryAfterMs: 15_000 });
        }
      }

      let resumedUpload: string | null = null;
      if (marker(text, "resume")) {
        if (!state.uploadId) {
          await input.saveState({ uploadId: `up_${target.id}`, segment: 1 });
          throw new DriverError("Simulated: connection lost during the upload.", "network", { platform });
        }
        resumedUpload = String(state.uploadId);
        await input.saveState({ segment: 2 });
      }

      const slow = marker(text, "slow");
      if (slow) await sleep(Math.min(120_000, Number(slow[1] ?? 1000)));

      const remote = createRemote({ key: target.idempotencyKey, channelId: input.channel.id, platform, text, attempt, resumedUpload, media: input.media.length });
      if (marker(text, "timeout-after-create") && attempt === 1) throw new DriverError("Simulated: the request timed out after the post was created.", "network", { platform });
      return { externalId: remote.id, permalink: `https://example.test/${platform}/${remote.id}`, publishedAt: remote.at };
    },
    async deleteRemote() {
      return;
    },
    async revoke(_ctx, channel) {
      fs.appendFileSync(revokedFile(), `${JSON.stringify({ channelId: channel.id, platform, at: new Date().toISOString() })}
`);
      return true;
    },
    async fetchMetrics() {
      return [];
    },
    async findExisting(_ctx, input) {
      if (marker(input.content.text, "find-error")) throw new DriverError("Simulated: the lookup of recent posts failed.", "network", { platform });
      const since = Date.parse(input.since);
      const found = readRemotePosts()
        .reverse()
        .find((p) => p.channelId === input.channel.id && p.text === input.content.text && Date.parse(p.at) >= since - 1000);
      return found ? { externalId: found.id, permalink: `https://example.test/${found.platform}/${found.id}` } : null;
    },
  };
}

const drivers = new Map<Platform, SocialDriver>();

export function installTestDriver(): void {
  console.warn("[queuezen] QZ_TEST_DRIVER=1: every platform uses the deterministic TEST driver. Never enable this on a real site.");
  setDriverOverride((platform) => {
    let d = drivers.get(platform);
    if (!d) {
      d = testDriver(platform);
      drivers.set(platform, d);
    }
    return d;
  });
}
