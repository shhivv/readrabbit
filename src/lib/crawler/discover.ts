import {
  classifyDomain,
  looksLikeArticlePath,
  rootDomain,
} from "./classify";
import {
  discoverFeedUrl,
  parseFeed,
  parseSyndicationDocument,
  selectFeedEntriesByDomain,
  type FeedEntry,
} from "./feeds";
import { fetchText, HostScheduler } from "./fetcher";
import {
  getDb,
  kvGetJson,
  kvSetJson,
  upsertSource,
  type Topic,
} from "../db";

// Discovery finds new personal blogs by mining links that seeded sources
// already cite, plus Hacker News for technology. Repeatedly-cited domains
// rank higher (a domain linked from many posts is likelier to be signal).

interface CandidatePool {
  [domain: string]: {
    sampleUrl: string;
    siteUrl: string;
    count: number;
    topic: Topic;
    addedAt: number;
    origin: "outbound" | "hn" | "aggregator";
  };
}

const CANDIDATES_KEY = "disco:candidates";
const REJECTED_KEY = "disco:rejected";
const HN_LAST_KEY = "disco:hn_last_at";
const COMMUNITY_LAST_KEY = "disco:community_last_at";
const SMALL_WEB_LAST_KEY = "disco:small_web_last_at";
const REDDIT_ECON_LAST_KEY = "disco:reddit_econ_last_at";
export const HN_DIRECT_ARTICLE_LIMIT = 36;
export const SMALL_WEB_DIRECT_ARTICLE_LIMIT = 30;
export const REDDIT_ECON_DIRECT_ARTICLE_LIMIT = 12;

const HN_RESULTS_PER_PAGE = 100;
const HN_MAX_PAGES = 4;

export interface HnStory {
  url: string;
  title: string;
  publishedAt: number | null;
  points: number;
  commentCount: number;
  isFrontPage: boolean;
}

export interface HnDiscoveryResult {
  candidateDomainsAdded: number;
  stories: HnStory[];
}

export interface SmallWebStory {
  url: string;
  title: string;
  publishedAt: number | null;
  author: string;
  topic: Topic;
}

export type RedditEconomicsStory = SmallWebStory;

// The pool lives in memory during a crawl and is persisted only at phase
// boundaries (flushCandidates). The old write-through version re-serialized
// the entire JSON blob per link batch — hundreds of kv round-trips per crawl.
let poolCache: CandidatePool | null = null;
let poolDirty = false;

export async function loadCandidates(): Promise<CandidatePool> {
  if (!poolCache) {
    poolCache = (await kvGetJson<CandidatePool>(CANDIDATES_KEY)) ?? {};
  }
  return poolCache;
}

export async function flushCandidates(): Promise<void> {
  if (poolCache && poolDirty) {
    await kvSetJson(CANDIDATES_KEY, poolCache);
    poolDirty = false;
  }
}

function normalizeCandidateUrl(url: string): {
  siteUrl: string;
  domain: string;
  path: string;
} | null {
  try {
    const parsed = new URL(url);
    if (!/^https?:$/i.test(parsed.protocol)) return null;
    const domain = parsed.host.replace(/^www\./, "").toLowerCase();
    const path = parsed.pathname.replace(/\/+$/, "");
    // site root: scheme + host (+ first path segment, often /blog)
    const segments = path.split("/").filter(Boolean);
    const keepSegments = segments.length > 0 && !looksLikeArticlePath(url) ? segments : segments.slice(0, segments.length > 1 && /^blog|writing|posts|articles|essays|notes$/.test(segments[0]) ? 1 : 0);
    const siteUrl = `${parsed.protocol}//${parsed.host}${keepSegments.length ? "/" + keepSegments.join("/") : ""}`;
    return { siteUrl, domain, path };
  } catch {
    return null;
  }
}

