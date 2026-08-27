import type { Topic } from "./db";

export interface RecommendationCandidate {
  id: number;
  topic: Topic;
  authorKey: string;
  domain: string;
  semanticCluster?: string;
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
  historyWeight: number,
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
    recencyWeight * recency + historyWeight * Math.log2(Math.max(1, count) + 1)
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
  now = Date.now(),
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
      2,
    );
  }
  const author = candidate.authorKey
    ? identityExposurePenalty(
        candidate.authorExposureCount,
        candidate.authorLastExposedAt,
        now,
        100,
        45,
        2,
      )
    : 0;
  const domain = candidate.domain
    ? identityExposurePenalty(
        candidate.domainExposureCount,
        candidate.domainLastExposedAt,
        now,
        25,
        21,
        0.5,
      )
    : 0;
  return author + domain;
}

export function coolByPersistentExposure<T extends PersistentExposureCandidate>(
  orderedCandidates: readonly T[],
  now = Date.now(),
): T[] {
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
  domainCap: number;
  voiceCap: number;
  lastAuthor: Map<string, number>;
  lastDomain: Map<string, number>;
  lastSemanticCluster: Map<string, number>;
  semanticRepeatPenalty: number;
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
  openingSize = 12,
): boolean {
  if (slate.length < openingSize) return false;

  const opening = slate.slice(0, openingSize);
  if (new Set(opening.map(voiceKey)).size < openingSize) return false;
  if (
    new Set(opening.map((candidate) => candidate.domain)).size < openingSize
  ) {
    return false;
  }

  const topics = [...new Set(selectedTopics)];
  if (topics.length < 2) return true;
  const counts = topics.map(
    (topic) => slate.filter((candidate) => candidate.topic === topic).length,
  );
  return Math.max(...counts) - Math.min(...counts) <= 1;
}

