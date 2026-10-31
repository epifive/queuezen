/**
 * Dependency-free RSS 2.0 / RSS 1.0 (RDF) / Atom 1.0 parser for the RSS auto-poster.
 *
 * It only reads what a post needs (title, link, summary, image, date, id) and is deliberately
 * tolerant: real feeds have stray HTML, double-escaped entities and missing fields. It never
 * expands DTD entities (no XXE / "billion laughs"): only the five XML entities and numeric
 * character references are decoded.
 */

export interface FeedItem {
  /** Stable id: guid / Atom id, else the link, else title + date. */
  guid: string;
  title: string;
  link: string;
  /** Plain-text summary (HTML removed, whitespace collapsed). */
  summary: string;
  author: string;
  /** First image found (enclosure, media:content / thumbnail, or <img> in the HTML). */
  image: string;
  /** ISO time, "" when the feed has none / an unreadable one. */
  publishedAt: string;
  categories: string[];
}

export interface ParsedFeed {
  kind: "rss" | "atom" | "rdf";
  title: string;
  link: string;
  items: FeedItem[];
}

export class FeedParseError extends Error {}

const MAX_ITEMS = 200;

/** Decodes the XML entities and numeric references (unknown named entities are kept as text). */
export function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z][a-z0-9]{1,31});/gi, (m, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "";
      return String.fromCodePoint(code);
    }
    const named = NAMED[ref.toLowerCase()];
    return named ?? m;
  });
}

/** The XML entities plus the HTML ones that feeds use most (inside escaped HTML). */
const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  copy: "©",
  reg: "®",
  trade: "™",
  euro: "€",
  pound: "£",
  middot: "·",
  bull: "•",
};

/** The text of an element's raw inner XML: CDATA unwrapped, entities decoded. */
function innerText(raw: string): string {
  let out = "";
  let rest = raw;
  for (;;) {
    const start = rest.indexOf("<![CDATA[");
    if (start < 0) {
      out += decodeEntities(rest);
      break;
    }
    out += decodeEntities(rest.slice(0, start));
    const end = rest.indexOf("]]>", start + 9);
    if (end < 0) {
      out += rest.slice(start + 9);
      break;
    }
    out += rest.slice(start + 9, end);
    rest = rest.slice(end + 3);
  }
  return out;
}

/** HTML → plain text: tags dropped (block tags become spaces), entities decoded, whitespace collapsed. */
export function htmlToText(html: string): string {
  const text = decodeEntities(
    html
      .replace(/<(script|style|iframe|noscript)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<\/(p|div|li|h[1-6]|blockquote|tr)>/gi, " ")
      .replace(/<[^>]*>/g, ""),
  );
  // Control characters (not allowed in posts) become spaces.
  let out = "";
  for (const ch of text) out += ch < " " ? " " : ch;
  return out.replace(/\s+/g, " ").trim();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface Element {
  attrs: Record<string, string>;
  inner: string;
}

function parseAttrs(src: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) attrs[m[1].toLowerCase()] = decodeEntities(m[3] ?? m[4] ?? "");
  return attrs;
}

/** All elements named `name` (qualified, case-insensitive) in `xml`, self-closing ones included. */
function elements(xml: string, name: string, limit = Infinity): Element[] {
  const out: Element[] = [];
  const n = escapeRe(name);
  const re = new RegExp(`<${n}(\\s[^>]*?)?(/>|>([\\s\\S]*?)</${n}\\s*>)`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) && out.length < limit) out.push({ attrs: parseAttrs(m[1] ?? ""), inner: m[3] ?? "" });
  return out;
}

function first(xml: string, names: string[]): Element | null {
  for (const name of names) {
    const [el] = elements(xml, name, 1);
    if (el) return el;
  }
  return null;
}

function firstText(xml: string, names: string[]): string {
  for (const name of names) {
    const [el] = elements(xml, name, 1);
    if (el) {
      const text = innerText(el.inner).trim();
      if (text) return text;
    }
  }
  return "";
}

/** Removes nested blocks that would confuse item-level lookups (e.g. <source> inside an Atom entry). */
function withoutBlocks(xml: string, names: string[]): string {
  let out = xml;
  for (const name of names) out = out.replace(new RegExp(`<${escapeRe(name)}(\\s[^>]*)?>[\\s\\S]*?</${escapeRe(name)}\\s*>`, "gi"), " ");
  return out;
}

function toIso(value: string): string {
  const v = value.trim();
  if (!v) return "";
  let ms = Date.parse(v);
  if (Number.isNaN(ms)) {
    // "Mon, 06 Oct 2026 10:00:00 +0200 (CEST)", "2026-10-06 10:00:00"
    ms = Date.parse(v.replace(/\s*\([^)]*\)\s*$/, "").replace(/^(\d{4}-\d{2}-\d{2}) (\d)/, "$1T$2"));
  }
  if (Number.isNaN(ms)) return "";
  const d = new Date(ms);
  const year = d.getUTCFullYear();
  return year >= 1990 && year <= 2200 ? d.toISOString() : "";
}

function cleanUrl(value: string, base: string): string {
  const v = value.trim();
  if (!v) return "";
  try {
    const u = base ? new URL(v, base) : new URL(v);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : "";
  } catch {
    return "";
  }
}

