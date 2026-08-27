import {
  bumpSourceTrust,
  getDueSources,
  getDb,
  kvGet,
  kvSet,
  markArticleFailed,
  recordSourceFailure,
  recordSourceSuccess,
  seedCatalogSources,
  setArticleContent,
  upsertArticleMeta,
  type ArticleRow,
  type Topic,
} from "../db";
import { fetchText, getHost, HostScheduler, Semaphore } from "./fetcher";
import { fetchFeed, selectFeedEntriesByDomain } from "./feeds";
import {
  collectOutboundLinks,
  communityDiscover,
  enqueueCandidates,
  flushCandidates,
  hnDiscover,
  loadCandidates,
  mineSeedBlogrolls,
  probeTopCandidates,
  redditEconomicsDiscover,
  smallWebDiscover,
  HN_DIRECT_ARTICLE_LIMIT,
  type HnDiscoveryResult,
  type HnStory,
  type RedditEconomicsStory,
  type SmallWebStory,
} from "./discover";
import { extractFromHtml, sanitizeContentHtml, normalizeWhitespace } from "./extract";
import { isLowValueRoundup } from "./editorial";
import { renderMathInHtml } from "./math";
import { scoreArticleQuality } from "./quality";
import { assessTopic } from "./topic";
import { pruneStorage } from "../prune";

export type CrawlMode = "initial" | "foreground" | "background";

export interface CrawlProgress {
  phase: "feeds" | "enrich" | "discover" | "done";
  done: number;
  total: number;
}

export interface CrawlOptions {
  mode: CrawlMode;
  onProgress?: (progress: CrawlProgress) => void;
}

// Budgets (ms) — bounded work per run keeps battery/memory impact small and
// matches TailEnder-style tight transfer bursts (Balasubramanian et al. '09).
const BUDGET_MS: Record<CrawlMode, number> = {
  initial: 4 * 60 * 1000,
  foreground: 90 * 1000,
  background: 90 * 1000,
};

const ENRICH_BATCH: Record<CrawlMode, number> = {
  initial: 150,
  foreground: 24,
  background: 24,
};

const DISCOVER_PROBES: Record<CrawlMode, number> = {
  initial: 24,
  foreground: 6,
  background: 6,
};

// Freshness contract at ingest: entries older than this never enter the DB.
// Archive-heavy feeds otherwise flood storage and enrichment budget with
// years-old posts the reader would never show anyway.
const MAX_INGEST_AGE_DAYS = 90;

// Entries whose feed summary carries at least this many words are treated
// as full articles (feed-tier enrichment) — readable immediately, no page
// fetch needed. Teaser-only feeds fall through to normal enrichment.
const MIN_FEED_TIER_WORDS = 250;
// A single high-frequency publication must not own the initial local cache.
// Twelve recent entries is ample between adaptive polls and leaves first-run
// enrichment capacity for the long tail of sources.
const MAX_ENTRIES_PER_SOURCE = 12;
// Community indexes point at many independent publishers. Giving them the
// personal-feed cap truncates that breadth before publisher-domain fairness
// gets a chance to operate, while a hard ceiling still bounds XML/DB work.
const MAX_AGGREGATOR_ENTRIES_PER_SOURCE = 24;
const HN_ARTICLE_SCORE = 0.5;
const SMALL_WEB_ARTICLE_SCORE = 0.45;

// Concurrent DOM parses allowed during enrichment (see extract gate below).
const EXTRACT_CONCURRENCY = 3;
// Feed parsing builds large object trees (full-content feeds can be MBs);
// fewer simultaneous parses keeps the memory profile flat without hurting
// wall-clock much — feed fetches overlap through the host scheduler either way.
const FEED_PARSE_CONCURRENCY = 5;

const LOCK_KEY = "engine_lock";
// Short enough that a task the OS killed mid-run (iOS suspends background
// work aggressively) doesn't block the next app-open refresh for long.
const LOCK_STALE_MS = 5 * 60 * 1000;
const LAST_CRAWL_KEY = "last_crawl_at";

let running: Promise<boolean> | null = null;

