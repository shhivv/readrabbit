import { getDb } from "./db";
import { refreshIfNeeded } from "./crawler/engine";

// The deque: an ordered stream of article ids backed entirely by SQLite.
// Ordering uses weighted sampling without replacement (Efraimidis & Spirakis):
// key = quality * recency * U(0,1) — high-quality recent posts win, but the
// shuffle keeps every session fresh. Recency bias per the product brief.

const MIN_WORDS = 250;
const WINDOW_SIZE = 60;
export const LOW_WATER = 12;

// Freshness contract: the reader is a "what's new worth reading" surface.
// - Hard gate: nothing older than STALE_DAYS enters the stream (the crawl
//   ingest gate keeps ~90 days of material around, so this rarely binds).
// - Soft bias: exponential decay with a ~14-day half-life, so last week's
//   best essay outranks today's mediocre one, but nothing lingers.
// - Diversity: at most MAX_PER_KEY slots per *author* (falling back to the
//   site's registrable domain, then source) in any window. Partitioning by
//   source_id alone lets an author with several feeds — or a multi-author
//   site with one prolific byline — crowd out everyone else.
// - Topic mix: the reader explicitly picked their topics, so no single one
//   may exceed half the window even when its bloggers are prolific.
const STALE_DAYS = 120;
const HALF_LIFE_DAYS = 14;
const MAX_PER_KEY = 3;
const MAX_PER_TOPIC = Math.ceil(WINDOW_SIZE / 2);

export interface DequeState {
  ids: number[];
}

function weightedSampleQuery(limit: number): string {
  const ageDays =
    `(strftime('%s','now') * 1000 - COALESCE(published_date, fetched_at)) / 86400000.0`;
  const recency = `POWER(0.5, MAX(${ageDays}, -30) / ${HALF_LIFE_DAYS}.0)`;
  // ABS(RANDOM()) mapped to (0,1]
  const uniform = `((ABS(RANDOM()) % 1000000) + 1) / 1000001.0`;
  // source trust prior (articles.score mirrors the origin-based source
  // prior, adapted over time by observed article quality)
  const trust = `(0.75 + 0.5 * MIN(MAX(score, 0.0), 1.0))`;
  const key = `(MAX(quality, 0.05) * ${recency} * ${trust} * ${uniform})`;
  // Dual caps: group blogs publish under rotating bylines, so an
  // author-only partition lets one domain flood the stream (martinfowler.com
  // case); a domain-only one over-penalizes a personal blog syndicated at
  // two domains. Enforce both, whichever binds first.
  const domainKey = `COALESCE(NULLIF(site_domain, ''), LOWER(TRIM(author)), 'd' || source_id)`;
  const authorKey = `COALESCE(NULLIF(LOWER(TRIM(author)), ''), site_domain, 'a' || source_id)`;
  return `
    SELECT id FROM (
      SELECT id,
             key,
             ROW_NUMBER() OVER (
               PARTITION BY COALESCE(topic, 'unknown')
               ORDER BY key DESC
             ) AS rank_in_topic
      FROM (
        SELECT id,
               topic,
               ${key} AS key,
               ROW_NUMBER() OVER (
                 PARTITION BY ${domainKey}
                 ORDER BY ${key} DESC
               ) AS rank_in_domain,
               ROW_NUMBER() OVER (
                 PARTITION BY ${authorKey}
                 ORDER BY ${key} DESC
               ) AS rank_in_author
        FROM articles
        WHERE is_archived = 0 AND is_read = 0
          AND word_count >= ${MIN_WORDS}
          AND COALESCE(published_date, fetched_at)
                > strftime('%s','now') * 1000 - ${STALE_DAYS} * 86400000
      )
      WHERE rank_in_domain <= ${MAX_PER_KEY}
        AND rank_in_author <= ${MAX_PER_KEY}
    )
    WHERE rank_in_topic <= ${MAX_PER_TOPIC}
    ORDER BY key DESC
    LIMIT ${limit}`;
}

export async function loadDeque(): Promise<number[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ id: number }>(weightedSampleQuery(WINDOW_SIZE));
  return rows.map((r) => r.id);
}

export async function countEligible(): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ c: number }>(
    `SELECT COUNT(*) AS c FROM articles WHERE is_archived = 0 AND is_read = 0 AND word_count >= ?`,
    [MIN_WORDS]
  );
  return row?.c ?? 0;
}

let toppingUp = false;

// Called when the reader approaches the end of its deque: refill from the DB,
// and if the DB itself is running dry, kick a foreground crawl burst.
export async function topUpDeque(currentIds: number[]): Promise<{
  ids: number[];
  crawling: boolean;
}> {
  if (toppingUp) return { ids: currentIds, crawling: true };
  toppingUp = true;
  try {
    let eligible = await countEligible();
    let crawling = false;

    if (eligible < LOW_WATER) {
      crawling = true;
      // fire-and-forget: the reader shows a gentle "finding more" state
      refreshIfNeeded();
      // give the crawl a short window to produce something before requerying
      await new Promise<void>((resolve) => setTimeout(resolve, 4000));
      eligible = await countEligible();
    }

    if (eligible > currentIds.length || currentIds.length === 0) {
      const fresh = await loadDeque();
      return { ids: mergeUnique(fresh, currentIds), crawling };
    }
    return { ids: currentIds, crawling };
  } finally {
    toppingUp = false;
  }
}

function mergeUnique(next: number[], prev: number[]): number[] {
  // keep any remaining tail of the old deque that's still valid, prepend new
  const seen = new Set(next);
  const keptTail = prev.filter((id) => !seen.has(id));
  return [...next.slice(0, WINDOW_SIZE - Math.min(keptTail.length, 20)), ...keptTail.slice(0, 20)];
}
