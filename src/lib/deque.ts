import { getDb, kvGet, TOPICS, type Topic } from "./db";
import { refreshIfNeeded } from "./crawler/engine";
import { MIN_TOPIC_RELEVANCE } from "./crawler/topic";
import { buildDiverseSlate } from "./recommend";

// The deque: an ordered stream of article ids backed entirely by SQLite.
// SQLite produces a generously sized, relevance-weighted candidate pool.
// A greedy slate builder then enforces what a user actually experiences:
// no repeated author/site in the first screen, spaced recurrences later, and
// a balanced mix of the topics they explicitly selected.

const MIN_WORDS = 250;
const WINDOW_SIZE = 60;
const CANDIDATE_POOL_SIZE = WINDOW_SIZE * 6;
export const LOW_WATER = 12;

// Freshness contract: the reader is a "what's new worth reading" surface.
// - Hard gate: nothing older than STALE_DAYS enters the stream (the crawl
//   ingest gate keeps ~90 days of material around, so this rarely binds).
// - Soft bias: exponential decay with a ~14-day half-life, so last week's
//   best essay outranks today's mediocre one, but nothing lingers.
// - Relevance: an article must contain evidence for its classified topic. A
//   feed label alone never makes an off-topic post eligible.
// - Preferences: selected topics and muted bylines are hard filters.
const STALE_DAYS = 90;
const HALF_LIFE_DAYS = 14;

export interface DequeState {
  ids: number[];
}

interface CandidateRow {
  id: number;
  topic: Topic;
  authorKey: string;
  domain: string;
}

function weightedCandidateQuery(topicCount: number): string {
  const ageDays =
    `(strftime('%s','now') * 1000 - COALESCE(a.published_date, a.fetched_at)) / 86400000.0`;
  const recency = `POWER(0.5, MAX(${ageDays}, -30) / ${HALF_LIFE_DAYS}.0)`;
  const uniform = `((ABS(RANDOM()) % 1000000) + 1) / 1000001.0`;
  const trust = `(0.75 + 0.5 * MIN(MAX(a.score, 0.0), 1.0))`;
  const relevance = `(0.35 + 0.65 * a.topic_relevance)`;
  const key = `(MAX(a.quality, 0.05) * ${relevance} * ${recency} * ${trust} * ${uniform})`;
  const topicSlots = Array.from({ length: topicCount }, () => "?").join(", ");
  return `
    SELECT a.id,
           a.topic,
           a.author_key AS authorKey,
           COALESCE(NULLIF(a.site_domain, ''), 'source:' || a.source_id, 'article:' || a.id) AS domain
    FROM articles AS a
    WHERE a.is_archived = 0 AND a.is_read = 0
      AND a.word_count >= ${MIN_WORDS}
      AND a.topic_relevance >= ?
      AND a.topic IN (${topicSlots})
      AND COALESCE(a.published_date, a.fetched_at)
            > strftime('%s','now') * 1000 - ${STALE_DAYS} * 86400000
      AND NOT EXISTS (
        SELECT 1 FROM muted_authors AS muted
        WHERE a.author_key != '' AND muted.author_key = a.author_key
      )
    ORDER BY ${key} DESC
    LIMIT ?`;
}

export async function loadDeque(): Promise<number[]> {
  const selectedTopics = await getSelectedTopics();
  if (selectedTopics.length === 0) return [];
  const db = await getDb();
  const rows = await db.getAllAsync<CandidateRow>(
    weightedCandidateQuery(selectedTopics.length),
    [MIN_TOPIC_RELEVANCE, ...selectedTopics, CANDIDATE_POOL_SIZE]
  );
  return buildDiverseSlate(rows, WINDOW_SIZE, selectedTopics).map((row) => row.id);
}

export async function countEligible(): Promise<number> {
  const selectedTopics = await getSelectedTopics();
  if (selectedTopics.length === 0) return 0;
  const db = await getDb();
  const row = await db.getFirstAsync<{ c: number }>(
    `SELECT COUNT(*) AS c
     FROM articles AS a
     WHERE a.is_archived = 0 AND a.is_read = 0
       AND a.word_count >= ?
       AND a.topic_relevance >= ?
       AND a.topic IN (${selectedTopics.map(() => "?").join(", ")})
       AND COALESCE(a.published_date, a.fetched_at)
             > strftime('%s','now') * 1000 - ${STALE_DAYS} * 86400000
       AND NOT EXISTS (
         SELECT 1 FROM muted_authors AS muted
         WHERE a.author_key != '' AND muted.author_key = a.author_key
       )`,
    [MIN_WORDS, MIN_TOPIC_RELEVANCE, ...selectedTopics]
  );
  return row?.c ?? 0;
}

async function getSelectedTopics(): Promise<Topic[]> {
  try {
    const raw = await kvGet("topics");
    if (raw != null) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        return TOPICS.filter((topic) => parsed.includes(topic));
      }
    }
  } catch {}
  // Harnesses and pre-topic-selection legacy installs have no preference key.
  return [...TOPICS];
}

let topUpInFlight: Promise<{ fresh: number[]; crawling: boolean }> | null = null;

// Called when the reader approaches the end of its deque: refill from the DB,
// and if the DB itself is running dry, kick a foreground crawl burst.
export async function topUpDeque(currentIds: number[]): Promise<{
  ids: number[];
  crawling: boolean;
}> {
  if (!topUpInFlight) {
    topUpInFlight = fetchTopUpCandidates();
  }

  const request = topUpInFlight;
  try {
    const { fresh, crawling } = await request;
    return { ids: appendUnseen(currentIds, fresh), crawling };
  } finally {
    if (topUpInFlight === request) topUpInFlight = null;
  }
}

async function fetchTopUpCandidates(): Promise<{
  fresh: number[];
  crawling: boolean;
}> {
  const eligible = await countEligible();
  let crawling = false;

  if (eligible < LOW_WATER) {
    crawling = true;
    // fire-and-forget: the reader keeps its current article visible while
    // the local crawler produces more candidates.
    refreshIfNeeded();
    // give the crawl a short window to produce something before requerying
    await new Promise<void>((resolve) => setTimeout(resolve, 4000));
  }

  return { fresh: await loadDeque(), crawling };
}

function appendUnseen(current: number[], fresh: number[]): number[] {
  // The current array is also the reader's navigation history. Reordering it
  // would make an existing index point at a different article, so top-ups may
  // only append IDs that have not appeared in this session.
  const seen = new Set(current);
  const unseen = fresh.filter((id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  return [...current, ...unseen];
}