export function collectOutboundLinks(
  html: string,
  baseUrl: string,
  options: { allowRootPaths?: boolean; topicHint?: Topic } = {}
): Array<{ url: string; topicHint: Topic }> {
  try {
    const base = new URL(baseUrl);
    const results: Array<{ url: string; topicHint: Topic }> = [];
    const seen = new Set<string>();
    const re = /<a\s[^>]*href=["']([^"']+)["'][^>]*>/gi;
    let match: RegExpExecArray | null;
    while ((match = re.exec(html)) !== null && results.length < 40) {
      const href = match[1];
      let resolved: URL;
      try {
        resolved = new URL(href, base);
      } catch {
        continue;
      }
      if (!/^https?:$/i.test(resolved.protocol)) continue;
      if (resolved.host === base.host) continue; // same-origin: not discovery
      const abs = `${resolved.protocol}//${resolved.host}${resolved.pathname}`;
      if (seen.has(abs)) continue;
      if (!options.allowRootPaths && !looksLikeArticlePath(abs)) continue;
      if (options.allowRootPaths) {
        // root paths allowed, but still skip obvious non-site links
        const path = resolved.pathname.toLowerCase();
        if (!looksLikeArticlePath(abs) && path !== "/" && path !== "") continue;
        if (/\.(pdf|jpg|jpeg|png|gif|zip|mp3|mp4)$/i.test(path)) continue;
      }
      const cls = classifyDomain(abs);
      if (!cls.allowed) continue;
      seen.add(abs);
      results.push({ url: abs, topicHint: options.topicHint ?? "technology" });
    }
    return results;
  } catch {
    return [];
  }
}

export function enqueueCandidates(
  links: Array<{ url: string; topicHint?: Topic }>,
  origin: "outbound" | "hn" | "aggregator"
): void {
  if (!links.length || !poolCache) return;
  let changed = false;
  for (const link of links.slice(0, 30)) {
    const normalized = normalizeCandidateUrl(link.url);
    if (!normalized) continue;
    const existing = poolCache[normalized.domain];
    if (existing) {
      existing.count += 1;
      // A topic-specific aggregator is stronger evidence than an incidental
      // cross-link. This also repairs old candidates written by the former
      // hard-coded-technology outbound collector.
      if (origin === "aggregator" && link.topicHint) {
        existing.topic = link.topicHint;
        existing.origin = "aggregator";
      }
      changed = true; // citation counts feed probe ranking — persist them
      continue;
    }
    poolCache[normalized.domain] = {
      sampleUrl: link.url,
      siteUrl: normalized.siteUrl,
      count: 1,
      topic: link.topicHint ?? "technology",
      addedAt: Date.now(),
      origin,
    };
    changed = true;
  }

  // cap pool size: drop oldest beyond 400
  const entries = Object.entries(poolCache);
  if (entries.length > 600) {
    entries.sort((a, b) => b[1].count - a[1].count || b[1].addedAt - a[1].addedAt);
    poolCache = Object.fromEntries(entries.slice(0, 600));
  }
  if (changed) poolDirty = true;
}

// Parse HN separately from its publisher-feed discovery path. A sufficiently
// popular link is already useful recommendation evidence; requiring the
// publisher to expose a discoverable RSS feed loses that exact article and
// biases HN toward prolific sites. Domain classification intentionally does
// not run here: it still protects long-lived feed discovery, while the HN vote
// threshold is the curator for these bounded, one-off article fetches.
export function parseHnStories(
  data: unknown,
  limit = HN_DIRECT_ARTICLE_LIMIT
): HnStory[] {
  if (!data || typeof data !== "object") return [];
  const boundedLimit = Math.max(0, Math.floor(limit));
  if (boundedLimit === 0) return [];
  const hits = (data as { hits?: unknown }).hits;
  if (!Array.isArray(hits)) return [];

  const stories: HnStory[] = [];
  const seen = new Set<string>();
  for (const raw of hits) {
    if (!raw || typeof raw !== "object") continue;
    const hit = raw as {
      url?: unknown;
      title?: unknown;
      created_at_i?: unknown;
      created_at?: unknown;
      points?: unknown;
      num_comments?: unknown;
      _tags?: unknown;
    };
    if (typeof hit.url !== "string" || typeof hit.title !== "string") continue;
    const title = hit.title.trim();
    if (!title) continue;

    let parsed: URL;
    try {
      parsed = new URL(hit.url);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(parsed.protocol)) continue;
    const host = parsed.host.toLowerCase();
    if (host === "news.ycombinator.com" || host.endsWith(".news.ycombinator.com")) {
      continue;
    }
    if (host === "hnrss.org" || host.endsWith(".hnrss.org")) continue;
    parsed.hash = "";
    const url = parsed.toString();
    if (seen.has(url)) continue;
    seen.add(url);

    let publishedAt: number | null = null;
    if (
      typeof hit.created_at_i === "number" &&
      Number.isFinite(hit.created_at_i) &&
      hit.created_at_i > 0
    ) {
      publishedAt = Math.trunc(hit.created_at_i * 1000);
    } else if (typeof hit.created_at === "string") {
      const parsedDate = Date.parse(hit.created_at);
      if (!Number.isNaN(parsedDate)) publishedAt = parsedDate;
    }

    stories.push({
      url,
      title,
      publishedAt,
      points:
        typeof hit.points === "number" && Number.isFinite(hit.points)
          ? Math.max(0, Math.trunc(hit.points))
          : 0,
      commentCount:
        typeof hit.num_comments === "number" &&
        Number.isFinite(hit.num_comments)
          ? Math.max(0, Math.trunc(hit.num_comments))
          : 0,
      isFrontPage:
        Array.isArray(hit._tags) && hit._tags.includes("front_page"),
    });
    if (stories.length >= boundedLimit) break;
  }
  return stories;
}

