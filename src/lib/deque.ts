import { getDb } from "./db";
import { refreshIfNeeded } from "./crawler/engine";

// The deque: an ordered stream of article ids backed entirely by SQLite.
// Ordering uses weighted sampling without replacement (Efraimidis & Spirakis):
// key = quality * recency * U(0,1) — high-quality recent posts win, but the
// shuffle keeps every session fresh. Recency bias per the product brief.

const MIN_WORDS = 250;
const WINDOW_SIZE = 60;
export const LOW_WATER = 12;

export interface DequeState {
  ids: number[];
}

function weightedSampleQuery(limit: number): string {
  const ageDays =
    `(strftime('%s','now') * 1000 - COALESCE(published_date, fetched_at)) / 86400000.0`;
  const recency = `(1.0 / (1.0 + MAX(${ageDays}, -30) / 7.0))`;
  // ABS(RANDOM()) mapped to (0,1]
  const uniform = `((ABS(RANDOM()) % 1000000) + 1) / 1000001.0`;
  return `
    SELECT id FROM articles
    WHERE is_archived = 0 AND is_read = 0 AND word_count >= ${MIN_WORDS}
    ORDER BY (MAX(quality, 0.05) * ${recency} * ${uniform}) DESC
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
