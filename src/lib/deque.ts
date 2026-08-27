import { getDb, kvGet, TOPICS, type Topic } from "./db";
import { runCrawl } from "./crawler/engine";
import { MIN_TOPIC_RELEVANCE } from "./crawler/topic";
import {
  buildDiverseSlate,
  coolByPersistentExposure,
  hasDiverseOpening,
  type RecommendationCandidate,
  type PersistentExposureCandidate,
} from "./recommend";
import { inferSemanticCluster } from "./semantic-cluster";

// The deque: an ordered stream of article ids backed entirely by SQLite.
// SQLite produces a generously sized, relevance-weighted candidate pool.
// A greedy slate builder then enforces what a user actually experiences:
// no repeated author/site in the first screen, spaced recurrences later, and
// a balanced mix of the topics they explicitly selected.

const MIN_WORDS = 250;
// Three visible screens are enough runway for instant navigation. Top-ups are
// local SQLite reads, so precomputing 60 cards only adds ranking work and
// memory without improving perceived responsiveness.
const WINDOW_SIZE = 36;
// Consider ten screens, identity-round-robin, before the JS slate pass. This
// is wide enough for the long tail without letting a prolific publication's
// hundreds of posts crowd those writers out before diversity rules run.
const CANDIDATE_POOL_SIZE = WINDOW_SIZE * 10;
// One or two cards of memory only prevent adjacency. A full reading-session
// tail prevents generation N+1 from rediscovering the same prolific people
// that generation N already used, while remaining a tiny SQLite lookup.
const DIVERSITY_CONTEXT_SIZE = 60;
export const LOW_WATER = 12;

// Freshness contract: the reader is a "what's new worth reading" surface.
// - Hard gate: nothing older than STALE_DAYS enters the stream (the crawl
//   ingest gate keeps ~90 days of material around, so this rarely binds).
// - Soft bias: exponential decay with a ~14-day half-life, so last week's
//   best essay outranks today's mediocre one, but nothing lingers.
// - Relevance: an article must contain evidence for its classified topic. A
//   feed label alone never makes an off-topic post eligible.
// - Preferences: selected topics and muted bylines are hard filters.
// - Exposure: durable author/publication counts cool familiar identities;
//   bylines carry more weight than sites and follow people across domains.
const STALE_DAYS = 90;
const HALF_LIFE_DAYS = 14;

export interface DequeState {
  ids: number[];
}

type CandidateQueryRow = PersistentExposureCandidate & {
  title: string;
  siteName: string;
  sourceName: string | null;
  sourceOrigin: string | null;
};

type CandidateRow = CandidateQueryRow & {
  semanticCluster: string;
};

function withSemanticCluster(row: CandidateQueryRow): CandidateRow {
  return {
    ...row,
    semanticCluster: inferSemanticCluster({
      topic: row.topic,
      title: row.title,
      siteDomain: row.domain,
      sourceName: row.sourceName ?? "",
      sourceOrigin: row.sourceOrigin ?? "",
    }),
  };
}

function weightedCandidateQuery(topicCount: number): string {
  const ageDays = `(strftime('%s','now') * 1000 - COALESCE(a.published_date, a.fetched_at)) / 86400000.0`;
  const recency = `POWER(0.5, MAX(${ageDays}, -30) / ${HALF_LIFE_DAYS}.0)`;
  const uniform = `((ABS(RANDOM()) % 1000000) + 1) / 1000001.0`;
  const trust = `(0.75 + 0.5 * MIN(MAX(a.score, 0.0), 1.0))`;
  const relevance = `(0.35 + 0.65 * a.topic_relevance)`;
  const key = `(MAX(a.quality, 0.05) * ${relevance} * ${recency} * ${trust} * ${uniform})`;
  const domain =
    `COALESCE(NULLIF(a.site_domain, ''), ` +
    `CASE WHEN a.source_id IS NOT NULL THEN 'source:' || a.source_id ` +
    `ELSE 'article:' || a.id END)`;
  const voice = `COALESCE(NULLIF(a.author_key, ''), ${domain})`;
  const topicSlots = Array.from({ length: topicCount }, () => "?").join(", ");
  return `
    WITH eligible AS MATERIALIZED (
      SELECT a.id,
             a.topic,
             a.title,
             a.site_name AS siteName,
             source.name AS sourceName,
             source.origin AS sourceOrigin,
             a.author_key AS authorKey,
             ${domain} AS domain,
             ${voice} AS voice_key,
             ${key} AS ranking_key,
             COALESCE(author_exposure.exposure_count, 0) AS authorExposureCount,
             author_exposure.last_exposed_at AS authorLastExposedAt,
             COALESCE(domain_exposure.exposure_count, 0) AS domainExposureCount,
             domain_exposure.last_exposed_at AS domainLastExposedAt
      FROM articles AS a
      LEFT JOIN sources AS source ON source.id = a.source_id
      LEFT JOIN identity_exposures AS author_exposure
        ON author_exposure.identity_kind = 'author'
       AND author_exposure.identity_key = a.author_key
      LEFT JOIN identity_exposures AS domain_exposure
        ON domain_exposure.identity_kind = 'domain'
       AND domain_exposure.identity_key = ${domain}
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
    ), identity_ranked AS (
      SELECT eligible.*,
             ROW_NUMBER() OVER (
               PARTITION BY voice_key ORDER BY ranking_key DESC
             ) AS rank_in_voice,
             ROW_NUMBER() OVER (
               PARTITION BY domain ORDER BY ranking_key DESC
             ) AS rank_in_domain
      FROM eligible
    )
    SELECT id, topic, title, siteName, sourceName, sourceOrigin,
           authorKey, domain,
           authorExposureCount, authorLastExposedAt,
           domainExposureCount, domainLastExposedAt
    FROM identity_ranked
    ORDER BY MAX(rank_in_voice, rank_in_domain), ranking_key DESC
    LIMIT ?`;
}