// HN is valuable because its readers discover one-off independent work that
// will never appear in a fixed feed catalog. Popularity alone, however, turns
// the stream into product announcements and breaking news. This deliberately
// blends a playful/experimental lane with a general viral-writing lane.
function hnPlayfulness(title: string): number {
  const normalized = title.toLowerCase();
  let score = 0;
  if (/^show hn\b/.test(normalized)) score += 2;
  if (
    /\b(paint|draw|art|visual(?:ize|izing|ization)?|animation|game|map|music|piano|creative|design|3d)\w*/.test(
      normalized
    )
  ) {
    score += 3;
  }
  if (
    /\b(i built|i made|i trained|building|making|training|experiment(?:ing)?|playing|exploring|from scratch|inside|how i)\b/.test(
      normalized
    )
  ) {
    score += 2;
  }
  if (
    /\b(weird|tiny|accident(?:al|ally)?|unexpected|reverse.engineer(?:ing)?|interactive|simulat\w*|playground|toy|museum)\b/.test(
      normalized
    )
  ) {
    score += 2;
  }
  return score;
}

function hnStoryDomain(story: HnStory): string {
  try {
    return rootDomain(new URL(story.url).host);
  } catch {
    return "";
  }
}

function hnSelectionScore(story: HnStory): number {
  return (
    Math.log2(Math.max(1, story.points) + 1) +
    hnPlayfulness(story.title) * 1.5
  );
}

function isLikelyHnReadingDestination(story: HnStory): boolean {
  if (!looksLikeArticlePath(story.url)) return false;
  const title = story.title.trim();
  // Bare product/model names and wire-style event headlines may belong on HN,
  // but they are not the personal essays and experiments this reader promises.
  if ((title.match(/\S+/g) ?? []).length < 4) return false;
  try {
    if (
      /\/(?:press|press-release|newsroom)(?:\/|$)/i.test(
        new URL(story.url).pathname
      )
    ) {
      return false;
    }
  } catch {
    return false;
  }
  if (
    /\b(acquires?|acquisition|agrees to acquire|introduces?|unveils?|shutting down|dies at|outage|state department|tariffs?|approves?|press release)\b/i.test(
      title
    )
  ) {
    return false;
  }
  return true;
}

export function selectHnStoriesForDirectIngestion(
  stories: readonly HnStory[],
  limit = HN_DIRECT_ARTICLE_LIMIT
): HnStory[] {
  const boundedLimit = Math.max(0, Math.floor(limit));
  if (boundedLimit === 0) return [];

  const seenUrls = new Set<string>();
  const eligible = stories.filter((story) => {
    if (seenUrls.has(story.url)) return false;
    seenUrls.add(story.url);
    return (
      classifyDomain(story.url).allowed &&
      hnStoryDomain(story) !== "" &&
      isLikelyHnReadingDestination(story)
    );
  });
  const playful = eligible
    .filter((story) => hnPlayfulness(story.title) > 0)
    .sort((a, b) => hnSelectionScore(b) - hnSelectionScore(a));
  const viral = [...eligible].sort(
    (a, b) => b.points - a.points || hnSelectionScore(b) - hnSelectionScore(a)
  );

  const selected: HnStory[] = [];
  const selectedUrls = new Set<string>();
  const selectedDomains = new Set<string>();
  const take = (pool: readonly HnStory[], quota: number) => {
    for (const story of pool) {
      if (selected.length >= boundedLimit || quota <= 0) return;
      const domain = hnStoryDomain(story);
      if (selectedUrls.has(story.url) || selectedDomains.has(domain)) continue;
      selected.push(story);
      selectedUrls.add(story.url);
      selectedDomains.add(domain);
      quota--;
    }
  };

  // A story that is literally on today's front page should not disappear
  // because it has 68 points while the weekly pool contains hundreds above
  // 70. Keep most of this bounded batch available to that live zeitgeist,
  // then reserve slots for older playful hits that have rolled off it.
  const frontPage = eligible
    .filter((story) => story.isFrontPage)
    .sort((a, b) => b.points - a.points);
  take(frontPage, Math.max(1, boundedLimit - 4));
  take(playful, boundedLimit - selected.length);
  take(viral, boundedLimit - selected.length);
  // A very small result set should still fill its requested bound. Domain
  // repetition is a last resort, never the normal discovery path.
  if (selected.length < boundedLimit) {
    for (const story of [...playful, ...viral]) {
      if (selected.length >= boundedLimit) break;
      if (selectedUrls.has(story.url)) continue;
      selected.push(story);
      selectedUrls.add(story.url);
    }
  }
  return selected;
}