function imageFrom(itemXml: string, html: string, base: string): string {
  for (const el of elements(itemXml, "enclosure")) {
    if ((el.attrs.type ?? "").startsWith("image/") || /\.(jpe?g|png|gif|webp)(\?|$)/i.test(el.attrs.url ?? "")) {
      const url = cleanUrl(el.attrs.url ?? "", base);
      if (url) return url;
    }
  }
  for (const name of ["media:content", "media:thumbnail"]) {
    for (const el of elements(itemXml, name)) {
      const medium = el.attrs.medium ?? "";
      const type = el.attrs.type ?? "";
      if (name === "media:content" && medium && medium !== "image" && !type.startsWith("image/")) continue;
      const url = cleanUrl(el.attrs.url ?? "", base);
      if (url) return url;
    }
  }
  const img = /<img\b[^>]*?\bsrc\s*=\s*("([^"]+)"|'([^']+)')/i.exec(html);
  return img ? cleanUrl(decodeEntities(img[2] ?? img[3] ?? ""), base) : "";
}

function atomLink(xml: string, base: string): string {
  const links = elements(xml, "link");
  const pick = links.find((l) => !l.attrs.rel || l.attrs.rel === "alternate") ?? links.find((l) => l.attrs.rel !== "self" && l.attrs.rel !== "enclosure");
  return pick ? cleanUrl(pick.attrs.href ?? innerText(pick.inner), base) : "";
}

function itemFrom(xml: string, kind: ParsedFeed["kind"], base: string): FeedItem {
  const own = kind === "atom" ? withoutBlocks(xml, ["source"]) : xml;
  const title = htmlToText(firstText(own, ["title", "dc:title"]));
  const link = kind === "atom" ? atomLink(own, base) : cleanUrl(firstText(own, ["link"]) || (first(own, ["link"])?.attrs.href ?? ""), base) || cleanUrl(firstText(own, ["feedburner:origLink"]), base);
  const html = kind === "atom" ? firstText(own, ["summary", "content", "media:description"]) : firstText(own, ["description", "content:encoded", "summary", "media:description"]);
  const fullHtml = firstText(own, ["content:encoded", "content"]) || html;
  const guidRaw = kind === "atom" ? firstText(own, ["id"]) : firstText(own, ["guid"]) || (first(own, ["item"])?.attrs["rdf:about"] ?? "");
  const publishedAt = toIso(kind === "atom" ? firstText(own, ["published", "updated", "issued"]) : firstText(own, ["pubDate", "dc:date", "published", "updated", "a10:updated"]));
  const author = htmlToText(kind === "atom" ? firstText(first(own, ["author"])?.inner ?? "", ["name"]) : firstText(own, ["dc:creator", "author"]));
  const categories = elements(own, "category", 30)
    .map((c) => htmlToText(c.attrs.term ?? innerText(c.inner)))
    .filter(Boolean);
  const guid = (guidRaw || link || `${title}|${publishedAt}`).trim().slice(0, 1000);
  return {
    guid,
    title: title.slice(0, 500),
    link,
    summary: htmlToText(html).slice(0, 5000),
    author: author.slice(0, 200),
    image: imageFrom(own, fullHtml, base),
    publishedAt,
    categories: [...new Set(categories)].slice(0, 20),
  };
}

/**
 * Parses an RSS 2.0, RSS 1.0 (RDF) or Atom feed. Throws FeedParseError when the document isn't
 * a feed. Items keep the feed's order (usually newest first); items without a link and a title are
 * dropped.
 */
export function parseFeed(input: string, baseUrl = ""): ParsedFeed {
  // Drop the BOM, comments, processing instructions and the DOCTYPE (never expanded).
  const xml = input
    .replace(/^\s+/, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<!DOCTYPE[^[>]*(\[[\s\S]*?\])?\s*>/gi, "");
  let kind: ParsedFeed["kind"];
  if (/<feed[\s>]/i.test(xml) && /<entry[\s>]/i.test(xml)) kind = "atom";
  else if (/<rdf:RDF[\s>]/i.test(xml)) kind = "rdf";
  else if (/<rss[\s>]/i.test(xml) || /<channel[\s>]/i.test(xml)) kind = "rss";
  else if (/<feed[\s>]/i.test(xml)) kind = "atom";
  else throw new FeedParseError("This address doesn't return an RSS or Atom feed.");

  const itemTag = kind === "atom" ? "entry" : "item";
  const firstItem = xml.search(new RegExp(`<${itemTag}[\\s>]`, "i"));
  const head = firstItem >= 0 ? xml.slice(0, firstItem) : xml;
  const feedTitle = htmlToText(firstText(head, ["title"]));
  const feedLink = kind === "atom" ? atomLink(head, baseUrl) : cleanUrl(firstText(head, ["link"]), baseUrl);
  const base = feedLink || baseUrl;

  const items: FeedItem[] = [];
  const seen = new Set<string>();
  for (const el of elements(xml, itemTag, MAX_ITEMS * 2)) {
    // Keep the item's own attributes (rdf:about) visible to itemFrom.
    const item = itemFrom(`<${itemTag} ${Object.entries(el.attrs).map(([k, v]) => `${k}="${v.replace(/"/g, "&quot;")}"`).join(" ")}>${el.inner}</${itemTag}>`, kind, base);
    if (!item.link && !item.title) continue;
    if (seen.has(item.guid)) continue;
    seen.add(item.guid);
    items.push(item);
    if (items.length >= MAX_ITEMS) break;
  }
  return { kind, title: feedTitle.slice(0, 255), link: feedLink, items };
}

/** Detects the character set of a feed from the HTTP header or the XML declaration. */
export function feedCharset(contentType: string | null | undefined, head: string): string {
  const fromHeader = /charset\s*=\s*"?([\w-]+)/i.exec(contentType ?? "")?.[1];
  const fromDecl = /<\?xml[^>]*encoding\s*=\s*["']([\w-]+)["']/i.exec(head)?.[1];
  const value = (fromDecl || fromHeader || "utf-8").toLowerCase();
  return value === "utf8" ? "utf-8" : value;
}
