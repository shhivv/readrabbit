import { normalizeWhitespace } from "./extract";
import type { ExtractedArticle } from "./extract";

// Composite article-quality scoring, grounded in:
// - Kohlschütter et al., "Boilerplate Detection using Shallow Text Features"
//   (WSDM 2010): stopword ratio, uppercase ratio, link density, sentence
//   statistics separate long-form content from nav junk / keyword stuffing.
// - Potthast et al., "Clickbait Detection" (ECIR 2016) + Clickbait Challenge
//   2017: curiosity-gap phrasing, forward reference, punctuation abuse in
//   titles are the strongest cheap teaser-side signals.
//
// Everything here is O(text) with no model inference, so it runs comfortably
// during on-device enrichment.

const STOPWORDS = new Set([
  "the", "be", "to", "of", "and", "a", "in", "that", "have", "i", "it",
  "for", "not", "on", "with", "he", "as", "you", "do", "at", "this",
  "but", "his", "by", "from", "they", "we", "say", "her", "she", "or",
  "an", "will", "my", "one", "all", "would", "there", "their", "what",
  "so", "up", "out", "if", "about", "who", "get", "which", "go", "me",
  "when", "make", "can", "like", "time", "no", "just", "him", "know",
  "take", "people", "into", "year", "your", "good", "some", "could",
  "them", "see", "other", "than", "then", "now", "look", "only", "come",
  "its", "over", "also", "back", "after", "use", "two", "how", "our",
  "work", "first", "well", "way", "even", "new", "want", "any", "these",
]);

const CLICKBAIT_PHRASES = [
  "you won't believe", "you wont believe", "won't believe what",
  "this one weird", "one simple trick", "click here", "what happened next",
  "here's what happened", "here is what happened", "the reason is not",
  "the reason isn't", "shocking truth", "mind-blowing", "game-changer",
  "changed everything", "changes everything", "will blow your mind",
  "destroyed", "slays", "owns", "epic takedown", "must read", "must-read",
  "everything you need to know", "ultimate guide to", "#will shock you",
  "do this every day", "do this daily", "stop doing", "start doing this",
];