export async function hnDiscover(
  selectedTopics?: readonly Topic[]
): Promise<HnDiscoveryResult> {
  const selected = selectedTopics
    ? new Set(selectedTopics)
    : await activeTopics();
  if (!selected.has("technology")) {
    return { candidateDomainsAdded: 0, stories: [] };
  }

  const last = (await kvGetJson<number>(HN_LAST_KEY)) ?? 0;
  if (Date.now() - last < 12 * 60 * 60 * 1000) {
    return { candidateDomainsAdded: 0, stories: [] };
  }

  const weekAgo = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
  const baseUrl = `https://hn.algolia.com/api/v1/search_by_date?tags=story&numericFilters=created_at_i>${weekAgo},points>70&hitsPerPage=${HN_RESULTS_PER_PAGE}`;
  try {
    const [res, frontPageRes] = await Promise.all([
      fetchText(`${baseUrl}&page=0`, { timeoutMs: 15000 }),
      fetchText(
        `https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=${HN_RESULTS_PER_PAGE}`,
        { timeoutMs: 15000 }
      ),
    ]);
    if (!res.ok) return { candidateDomainsAdded: 0, stories: [] };
    const firstPage = JSON.parse(res.text) as { nbPages?: unknown };
    const reportedPages =
      typeof firstPage.nbPages === "number" && Number.isFinite(firstPage.nbPages)
        ? Math.max(1, Math.trunc(firstPage.nbPages))
        : 1;
    const pageCount = Math.min(HN_MAX_PAGES, reportedPages);
    const remainingPages = await Promise.all(
      Array.from({ length: pageCount - 1 }, (_, index) =>
        fetchText(`${baseUrl}&page=${index + 1}`, { timeoutMs: 15000 })
      )
    );
    // Put the front-page response first so deduplication retains its tag when
    // the same URL is also present in the weekly search response.
    const pages: unknown[] = [];
    if (frontPageRes.ok) {
      try {
        pages.push(JSON.parse(frontPageRes.text) as unknown);
      } catch {}
    }
    pages.push(firstPage);
    for (const page of remainingPages) {
      if (!page.ok) continue;
      try {
        pages.push(JSON.parse(page.text) as unknown);
      } catch {}
    }

    const allStories = pages.flatMap((page) =>
      parseHnStories(page, HN_RESULTS_PER_PAGE)
    );
    const selectedStories = selectHnStoriesForDirectIngestion(allStories);
    // Candidate promotion only inspects a bounded prefix, so lead with the
    // selected domains before retaining extra links for publisher-feed probes.
    const selectedUrls = new Set(selectedStories.map((story) => story.url));
    const links = [
      ...selectedStories,
      ...allStories.filter((story) => !selectedUrls.has(story.url)),
    ].map((story) => ({ url: story.url }));
    await kvSetJson(HN_LAST_KEY, Date.now());
    const before = Object.keys(await loadCandidates()).length;
    enqueueCandidates(links, "hn");
    return {
      candidateDomainsAdded: Object.keys(poolCache ?? {}).length - before,
      stories: selectedStories,
    };
  } catch {
    return { candidateDomainsAdded: 0, stories: [] };
  }
}

