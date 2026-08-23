import type { Topic } from "./db";

export interface RecommendationCandidate {
  id: number;
  topic: Topic;
  authorKey: string;
  domain: string;
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

function passesStrictDiversity(
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
  if (authorCount >= 2 || domainCount >= 3) return false;

  const lastAuthor = candidate.authorKey
    ? state.lastAuthor.get(candidate.authorKey)
    : undefined;
  const lastDomain = candidate.domain
    ? state.lastDomain.get(candidate.domain)
    : undefined;
  return (
    (lastAuthor == null || position - lastAuthor >= 10) &&
    (lastDomain == null || position - lastDomain >= 5)
  );
}

function passesRelaxedDiversity(
  candidate: RecommendationCandidate,
  position: number,
  state: SelectionState
): boolean {
  const authorCount = countFor(state.authorCounts, candidate.authorKey);
  const domainCount = countFor(state.domainCounts, candidate.domain);
  const authorLimit = position < 12 ? 2 : 3;
  const domainLimit = position < 12 ? 2 : 4;
  if (authorCount >= authorLimit || domainCount >= domainLimit) return false;

  const lastAuthor = candidate.authorKey
    ? state.lastAuthor.get(candidate.authorKey)
    : undefined;
  const lastDomain = candidate.domain
    ? state.lastDomain.get(candidate.domain)
    : undefined;
  return (
    (lastAuthor == null || position - lastAuthor >= 4) &&
    (lastDomain == null || position - lastDomain >= 2)
  );
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
    const selectors = [
      (row: T) =>
        topicIsBalanced(row, state, selectedTopics) &&
        passesStrictDiversity(row, position, state),
      (row: T) => passesStrictDiversity(row, position, state),
      (row: T) => passesRelaxedDiversity(row, position, state),
      () => true,
    ];

    let index = -1;
    for (const selector of selectors) {
      index = remaining.findIndex(selector);
      if (index >= 0) break;
    }
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
