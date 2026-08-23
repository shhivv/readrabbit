// Recurring link dumps and scratchpad compilations can be long enough to
// look like essays to structural quality metrics. They are useful discovery
// inputs, but poor reader cards: one prolific feed can contribute a month of
// near-identical "Fragments" posts. This module stays dependency-free because
// migrations and feed ingest both need it on performance-sensitive paths.
const ROUNDUP_TITLE_PATTERNS: RegExp[] = [
  /^\s*fragments?\s*(?::|#|-|–|—|\d)/i,
  /^\s*(?:(?:some|assorted|weekly|weekend|friday|saturday|sunday)\s+)?links\s*(?::|#|-|–|—|$)/i,
  /^\s*(?:weekly\s+)?reading list\s*(?::|#|-|–|—|\d|$)/i,
  /^\s*roundup\s*(?::|#|-|–|—|\d|$)/i,
  /^\s*(?:weekly|weekend|monthly)\s+(?:roundup|digest)\b/i,
];

export function isLowValueRoundup(title: string): boolean {
  return ROUNDUP_TITLE_PATTERNS.some((pattern) => pattern.test(title));
}