// Kagi Small Web is a bounded, public Atom feed of independent sites. It is
// deliberately article-only: one appearance earns one article fetch, not a
// permanent subscription to the publisher that would recreate feed
// concentration. The feed's dates can reflect rediscovery rather than the
// original publication, so page extraction remains the date authority.
export function selectSmallWebStories(
  entries: readonly FeedEntry[],
  selectedTopics: readonly Topic[],
  limit = SMALL_WEB_DIRECT_ARTICLE_LIMIT
): SmallWebStory[] {
  const boundedLimit = Math.max(0, Math.floor(limit));
  if (boundedLimit === 0 || selectedTopics.length === 0) return [];
  const topicHint = selectedTopics.length === 1
    ? selectedTopics[0]
    : "technology";
  const stories: SmallWebStory[] = [];
  const seenUrls = new Set<string>();
  const seenDomains = new Set<string>();

  for (const entry of entries) {
    if (!entry.title.trim() || !looksLikeArticlePath(entry.url)) continue;
    let domain: string;
    try {
      domain = rootDomain(new URL(entry.url).host);
    } catch {
      continue;
    }
    if (!domain || seenDomains.has(domain) || seenUrls.has(entry.url)) continue;
    seenDomains.add(domain);
    seenUrls.add(entry.url);
    stories.push({
      url: entry.url,
      title: entry.title.trim(),
      author: entry.author.trim(),
      publishedAt: null,
      topic: topicHint,
    });
    if (stories.length >= boundedLimit) break;
  }
  return stories;
}

export async function smallWebDiscover(
  selectedTopics?: readonly Topic[]
): Promise<SmallWebStory[]> {
  const selected = selectedTopics
    ? [...selectedTopics]
    : [...(await activeTopics())];
  if (selected.length === 0) return [];

  const last = (await kvGetJson<number>(SMALL_WEB_LAST_KEY)) ?? 0;
  if (Date.now() - last < 6 * 60 * 60 * 1000) return [];

  try {
    const url = "https://kagi.com/api/v1/smallweb/feed/?limit=60";
    const res = await fetchText(url, { timeoutMs: 15_000 });
    if (!res.ok || !res.text) return [];
    const feed = parseSyndicationDocument(res.text, res.finalUrl || url);
    if (!feed?.entries.length) return [];
    const stories = selectSmallWebStories(feed.entries, selected);
    await kvSetJson(SMALL_WEB_LAST_KEY, Date.now());
    return stories;
  } catch {
    return [];
  }
}

function isRedditInfrastructure(host: string): boolean {
  const normalized = host.replace(/^www\./, "").toLowerCase();
  return (
    normalized === "reddit.com" ||
    normalized.endsWith(".reddit.com") ||
    normalized === "redd.it" ||
    normalized.endsWith(".redd.it") ||
    normalized.endsWith("redditmedia.com") ||
    normalized.endsWith("redditstatic.com")
  );
}

// Reddit's Atom alternate link is the discussion page; the destination
// article lives inside the HTML content. The submitter is not the article
// author, so byline remains empty until page extraction.
export function selectRedditEconomicsStories(
  entries: readonly FeedEntry[],
  limit = REDDIT_ECON_DIRECT_ARTICLE_LIMIT
): RedditEconomicsStory[] {
  const boundedLimit = Math.max(0, Math.floor(limit));
  if (boundedLimit === 0) return [];
  const stories: RedditEconomicsStory[] = [];
  const seenDomains = new Set<string>();

  for (const entry of entries) {
    const anchors = entry.summaryHtml.matchAll(/href=["']([^"']+)["']/gi);
    let destination = "";
    let domain = "";
    for (const match of anchors) {
      try {
        const parsed = new URL(match[1].replace(/&amp;/gi, "&"), entry.url);
        if (!/^https?:$/.test(parsed.protocol) || isRedditInfrastructure(parsed.host)) {
          continue;
        }
        if (!looksLikeArticlePath(parsed.toString())) continue;
        const candidateDomain = rootDomain(parsed.host);
        if (!candidateDomain || seenDomains.has(candidateDomain)) continue;
        parsed.hash = "";
        destination = parsed.toString();
        domain = candidateDomain;
        break;
      } catch {}
    }
    if (!destination || !entry.title.trim()) continue;
    seenDomains.add(domain);
    stories.push({
      url: destination,
      title: entry.title.trim(),
      author: "",
      publishedAt: entry.publishedAt,
      topic: "economics",
    });
    if (stories.length >= boundedLimit) break;
  }
  return stories;
}