export async function loadDeque(): Promise<number[]> {
  const selectedTopics = await getSelectedTopics();
  if (selectedTopics.length === 0) return [];
  return loadDequeWindow(selectedTopics);
}

// First-run readiness is intentionally stricter than ordinary refills. Do not
// build a reader from the first prolific feed to answer: wait until the actual
// opening has a full screen of people/publications and a balanced topic batch.
export async function loadDiverseOpeningDeque(): Promise<number[]> {
  const selectedTopics = await getSelectedTopics();
  if (selectedTopics.length === 0) return [];
  const slate = await buildDequeWindow(selectedTopics);
  return hasDiverseOpening(slate, selectedTopics)
    ? slate.map((row) => row.id)
    : [];
}

async function loadDequeWindow(
  selectedTopics: Topic[],
  excludedIds: readonly number[] = [],
): Promise<number[]> {
  return (await buildDequeWindow(selectedTopics, excludedIds)).map(
    (row) => row.id,
  );
}

async function buildDequeWindow(
  selectedTopics: Topic[],
  excludedIds: readonly number[] = [],
): Promise<CandidateRow[]> {
  const db = await getDb();
  const rows = (
    await db.getAllAsync<CandidateQueryRow>(
      weightedCandidateQuery(selectedTopics.length),
      [MIN_TOPIC_RELEVANCE, ...selectedTopics, CANDIDATE_POOL_SIZE],
    )
  ).map(withSemanticCluster);
  const excluded = new Set(excludedIds);
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const minimumPerTopic = Math.floor(WINDOW_SIZE / selectedTopics.length);

  // The broad query is the fast path. Only rescue a topic separately when a
  // much larger pool crowded it below its batch share (or queued IDs consumed
  // that share). Typical generations stay a single SQLite read.
  for (const topic of selectedTopics) {
    const available = rows.filter(
      (row) => row.topic === topic && !excluded.has(row.id),
    ).length;
    if (available >= minimumPerTopic) continue;

    const rescueRows = (
      await db.getAllAsync<CandidateQueryRow>(
        weightedCandidateQuery(1),
        [MIN_TOPIC_RELEVANCE, topic, CANDIDATE_POOL_SIZE],
      )
    ).map(withSemanticCluster);
    for (const row of rescueRows) rowsById.set(row.id, row);
  }

  const availableRows = [...rowsById.values()].filter(
    (row) => !excluded.has(row.id),
  );
  const hasRelevantHistory = availableRows.some(
    (row) => row.authorExposureCount > 0 || row.domainExposureCount > 0,
  );
  // On a fresh install every exposure cost is zero, so sorting would return
  // exactly the SQL order after allocating hundreds of wrapper objects. Keep
  // that common path allocation-free; restarts still get the full cooldown.
  const exposureAdjusted = hasRelevantHistory
    ? coolByPersistentExposure(availableRows)
    : availableRows;
  const priorCandidates =
    excludedIds.length > 0 || hasRelevantHistory
      ? await loadDiversityContext(db, excludedIds)
      : [];
  return buildDiverseSlate(
    exposureAdjusted,
    WINDOW_SIZE,
    selectedTopics,
    priorCandidates,
  );
}

