import { XMLParser } from "fast-xml-parser";
import { fetchText } from "./fetcher";

export interface FeedEntry {
  url: string;
  title: string;
  author: string;
  publishedAt: number | null;
  summaryHtml: string;
}

export interface ParsedFeed {
  title: string;
  siteUrl: string | null;
  entries: FeedEntry[];
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: true,
  processEntities: true,
});

function toArray<T>(value: T | T[] | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function asText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj["#text"] === "string") return obj["#text"].trim();
    if (typeof obj["@_href"] === "string") return obj["@_href"].trim();
  }
  return "";
}

function parseDate(raw: string): number | null {
  if (!raw) return null;
  const parsed = Date.parse(raw);
  if (!Number.isNaN(parsed)) return parsed;

  const isoMatch = raw.match(/(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) {
    const d = Date.parse(isoMatch[1]);
    if (!Number.isNaN(d)) return d;
  }
  return null;
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isProbablyFeedXml(text: string): boolean {
  const head = text.slice(0, 3000).toLowerCase();
  return (
    head.includes("<rss") ||
    head.includes("<feed") ||
    head.includes("<rdf:rdf") ||
    head.includes("<?xml")
  );
}

export function parseFeed(xmlText: string, fallbackSiteUrl?: string): ParsedFeed | null {
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xmlText) as Record<string, unknown>;
  } catch {
    return null;
  }

  const rss = doc["rss"] as Record<string, unknown> | undefined;
  if (rss) {
    return parseRss(rss, fallbackSiteUrl);
  }

  const atom = doc["feed"] as Record<string, unknown> | undefined;
  if (atom) {
    return parseAtom(atom, fallbackSiteUrl);
  }

  const rdf =
    (doc["rdf:RDF"] as Record<string, unknown> | undefined) ??
    (doc["RDF"] as Record<string, unknown> | undefined);
  if (rdf) {
    return parseRdf(rdf, fallbackSiteUrl);
  }

  return null;
}

function parseRss(
  rss: Record<string, unknown>,
  fallbackSiteUrl?: string
): ParsedFeed | null {
  const channel = rss["channel"] as Record<string, unknown> | undefined;
  if (!channel) return null;

  const feedTitle = stripHtml(asText(channel["title"]));
  const siteLink = asText(channel["link"]) || fallbackSiteUrl || null;

  const entries: FeedEntry[] = [];
  for (const item of toArray(channel["item"] as Record<string, unknown> | Record<string, unknown>[])) {
    const url = normalizeEntryUrl(asText(item["link"]) || asText(item["guid"]));
    if (!url) continue;
    entries.push({
      url,
      title: stripHtml(asText(item["title"])) || "(untitled)",
      author:
        stripHtml(asText(item["dc:creator"])) ||
        stripHtml(asText(item["author"])),
      publishedAt:
        parseDate(asText(item["pubDate"])) ??
        parseDate(asText(item["dc:date"])) ??
        null,
      summaryHtml:
        asText(item["content:encoded"]) || asText(item["description"]),
    });
  }

  return { title: tidyFeedTitle(feedTitle), siteUrl: siteLink, entries };
}

function parseAtom(
  feed: Record<string, unknown>,
  fallbackSiteUrl?: string
): ParsedFeed | null {
  const feedTitle = stripHtml(asText(feed["title"]));

  let siteUrl: string | null = null;
  for (const link of toArray(feed["link"] as Record<string, unknown> | Record<string, unknown>[])) {
    const rel = typeof link["@_rel"] === "string" ? link["@_rel"] : "alternate";
    const href = typeof link["@_href"] === "string" ? link["@_href"] : "";
    if (rel === "alternate" && href) {
      siteUrl = href;
      break;
    }
  }
  siteUrl = siteUrl || fallbackSiteUrl || null;

  const entries: FeedEntry[] = [];
  for (const entry of toArray(feed["entry"] as Record<string, unknown> | Record<string, unknown>[])) {
    let url = "";
    for (const link of toArray(entry["link"] as Record<string, unknown> | Record<string, unknown>[])) {
      const rel = typeof link["@_rel"] === "string" ? link["@_rel"] : "alternate";
      const href = typeof link["@_href"] === "string" ? link["@_href"] : "";
      if ((rel === "alternate" || !rel) && href) {
        url = href;
        break;
      }
    }
    url = normalizeEntryUrl(url || asText(entry["id"]));
    if (!url) continue;

    entries.push({
      url,
      title: stripHtml(asText(entry["title"])) || "(untitled)",
      author: stripHtml(
        asText((entry["author"] as Record<string, unknown>)?.["name"])
      ),
      publishedAt:
        parseDate(asText(entry["published"])) ??
        parseDate(asText(entry["updated"])) ??
        parseDate(asText(feed["updated"])),
      summaryHtml:
        asText(entry["content"]) || asText(entry["summary"]),
    });
  }

  return { title: tidyFeedTitle(feedTitle), siteUrl, entries };
}