export async function redditEconomicsDiscover(
  selectedTopics?: readonly Topic[]
): Promise<RedditEconomicsStory[]> {
  const selected = selectedTopics
    ? new Set(selectedTopics)
    : await activeTopics();
  if (!selected.has("economics")) return [];

  const last = (await kvGetJson<number>(REDDIT_ECON_LAST_KEY)) ?? 0;
  if (Date.now() - last < 12 * 60 * 60 * 1000) return [];

  try {
    const url =
      "https://www.reddit.com/r/Economics/.rss?sort=top&t=week&limit=25";
    const res = await fetchText(url, { timeoutMs: 15_000 });
    if (!res.ok || !res.text) return [];
    const feed = parseSyndicationDocument(res.text, res.finalUrl || url);
    if (!feed?.entries.length) return [];
    const stories = selectRedditEconomicsStories(feed.entries);
    if (stories.length > 0) {
      await kvSetJson(REDDIT_ECON_LAST_KEY, Date.now());
    }
    return stories;
  } catch {
    // Reddit rate-limits shared IPs intermittently; this channel is optional
    // and retries next crawl without delaying the rest of the reader.
    return [];
  }
}

interface CommunityChannel {
  id: string;
  topic: Topic;
  url: string;
}

// These are discovery inputs, not recommendation sources: their entries
// point at independent publishers, whose own feed is verified before being
// added. Mathblogging is maintained specifically as a map of the mathematical
// blogosphere; EconAcademics monitors economics-research blogs and updates its
// English index twice daily. Both are public and require no account/API key.
const COMMUNITY_CHANNELS: readonly CommunityChannel[] = [
  {
    id: "mathblogging-posts",
    topic: "math",
    url: "https://mathblogging.org/posts.xml",
  },
  {
    id: "econacademics-en",
    topic: "economics",
    url: "https://www.econacademics.org/en.html",
  },
];

async function activeTopics(): Promise<Set<Topic>> {
  const stored = await kvGetJson<unknown>("topics");
  if (Array.isArray(stored)) {
    return new Set(
      stored.filter((topic): topic is Topic =>
        topic === "technology" || topic === "economics" || topic === "math"
      )
    );
  }

  const db = await getDb();
  const rows = await db.getAllAsync<{ topic: string }>(
    `SELECT DISTINCT topic FROM sources
     WHERE status IN ('active', 'failing')`
  );
  return new Set(
    rows
      .map((row) => row.topic)
      .filter((topic): topic is Topic =>
        topic === "technology" || topic === "economics" || topic === "math"
      )
  );
}

// Pull rolling, topic-specific community indexes into the candidate pool.
// A caller may pass the selected topics directly; otherwise we infer them
// from the locally seeded active sources. Successful channels are throttled
// independently so a broken endpoint does not suppress the others.
export async function communityDiscover(
  selectedTopics?: readonly Topic[]
): Promise<number> {
  const selected = selectedTopics
    ? new Set(selectedTopics)
    : await activeTopics();
  const last =
    (await kvGetJson<Record<string, number>>(COMMUNITY_LAST_KEY)) ?? {};
  const refreshMs = 12 * 60 * 60 * 1000;
  const now = Date.now();
  let discovered = 0;

  await loadCandidates();
  const due = COMMUNITY_CHANNELS.filter(
    (channel) =>
      selected.has(channel.topic) &&
      now - (last[channel.id] ?? 0) >= refreshMs
  );
  // The channels live on different hosts. Fetching them together removes a
  // full network round trip from all-topic discovery without increasing load
  // on either publisher.
  const fetched = await Promise.all(
    due.map(async (channel) => {
      try {
        const res = await fetchText(channel.url, { timeoutMs: 15_000 });
        if (!res.ok || !res.text) return null;
        const parsed = parseSyndicationDocument(
          res.text.slice(0, 1_500_000),
          res.finalUrl || channel.url
        );
        return parsed?.entries.length ? { channel, parsed } : null;
      } catch {
        return null;
      }
    })
  );

  for (const result of fetched) {
    if (!result) continue;
    const before = Object.keys(poolCache ?? {}).length;
    enqueueCandidates(
      selectFeedEntriesByDomain(result.parsed.entries, 30, 1).map((entry) => ({
        url: entry.url,
        topicHint: result.channel.topic,
      })),
      "aggregator"
    );
    discovered += Object.keys(poolCache ?? {}).length - before;
    last[result.channel.id] = now;
  }

  await flushCandidates();
  await kvSetJson(COMMUNITY_LAST_KEY, last);
  return discovered;
}

const BLOGROLL_MINED_KEY = "disco:blogroll_mined_at";
const BLOGROLL_REMINE_DAYS = 14;
// Pages personal blogs keep specifically to recommend other writing.
const BLOGROLL_PATHS = ["/", "/about/", "/links/", "/blogroll/", "/reading/"];

