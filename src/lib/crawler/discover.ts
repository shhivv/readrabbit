import {
  classifyDomain,
  looksLikeArticlePath,
} from "./classify";
import { discoverFeedUrl, parseFeed } from "./feeds";
import { fetchText } from "./fetcher";
import { getDb, upsertSource } from "../db";
import type { Topic } from "../db";
import { kvGetJson, kvSetJson } from "../db";

// Discovery finds new personal blogs by mining links that seeded sources
// already cite, plus Hacker News for technology. Repeatedly-cited domains
// rank higher (a domain linked from many posts is likelier to be signal).

interface CandidatePool {
  [domain: string]: {
    sampleUrl: string;
    siteUrl: string;
    count: number;
    topic: Topic;
    addedAt: number;
    origin: "outbound" | "hn";
  };
}

const CANDIDATES_KEY = "disco:candidates";
const REJECTED_KEY = "disco:rejected";
const HN_LAST_KEY = "disco:hn_last_at";

export async function loadCandidates(): Promise<CandidatePool> {
  return (await kvGetJson<CandidatePool>(CANDIDATES_KEY)) ?? {};
}

async function saveCandidates(pool: CandidatePool): Promise<void> {
  await kvSetJson(CANDIDATES_KEY, pool);
}

function normalizeCandidateUrl(url: string): {
  siteUrl: string;
  domain: string;
  path: string;
} | null {
  try {
    const parsed = new URL(url);
    if (!/^https?:$/i.test(parsed.protocol)) return null;
    const domain = parsed.host.replace(/^www\./, "").toLowerCase();
    const path = parsed.pathname.replace(/\/+$/, "");
    // site root: scheme + host (+ first path segment, often /blog)
    const segments = path.split("/").filter(Boolean);
    const keepSegments = segments.length > 0 && !looksLikeArticlePath(url) ? segments : segments.slice(0, segments.length > 1 && /^blog|writing|posts|articles|essays|notes$/.test(segments[0]) ? 1 : 0);
    const siteUrl = `${parsed.protocol}//${parsed.host}${keepSegments.length ? "/" + keepSegments.join("/") : ""}`;
    return { siteUrl, domain, path };
  } catch {
    return null;
  }
}

export function collectOutboundLinks(
  html: string,
  baseUrl: string
): Array<{ url: string; topicHint: Topic }> {
  try {
    const base = new URL(baseUrl);
    const results: Array<{ url: string; topicHint: Topic }> = [];
    const seen = new Set<string>();
    const re = /<a\s[^>]*href=["']([^"']+)["'][^>]*>/gi;
    let match: RegExpExecArray | null;
    while ((match = re.exec(html)) !== null && results.length < 40) {
      const href = match[1];
      let resolved: URL;
      try {
        resolved = new URL(href, base);
      } catch {
        continue;
      }
      if (!/^https?:$/i.test(resolved.protocol)) continue;
      if (resolved.host === base.host) continue; // same-origin: not discovery
      const abs = `${resolved.protocol}//${resolved.host}${resolved.pathname}`;
      if (seen.has(abs)) continue;
      if (!looksLikeArticlePath(abs)) continue;
      const cls = classifyDomain(abs);
      if (!cls.allowed) continue;
      seen.add(abs);
      results.push({ url: abs, topicHint: "technology" });
    }
    return results;
  } catch {
    return [];
  }
}

export async function enqueueCandidates(
  links: Array<{ url: string; topicHint?: Topic }>,
  origin: "outbound" | "hn"
): Promise<number> {
  const pool = await loadCandidates();
  let added = 0;
  for (const link of links.slice(0, 30)) {
    const normalized = normalizeCandidateUrl(link.url);
    if (!normalized) continue;
    const existing = pool[normalized.domain];
    if (existing) {
      existing.count += 1;
      continue;
    }
    pool[normalized.domain] = {
      sampleUrl: link.url,
      siteUrl: normalized.siteUrl,
      count: 1,
      topic: link.topicHint ?? "technology",
      addedAt: Date.now(),
      origin,
    };
    added++;
  }

  // cap pool size: drop oldest beyond 400
  const entries = Object.entries(pool);
  if (entries.length > 400) {
    entries.sort((a, b) => b[1].count - a[1].count || b[1].addedAt - a[1].addedAt);
    await saveCandidates(Object.fromEntries(entries.slice(0, 400)));
  } else {
    await saveCandidates(pool);
  }
  return added;
}

export async function hnDiscover(): Promise<number> {
  const last = (await kvGetJson<number>(HN_LAST_KEY)) ?? 0;
  if (Date.now() - last < 12 * 60 * 60 * 1000) return 0;

  const weekAgo = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
  const url = `https://hn.algolia.com/api/v1/search_by_date?tags=story&numericFilters=created_at_i>${weekAgo},points>70&hitsPerPage=60`;
  try {
    const res = await fetchText(url, { timeoutMs: 15000 });
    if (!res.ok) return 0;
    const data = JSON.parse(res.text) as {
      hits?: Array<{ url?: string | null; title?: string }>;
    };
    const links = (data.hits ?? [])
      .filter((hit) => hit.url && hit.title)
      .map((hit) => ({ url: hit.url as string }));
    await kvSetJson(HN_LAST_KEY, Date.now());
    return enqueueCandidates(links, "hn");
  } catch {
    return 0;
  }
}

export interface ProbeResult {
  domain: string;
  outcome: "added" | "known" | "blocked" | "no-feed" | "error";
}

export async function probeTopCandidates(limit: number): Promise<ProbeResult[]> {
  const pool = await loadCandidates();
  const rejected = (await kvGetJson<Record<string, number>>(REJECTED_KEY)) ?? {};

  const ranked = Object.entries(pool)
    .filter(([domain]) => rejected[domain] == null)
    .sort((a, b) => b[1].count - a[1].count);

  const results: ProbeResult[] = [];
  const db = await getDb();

  for (const [domain, candidate] of ranked) {
    if (results.length >= limit) break;

    const classification = classifyDomain(domain);
    if (!classification.allowed) {
      rejected[domain] = Date.now();
      results.push({ domain, outcome: "blocked" });
      continue;
    }

    const known = await db.getFirstAsync(
      `SELECT id FROM sources WHERE feed_url LIKE ? OR site_url LIKE ? LIMIT 1`,
      [`%${domain}%`, `%${domain}%`]
    );
    if (known) {
      delete pool[domain]; // already have it; stop tracking
      results.push({ domain, outcome: "known" });
      continue;
    }

    const feedUrl = await discoverFeedUrl(candidate.siteUrl.startsWith("http") ? candidate.siteUrl : `https://${candidate.siteUrl}`);
    if (!feedUrl) {
      rejected[domain] = Date.now();
      results.push({ domain, outcome: "no-feed" });
      continue;
    }

    try {
      const res = await fetchText(feedUrl, { timeoutMs: 10000 });
      const feed = res.ok ? parseFeed(res.text, candidate.siteUrl) : null;
      if (!feed || feed.entries.length < 2) {
        rejected[domain] = Date.now();
        results.push({ domain, outcome: "no-feed" });
        continue;
      }

      await upsertSource({
        siteUrl: candidate.siteUrl.startsWith("http")
          ? candidate.siteUrl
          : `https://${candidate.siteUrl}`,
        feedUrl,
        name: feed.title || domain,
        topic: candidate.topic,
        origin: candidate.origin,
      });
      delete pool[domain];
      results.push({ domain, outcome: "added" });
    } catch {
      results.push({ domain, outcome: "error" });
    }
  }

  await saveCandidates(pool);
  await kvSetJson(REJECTED_KEY, rejected);
  return results;
}