function parseRdf(
  rdf: Record<string, unknown>,
  fallbackSiteUrl?: string
): ParsedFeed | null {
  const channel = rdf["channel"] as Record<string, unknown> | undefined;
  const feedTitle = channel ? stripHtml(asText(channel["title"])) : "";

  const entries: FeedEntry[] = [];
  for (const item of toArray(rdf["item"] as Record<string, unknown> | Record<string, unknown>[])) {
    const url = normalizeEntryUrl(asText(item["link"]));
    if (!url) continue;
    entries.push({
      url,
      title: stripHtml(asText(item["title"])) || "(untitled)",
      author: stripHtml(asText(item["dc:creator"])),
      publishedAt: parseDate(asText(item["dc:date"])),
      summaryHtml:
        asText(item["content:encoded"]) || asText(item["description"]),
    });
  }

  if (entries.length === 0) return null;
  return { title: tidyFeedTitle(feedTitle), siteUrl: fallbackSiteUrl ?? null, entries };
}

// Query params that mark the same article as a different URL across feeds
// and social shares — the reader would otherwise show it twice.
const TRACKING_PARAM = /^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$|ref_src$|ref_url$|cmpid$|spm$|igshid$|si$)/i;

function stripTrackingParams(url: string): string {
  try {
    const parsed = new URL(url);
    const isMedium =
      parsed.hostname === "medium.com" || parsed.hostname.endsWith(".medium.com");
    const isTracking = (key: string) =>
      TRACKING_PARAM.test(key) || (isMedium && key === "source");
    if (![...parsed.searchParams.keys()].some(isTracking)) {
      return url;
    }
    for (const key of [...parsed.searchParams.keys()]) {
      if (isTracking(key)) parsed.searchParams.delete(key);
    }
    const qs = parsed.searchParams.toString();
    return `${parsed.origin}${parsed.pathname}${qs ? `?${qs}` : ""}`;
  } catch {
    return url;
  }
}

function normalizeEntryUrl(raw: string): string {
  const trimmed = raw.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return stripTrackingParams(trimmed.split("#")[0]);
  }
  return "";
}

// Feed titles often carry taglines ("Conversable Economist - In Hume's
// spirit, ..."). Cut the tail at a dash when what remains is still a real
// name; keeps source labels readable in the reader UI.
export function tidyFeedTitle(raw: string): string {
  const title = raw.trim();
  if (title.length <= 48) return title;
  const separators = [" — ", " – ", " - ", " :: ", " | "];
  for (const sep of separators) {
    const idx = title.indexOf(sep);
    if (idx >= 12) {
      const head = title.slice(0, idx).trim();
      if (head.length >= 12) return head;
    }
  }
  return title.slice(0, 60).replace(/\s\S*$/, "") + "…";
}

// EconAcademics is a maintained economics-blog aggregator whose current
// index is HTML (its /feed endpoint is a stale, single-item WordPress feed
// from 2012). Treating this known index as a syndication document gives the
// crawler a fresh, multi-publisher economics channel without a server or API
// key. Keep the adapter deliberately host/path-specific: arbitrary HTML must
// never be mistaken for a feed or turned into an unbounded link firehose.
const ECON_ACADEMICS_INDEX = /^https?:\/\/(?:www\.)?econacademics\.org\/(?:en\.html)?(?:[?#].*)?$/i;

function decodeTextEntities(raw: string): string {
  return raw
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 10))
    )
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16))
    );
}

function cleanHtmlText(raw: string): string {
  return stripHtml(decodeTextEntities(raw));
}

function cleanAggregatorAuthor(raw: string): string {
  const author = cleanHtmlText(raw).trim();
  if (!author || author === "?") return "";
  // Blogger commonly emits "noreply@blogger.com (Jane Doe)". The display
  // name is the useful, muteable identity; the transport address is not.
  const blogger = author.match(/^(?:noreply@blogger\.com|[^\s]+@[^\s]+)\s*\(([^)]+)\)$/i);
  return blogger?.[1]?.trim() || author;
}

export function parseKnownAggregatorHtml(
  htmlText: string,
  sourceUrl: string
): ParsedFeed | null {
  if (!ECON_ACADEMICS_INDEX.test(sourceUrl)) return null;

  const entries: FeedEntry[] = [];
  const seen = new Set<string>();
  // The index is intentionally simple server-rendered HTML. Split on list
  // items first so links cited inside an excerpt cannot be mistaken for the
  // article's canonical URL.
  const itemRe = /<li\b[^>]*>([\s\S]*?)(?=<li\b|<\/ul>)/gi;
  let match: RegExpExecArray | null;
  while ((match = itemRe.exec(htmlText)) !== null && entries.length < 60) {
    const item = match[1];
    const article = item.match(
      /<b>\s*<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>\s*<\/b>/i
    );
    if (!article) continue;

    let url: string;
    try {
      url = normalizeEntryUrl(new URL(decodeTextEntities(article[1]), sourceUrl).toString());
    } catch {
      continue;
    }
    if (!url || seen.has(url) || ECON_ACADEMICS_INDEX.test(url)) continue;

    const byline = item.match(/<br\s*\/?>(?:\s|&nbsp;)*by\s+([\s\S]*?)\s+in\s+<i>/i);
    const date = item.match(/<\/i>\s*,\s*([^<\r\n]+?)\s*(?=<|$)/i);
    const summary = item.match(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/i);

    seen.add(url);
    entries.push({
      url,
      title: cleanHtmlText(article[2]) || "(untitled)",
      author: cleanAggregatorAuthor(byline?.[1] ?? ""),
      publishedAt: parseDate(cleanHtmlText(date?.[1] ?? "")),
      summaryHtml: summary?.[1]?.trim() ?? "",
    });
  }

  if (entries.length === 0) return null;
  return {
    title: "EconAcademics",
    siteUrl: "https://www.econacademics.org/",
    entries,
  };
}