export async function refreshIfNeeded(): Promise<void> {
  let seeded = 0;
  try {
    const rawTopics = await kvGet("topics");
    const parsed = rawTopics ? (JSON.parse(rawTopics) as unknown) : [];
    const topics = Array.isArray(parsed)
      ? parsed.filter(
          (topic): topic is Topic =>
            topic === "technology" || topic === "economics" || topic === "math"
        )
      : [];
    if (topics.length > 0) seeded = await seedCatalogSources(topics);
  } catch {}

  const lastRaw = await kvGet(LAST_CRAWL_KEY);
  const last = lastRaw ? parseInt(lastRaw, 10) : 0;
  // Catalog additions should start filling immediately after an app update,
  // even when the normal four-hour refresh window has not elapsed.
  if (seeded === 0 && Date.now() - last < 4 * 60 * 60 * 1000) return;
  runCrawl({ mode: "background" }).catch(() => {});
}

export async function runCrawl(options: CrawlOptions): Promise<boolean> {
  if (running) return running;

  running = (async () => {
    const lockRaw = await kvGet(LOCK_KEY);
    if (lockRaw) {
      const startedAt = parseInt(lockRaw, 10);
      if (!Number.isNaN(startedAt) && Date.now() - startedAt < LOCK_STALE_MS) {
        return false; // another crawl is genuinely in flight
      }
    }
    await kvSet(LOCK_KEY, String(Date.now()));

    try {
      await execute(options);
      return true;
    } finally {
      await kvSet(LAST_CRAWL_KEY, String(Date.now()));
      await kvSet(LOCK_KEY, "");
    }
  })();

  try {
    return await running;
  } finally {
    running = null;
  }
}

async function execute({ mode, onProgress }: CrawlOptions): Promise<void> {
  const deadline = Date.now() + BUDGET_MS[mode];
  // Mercator-style per-host queues with cross-host parallelism: TailEnder's
  // batching insight (keep the radio busy with back-to-back transfers) plus
  // Mercator's insight (politeness is a per-host property). 8 hosts in flight
  // keeps a burst tight while no single server sees more than ~1 req/1.2s.
  const network = new HostScheduler(8);

  // candidate pool lives in memory for the whole crawl; flushed at phase ends
  await loadCandidates();

  // HN is a single cheap request and can overlap the slower per-host feed
  // sweep. Persist its voted article URLs before enrichment so they can become
  // readable in this crawl; publisher RSS probing remains a secondary path.
  const hnPromise: Promise<HnDiscoveryResult> =
    mode === "foreground"
      ? Promise.resolve({ candidateDomainsAdded: 0, stories: [] })
      : hnDiscover();
  const smallWebPromise: Promise<SmallWebStory[]> =
    mode === "foreground" ? Promise.resolve([]) : smallWebDiscover();
  const redditEconomicsPromise: Promise<RedditEconomicsStory[]> =
    mode === "foreground" ? Promise.resolve([]) : redditEconomicsDiscover();

  await updateFeeds(network, deadline, mode, onProgress);
  const [hn, smallWebStories, redditEconomicsStories] = await Promise.all([
    hnPromise,
    smallWebPromise,
    redditEconomicsPromise,
  ]);
  await ingestHnStories(hn.stories);
  await ingestSmallWebStories(smallWebStories);
  await ingestRedditEconomicsStories(redditEconomicsStories);
  await flushCandidates();
  if (Date.now() < deadline) {
    await enrichArticles(network, deadline, ENRICH_BATCH[mode], onProgress);
    await flushCandidates();
  }
  if (Date.now() < deadline && mode !== "foreground") {
    onProgress?.({ phase: "discover", done: 0, total: DISCOVER_PROBES[mode] });
    // curated pointers from seed authors' own pages — capped so probing
    // keeps its share of the remaining budget
    await mineSeedBlogrolls(network, Date.now() + 30_000);
    await flushCandidates();
    await communityDiscover();
    await flushCandidates();
    await probeTopCandidates(DISCOVER_PROBES[mode], Date.now() + 60_000);
    await flushCandidates();
  }
  if (mode !== "initial") {
    // keep first-open snappy; prune on every subsequent cycle
    pruneStorage().catch(() => {});
  }
  onProgress?.({ phase: "done", done: 1, total: 1 });
}

