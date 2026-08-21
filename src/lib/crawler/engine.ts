import {
  getDueSources,
  getDb,
  kvGet,
  kvSet,
  markArticleFailed,
  recordSourceFailure,
  recordSourceSuccess,
  setArticleContent,
  upsertArticleMeta,
  type ArticleRow,
} from "../db";
import { fetchText, Semaphore } from "./fetcher";
import { fetchFeed } from "./feeds";
import { collectOutboundLinks, enqueueCandidates, hnDiscover, probeTopCandidates } from "./discover";
import { extractFromHtml } from "./extract";
import { scoreArticleQuality } from "./quality";

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
  initial: 80,
  foreground: 20,
  background: 15,
};

const DISCOVER_PROBES: Record<CrawlMode, number> = {
  initial: 24,
  foreground: 6,
  background: 6,
};

const LOCK_KEY = "engine_lock";
const LOCK_STALE_MS = 15 * 60 * 1000;
const LAST_CRAWL_KEY = "last_crawl_at";

let running: Promise<boolean> | null = null;

export async function refreshIfNeeded(): Promise<void> {
  const lastRaw = await kvGet(LAST_CRAWL_KEY);
  const last = lastRaw ? parseInt(lastRaw, 10) : 0;
  if (Date.now() - last < 4 * 60 * 60 * 1000) return;
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
  // TailEnder batching: keep transfers back-to-back within a burst. The
  // politeness delay in fetcher.ts spaces same-host requests without letting
  // the radio drop to idle between items.
  const network = new Semaphore(mode === "initial" ? 3 : 2);

  await updateFeeds(network, deadline, mode, onProgress);
  if (Date.now() < deadline) {
    await enrichArticles(network, deadline, ENRICH_BATCH[mode], onProgress);
  }
  if (Date.now() < deadline && mode !== "foreground") {
    onProgress?.({ phase: "discover", done: 0, total: DISCOVER_PROBES[mode] });
    await hnDiscover();
    await probeTopCandidates(DISCOVER_PROBES[mode]);
  }
  onProgress?.({ phase: "done", done: 1, total: 1 });
}

// ---------- phase 1: feeds ----------

async function updateFeeds(
  network: Semaphore,
  deadline: number,
  _mode: CrawlMode,
  onProgress?: (progress: CrawlProgress) => void
): Promise<void> {
  const sources = await getDueSources(120);
  onProgress?.({ phase: "feeds", done: 0, total: sources.length });

  let done = 0;
  for (const source of sources) {
    if (Date.now() > deadline) break;

    try {
      const res = await network.run(() =>
        fetchFeed({
          feed_url: source.feed_url,
          etag: source.etag,
          last_modified: source.last_modified,
        })
      );

      if (res.notModified) {
        await recordSourceSuccess(source.id, res.etag, res.lastModified, 0);
        done++;
        onProgress?.({ phase: "feeds", done, total: sources.length });
        continue;
      }

      if (!res.feed || res.feed.entries.length === 0) {
        await recordSourceFailure(source.id);
        done++;
        continue;
      }

      let newEntries = 0;
      for (const entry of res.feed.entries.slice(0, 30)) {
        const inserted = await upsertArticleMeta({
          sourceId: source.id,
          url: entry.url,
          title: entry.title,
          author: entry.author,
          siteName: res.feed.title || source.name,
          publishedDate: entry.publishedAt,
          excerpt: firstParagraphText(entry.summaryHtml),
          topic: source.topic,
          score: source.score,
        });
        if (inserted != null) newEntries++;

        // free link mining from feed content — no extra page fetches
        if (entry.summaryHtml.length > 200) {
          await enqueueCandidates(
            collectOutboundLinks(entry.summaryHtml, entry.url),
            "outbound"
          );
        }
      }

      await recordSourceSuccess(
        source.id,
        res.etag,
        res.lastModified,
        newEntries
      );
    } catch {
      await recordSourceFailure(source.id);
    }

    done++;
    onProgress?.({ phase: "feeds", done, total: sources.length });
    // yield to the JS thread / UI every item
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function firstParagraphText(summaryHtml: string): string {
  if (!summaryHtml) return "";
  const text = summaryHtml
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= 300) return text;
  return text.slice(0, 297).replace(/\s\S*$/, "") + "…";
}

// ---------- phase 2: enrichment ----------

async function enrichArticles(
  network: Semaphore,
  deadline: number,
  batch: number,
  onProgress?: (progress: CrawlProgress) => void
): Promise<void> {
  const db = await getDb();
  const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;

  const candidates = await db.getAllAsync<ArticleRow>(
    `SELECT id, url, title, score, fetched_at FROM articles
     WHERE word_count = 0 AND content_html = ''
       AND fetched_at > ?
     ORDER BY score DESC, fetched_at DESC
     LIMIT ?`,
    [cutoff, batch]
  );
  if (candidates.length === 0) return;

  onProgress?.({ phase: "enrich", done: 0, total: candidates.length });

  let done = 0;
  for (const article of candidates) {
    if (Date.now() > deadline) break;

    try {
      const res = await network.run(() =>
        fetchText(article.url, { timeoutMs: 15000 })
      );
      if (res.ok && res.text) {
        // mine outbound links from the full page before extraction trims it
        await enqueueCandidates(
          collectOutboundLinks(res.text.slice(0, 500_000), article.url),
          "outbound"
        );

        const extracted = extractFromHtml(res.text, res.finalUrl || article.url);
        if (extracted) {
          const { quality } = scoreArticleQuality(extracted);
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
          });
          // a fresh full-text read counts as unread+ready for the deque
        } else {
          await markArticleFailed(article.id);
        }
      } else if (res.status >= 400 && res.status < 500) {
        await markArticleFailed(article.id); // gone is gone
      }
      // transient server errors: leave word_count=0 to retry next run
    } catch {
      // leave for retry
    }

    done++;
    onProgress?.({ phase: "enrich", done, total: candidates.length });
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