const CLICKBAIT_TITLE_PATTERNS: RegExp[] = [
  /^\d+\s+(things|ways|reasons|lessons|tips|tricks|hacks|facts)\b/i,
  /\b\d+\s+(things|ways|reasons|tips|tricks)\b.*\b(you|your)\b/i,
  /^(this|these|that|those)\b.{0,40}\b(is why|is how|changed|broke)\b/i,
  /\b(why|how)\b.{0,30}\b(will|won't|wont|can't|cant|shouldn't)\b/i,
  /\bi tried\b.{0,30}\bfor\b/i,
  /\bis (actually )?(dead|dying|over|back)\b/i,
  /\byou'?re (doing|using) (it|them) wrong\b/i,
  /\bno one talks about\b/i,
  /\bnobody (talks|tells you)\b/i,
  /\bthe (dark |hidden )?(truth|secret) about\b/i,
];

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function words(text: string): string[] {
  return text.toLowerCase().match(/[a-z']+/g) ?? [];
}

// Long-form depth: generous credit by ~600 words, gentle beyond.
export function depthScore(wordCount: number): number {
  if (wordCount <= 0) return 0;
  return clamp01(Math.log10(wordCount / 60) / Math.log10(14));
}

// Kohlschütter: running prose sits near 0.35-0.55 stopword share; nav menus,
// tag clouds and keyword-stuffed spam fall well below.
export function stopwordScore(text: string): number {
  const ws = words(text.slice(0, 4000));
  if (ws.length < 50) return 0.5;
  const hits = ws.reduce((sum, w) => sum + (STOPWORDS.has(w) ? 1 : 0), 0);
  const ratio = hits / ws.length;
  if (ratio >= 0.32 && ratio <= 0.58) return 1;
  if (ratio >= 0.22 && ratio < 0.32) return 0.7;
  if (ratio > 0.58 && ratio <= 0.68) return 0.7;
  return 0.25;
}

// Sentence structure sanity: prose averages ~8-30 words/sentence.
export function sentenceScore(text: string): number {
  const slice = text.slice(0, 4000);
  const sentences = slice.split(/[.!?]+(?:\s|$)/).filter((s) => s.trim().length > 2);
  if (sentences.length < 5) return 0.6;
  const avgLen = slice.split(/\s+/).length / sentences.length;
  if (avgLen >= 8 && avgLen <= 32) return 1;
  if (avgLen >= 5 && avgLen <= 45) return 0.7;
  return 0.3;
}

// Shouting penalty: ALL-CAPS word share in title + first paragraph.
export function capsPenalty(title: string, bodyHead: string): number {
  const sample = `${title} ${bodyHead.slice(0, 600)}`;
  const ws = sample.match(/\b[A-Z]{3,}\b/g) ?? [];
  const total = sample.match(/[A-Za-z]+/g)?.length ?? 1;
  const ratio = ws.length / total;
  return clamp01(ratio * 12);
}

// Punctuation abuse: !!!, ???, decorative emoji-laden headlines.
export function punctuationPenalty(title: string): number {
  let penalty = 0;
  if (/!{2,}|\?{2,}/.test(title)) penalty += 0.5;
  if ((title.match(/!/g) ?? []).length > 2) penalty += 0.4;
  if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(title)) penalty += 0.3;
  return clamp01(penalty);
}

// Potthast-style curiosity-gap detection on the title.
export function clickbaitPenalty(title: string): number {
  const lower = title.toLowerCase();
  let penalty = 0;

  for (const phrase of CLICKBAIT_PHRASES) {
    if (lower.includes(phrase)) penalty += 0.45;
  }
  for (const pattern of CLICKBAIT_TITLE_PATTERNS) {
    if (pattern.test(title)) penalty += 0.35;
  }

  // forward reference: demonstratives without a referent
  if (/\b(this|these)\b/.test(lower) && lower.split(" ").length <= 12) {
    penalty += 0.15;
  }
  // ellipsis teasers "…what X did next"
  if (/(\.\.\.|…)/.test(title)) penalty += 0.2;

  return clamp01(penalty);
}

// Link-dense bodies are aggregations, not essays.
export function linkDensityPenalty(contentHtml: string): number {
  const text = contentHtml.replace(/<[^>]*>/g, " ");
  const links = contentHtml.match(/<a\s[^>]*href[^>]*>([\s\S]*?)<\/a>/gi) ?? [];
  const anchorText = links.reduce((sum, a) => sum + a.replace(/<[^>]*>/g, "").length, 0);
  if (text.length === 0) return 1;
  const ratio = anchorText / text.length;
  if (ratio <= 0.15) return 0;
  if (ratio <= 0.3) return 0.3;
  return clamp01((ratio - 0.3) * 2.5);
}

export interface QualityResult {
  quality: number;
  components: {
    depth: number;
    stopwords: number;
    sentences: number;
    caps: number;
    punctuation: number;
    clickbait: number;
    linkDensity: number;
  };
}

export function scoreArticleQuality(article: ExtractedArticle): QualityResult {
  const depth = depthScore(article.wordCount);
  const stopwords = stopwordScore(article.textContent);
  const sentences = sentenceScore(article.textContent);
  const caps = capsPenalty(article.title, article.textContent);
  const punctuation = punctuationPenalty(article.title);
  const clickbait = clickbaitPenalty(article.title);
  const linkDensity = linkDensityPenalty(article.contentHtml);

  const quality = clamp01(
    0.24 * depth +
      0.16 * stopwords +
      0.10 * sentences +
      0.20 * (1 - caps) +
      0.08 * (1 - punctuation) +
      0.14 * (1 - clickbait) +
      0.08 * (1 - linkDensity)
  );

  return {
    quality,
    components: {
      depth,
      stopwords,
      sentences,
      caps,
      punctuation,
      clickbait,
      linkDensity,
    },
  };
}