function allocateTopicQuotas(
  selectedTopics: Topic[],
  candidates: readonly RecommendationCandidate[],
  limit: number,
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
    [...available.values()].reduce((sum, count) => sum + count, 0),
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

function fairIdentityCap(
  candidates: readonly RecommendationCandidate[],
  limit: number,
  identityFor: (candidate: RecommendationCandidate) => string,
): number {
  const availability = new Map<string, number>();
  for (const candidate of candidates) {
    const identity = identityFor(candidate);
    availability.set(identity, (availability.get(identity) ?? 0) + 1);
  }
  const slots = Math.min(Math.max(0, limit), candidates.length);
  let cap = 0;
  while (
    [...availability.values()].reduce(
      (sum, count) => sum + Math.min(count, cap),
      0,
    ) < slots
  ) {
    cap++;
  }
  return cap;
}

function maxDomainTopicSupply(
  candidates: readonly RecommendationCandidate[],
  domainCap: number,
  topicDemand: ReadonlyMap<Topic, number>,
): number {
  const domains = [...new Set(candidates.map((candidate) => candidate.domain))];
  const topics = [...topicDemand.keys()];
  const domainIndex = new Map(domains.map((domain, index) => [domain, index]));
  const topicIndex = new Map(topics.map((topic, index) => [topic, index]));
  const pairCounts = new Map<string, number>();
  for (const candidate of candidates) {
    const topic = topicIndex.get(candidate.topic);
    if (topic == null) continue;
    const pair = `${domainIndex.get(candidate.domain)}:${topic}`;
    pairCounts.set(pair, (pairCounts.get(pair) ?? 0) + 1);
  }

  const source = 0;
  const domainOffset = 1;
  const topicOffset = domainOffset + domains.length;
  const sink = topicOffset + topics.length;
  const graph: { to: number; capacity: number; reverse: number }[][] =
    Array.from({ length: sink + 1 }, () => []);
  const addEdge = (from: number, to: number, capacity: number) => {
    graph[from].push({ to, capacity, reverse: graph[to].length });
    graph[to].push({ to: from, capacity: 0, reverse: graph[from].length - 1 });
  };

  domains.forEach((_, index) => addEdge(source, domainOffset + index, domainCap));
  for (const [pair, capacity] of pairCounts) {
    const [domain, topic] = pair.split(":").map(Number);
    addEdge(domainOffset + domain, topicOffset + topic, capacity);
  }
  topics.forEach((topic, index) =>
    addEdge(topicOffset + index, sink, topicDemand.get(topic) ?? 0),
  );

  let flow = 0;
  for (;;) {
    const parent: ([number, number] | null)[] = Array(sink + 1).fill(null);
    const queue = [source];
    for (
      let cursor = 0;
      cursor < queue.length && parent[sink] == null;
      cursor++
    ) {
      const node = queue[cursor];
      for (let edgeIndex = 0; edgeIndex < graph[node].length; edgeIndex++) {
        const edge = graph[node][edgeIndex];
        if (
          edge.capacity <= 0 ||
          edge.to === source ||
          parent[edge.to] != null
        ) {
          continue;
        }
        parent[edge.to] = [node, edgeIndex];
        queue.push(edge.to);
      }
    }
    if (parent[sink] == null) break;

    for (let node = sink; node !== source;) {
      const [previous, edgeIndex] = parent[node]!;
      const edge = graph[previous][edgeIndex];
      edge.capacity--;
      graph[node][edge.reverse].capacity++;
      node = previous;
    }
    flow++;
  }
  return flow;
}

function fairTopicAwareDomainCap(
  candidates: readonly RecommendationCandidate[],
  topicDemand: ReadonlyMap<Topic, number>,
): number {
  const required = [...topicDemand.values()].reduce(
    (sum, count) => sum + count,
    0,
  );
  // The topic-agnostic cap is a lower bound, so start there instead of
  // rebuilding the flow graph for impossible smaller caps.
  let cap = fairIdentityCap(
    candidates,
    required,
    (candidate) => candidate.domain,
  );
  while (
    cap < required &&
    maxDomainTopicSupply(candidates, cap, topicDemand) < required
  ) {
    cap++;
  }
  return cap;
}

function maxVoiceDomainSupply(
  candidates: readonly RecommendationCandidate[],
  voiceCap: number,
  domainCap: number,
): number {
  const voices = [...new Set(candidates.map(voiceKey))];
  const domains = [...new Set(candidates.map((candidate) => candidate.domain))];
  const voiceIndex = new Map(voices.map((voice, index) => [voice, index]));
  const domainIndex = new Map(domains.map((domain, index) => [domain, index]));
  const pairCounts = new Map<string, number>();
  for (const candidate of candidates) {
    const pair = `${voiceIndex.get(voiceKey(candidate))}:${domainIndex.get(candidate.domain)}`;
    pairCounts.set(pair, (pairCounts.get(pair) ?? 0) + 1);
  }

  const source = 0;
  const voiceOffset = 1;
  const domainOffset = voiceOffset + voices.length;
  const sink = domainOffset + domains.length;
  const graph: { to: number; capacity: number; reverse: number }[][] =
    Array.from({ length: sink + 1 }, () => []);
  const addEdge = (from: number, to: number, capacity: number) => {
    graph[from].push({ to, capacity, reverse: graph[to].length });
    graph[to].push({ to: from, capacity: 0, reverse: graph[from].length - 1 });
  };

  voices.forEach((_, index) => addEdge(source, voiceOffset + index, voiceCap));
  domains.forEach((_, index) => addEdge(domainOffset + index, sink, domainCap));
  for (const [pair, capacity] of pairCounts) {
    const [voice, domain] = pair.split(":").map(Number);
    addEdge(voiceOffset + voice, domainOffset + domain, capacity);
  }

  let flow = 0;
  for (;;) {
    const parent: ([number, number] | null)[] = Array(sink + 1).fill(null);
    const queue = [source];
    for (
      let cursor = 0;
      cursor < queue.length && parent[sink] == null;
      cursor++
    ) {
      const node = queue[cursor];
      for (let edgeIndex = 0; edgeIndex < graph[node].length; edgeIndex++) {
        const edge = graph[node][edgeIndex];
        if (
          edge.capacity <= 0 ||
          edge.to === source ||
          parent[edge.to] != null
        ) {
          continue;
        }
        parent[edge.to] = [node, edgeIndex];
        queue.push(edge.to);
      }
    }
    if (parent[sink] == null) break;

    let amount = Number.POSITIVE_INFINITY;
    for (let node = sink; node !== source;) {
      const [previous, edgeIndex] = parent[node]!;
      amount = Math.min(amount, graph[previous][edgeIndex].capacity);
      node = previous;
    }
    for (let node = sink; node !== source;) {
      const [previous, edgeIndex] = parent[node]!;
      const edge = graph[previous][edgeIndex];
      edge.capacity -= amount;
      graph[node][edge.reverse].capacity += amount;
      node = previous;
    }
    flow += amount;
  }
  return flow;
}

function fairJointVoiceCap(
  candidates: readonly RecommendationCandidate[],
  limit: number,
  domainCap: number,
): number {
  const slots = Math.min(Math.max(0, limit), candidates.length);
  let voiceCap = fairIdentityCap(candidates, slots, voiceKey);
  while (
    voiceCap < slots &&
    maxVoiceDomainSupply(candidates, voiceCap, domainCap) < slots
  ) {
    voiceCap++;
  }
  return voiceCap;
}

function voiceCountFor(
  candidate: RecommendationCandidate,
  state: SelectionState,
): number {
  return candidate.authorKey
    ? countFor(state.authorCounts, candidate.authorKey)
    : countFor(state.domainCounts, candidate.domain);
}

function diversityTier(
  candidate: RecommendationCandidate,
  position: number,
  state: SelectionState,
): number {
  const voiceCount = voiceCountFor(candidate, state);
  const domainCount = countFor(state.domainCounts, candidate.domain);
  const lastVoice = candidate.authorKey
    ? state.lastAuthor.get(candidate.authorKey)
    : state.lastDomain.get(candidate.domain);
  const lastDomain = candidate.domain
    ? state.lastDomain.get(candidate.domain)
    : undefined;
  const adjacent = lastVoice === position - 1 || lastDomain === position - 1;
  const voiceTooRecent = lastVoice != null && position - lastVoice < 7;
  const domainTooRecent = lastDomain != null && position - lastDomain < 4;
  const lastSemanticCluster = candidate.semanticCluster
    ? state.lastSemanticCluster.get(candidate.semanticCluster)
    : undefined;
  // One ecosystem may arrive through many aggregators, authors, and domains.
  // Treat a second appearance within one visible screen as less novel, while
  // keeping it a soft preference so a narrow/offline library can still fill.
  // A one-point tier is intentionally weaker than repeating a publication.
  const semanticRepeat =
    lastSemanticCluster != null && position - lastSemanticCluster < 12;
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
  const aboveFairDomainShare = domainCount >= state.domainCap;
  const aboveFairVoiceShare = voiceCount >= state.voiceCap;
  return (
    novelty * 2 +
    // Recent repetition is more noticeable than exceeding an eventual fair
    // share by one card. This is especially important at refill boundaries,
    // where the same person on a new domain must not look "novel" again.
    (voiceTooRecent ? 4_000 : 0) +
    (domainTooRecent ? 3_000 : 0) +
    (semanticRepeat ? state.semanticRepeatPenalty : 0) +
    (adjacent ? 10_000 : 0) +
    (aboveFairDomainShare ? 2_000 : 0) +
    (aboveFairVoiceShare ? 1_000 : 0)
  );
}

function diversityCost(
  candidate: RecommendationCandidate,
  rank: number,
  remainingCount: number,
  position: number,
  state: SelectionState,
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
  state: SelectionState,
): number {
  let bestIndex = -1;
  let bestTier = Number.POSITIVE_INFINITY;
  let bestDomainBreadth = Number.POSITIVE_INFINITY;
  let bestTopicBreadth = Number.POSITIVE_INFINITY;
  let bestFallbackCost = Number.POSITIVE_INFINITY;
  let minimumRollingTopicCount = Number.POSITIVE_INFINITY;
  for (const [topic, quota] of state.topicQuotas) {
    if ((state.topicCounts.get(topic) ?? 0) >= quota) continue;
    minimumRollingTopicCount = Math.min(
      minimumRollingTopicCount,
      state.rollingTopicCounts.get(topic) ?? 0,
    );
  }

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
      state,
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
  priorCandidates: readonly RecommendationCandidate[] = [],
): T[] {
  return buildDiverseSlateInternal(
    orderedCandidates,
    limit,
    selectedTopics,
    priorCandidates,
    true,
  );
}

function repairFairShare<T extends RecommendationCandidate>(
  selected: readonly T[],
  unused: readonly T[],
  priorCandidates: readonly RecommendationCandidate[],
  voiceCap: number,
  domainCap: number,
): { slate: T[]; changed: boolean } {
  const slate = selected.slice();
  const alternatives = unused.slice();
  const voiceCounts = new Map<string, number>();
  const domainCounts = new Map<string, number>();
  const semanticClusterCounts = new Map<string, number>();
  const add = (candidate: RecommendationCandidate, amount: 1 | -1) => {
    const voice = voiceKey(candidate);
    voiceCounts.set(voice, (voiceCounts.get(voice) ?? 0) + amount);
    domainCounts.set(
      candidate.domain,
      (domainCounts.get(candidate.domain) ?? 0) + amount,
    );
    if (candidate.semanticCluster) {
      semanticClusterCounts.set(
        candidate.semanticCluster,
        (semanticClusterCounts.get(candidate.semanticCluster) ?? 0) + amount,
      );
    }
  };
  for (const candidate of priorCandidates) add(candidate, 1);
  for (const candidate of slate) add(candidate, 1);

  let changed = false;
  // Every successful pass removes at least one current cap violation. The
  // bound prevents pathological fixtures from turning ranking into a search
  // problem when the joint author/publication constraints are infeasible.
  for (let pass = 0; pass < slate.length * 2; pass++) {
    let repaired = false;
    for (
      let selectedIndex = slate.length - 1;
      selectedIndex >= 0;
      selectedIndex--
    ) {
      const current = slate[selectedIndex];
      const currentVoice = voiceKey(current);
      const voiceOverflow = (voiceCounts.get(currentVoice) ?? 0) > voiceCap;
      const domainOverflow =
        (domainCounts.get(current.domain) ?? 0) > domainCap;
      if (!voiceOverflow && !domainOverflow) continue;

      add(current, -1);
      let alternativeIndex = -1;
      let bestSemanticCount = Number.POSITIVE_INFINITY;
      for (let index = 0; index < alternatives.length; index++) {
        const candidate = alternatives[index];
        if (
          candidate.topic !== current.topic ||
          (voiceCounts.get(voiceKey(candidate)) ?? 0) >= voiceCap ||
          (domainCounts.get(candidate.domain) ?? 0) >= domainCap
        ) {
          continue;
        }
        // Repairs exist to fix an author/publication cap after the greedy
        // pass. Among equally valid swaps, never recreate the original bug by
        // pulling from an ecosystem that is already common in the window.
        const semanticCount = candidate.semanticCluster
          ? (semanticClusterCounts.get(candidate.semanticCluster) ?? 0)
          : 0;
        if (semanticCount < bestSemanticCount) {
          alternativeIndex = index;
          bestSemanticCount = semanticCount;
          if (semanticCount === 0) break;
        }
      }
      if (alternativeIndex < 0) {
        add(current, 1);
        continue;
      }

      const [replacement] = alternatives.splice(alternativeIndex, 1);
      alternatives.push(current);
      slate[selectedIndex] = replacement;
      add(replacement, 1);
      changed = true;
      repaired = true;
      break;
    }
    if (!repaired) break;
  }

  // Identity-cap repair can otherwise exchange a varied article for another
  // domain from an already-heavy ecosystem. Keep enough clustered cards for
  // one appearance per 12-card screen, and replace only the excess when a
  // same-topic, identity-feasible alternative exists. The subsequent ordering
  // pass handles exact rolling spacing; this pass merely makes that ordering
  // feasible without weakening author/publication caps.
  const semanticCap = Math.max(
    1,
    Math.ceil((priorCandidates.length + slate.length) / 12),
  );
  for (let selectedIndex = slate.length - 1; selectedIndex >= 0; selectedIndex--) {
    const current = slate[selectedIndex];
    if (
      !current.semanticCluster ||
      (semanticClusterCounts.get(current.semanticCluster) ?? 0) <= semanticCap
    ) {
      continue;
    }

    add(current, -1);
    let alternativeIndex = -1;
    for (let index = 0; index < alternatives.length; index++) {
      const candidate = alternatives[index];
      if (
        candidate.topic !== current.topic ||
        (voiceCounts.get(voiceKey(candidate)) ?? 0) >= voiceCap ||
        (domainCounts.get(candidate.domain) ?? 0) >= domainCap ||
        (candidate.semanticCluster &&
          (semanticClusterCounts.get(candidate.semanticCluster) ?? 0) >=
            semanticCap)
      ) {
        continue;
      }
      alternativeIndex = index;
      if (!candidate.semanticCluster) break;
    }
    if (alternativeIndex < 0) {
      add(current, 1);
      continue;
    }

    const [replacement] = alternatives.splice(alternativeIndex, 1);
    alternatives.push(current);
    slate[selectedIndex] = replacement;
    add(replacement, 1);
    changed = true;
  }

  return { slate, changed };
}

function buildDiverseSlateInternal<T extends RecommendationCandidate>(
  orderedCandidates: T[],
  limit: number,
  selectedTopics: Topic[],
  priorCandidates: readonly RecommendationCandidate[],
  repair: boolean,
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
    const domainTopics =
      topicsByDomain.get(candidate.domain) ?? new Set<Topic>();
    domainTopics.add(candidate.topic);
    topicsByDomain.set(candidate.domain, domainTopics);
  }
  const capCandidates = [...priorCandidates, ...remaining];
  // A refill is requested with one third of the current 36-card window still
  // queued, so only the first two thirds of the appended slate are exposed
  // before the next fairness decision. Size caps for that rolling horizon,
  // not all 36 appended cards; otherwise late cards can consume a third share
  // before a 60-card journey reaches the next refill boundary.
  const appendedFairnessHorizon = priorCandidates.length
    ? Math.max(12, Math.ceil((Math.max(0, limit) * 2) / 3))
    : Math.max(0, limit);
  const capTopicDemand = allocateTopicQuotas(
    selectedTopics,
    remaining,
    Math.min(appendedFairnessHorizon, remaining.length),
  );
  for (const candidate of priorCandidates) {
    capTopicDemand.set(
      candidate.topic,
      (capTopicDemand.get(candidate.topic) ?? 0) + 1,
    );
  }
  const capWindow = [...capTopicDemand.values()].reduce(
    (sum, count) => sum + count,
    0,
  );
  const domainCap = fairTopicAwareDomainCap(capCandidates, capTopicDemand);
  const voiceCap = priorCandidates.length
    ? fairJointVoiceCap(capCandidates, capWindow, domainCap)
    : Number.POSITIVE_INFINITY;
  const state: SelectionState = {
    authorCounts: new Map(),
    domainCounts: new Map(),
    topicCounts: new Map(),
    rollingTopicCounts: new Map(
      [...new Set(selectedTopics)].map((topic) => [topic, 0]),
    ),
    topicQuotas: allocateTopicQuotas(selectedTopics, remaining, limit),
    domainCap,
    voiceCap,
    lastAuthor: new Map(),
    lastDomain: new Map(),
    lastSemanticCluster: new Map(),
    // Theme spacing wins over a harmless, well-spaced identity repeat. This
    // matters after the first few screens, when unique authors from one large
    // ecosystem (notably Python) would otherwise look novel individually and
    // bunch together despite being the same subject experience.
    semanticRepeatPenalty: 10,
    topicBreadthByCandidate: new Map(
      remaining.map((candidate) => [
        candidate.id,
        topicsByVoice.get(voiceKey(candidate))?.size ?? 1,
      ]),
    ),
    topicBreadthByDomain: new Map(
      [...topicsByDomain].map(([domain, topics]) => [domain, topics.size]),
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
        countFor(state.authorCounts, candidate.authorKey) + 1,
      );
      state.lastAuthor.set(candidate.authorKey, position);
    }
    if (candidate.domain) {
      state.domainCounts.set(
        candidate.domain,
        countFor(state.domainCounts, candidate.domain) + 1,
      );
      state.lastDomain.set(candidate.domain, position);
    }
    if (candidate.semanticCluster) {
      state.lastSemanticCluster.set(candidate.semanticCluster, position);
    }
    if (state.rollingTopicCounts.has(candidate.topic)) {
      state.rollingTopicCounts.set(
        candidate.topic,
        (state.rollingTopicCounts.get(candidate.topic) ?? 0) + 1,
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
        countFor(state.authorCounts, picked.authorKey) + 1,
      );
      state.lastAuthor.set(picked.authorKey, position);
    }
    if (picked.domain) {
      state.domainCounts.set(
        picked.domain,
        countFor(state.domainCounts, picked.domain) + 1,
      );
      state.lastDomain.set(picked.domain, position);
    }
    if (picked.semanticCluster) {
      state.lastSemanticCluster.set(picked.semanticCluster, position);
    }
    state.topicCounts.set(
      picked.topic,
      (state.topicCounts.get(picked.topic) ?? 0) + 1,
    );
    state.rollingTopicCounts.set(
      picked.topic,
      (state.rollingTopicCounts.get(picked.topic) ?? 0) + 1,
    );
  }

  if (repair && priorCandidates.length > 0) {
    const repaired = repairFairShare(
      result,
      remaining,
      priorCandidates,
      state.voiceCap,
      state.domainCap,
    );
    if (repaired.changed) {
      // The repaired set is already cap-feasible. Run the same lightweight
      // ordering pass once more so swaps made near the tail also respect the
      // normal author/publication spacing and rolling topic rhythm.
      return buildDiverseSlateInternal(
        repaired.slate,
        limit,
        selectedTopics,
        priorCandidates,
        false,
      );
    }
  }

  return result;
}