type ArticleMetaInput = Parameters<typeof upsertArticleMeta>[0];
type ArticleMetaWriter = (input: ArticleMetaInput) => Promise<number | null>;

// HN itself is the discovery source, not a permanent feed row. A null
// source_id lets the article retain its real publisher domain while enrichment
// fills the byline/site metadata from the linked page.
export async function ingestHnStories(
  stories: readonly HnStory[],
  persist: ArticleMetaWriter = upsertArticleMeta
): Promise<number> {
  let inserted = 0;
  for (const story of stories.slice(0, HN_DIRECT_ARTICLE_LIMIT)) {
    try {
      const host = new URL(story.url).host.replace(/^www\./, "");
      const id = await persist({
        sourceId: null,
        url: story.url,
        title: story.title,
        author: "",
        siteName: host,
        publishedDate: story.publishedAt,
        excerpt: "",
        topic: "technology",
        score: hnArticleScore(story.points, story.isFrontPage),
      });
      if (id != null) inserted++;
    } catch {
      // One malformed/transient row must not discard the rest of the HN batch.
    }
  }
  return inserted;
}

export function hnArticleScore(points: number, isFrontPage = false): number {
  if (!Number.isFinite(points) || points <= 0) return HN_ARTICLE_SCORE;
  // Votes are useful evidence, but remain bounded so HN cannot crowd every
  // established feed out of a background enrichment batch.
  return Math.min(
    0.78,
    0.54 + Math.log2(points + 1) * 0.018 + (isFrontPage ? 0.05 : 0)
  );
}

export async function ingestSmallWebStories(
  stories: readonly SmallWebStory[],
  persist: ArticleMetaWriter = upsertArticleMeta
): Promise<number> {
  let inserted = 0;
  for (const story of stories) {
    try {
      const host = new URL(story.url).host.replace(/^www\./, "");
      const id = await persist({
        sourceId: null,
        url: story.url,
        title: story.title,
        author: story.author,
        siteName: host,
        // Kagi can rediscover old pages under today's feed timestamp. Keep
        // this null so page extraction can supply the real publication date.
        publishedDate: null,
        excerpt: "",
        topic: story.topic,
        score: SMALL_WEB_ARTICLE_SCORE,
      });
      if (id != null) inserted++;
    } catch {
      // Keep the rest of the bounded batch moving.
    }
  }
  return inserted;
}

export async function ingestRedditEconomicsStories(
  stories: readonly RedditEconomicsStory[],
  persist: ArticleMetaWriter = upsertArticleMeta
): Promise<number> {
  let inserted = 0;
  for (const story of stories) {
    try {
      const host = new URL(story.url).host.replace(/^www\./, "");
      const id = await persist({
        sourceId: null,
        url: story.url,
        title: story.title,
        author: "",
        siteName: host,
        publishedDate: story.publishedAt,
        excerpt: "",
        topic: "economics",
        score: SMALL_WEB_ARTICLE_SCORE,
      });
      if (id != null) inserted++;
    } catch {
      // Optional channel: a malformed entry cannot affect the crawl.
    }
  }
  return inserted;
}

export function maxEntriesForSourceOrigin(origin: string): number {
  return origin === "aggregator"
    ? MAX_AGGREGATOR_ENTRIES_PER_SOURCE
    : MAX_ENTRIES_PER_SOURCE;
}

export function selectEntriesForSourceOrigin<T extends import("./feeds").FeedEntry>(
  entries: readonly T[],
  origin: string
): T[] {
  const limit = maxEntriesForSourceOrigin(origin);
  return origin === "aggregator"
    ? (selectFeedEntriesByDomain(entries, limit) as T[])
    : entries.slice(0, limit);
}

export function siteNameForFeedEntry(
  origin: string,
  entryUrl: string,
  feedTitle: string,
  sourceName: string
): string {
  if (origin === "aggregator") {
    const host = getHost(entryUrl)?.replace(/^www\./, "");
    if (host) return host;
  }
  return feedTitle || sourceName;
}

// ---------- phase 1: feeds ----------

