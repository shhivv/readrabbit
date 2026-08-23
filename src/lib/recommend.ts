import type { Topic } from "./db";

export interface RecommendationCandidate {
  id: number;
  topic: Topic;
  authorKey: string;
  domain: string;
}

export interface PersistentExposureCandidate extends RecommendationCandidate {
  authorExposureCount: number;
  authorLastExposedAt: number | null;
  domainExposureCount: number;
  domainLastExposedAt: number | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function identityExposurePenalty(
  count: number,
  lastExposedAt: number | null,
  now: number,
  recencyWeight: number,
  halfLifeDays: number,
  historyWeight: number
): number {
  if (count <= 0) return 0;
  const ageDays = lastExposedAt
    ? Math.max(0, now - lastExposedAt) / DAY_MS
    : Number.POSITIVE_INFINITY;
  const recency = Number.isFinite(ageDays)
    ? Math.pow(0.5, ageDays / halfLifeDays)
    : 0;
  // Recency fades, but the tiny log-scaled memory remains: an unseen voice is
  // still preferable to one that has occupied many cards over the app's life.
  return (
    recencyWeight * recency +
    historyWeight * Math.log2(Math.max(1, count) + 1)
  );
}

/**
 * Person-first persistent cooldown. A byline follows the writer across
 * publications and therefore carries four times the recency weight of a
 * publication. Nothing is filtered: when supply is scarce, exposed voices
 * remain available in least-seen/least-recent order.
 */
export function persistentExposureCost(
  candidate: PersistentExposureCandidate,
  now = Date.now()
): number {
  // When extraction cannot find a trustworthy byline, the publication is the
  // voice. Giving that fallback only the weaker domain penalty lets anonymous
  // prolific feeds recur far more often than named writers.
  if (!candidate.authorKey && candidate.domain) {
    return identityExposurePenalty(
      candidate.domainExposureCount,
      candidate.domainLastExposedAt,
      now,
      100,
      45,
      2
    );
  }
  const author = candidate.authorKey
    ? identityExposurePenalty(
        candidate.authorExposureCount,
        candidate.authorLastExposedAt,
        now,
        100,
        45,
        2
      )
    : 0;
  const domain = candidate.domain
    ? identityExposurePenalty(
        candidate.domainExposureCount,
        candidate.domainLastExposedAt,
        now,
        25,
        21,
        0.5
      )
    : 0;
  return author + domain;
}

export function coolByPersistentExposure<
  T extends PersistentExposureCandidate,
>(orderedCandidates: readonly T[], now = Date.now()): T[] {
  return orderedCandidates
    .map((candidate, rank) => ({
      candidate,
      rank,
      cost: persistentExposureCost(candidate, now),
    }))
    .sort((left, right) => left.cost - right.cost || left.rank - right.rank)
    .map(({ candidate }) => candidate);
}

interface SelectionState {
  authorCounts: Map<string, number>;
  domainCounts: Map<string, number>;
  topicCounts: Map<Topic, number>;
  topicQuotas: Map<Topic, number>;
  lastAuthor: Map<string, number>;
  lastDomain: Map<string, number>;
  topicBreadthByCandidate: Map<number, number>;
}

function countFor(map: Map<string, number>, key: string): number {
  return key ? (map.get(key) ?? 0) : 0;
}

function voiceKey(candidate: RecommendationCandidate): string {
  return candidate.authorKey || `site:${candidate.domain}`;
}

function allocateTopicQuotas(
  selectedTopics: Topic[],
  candidates: readonly RecommendationCandidate[],
  limit: number
): Map<Topic, number> {
  const topics = [...new Set(selectedTopics)];
  const available = new Map<Topic, number>(topics.map((topic) => [topic, 0]));
  for (const candidate of candidates) {
    if (available.has(candidate.topic)) {
      available.set(candidate.topic, (available.get(candidate.topic) ?? 0) + 1);
    }
  }

  const quotas = new Map<Topic, number>(topics.map((topic) => [topic, 0]));
  let slots = Math.min(
    Math.max(0, limit),
    [...available.values()].reduce((sum, count) => sum + count, 0)
  );

  // Water-fill the batch evenly. A topic that runs out simply stops taking
  // turns in quota allocation, so its unused share is redistributed without
  // leaving the reader short.
  while (slots > 0) {
    let allocated = false;
    for (const topic of topics) {
      if (slots === 0) break;
      const quota = quotas.get(topic) ?? 0;
      if (quota >= (available.get(topic) ?? 0)) continue;
      quotas.set(topic, quota + 1);
      slots--;
      allocated = true;
    }
    if (!allocated) break;
  }

  return quotas;
}

function passesStrictCaps(
  candidate: RecommendationCandidate,
  position: number,
  state: SelectionState
): boolean {
  const authorCount = countFor(state.authorCounts, candidate.authorKey);
  const domainCount = countFor(state.domainCounts, candidate.domain);

  // The visible first screen is deliberately one voice and one publication
  // at a time. Later in the session, excellent writers may recur—but never
  // close together and never often enough to dominate the stream.
  if (position < 12) {
    return authorCount === 0 && domainCount === 0;
  }
  return authorCount < 1 && domainCount < 1;
}

function passesStrictDiversity(
  candidate: RecommendationCandidate,
  position: number,
  state: SelectionState
): boolean {
  if (!passesStrictCaps(candidate, position, state)) return false;

  const lastAuthor = candidate.authorKey
    ? state.lastAuthor.get(candidate.authorKey)
    : undefined;
  const lastDomain = candidate.domain
    ? state.lastDomain.get(candidate.domain)
    : undefined;
  return (
    (lastAuthor == null || position - lastAuthor >= 15) &&
    (lastDomain == null || position - lastDomain >= 10)
  );
}

function passesRelaxedDiversity(
  candidate: RecommendationCandidate,
  position: number,
  state: SelectionState
): boolean {
  const authorCount = countFor(state.authorCounts, candidate.authorKey);
  const domainCount = countFor(state.domainCounts, candidate.domain);
  const authorLimit = 2;
  const domainLimit = 2;
  if (authorCount >= authorLimit || domainCount >= domainLimit) return false;

  const lastAuthor = candidate.authorKey
    ? state.lastAuthor.get(candidate.authorKey)
    : undefined;
  const lastDomain = candidate.domain
    ? state.lastDomain.get(candidate.domain)
    : undefined;
  return (
    (lastAuthor == null || position - lastAuthor >= 6) &&
    (lastDomain == null || position - lastDomain >= 4)
  );
}

function fallbackDiversityCost(
  candidate: RecommendationCandidate,
  rank: number,
  remainingCount: number,
  position: number,
  state: SelectionState
): number {
  const domainCount = countFor(state.domainCounts, candidate.domain);
  const authorCount = countFor(state.authorCounts, candidate.authorKey);
  const lastDomain = candidate.domain
    ? state.lastDomain.get(candidate.domain)
    : undefined;
  const lastAuthor = candidate.authorKey
    ? state.lastAuthor.get(candidate.authorKey)
    : undefined;
  const adjacentPenalty =
    (lastDomain === position - 1 ? 80 : 0) +
    (lastAuthor === position - 1 ? 40 : 0);

  return (
    domainCount * 1_000 +
    authorCount * 100 +
    adjacentPenalty +
    rank / Math.max(1, remainingCount)
  );
}

function selectCandidateIndex<T extends RecommendationCandidate>(
  remaining: T[],
  position: number,
  state: SelectionState
): number {
  let bestIndex = -1;
  let bestTier = Number.POSITIVE_INFINITY;
  let bestTopicBreadth = Number.POSITIVE_INFINITY;
  let bestFallbackCost = Number.POSITIVE_INFINITY;

  // One priority scan replaces five repeated findIndex passes. Within each
  // rule tier the original quality/random order is retained.
  for (let index = 0; index < remaining.length; index++) {
    const candidate = remaining[index];
    if (
      (state.topicCounts.get(candidate.topic) ?? 0) >=
      (state.topicQuotas.get(candidate.topic) ?? 0)
    ) {
      continue;
    }

    const strict = passesStrictDiversity(candidate, position, state);
    const caps = strict || passesStrictCaps(candidate, position, state);
    let tier: number;

    if (strict) tier = 0;
    else if (caps) tier = 1;
    else if (passesRelaxedDiversity(candidate, position, state)) tier = 2;
    else tier = 3;

    // A voice with articles in several selected topics is flexible supply.
    // Prefer a topic-exclusive voice at the same diversity tier so one topic
    // cannot consume somebody another topic will need for a diverse batch.
    const topicBreadth = state.topicBreadthByCandidate.get(candidate.id) ?? 1;
    if (tier === 0 && topicBreadth === 1) return index;
    const fallbackCost =
      tier === 3
        ? fallbackDiversityCost(
            candidate,
            index,
            remaining.length,
            position,
            state
          )
        : Number.POSITIVE_INFINITY;
    if (
      tier < bestTier ||
      (tier === bestTier && topicBreadth < bestTopicBreadth) ||
      (tier === bestTier &&
        topicBreadth === bestTopicBreadth &&
        fallbackCost < bestFallbackCost)
    ) {
      bestTier = tier;
      bestTopicBreadth = topicBreadth;
      bestIndex = index;
      bestFallbackCost = fallbackCost;
    }
  }
  return bestIndex;
}

/**
 * Turns a quality-ordered candidate pool into a session slate. Quality still
 * decides between eligible rows; this layer only prevents a prolific site or
 * byline from consuming the top of the reader and balances selected topics.
 */
export function buildDiverseSlate<T extends RecommendationCandidate>(
  orderedCandidates: T[],
  limit: number,
  selectedTopics: Topic[]
): T[] {
  const remaining = orderedCandidates.slice();
  const result: T[] = [];
  const topicsByVoice = new Map<string, Set<Topic>>();
  for (const candidate of remaining) {
    const key = voiceKey(candidate);
    const topics = topicsByVoice.get(key) ?? new Set<Topic>();
    topics.add(candidate.topic);
    topicsByVoice.set(key, topics);
  }
  const state: SelectionState = {
    authorCounts: new Map(),
    domainCounts: new Map(),
    topicCounts: new Map(),
    topicQuotas: allocateTopicQuotas(selectedTopics, remaining, limit),
    lastAuthor: new Map(),
    lastDomain: new Map(),
    topicBreadthByCandidate: new Map(
      remaining.map((candidate) => [
        candidate.id,
        topicsByVoice.get(voiceKey(candidate))?.size ?? 1,
      ])
    ),
  };

  while (result.length < limit && remaining.length > 0) {
    const position = result.length;
    const index = selectCandidateIndex(remaining, position, state);
    if (index < 0) break;

    const [picked] = remaining.splice(index, 1);
    result.push(picked);
    if (picked.authorKey) {
      state.authorCounts.set(
        picked.authorKey,
        countFor(state.authorCounts, picked.authorKey) + 1
      );
      state.lastAuthor.set(picked.authorKey, position);
    }
    if (picked.domain) {
      state.domainCounts.set(
        picked.domain,
        countFor(state.domainCounts, picked.domain) + 1
      );
      state.lastDomain.set(picked.domain, position);
    }
    state.topicCounts.set(
      picked.topic,
      (state.topicCounts.get(picked.topic) ?? 0) + 1
    );
  }

  return result;
}
