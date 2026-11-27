#!/usr/bin/env node
/**
 * npm run diagnose:network [-- extra.host.com ...]
 *
 * Checks, from this server, everything a platform connection needs before any token is involved:
 * DNS (IPv4 and IPv6), a TCP + TLS connection to each address family, and one real HTTPS call to
 * the Graph API. Use it when connecting a channel fails with "Network error ... fetch failed".
 * No secrets are read or sent; nothing is written.
 */
import dns from "node:dns/promises";
import tls from "node:tls";

const HOSTS = ["graph.facebook.com", "www.facebook.com", "rupload.facebook.com", "graph.instagram.com", "api.instagram.com", ...process.argv.slice(2)];
const TIMEOUT_MS = 8000;
const problems = new Set();

const line = (s = "") => console.log(s);
const ms = (t) => `${Date.now() - t} ms`;

function tlsProbe(host, address) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = tls.connect({ host: address, port: 443, servername: host, timeout: TIMEOUT_MS });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.once("secureConnect", () => done({ ok: socket.authorized, detail: socket.authorized ? `TLS ok in ${ms(started)}` : `TLS certificate not trusted: ${socket.authorizationError}` , code: socket.authorized ? "" : String(socket.authorizationError) }));
    socket.once("timeout", () => done({ ok: false, detail: `no connection after ${TIMEOUT_MS} ms`, code: "ETIMEDOUT" }));
    socket.once("error", (e) => done({ ok: false, detail: e.message, code: e.code || "" }));
  });
}

line("Queuezen network diagnosis");
line(`Node ${process.version} on ${process.platform}/${process.arch}`);
for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "NODE_EXTRA_CA_CERTS", "NODE_OPTIONS", "QUEUEZEN_IP_FAMILY"]) {
  if (process.env[k]) line(`  ${k}=${k.toLowerCase().includes("proxy") ? process.env[k].replace(/\/\/[^@/]*@/, "//***@") : process.env[k]}`);
}
line(`DNS servers: ${dns.getServers().join(", ") || "(none)"}`);
line();

for (const host of HOSTS) {
  line(`== ${host}`);
  let addrs = [];
  const t = Date.now();
  try {
    addrs = await dns.lookup(host, { all: true, verbatim: true });
    line(`  DNS ok in ${ms(t)}: ${addrs.map((a) => a.address).join(", ")}`);
  } catch (e) {
    line(`  DNS FAILED (${e.code}): ${e.message}`);
    problems.add("dns");
    continue;
  }
  for (const family of [4, 6]) {
    const a = addrs.find((x) => x.family === family);
    if (!a) {
      line(`  IPv${family}: no address`);
      continue;
    }
    const r = await tlsProbe(host, a.address);
    line(`  IPv${family} ${a.address}: ${r.ok ? "OK" : "FAILED"} (${r.detail})`);
    if (!r.ok) {
      if (/CERT|SELF_SIGNED|UNABLE_TO/.test(r.code)) problems.add("tls");
      else problems.add(`ipv${family}`);
    }
  }
}

line();
line("== HTTPS call to the Graph API (an access-token error here means the API is reachable)");
try {
  const t = Date.now();
  const res = await fetch("https://graph.facebook.com/v26.0/me", { signal: AbortSignal.timeout(15000) });
  const body = await res.text();
  line(`  HTTP ${res.status} in ${ms(t)}: ${body.slice(0, 160)}`);
  if (res.status >= 500) problems.add("api");
} catch (e) {
  let cause = e;
  while (cause && cause.cause) cause = cause.cause;
  line(`  FAILED: ${e.message}${cause && cause !== e ? ` <- ${cause.code || ""} ${cause.message}` : ""}`);
  problems.add("fetch");
}

line();
line("== Result");
if (!problems.size) line("  Everything reachable. If connecting still fails, the cause is in the Meta app or the account (permissions, Page access), not the network.");
if (problems.has("dns")) line("  - DNS: the server cannot resolve Meta hostnames. Fix the resolver (container /etc/resolv.conf or the host's DNS settings).");
if (problems.has("ipv6") && !problems.has("ipv4")) line("  - IPv6 is broken but IPv4 works: set QUEUEZEN_IP_FAMILY=4 in the environment and restart Queuezen (web and worker).");
if (problems.has("ipv4")) line("  - Outbound HTTPS (TCP 443) is blocked or timing out: ask the host to allow outbound connections to graph.facebook.com and the other Meta hosts above.");
if (problems.has("tls")) line("  - HTTPS is intercepted (untrusted certificate): add the proxy's CA with NODE_EXTRA_CA_CERTS=/path/ca.pem, or exclude Meta hosts from the interception.");
if (problems.has("fetch") && !problems.has("ipv4") && !problems.has("dns")) line("  - Raw connections work but Node's fetch fails: check proxy settings and Node version (20.9+).");
if (problems.has("api")) line("  - Meta answered with a server error: retry later (status page: https://metastatus.com).");
process.exitCode = problems.size ? 1 : 0;
