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
  rollingTopicCounts: Map<Topic, number>;
  topicQuotas: Map<Topic, number>;
  lastAuthor: Map<string, number>;
  lastDomain: Map<string, number>;
  topicBreadthByCandidate: Map<number, number>;
  topicBreadthByDomain: Map<string, number>;
}

function countFor(map: Map<string, number>, key: string): number {
  return key ? (map.get(key) ?? 0) : 0;
}

function voiceKey(candidate: RecommendationCandidate): string {
  return candidate.authorKey || `site:${candidate.domain}`;
}

export function hasDiverseOpening(
  slate: readonly RecommendationCandidate[],
  selectedTopics: Topic[],
  openingSize = 12
): boolean {
  if (slate.length < openingSize) return false;

  const opening = slate.slice(0, openingSize);
  if (new Set(opening.map(voiceKey)).size < openingSize) return false;
  if (new Set(opening.map((candidate) => candidate.domain)).size < openingSize) {
    return false;
  }

  const topics = [...new Set(selectedTopics)];
  if (topics.length < 2) return true;
  const counts = topics.map(
    (topic) => slate.filter((candidate) => candidate.topic === topic).length
  );
  return Math.max(...counts) - Math.min(...counts) <= 1;
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

function voiceCountFor(
  candidate: RecommendationCandidate,
  state: SelectionState
): number {
  return candidate.authorKey
    ? countFor(state.authorCounts, candidate.authorKey)
    : countFor(state.domainCounts, candidate.domain);
}

function diversityTier(
  candidate: RecommendationCandidate,
  position: number,
  state: SelectionState
): number {
  const voiceCount = voiceCountFor(candidate, state);
  const domainCount = countFor(state.domainCounts, candidate.domain);
  const lastVoice = candidate.authorKey
    ? state.lastAuthor.get(candidate.authorKey)
    : state.lastDomain.get(candidate.domain);
  const lastDomain = candidate.domain
    ? state.lastDomain.get(candidate.domain)
    : undefined;
  const spaced =
    (lastVoice == null || position - lastVoice >= 6) &&
    (lastDomain == null || position - lastDomain >= 4);
  const adjacent =
    lastVoice === position - 1 || lastDomain === position - 1;
  const novelty =
    voiceCount === 0 && domainCount === 0
      ? 0
      : voiceCount === 0
        ? 1
        : domainCount === 0
          ? 2
          : 3;

  // Both identities unseen is always best. Once publications run out, keep
  // exhausting unseen people before repeating a familiar byline; this is the
  // distinction the old all-or-nothing cap lost after the first site repeat.
  // Adjacency is a hard experiential boundary: a new byline does not make two
  // consecutive cards from the same publication feel diverse. Outside that
  // boundary, unseen people still beat longer soft cooldowns.
  return novelty * 2 + (spaced ? 0 : 1) + (adjacent ? 100 : 0);
}

function diversityCost(
  candidate: RecommendationCandidate,
  rank: number,
  remainingCount: number,
  position: number,
  state: SelectionState
): number {
  const domainCount = countFor(state.domainCounts, candidate.domain);
  const voiceCount = voiceCountFor(candidate, state);
  const lastDomain = candidate.domain
    ? state.lastDomain.get(candidate.domain)
    : undefined;
  const lastVoice = candidate.authorKey
    ? state.lastAuthor.get(candidate.authorKey)
    : state.lastDomain.get(candidate.domain);
  const adjacentPenalty =
    (lastDomain === position - 1 ? 800 : 0) +
    (lastVoice === position - 1 ? 400 : 0);

  return (
    voiceCount * 1_000 +
    domainCount * 100 +
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
  let bestDomainBreadth = Number.POSITIVE_INFINITY;
  let bestTopicBreadth = Number.POSITIVE_INFINITY;
  let bestFallbackCost = Number.POSITIVE_INFINITY;
  const eligibleTopics = new Set(
    remaining
      .filter(
        (candidate) =>
          (state.topicCounts.get(candidate.topic) ?? 0) <
          (state.topicQuotas.get(candidate.topic) ?? 0)
      )
      .map((candidate) => candidate.topic)
  );
  const minimumRollingTopicCount = Math.min(
    ...[...eligibleTopics].map(
      (topic) => state.rollingTopicCounts.get(topic) ?? 0
    )
  );

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
    // Let quality create short, natural runs, but stop any selected topic
    // getting more than two cards ahead of another. Seeding this count from
    // the queued tail keeps the mix stable across a top-up boundary too.
    if (
      (state.rollingTopicCounts.get(candidate.topic) ?? 0) >
      minimumRollingTopicCount + 1
    ) {
      continue;
    }

    const tier = diversityTier(candidate, position, state);

    // A voice with articles in several selected topics is flexible supply.
    // The same applies to a publication carrying several topics: reserve
    // flexible identities so a greedy early choice cannot force a repeat in
    // a later topic even though a globally unique slate was possible.
    const topicBreadth = state.topicBreadthByCandidate.get(candidate.id) ?? 1;
    const domainBreadth = state.topicBreadthByDomain.get(candidate.domain) ?? 1;
    if (tier === 0 && topicBreadth === 1 && domainBreadth === 1) return index;
    const fallbackCost = diversityCost(
      candidate,
      index,
      remaining.length,
      position,
      state
    );
    if (
      tier < bestTier ||
      (tier === bestTier && domainBreadth < bestDomainBreadth) ||
      (tier === bestTier &&
        domainBreadth === bestDomainBreadth &&
        topicBreadth < bestTopicBreadth) ||
      (tier === bestTier &&
        domainBreadth === bestDomainBreadth &&
        topicBreadth === bestTopicBreadth &&
        fallbackCost < bestFallbackCost)
    ) {
      bestTier = tier;
      bestDomainBreadth = domainBreadth;
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
  selectedTopics: Topic[],
  priorCandidates: readonly RecommendationCandidate[] = []
): T[] {
  const remaining = orderedCandidates.slice();
  const result: T[] = [];
  const topicsByVoice = new Map<string, Set<Topic>>();
  const topicsByDomain = new Map<string, Set<Topic>>();
  for (const candidate of remaining) {
    const key = voiceKey(candidate);
    const topics = topicsByVoice.get(key) ?? new Set<Topic>();
    topics.add(candidate.topic);
    topicsByVoice.set(key, topics);
    const domainTopics = topicsByDomain.get(candidate.domain) ?? new Set<Topic>();
    domainTopics.add(candidate.topic);
    topicsByDomain.set(candidate.domain, domainTopics);
  }
  const state: SelectionState = {
    authorCounts: new Map(),
    domainCounts: new Map(),
    topicCounts: new Map(),
    rollingTopicCounts: new Map(
      [...new Set(selectedTopics)].map((topic) => [topic, 0])
    ),
    topicQuotas: allocateTopicQuotas(selectedTopics, remaining, limit),
    lastAuthor: new Map(),
    lastDomain: new Map(),
    topicBreadthByCandidate: new Map(
      remaining.map((candidate) => [
        candidate.id,
        topicsByVoice.get(voiceKey(candidate))?.size ?? 1,
      ])
    ),
    topicBreadthByDomain: new Map(
      [...topicsByDomain].map(([domain, topics]) => [domain, topics.size])
    ),
  };

  // Treat the tail of the existing stream as positions immediately before
  // this slate. That makes author/publication spacing continuous across app
  // restarts and top-up boundaries instead of resetting at every generation.
  for (let index = 0; index < priorCandidates.length; index++) {
    const candidate = priorCandidates[index];
    const position = index - priorCandidates.length;
    if (candidate.authorKey) {
      state.authorCounts.set(
        candidate.authorKey,
        countFor(state.authorCounts, candidate.authorKey) + 1
      );
      state.lastAuthor.set(candidate.authorKey, position);
    }
    if (candidate.domain) {
      state.domainCounts.set(
        candidate.domain,
        countFor(state.domainCounts, candidate.domain) + 1
      );
      state.lastDomain.set(candidate.domain, position);
    }
    if (state.rollingTopicCounts.has(candidate.topic)) {
      state.rollingTopicCounts.set(
        candidate.topic,
        (state.rollingTopicCounts.get(candidate.topic) ?? 0) + 1
      );
    }
  }

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
    state.rollingTopicCounts.set(
      picked.topic,
      (state.rollingTopicCounts.get(picked.topic) ?? 0) + 1
    );
  }

  return result;
}