async function updateFeeds(
  network: HostScheduler,
  deadline: number,
  _mode: CrawlMode,
  onProgress?: (progress: CrawlProgress) => void
): Promise<void> {
  const sources = await getDueSources(120);
  onProgress?.({ phase: "feeds", done: 0, total: sources.length });

  let done = 0;
  const tick = () => {
    done++;
    onProgress?.({ phase: "feeds", done, total: sources.length });
  };

  await runPool(sources, FEED_PARSE_CONCURRENCY, (source) =>
    (async () => {
      if (Date.now() > deadline) return;

      try {
      const res = await network.run(source.feed_url, () =>
        fetchFeed({
          feed_url: source.feed_url,
          etag: source.etag,
          last_modified: source.last_modified,
        })
      );

      if (res.notModified) {
        await safeRecord(() =>
          recordSourceSuccess(source.id, res.etag, res.lastModified, 0)
        );
        tick();
        return;
      }

      if (!res.feed || res.feed.entries.length === 0) {
        await safeRecord(() => recordSourceFailure(source.id));
        tick();
        return;
      }

      const db = await getDb();
      const ingestCutoff = Date.now() - MAX_INGEST_AGE_DAYS * 24 * 60 * 60 * 1000;
      let newEntries = 0;
      const linkBatch: Array<{ url: string; topicHint: import("../db").Topic }> = [];
      const feedTier: Array<{ id: number; entry: (typeof res.feed.entries)[number] }> = [];

      // One transaction per source: on flash storage every implicit
      // transaction is an fsync, so 30 individual inserts would mean 30
      // syncs; batched they cost one.
      await db.withTransactionAsync(async () => {
        for (const entry of selectEntriesForSourceOrigin(
          res.feed!.entries,
          source.origin
        )) {
          if (isLowValueRoundup(entry.title)) {
            continue;
          }
          if (
            entry.publishedAt != null &&
            entry.publishedAt < ingestCutoff
          ) {
            continue; // stale: never enters the DB
          }
          const entrySiteName = siteNameForFeedEntry(
            source.origin,
            entry.url,
            res.feed!.title,
            source.name
          );
          const inserted = await upsertArticleMeta({
            sourceId: source.id,
            url: entry.url,
            title: entry.title,
            author: entry.author,
            siteName: entrySiteName,
            publishedDate: entry.publishedAt,
            excerpt: firstParagraphText(entry.summaryHtml),
            topic: source.topic,
            score: source.score,
          });
          if (inserted != null) newEntries++;

          // Full-content feeds carry the entire article in the entry —
          // most independent blogs do. Storing it here makes cards readable
          // within seconds of app open and skips the later page fetch.
          if (
            inserted != null &&
            summaryWordCount(entry.summaryHtml) >= MIN_FEED_TIER_WORDS
          ) {
            feedTier.push({ id: inserted, entry });
          }

          // free link mining from feed content — no extra page fetches
          // (summaries can carry full-article HTML; links live in the head)
          if (entry.summaryHtml.length > 200) {
            linkBatch.push(
              ...collectOutboundLinks(
                entry.summaryHtml.slice(0, 50_000),
                entry.url,
                { topicHint: asTopic(source.topic) }
              )
            );
          }
        }
      });

      // feed-tier enrichment happens outside the write transaction: it's
      // CPU work (DOM sanitize), not bookkeeping
      for (const { id, entry } of feedTier) {
        try {
          const clean = sanitizeContentHtml(entry.summaryHtml, entry.url);
          if (!clean) continue;
          const html = /\$|\\\(|\\\[|math\/tex/i.test(clean)
            ? renderMathInHtml(clean)
            : clean;
          const text = normalizeWhitespace(
            html.replace(/<[^>]*>/g, " ").replace(/&[a-z#0-9]+;/gi, " ")
          );
          const wordCount = text ? text.split(/\s+/).length : 0;
          if (wordCount < 80) continue; // teaser that snuck past the estimate
          const entrySiteName = siteNameForFeedEntry(
            source.origin,
            entry.url,
            res.feed!.title,
            source.name
          );
          const { quality } = scoreArticleQuality({
            title: entry.title,
            author: entry.author,
            siteName: entrySiteName,
            publishedDate: entry.publishedAt,
            excerpt: firstParagraphText(entry.summaryHtml),
            contentHtml: html,
            textContent: text,
            leadImageUrl: "",
            wordCount,
          });
          const topic = assessTopic(
            {
              title: entry.title,
              excerpt: firstParagraphText(entry.summaryHtml),
              textContent: text,
            },
            asTopic(source.topic)
          );
          await safeRecord(() =>
            setArticleContent(id, {
              title: entry.title,
              author: entry.author,
              siteName: entrySiteName,
              publishedDate: entry.publishedAt,
              excerpt: "",
              contentHtml: html,
              textContent: text.slice(0, 60_000),
              leadImageUrl: "",
              wordCount,
              quality,
              topic: topic.topic,
              topicRelevance: topic.relevance,
            })
          );
        } catch {}
      }
      enqueueCandidates(linkBatch, "outbound");

      await safeRecord(() =>
        recordSourceSuccess(source.id, res.etag, res.lastModified, newEntries)
      );
      } catch {
        await safeRecord(() => recordSourceFailure(source.id));
      }

      tick();
      // yield between items so the JS thread stays responsive
      await new Promise<void>((resolve) => setImmediate(resolve));
    })()
  );
}

// Bookkeeping must never take down a crawl phase (a schema hiccup or disk
// glitch should degrade to lost bookkeeping, not a dead loop).
async function safeRecord(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch {}
}

// Fixed worker pool over a shared cursor — this is what actually puts N
// requests in flight; the HostScheduler then only arbitrates host politeness.
async function runPool<T>(
  items: T[],
  workers: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  let next = 0;
  const n = Math.min(workers, items.length);
  await Promise.all(
    Array.from({ length: n }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        await fn(items[i]);
      }
    })
  );
}

function summaryWordCount(summaryHtml: string): number {
  if (!summaryHtml) return 0;
  // cheap estimate over the head of the content; full text is recomputed
  // after sanitization for anything that qualifies
  const slice = summaryHtml.slice(0, 100_000);
  const words = slice.replace(/<[^>]*>/g, " ").match(/\S+/g);
  return words ? words.length : 0;
}

function firstParagraphText(summaryHtml: string): string {
  if (!summaryHtml) return "";
  // excerpt needs ~300 chars; don't regex whole full-article summaries
  const text = summaryHtml
    .slice(0, 4000)
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= 300) return text;
  return text.slice(0, 297).replace(/\s\S*$/, "") + "…";
}

// ---------- phase 2: enrichment ----------

async function enrichArticles(
  network: HostScheduler,
  deadline: number,
  batch: number,
  onProgress?: (progress: CrawlProgress) => void
): Promise<void> {
  const db = await getDb();
  const cutoff = Date.now() - MAX_INGEST_AGE_DAYS * 24 * 60 * 60 * 1000;

  const raw = await db.getAllAsync<EnrichmentArticleRow>(
    `SELECT id, source_id, url, title, topic, score, fetched_at,
            site_domain, published_date
     FROM articles
     WHERE word_count = 0 AND content_html = ''
       AND fetched_at > ?
       AND (published_date IS NULL OR published_date > ?)
     ORDER BY score DESC, COALESCE(published_date, fetched_at) DESC
     LIMIT ?`,
    [cutoff, cutoff, batch * 4]
  );
  if (raw.length === 0) return;

  const candidates = selectEnrichmentCandidates(raw, batch);

  // Interleave hosts before pooling: score-ordered candidates cluster
  // same-host articles together, and per-host politeness then serializes a
  // worker chain (1.2s × N). Round-robin by host keeps every worker on a
  // different server.
  const byHost = new Map<string, ArticleRow[]>();
  for (const article of candidates) {
    const host = getHost(article.url) ?? "unknown";
    const list = byHost.get(host);
    if (list) list.push(article);
    else byHost.set(host, [article]);
  }
  const interleaved: ArticleRow[] = [];
  let added = true;
  while (added) {
    added = false;
    for (const list of byHost.values()) {
      const next = list.shift();
      if (next) {
        interleaved.push(next);
        added = true;
      }
    }
  }

  onProgress?.({ phase: "enrich", done: 0, total: interleaved.length });

  const extractGate = new Semaphore(EXTRACT_CONCURRENCY);

  let done = 0;
  const tick = () => {
    done++;
    onProgress?.({ phase: "enrich", done, total: interleaved.length });
  };

  await runPool(interleaved, network.parallelism, (article) =>
    (async () => {
      if (Date.now() > deadline) return;

      try {
      const res = await network.run(article.url, () =>
        fetchText(article.url, { timeoutMs: 15000 })
      );
      if (res.ok && res.text) {
        // mine outbound links from the full page before extraction trims it
        enqueueCandidates(
          collectOutboundLinks(res.text.slice(0, 500_000), article.url, {
            topicHint: asTopic(article.topic),
          }),
          "outbound"
        );

        // Extraction is the memory-heavy stage (DOM trees cost ~35× the
        // HTML in heap), so it runs behind its own small gate: downloads
        // stay fully parallel, but at most a few pages are parsed at once.
        const extracted = await extractGate.run(() =>
          extractFromHtml(res.text, res.finalUrl || article.url)
        );
        if (extracted) {
          if (
            requiresVerifiedPublicationDate(
              article.source_id,
              article.published_date,
              extracted.publishedDate
            )
          ) {
            await markArticleFailed(article.id);
            tick();
            return;
          }
          const { quality } = scoreArticleQuality(extracted);
          const topic = assessTopic(extracted, asTopic(article.topic));
          await setArticleContent(article.id, {
            title: extracted.title,
            author: extracted.author,
            siteName: extracted.siteName,
            publishedDate: extracted.publishedDate,
            excerpt: extracted.excerpt,
            contentHtml: extracted.contentHtml,
            textContent: extracted.textContent,
            leadImageUrl: extracted.leadImageUrl,
            wordCount: extracted.wordCount,
            quality,
            topic: topic.topic,
            topicRelevance: topic.relevance,
          });
          if (article.source_id != null) {
            await safeRecord(() => bumpSourceTrust(article.source_id!, quality));
          }
          // a fresh full-text read counts as unread+ready for the deque
        } else {
          await markArticleFailed(article.id);
        }
      } else if (res.status >= 400 && res.status < 500) {
        await markArticleFailed(article.id); // gone is gone
      }
      // transient server errors: leave word_count=0 to retry next run
      } catch {
        // transient: leave word_count=0 to retry next run
      }

      tick();
      await new Promise<void>((resolve) => setImmediate(resolve));
    })()
  );
}

type EnrichmentArticleRow = ArticleRow & {
  site_domain: string;
  published_date: number | null;
};

// Direct Small Web rows intentionally arrive without the feed's unreliable
// rediscovery date. HN rows carry a trustworthy submission date. Requiring
// the destination page to date the remaining null-source rows prevents an
// old undated post from masquerading as today's discovery.
export function requiresVerifiedPublicationDate(
  sourceId: number | null,
  storedPublishedDate: number | null,
  extractedPublishedDate: number | null
): boolean {
  return (
    sourceId == null &&
    storedPublishedDate == null &&
    extractedPublishedDate == null
  );
}

interface EnrichmentFairnessRow {
  id: number;
  source_id: number | null;
  url: string;
  site_domain: string;
}

// Community/HN inputs can put many publishers behind one source_id (or null
// for direct HN stories). Fairness therefore follows the article's publisher
// domain, falling back to the concrete host and only then the source/article.
export function selectEnrichmentCandidates<T extends EnrichmentFairnessRow>(
  raw: readonly T[],
  batch: number
): T[] {
  const byPublisher = new Map<string, T[]>();
  for (const row of raw) {
    const key =
      row.site_domain?.trim() ||
      getHost(row.url) ||
      (row.source_id != null ? `source:${row.source_id}` : `article:${row.id}`);
    const list = byPublisher.get(key);
    if (list) list.push(row);
    else byPublisher.set(key, [row]);
  }

  const candidates: T[] = [];
  let pickedAny = true;
  while (candidates.length < batch && pickedAny) {
    pickedAny = false;
    for (const list of byPublisher.values()) {
      if (candidates.length >= batch) break;
      const next = list.shift();
      if (next) {
        candidates.push(next);
        pickedAny = true;
      }
    }
  }
  return candidates;
}

function asTopic(value: string | null | undefined): Topic {
  return value === "economics" || value === "math" ? value : "technology";
}