async function loadDiversityContext(
  db: Awaited<ReturnType<typeof getDb>>,
  queuedIds: readonly number[],
): Promise<RecommendationCandidate[]> {
  const domain =
    `COALESCE(NULLIF(a.site_domain, ''), ` +
    `CASE WHEN a.source_id IS NOT NULL THEN 'source:' || a.source_id ` +
    `ELSE 'article:' || a.id END)`;
  const contextIds = queuedIds.slice(-DIVERSITY_CONTEXT_SIZE);

  if (contextIds.length > 0) {
    const rows = await db.getAllAsync<CandidateQueryRow>(
      `SELECT a.id, a.topic, a.title, a.site_name AS siteName,
              source.name AS sourceName, source.origin AS sourceOrigin,
              a.author_key AS authorKey, ${domain} AS domain,
              0 AS authorExposureCount, NULL AS authorLastExposedAt,
              0 AS domainExposureCount, NULL AS domainLastExposedAt
       FROM articles AS a
       LEFT JOIN sources AS source ON source.id = a.source_id
       WHERE a.id IN (${contextIds.map(() => "?").join(", ")})`,
      contextIds,
    );
    const byId = new Map(rows.map(withSemanticCluster).map((row) => [row.id, row]));
    return contextIds
      .map((id) => byId.get(id))
      .filter((row): row is CandidateRow => row != null);
  }

  const recent = await db.getAllAsync<CandidateQueryRow>(
    `SELECT a.id, a.topic, a.title, a.site_name AS siteName,
            source.name AS sourceName, source.origin AS sourceOrigin,
            a.author_key AS authorKey, ${domain} AS domain,
            0 AS authorExposureCount, NULL AS authorLastExposedAt,
            0 AS domainExposureCount, NULL AS domainLastExposedAt
     FROM articles AS a
     LEFT JOIN sources AS source ON source.id = a.source_id
     WHERE a.is_read = 1 AND a.read_at IS NOT NULL
       AND a.topic IN ('technology', 'economics', 'math')
     ORDER BY a.read_at DESC
     LIMIT ?`,
    [DIVERSITY_CONTEXT_SIZE],
  );
  return recent.map(withSemanticCluster).reverse();
}

export async function countEligible(): Promise<number> {
  const counts = await countEligibleByTopic();
  return [...counts.values()].reduce((sum, count) => sum + count, 0);
}

export async function countEligibleByTopic(): Promise<Map<Topic, number>> {
  const selectedTopics = await getSelectedTopics();
  const counts = new Map<Topic, number>(
    selectedTopics.map((topic) => [topic, 0]),
  );
  if (selectedTopics.length === 0) return counts;
  const db = await getDb();
  const rows = await db.getAllAsync<{ topic: Topic; c: number }>(
    `SELECT a.topic, COUNT(*) AS c
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
       )
     GROUP BY a.topic`,
    [MIN_WORDS, MIN_TOPIC_RELEVANCE, ...selectedTopics],
  );
  for (const row of rows) counts.set(row.topic, row.c);
  return counts;
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

let topUpInFlight: {
  tailId: number | null;
  promise: Promise<{ fresh: number[]; crawling: boolean }>;
} | null = null;

// Called when the reader approaches the end of its deque: refill from the DB,
// and if the DB itself is running dry, kick a foreground crawl burst.
export async function topUpDeque(currentIds: number[]): Promise<{
  ids: number[];
  crawling: boolean;
}> {
  const tailId = currentIds.at(-1) ?? null;
  if (!topUpInFlight || topUpInFlight.tailId !== tailId) {
    topUpInFlight = {
      tailId,
      promise: fetchTopUpCandidates(currentIds),
    };
  }

  const request = topUpInFlight;
  try {
    const { fresh, crawling } = await request.promise;
    return { ids: appendUnseen(currentIds, fresh), crawling };
  } finally {
    if (topUpInFlight === request) topUpInFlight = null;
  }
}

async function fetchTopUpCandidates(currentIds: readonly number[]): Promise<{
  fresh: number[];
  crawling: boolean;
}> {
  const eligibleByTopic = await countEligibleByTopic();
  let crawling = false;

  if ([...eligibleByTopic.values()].some((count) => count < LOW_WATER)) {
    crawling = true;
    // fire-and-forget: the reader keeps its current article visible while
    // the local crawler produces more candidates.
    runCrawl({ mode: "foreground" }).catch(() => {});
    // give the crawl a short window to produce something before requerying
    await new Promise<void>((resolve) => setTimeout(resolve, 4000));
  }

  const selectedTopics = await getSelectedTopics();
  if (selectedTopics.length === 0) return { fresh: [], crawling };

  return {
    fresh: await loadDequeWindow(selectedTopics, currentIds),
    crawling,
  };
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
