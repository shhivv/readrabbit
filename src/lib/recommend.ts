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
  remainingTopicCounts: Map<Topic, number>;
  lastAuthor: Map<string, number>;
  lastDomain: Map<string, number>;
}

function countFor(map: Map<string, number>, key: string): number {
  return key ? (map.get(key) ?? 0) : 0;
}

function topicIsBalanced(
  candidate: RecommendationCandidate,
  state: SelectionState,
  selectedTopics: Topic[]
): boolean {
  const available = selectedTopics.filter(
    (topic) => (state.remainingTopicCounts.get(topic) ?? 0) > 0
  );
  if (available.length < 2) return true;
  const minimum = Math.min(...available.map((topic) => state.topicCounts.get(topic) ?? 0));
  return (state.topicCounts.get(candidate.topic) ?? 0) <= minimum;
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
  state: SelectionState,
  selectedTopics: Topic[]
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
    (topicIsBalanced(candidate, state, selectedTopics) ? 0 : 100_000) +
    domainCount * 1_000 +
    authorCount * 100 +
    adjacentPenalty +
    rank / Math.max(1, remainingCount)
  );
}

function selectCandidateIndex<T extends RecommendationCandidate>(
  remaining: T[],
  position: number,
  state: SelectionState,
  selectedTopics: Topic[]
): number {
  let bestIndex = -1;
  let bestTier = Number.POSITIVE_INFINITY;
  let bestFallbackCost = Number.POSITIVE_INFINITY;

  // One priority scan replaces five repeated findIndex passes. Within each
  // rule tier the original quality/random order is retained.
  for (let index = 0; index < remaining.length; index++) {
    const candidate = remaining[index];
    const balanced = topicIsBalanced(candidate, state, selectedTopics);
    const strict = passesStrictDiversity(candidate, position, state);
    const caps = strict || passesStrictCaps(candidate, position, state);
    let tier: number;

    if (balanced && strict) tier = 0;
    else if (strict) tier = 1;
    else if (balanced && caps) tier = 2;
    else if (caps) tier = 3;
    else if (passesRelaxedDiversity(candidate, position, state)) tier = 4;
    else tier = 5;

    if (tier === 0) return index;
    if (tier < bestTier) {
      bestTier = tier;
      bestIndex = index;
      bestFallbackCost =
        tier === 5
          ? fallbackDiversityCost(
              candidate,
              index,
              remaining.length,
              position,
              state,
              selectedTopics
            )
          : Number.POSITIVE_INFINITY;
    } else if (tier === 5 && bestTier === 5) {
      const cost = fallbackDiversityCost(
        candidate,
        index,
        remaining.length,
        position,
        state,
        selectedTopics
      );
      if (cost < bestFallbackCost) {
        bestFallbackCost = cost;
        bestIndex = index;
      }
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
  const state: SelectionState = {
    authorCounts: new Map(),
    domainCounts: new Map(),
    topicCounts: new Map(),
    remainingTopicCounts: new Map(),
    lastAuthor: new Map(),
    lastDomain: new Map(),
  };
  for (const candidate of remaining) {
    state.remainingTopicCounts.set(
      candidate.topic,
      (state.remainingTopicCounts.get(candidate.topic) ?? 0) + 1
    );
  }

  while (result.length < limit && remaining.length > 0) {
    const position = result.length;
    const index = selectCandidateIndex(
      remaining,
      position,
      state,
      selectedTopics
    );
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
    state.remainingTopicCounts.set(
      picked.topic,
      Math.max(0, (state.remainingTopicCounts.get(picked.topic) ?? 1) - 1)
    );
  }

  return result;
}
