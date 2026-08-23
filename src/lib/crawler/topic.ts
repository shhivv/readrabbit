import type { Topic } from "../db";

export interface TopicInput {
  title: string;
  excerpt?: string;
  textContent?: string;
}

export interface TopicAssessment {
  topic: Topic;
  relevance: number;
  scores: Record<Topic, number>;
}

interface Lexicon {
  strong: readonly string[];
  supporting: readonly string[];
}

const LEXICONS: Record<Topic, Lexicon> = {
  technology: {
    strong: [
      "artificial intelligence", "machine learning", "large language model",
      "model context protocol", "software engineering", "computer science",
      "programming language", "distributed system", "operating system",
      "database", "compiler", "kernel", "cybersecurity", "cryptography",
      "algorithm", "source code", "open source", "developer tool",
      "web browser", "cloud computing", "neural network",
      "generative ai", "language model", "coding agent", "memory safety",
      "computer vision", "wireless network", "virtual machine", "nanogpt",
    ],
    supporting: [
      "software", "programming", "computer", "developer", "coding", "code",
      "internet", "protocol", "network", "server", "api", "framework",
      "library", "runtime", "linux", "python", "javascript", "typescript",
      "rust", "security", "encryption", "hardware", "gpu", "llm", "mcp",
      "chatgpt", "claude", "openai", "debugging", "browser", "ai model",
      "gpt", "wifi", "wi-fi", "wireless", "firmware", "microprocessor",
      "processor", "chipset", "emulator", "bookmarklet", "webpage",
    ],
  },
  economics: {
    strong: [
      "economics", "economic growth", "monetary policy", "fiscal policy",
      "central bank", "federal reserve", "interest rate", "labor market",
      "public finance", "industrial policy", "international trade",
      "exchange rate", "cost of living", "income inequality",
      "development economics", "behavioral economics", "game theory",
      "consumer price", "gross domestic product", "supply and demand",
      "market power", "economic policy",
      "political economy", "marginal utility", "balance of payments",
      "debt to gdp", "stock market", "economic education", "economic history",
    ],
    supporting: [
      "economy", "economic", "economist", "inflation", "deflation",
      "unemployment", "productivity", "recession", "tariff", "trade",
      "wage", "income", "consumption", "investment", "capital", "market",
      "price", "competition", "monopoly", "housing", "inequality", "tax",
      "regulation", "currency", "gdp", "bond", "yield", "incentive",
      "econometric", "macroeconomic", "microeconomic",
      "stagnation", "auction", "bankruptcy", "birth rate", "migration",
    ],
  },
  math: {
    strong: [
      "mathematics", "mathematical", "number theory", "graph theory",
      "category theory", "set theory", "group theory", "measure theory",
      "linear algebra", "differential equation", "partial differential",
      "complex analysis", "real analysis", "algebraic geometry",
      "differential geometry", "probability theory", "random variable",
      "prime number", "formal proof",
      "bessel function", "fourier transform", "hadamard matrix",
      "zeta function", "statistical model", "bayesian inference",
      "complexity theory", "quantum computing",
    ],
    supporting: [
      "theorem", "proof", "lemma", "corollary", "geometry", "algebra",
      "calculus", "topology", "combinatorics", "probability", "statistics",
      "equation", "integral", "derivative", "matrix", "polynomial", "prime",
      "integer", "sequence", "function", "manifold", "vector", "tensor",
      "symmetry", "infinity", "axiom", "conjecture",
    ],
  },
};

const TOPICS: readonly Topic[] = ["technology", "economics", "math"];

function normalizedText(value: string): string {
  return ` ${value
    .toLowerCase()
    .replace(/[^a-z0-9+#.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()} `;
}

function occurrences(text: string, term: string): number {
  const needle = ` ${term} `;
  let count = 0;
  let cursor = 0;
  while (count < 3) {
    const found = text.indexOf(needle, cursor);
    if (found < 0) break;
    count++;
    cursor = found + needle.length;
  }
  return count;
}

function fieldScore(text: string, lexicon: Lexicon): number {
  let score = 0;
  for (const term of lexicon.strong) {
    score += occurrences(text, term) * 2.4;
  }
  for (const term of lexicon.supporting) {
    score += occurrences(text, term) * 0.75;
  }
  return score;
}

function rawTopicScore(input: TopicInput, topic: Topic): number {
  const lexicon = LEXICONS[topic];
  const title = normalizedText(input.title);
  const excerpt = normalizedText(input.excerpt ?? "");
  const body = normalizedText((input.textContent ?? "").slice(0, 12_000));

  const headline =
    fieldScore(title, lexicon) * 3.5 + fieldScore(excerpt, lexicon) * 1.5;
  const raw = headline + fieldScore(body, lexicon) * 0.35;

  // Body-only generic matches ("market", "function", "model") are weak
  // evidence. They used to turn a restaurant guide on an economics blog into
  // an economics recommendation. A genuinely subject-heavy article can still
  // qualify from its body, but a couple of incidental mentions cannot.
  return headline === 0 && raw < 4 ? raw * 0.25 : raw;
}

function confidence(raw: number): number {
  return Math.max(0, Math.min(1, 1 - Math.exp(-raw / 5)));
}

/**
 * Classifies the article itself rather than trusting the feed it came from.
 * The feed topic is only a tie-breaker: a technology detour on an economics
 * blog must not enter an economics-only reader.
 */
export function assessTopic(
  input: TopicInput,
  sourceHint: Topic
): TopicAssessment {
  const raw = Object.fromEntries(
    TOPICS.map((topic) => [topic, rawTopicScore(input, topic)])
  ) as Record<Topic, number>;

  let topic = sourceHint;
  for (const candidate of TOPICS) {
    if (raw[candidate] > raw[topic]) topic = candidate;
  }

  // A near-tie stays with the trusted feed hint. This avoids relabeling an
  // economics piece as technology merely because it discusses software once.
  if (topic !== sourceHint && raw[topic] < raw[sourceHint] * 1.25 + 1.2) {
    topic = sourceHint;
  }

  const scores = Object.fromEntries(
    TOPICS.map((candidate) => [candidate, confidence(raw[candidate])])
  ) as Record<Topic, number>;

  return { topic, relevance: scores[topic], scores };
}

export const MIN_TOPIC_RELEVANCE = 0.4;