// Mine seed sources' homepages/blogrolls for curated pointers. A link a
// trusted author keeps on their blogroll is stronger signal than one that
// happened to appear inside a post — these people are taste-makers in
// precisely the niches the user opted into.
export async function mineSeedBlogrolls(
  network: HostScheduler,
  deadline: number
): Promise<void> {
  const minedAt = (await kvGetJson<Record<string, number>>(BLOGROLL_MINED_KEY)) ?? {};
  const db = await getDb();
  const sources = await db.getAllAsync<{ id: number; site_url: string; topic: Topic }>(
    `SELECT id, site_url, topic FROM sources WHERE status = 'active' ORDER BY origin ASC`
  );

  await loadCandidates();
  for (const source of sources) {
    if (Date.now() > deadline) break;
    const last = minedAt[String(source.id)] ?? 0;
    if (Date.now() - last < BLOGROLL_REMINE_DAYS * 24 * 60 * 60 * 1000) continue;

    let origin = "";
    try {
      origin = new URL(source.site_url).origin;
    } catch {
      continue;
    }

    for (const path of BLOGROLL_PATHS) {
      if (Date.now() > deadline) break;
      const pageUrl = `${origin}${path}`;
      try {
        const res = await network.run(pageUrl, () =>
          fetchText(pageUrl, { timeoutMs: 8000 })
        );
        if (!res.ok || !res.text) continue;
        // blogrolls link homepages ("https://friend.example/") — allow
        // root paths here, unlike in-post mining where they'd be noise
        const links = collectOutboundLinks(
          res.text.slice(0, 300_000),
          res.finalUrl || pageUrl,
          { allowRootPaths: true, topicHint: source.topic }
        );
        enqueueCandidates(links, "outbound");
        // any page that yields links counts as mined; don't try deeper paths
        minedAt[String(source.id)] = Date.now();
        break;
      } catch {
        // next path
      }
    }
  }
  await kvSetJson(BLOGROLL_MINED_KEY, minedAt);
}

export interface ProbeResult {
  domain: string;
  outcome: "added" | "known" | "blocked" | "no-feed" | "error";
}

// Feed titles that indicate an institutional/infra feed rather than a
// personal blog worth reading: podcast indexes, changelogs, link archives,
// corporate newsrooms.
const NON_BLOG_TITLE = /podcast|archive|changelog|release notes|recent additions|\bnews\b|status|jobs|roadmap|press release/i;

function isNonBlogFeedTitle(title: string): boolean {
  return NON_BLOG_TITLE.test(title);
}

// Editorial outlets rotate writers; personal blogs don't. A candidate whose
// recent entries carry ≥4 distinct bylines is a magazine/newsroom, not an
// independent voice — exactly what the reader is not for.
const EDITORIAL_DISTINCT_AUTHORS = 4;

function distinctAuthors(entries: Array<{ author: string }>): number {
  return new Set(
    entries.map((e) => e.author.trim().toLowerCase()).filter(Boolean)
  ).size;
}