// Parse ordinary XML first, then explicitly supported aggregator formats.
// Exported for the discovery channels and their fixture tests so ingestion
// and source discovery cannot drift into two different interpretations.
export function parseSyndicationDocument(
  text: string,
  sourceUrl: string
): ParsedFeed | null {
  return parseFeed(text, sourceUrl) ?? parseKnownAggregatorHtml(text, sourceUrl);
}

// ---------- fetching + autodiscovery ----------

export async function fetchFeed(source: {
  feed_url: string;
  etag: string | null;
  last_modified: string | null;
}): Promise<{ notModified: boolean; feed: ParsedFeed | null; etag: string | null; lastModified: string | null; finalUrl: string }> {
  const res = await fetchText(source.feed_url, {
    etag: source.etag,
    lastModified: source.last_modified,
  });

  if (res.status === 304) {
    return {
      notModified: true,
      feed: null,
      etag: res.etag,
      lastModified: res.lastModified,
      finalUrl: res.finalUrl,
    };
  }

  if (!res.ok) {
    throw new Error(`feed fetch failed: ${res.status}`);
  }

  return {
    notModified: false,
    // oversized XML is almost always an error page or a firehose; parsing
    // multi-MB docs spikes memory for no reading value
    feed: parseSyndicationDocument(
      res.text.slice(0, 1_500_000),
      res.finalUrl || source.feed_url
    ),
    etag: res.etag,
    lastModified: res.lastModified,
    finalUrl: res.finalUrl,
  };
}

const COMMON_FEED_PATHS = [
  "/atom.xml",
  "/feed.xml",
  "/rss.xml",
  "/index.xml",
  "/feed/",
  "/feed",
  "/rss",
  "/blog/atom.xml",
  "/blog/feed.xml",
  "/blog/feed/",
  "/?feed=rss2",
  "/feeds/posts/default",
];

// When the homepage loads but has no <link rel="alternate">, the site is
// probably not a blog — probing all 12 fallback paths with 8s timeouts is how
// discovery spent minutes on dead domains. Probe a short list instead.
const FALLBACK_PATHS_SHORT = COMMON_FEED_PATHS.slice(0, 4);

export async function discoverFeedUrl(siteUrl: string): Promise<string | null> {
  const deadline = Date.now() + 25_000;

  let homepageOk = false;
  try {
    const res = await fetchText(siteUrl, { timeoutMs: 10000 });
    if (res.ok && res.text) {
      homepageOk = true;
      const fromLinkTag = extractAlternateLinks(res.text, res.finalUrl);
      for (const candidate of fromLinkTag) {
        if (Date.now() > deadline) return null;
        if (await probeIsFeed(candidate)) return candidate;
      }
    }
  } catch {
    // fall through to common paths
  }

  let base: URL;
  try {
    base = new URL(siteUrl);
  } catch {
    return null;
  }

  const paths = homepageOk ? FALLBACK_PATHS_SHORT : COMMON_FEED_PATHS;
  for (const path of paths) {
    if (Date.now() > deadline) return null;
    const candidate = `${base.origin}${path}`;
    if (await probeIsFeed(candidate)) return candidate;
  }

  return null;
}

function absoluteUrl(href: string, baseUrl: string): string | null {
  try {
    const resolved = new URL(href, baseUrl);
    if (!/^https?:$/i.test(resolved.protocol)) return null;
    return resolved.toString().split("#")[0];
  } catch {
    return null;
  }
}

function extractAlternateLinks(html: string, baseUrl: string): string[] {
  const results: string[] = [];
  const re = /<link\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const tag = match[0];
    if (!/\brel=["']?alternate/i.test(tag)) continue;
    if (
      !/\btype=["']application\/(rss|atom)\+xml/i.test(tag) &&
      !/\btype=["']text\/xml/i.test(tag)
    ) {
      continue;
    }
    const hrefMatch = tag.match(/\bhref=["']([^"']+)["']/i);
    if (!hrefMatch) continue;
    const abs = absoluteUrl(decodeEntities(hrefMatch[1]), baseUrl);
    if (abs) results.push(abs);
  }
  return [...new Set(results)];
}

function decodeEntities(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

async function probeIsFeed(url: string): Promise<boolean> {
  try {
    const res = await fetchText(url, { timeoutMs: 8000 });
    if (!res.ok || !res.text) return false;
    if (!isProbablyFeedXml(res.text)) return false;
    const parsed = parseFeed(res.text, url);
    return parsed != null && parsed.entries.length > 0;
  } catch {
    return false;
  }
}