function normalizeName(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Same writer, second domain ("Ahead of AI" vs seeded sebastianraschka.com,
// "The Grumpy Economist" vs seeded "John Cochrane (The Grumpy Economist)"):
// if the candidate's authors or title collide with an existing source, we
// already carry that voice — another feed of theirs worsens repetition.
async function isDuplicateVoice(
  db: Awaited<ReturnType<typeof getDb>>,
  feed: { title: string; entries: Array<{ author: string }> },
  candidateDomain?: string
): Promise<boolean> {
  const authors = new Set<string>();
  for (const e of feed.entries) {
    const n = normalizeName(e.author);
    if (n.length >= 6) authors.add(n); // guard against short-name collisions
  }
  const titleNorm = normalizeName(feed.title);

  const existing = await db.getAllAsync<{ name: string; site_url: string; feed_url: string }>(
    "SELECT name, site_url, feed_url FROM sources"
  );
  for (const row of existing) {
    const n = normalizeName(row.name);

    // exact or contained name overlap (parentheticals, honorifics, "PhD")
    const nameMatches =
      n.length >= 6 &&
      (authors.has(n) ||
        n === titleNorm ||
        (n.length >= 8 &&
          ([...authors].some((a) => a.length >= 8 && (a.includes(n) || n.includes(a))) ||
            (titleNorm.length >= 8 &&
              (titleNorm.includes(n) || n.includes(titleNorm))))));
    if (nameMatches) return true;

    // same registrable domain under a different scheme/subdomain
    if (candidateDomain) {
      for (const url of [row.site_url, row.feed_url]) {
        try {
          if (rootDomain(new URL(url).host) === candidateDomain) return true;
        } catch {}
      }
    }
  }
  return false;
}

// Probing one candidate = homepage fetch + feed autodiscovery + feed fetch,
// all serial *within* the candidate's host (politeness) but fully parallel
// *across* candidates. Sequential probing was the single largest cost of the
// initial crawl (~150s for 24 candidates on desktop; phones are worse).
export async function probeTopCandidates(
  limit: number,
  deadlineMs: number = Date.now() + 120_000
): Promise<ProbeResult[]> {
  const pool = await loadCandidates();
  const rejected = (await kvGetJson<Record<string, number>>(REJECTED_KEY)) ?? {};

  const ranked = Object.entries(pool)
    .filter(([domain]) => rejected[domain] == null)
    // A one-off community appearance earns its article a chance, not a
    // permanent subscription to the whole publisher. Only topic-specific
    // aggregators bypass the two-citation promotion threshold.
    .filter(([, c]) => c.origin === "aggregator" || c.origin === "hn" || c.count >= 2)
    .sort((a, b) => b[1].count - a[1].count);

  const db = await getDb();
  const results: ProbeResult[] = [];
  const network = new HostScheduler(6);
  let cursor = 0;

  const probeOne = async (
    domain: string,
    candidate: CandidatePool[string]
  ): Promise<ProbeResult> => {
    const classification = classifyDomain(domain);
    if (!classification.allowed) {
      rejected[domain] = Date.now();
      return { domain, outcome: "blocked" };
    }

    const known = await db.getFirstAsync(
      `SELECT id FROM sources WHERE feed_url LIKE ? OR site_url LIKE ? LIMIT 1`,
      [`%${domain}%`, `%${domain}%`]
    );
    if (known) {
      delete pool[domain]; // already have it; stop tracking
      poolDirty = true;
      return { domain, outcome: "known" };
    }

    const siteUrl = candidate.siteUrl.startsWith("http")
      ? candidate.siteUrl
      : `https://${candidate.siteUrl}`;
    const feedUrl = await network.run(siteUrl, () => discoverFeedUrl(siteUrl));
    if (!feedUrl) {
      rejected[domain] = Date.now();
      return { domain, outcome: "no-feed" };
    }

    try {
      const res = await network.run(feedUrl, () =>
        fetchText(feedUrl, { timeoutMs: 10000 })
      );
      const feed = res.ok ? parseFeed(res.text, siteUrl) : null;
      if (!feed || feed.entries.length < 2) {
        rejected[domain] = Date.now();
        return { domain, outcome: "no-feed" };
      }
      if (isNonBlogFeedTitle(feed.title)) {
        // archive pages, changelogs, podcast indexes — real feeds, wrong
        // genre for a reading app
        rejected[domain] = Date.now();
        return { domain, outcome: "blocked" };
      }
      if (distinctAuthors(feed.entries) >= EDITORIAL_DISTINCT_AUTHORS) {
        rejected[domain] = Date.now();
        return { domain, outcome: "blocked" };
      }
      if (await isDuplicateVoice(db, feed, domain)) {
        delete pool[domain];
        poolDirty = true;
        return { domain, outcome: "known" };
      }

      await upsertSource({
        siteUrl,
        feedUrl,
        name: feed.title || domain,
        topic: candidate.topic,
        origin: candidate.origin,
      });
      delete pool[domain];
      poolDirty = true;
      return { domain, outcome: "added" };
    } catch {
      return { domain, outcome: "error" };
    }
  };

  const workers = Array.from({ length: Math.min(network.parallelism, ranked.length) }, async () => {
    for (;;) {
      if (Date.now() > deadlineMs || results.length >= limit) return;
      const i = cursor++;
      if (i >= ranked.length) return;
      const [domain, candidate] = ranked[i];
      const result = await probeOne(domain, candidate);
      // `added`/`blocked`/`no-feed` consume a probe slot; `error` doesn't so a
      // flaky host can't starve discovery this run.
      if (result.outcome !== "error") results.push(result);
    }
  });

  await Promise.all(workers);
  await flushCandidates();
  await kvSetJson(REJECTED_KEY, rejected);
  return results;
}
