import {
  classifyDomain,
  looksLikeArticlePath,
  rootDomain,
} from "./classify";
import { discoverFeedUrl, parseFeed } from "./feeds";
import { fetchText, getHost, HostScheduler } from "./fetcher";
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

// The pool lives in memory during a crawl and is persisted only at phase
// boundaries (flushCandidates). The old write-through version re-serialized
// the entire JSON blob per link batch — hundreds of kv round-trips per crawl.
let poolCache: CandidatePool | null = null;
let poolDirty = false;

export async function loadCandidates(): Promise<CandidatePool> {
  if (!poolCache) {
    poolCache = (await kvGetJson<CandidatePool>(CANDIDATES_KEY)) ?? {};
  }
  return poolCache;
}

export async function flushCandidates(): Promise<void> {
  if (poolCache && poolDirty) {
    await kvSetJson(CANDIDATES_KEY, poolCache);
    poolDirty = false;
  }
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
  baseUrl: string,
  options: { allowRootPaths?: boolean } = {}
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
      if (!options.allowRootPaths && !looksLikeArticlePath(abs)) continue;
      if (options.allowRootPaths) {
        // root paths allowed, but still skip obvious non-site links
        const path = resolved.pathname.toLowerCase();
        if (!looksLikeArticlePath(abs) && path !== "/" && path !== "") continue;
        if (/\.(pdf|jpg|jpeg|png|gif|zip|mp3|mp4)$/i.test(path)) continue;
      }
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

export function enqueueCandidates(
  links: Array<{ url: string; topicHint?: Topic }>,
  origin: "outbound" | "hn"
): void {
  if (!links.length || !poolCache) return;
  let changed = false;
  for (const link of links.slice(0, 30)) {
    const normalized = normalizeCandidateUrl(link.url);
    if (!normalized) continue;
    const existing = poolCache[normalized.domain];
    if (existing) {
      existing.count += 1;
      changed = true; // citation counts feed probe ranking — persist them
      continue;
    }
    poolCache[normalized.domain] = {
      sampleUrl: link.url,
      siteUrl: normalized.siteUrl,
      count: 1,
      topic: link.topicHint ?? "technology",
      addedAt: Date.now(),
      origin,
    };
    changed = true;
  }

  // cap pool size: drop oldest beyond 400
  const entries = Object.entries(poolCache);
  if (entries.length > 400) {
    entries.sort((a, b) => b[1].count - a[1].count || b[1].addedAt - a[1].addedAt);
    poolCache = Object.fromEntries(entries.slice(0, 400));
  }
  if (changed) poolDirty = true;
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
    // Self-posts link back to HN itself; they'd otherwise enter discovery
    // as "news.ycombinator.com" and pollute the candidate pool.
    const links = (data.hits ?? [])
      .filter((hit) => hit.url && hit.title)
      .map((hit) => ({ url: hit.url as string }))
      .filter((link) => {
        const host = getHost(link.url);
        return host != null && !host.endsWith("news.ycombinator.com") && !host.endsWith("hnrss.org");
      });
    await kvSetJson(HN_LAST_KEY, Date.now());
    const before = Object.keys(await loadCandidates()).length;
    enqueueCandidates(links, "hn");
    return Object.keys(poolCache ?? {}).length - before;
  } catch {
    return 0;
  }
}

const BLOGROLL_MINED_KEY = "disco:blogroll_mined_at";
const BLOGROLL_REMINE_DAYS = 30;
// Pages personal blogs keep specifically to recommend other writing.
const BLOGROLL_PATHS = ["/", "/about/", "/links/", "/blogroll/", "/reading/"];

// Mine seed sources' homepages/blogrolls for curated pointers. A link a
// trusted author keeps on their blogroll is stronger signal than one that
// happened to appear inside a post — these people are taste-makers in
// precisely the niches the user opted into.
export async function mineSeedBlogrolls(
  network: HostScheduler,
  deadline: number
): Promise<void> {
  const minedAt = (await kvGetJson<Record<string, number>>(BLOGROLL_MINED_KEY)) ?? {};
  const db = await getDb();
  const sources = await db.getAllAsync<{ id: number; site_url: string }>(
    `SELECT id, site_url FROM sources WHERE status = 'active' ORDER BY origin ASC`
  );

  await loadCandidates();
  for (const source of sources) {
    if (Date.now() > deadline) break;
    const last = minedAt[String(source.id)] ?? 0;
    if (Date.now() - last < BLOGROLL_REMINE_DAYS * 24 * 60 * 60 * 1000) continue;

    let origin = "";
    try {
      origin = new URL(source.site_url).origin;
    } catch {
      continue;
    }

    for (const path of BLOGROLL_PATHS) {
      if (Date.now() > deadline) break;
      const pageUrl = `${origin}${path}`;
      try {
        const res = await network.run(pageUrl, () =>
          fetchText(pageUrl, { timeoutMs: 8000 })
        );
        if (!res.ok || !res.text) continue;
        // blogrolls link homepages ("https://friend.example/") — allow
        // root paths here, unlike in-post mining where they'd be noise
        const links = collectOutboundLinks(
          res.text.slice(0, 300_000),
          res.finalUrl || pageUrl,
          { allowRootPaths: true }
        );
        enqueueCandidates(links, "outbound");
        // any page that yields links counts as mined; don't try deeper paths
        minedAt[String(source.id)] = Date.now();
        break;
      } catch {
        // next path
      }
    }
  }
  await kvSetJson(BLOGROLL_MINED_KEY, minedAt);
}

export interface ProbeResult {
  domain: string;
  outcome: "added" | "known" | "blocked" | "no-feed" | "error";
}

// Feed titles that indicate an institutional/infra feed rather than a
// personal blog worth reading: podcast indexes, changelogs, link archives,
// corporate newsrooms.
const NON_BLOG_TITLE = /podcast|archive|changelog|release notes|recent additions|\bnews\b|status|jobs|roadmap|press release/i;

function isNonBlogFeedTitle(title: string): boolean {
  return NON_BLOG_TITLE.test(title);
}

// Editorial outlets rotate writers; personal blogs don't. A candidate whose
// recent entries carry ≥4 distinct bylines is a magazine/newsroom, not an
// independent voice — exactly what the reader is not for.
const EDITORIAL_DISTINCT_AUTHORS = 4;

function distinctAuthors(entries: Array<{ author: string }>): number {
  return new Set(
    entries.map((e) => e.author.trim().toLowerCase()).filter(Boolean)
  ).size;
}

function normalizeName(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Same writer, second domain ("Ahead of AI" vs seeded sebastianraschka.com,
// "The Grumpy Economist" vs seeded "John Cochrane (The Grumpy Economist)"):
// if the candidate's authors or title collide with an existing source, we
// already carry that voice — another feed of theirs worsens repetition.
async function isDuplicateVoice(
  db: Awaited<ReturnType<typeof getDb>>,
  feed: { title: string; entries: Array<{ author: string }> },
  candidateDomain?: string
): Promise<boolean> {
  const authors = new Set<string>();
  for (const e of feed.entries) {
    const n = normalizeName(e.author);
    if (n.length >= 6) authors.add(n); // guard against short-name collisions
  }
  const titleNorm = normalizeName(feed.title);

  const existing = await db.getAllAsync<{ name: string; site_url: string; feed_url: string }>(
    "SELECT name, site_url, feed_url FROM sources"
  );
  for (const row of existing) {
    const n = normalizeName(row.name);

    // exact or contained name overlap (parentheticals, honorifics, "PhD")
    const nameMatches =
      n.length >= 6 &&
      (authors.has(n) ||
        n === titleNorm ||
        (n.length >= 8 &&
          ([...authors].some((a) => a.length >= 8 && (a.includes(n) || n.includes(a))) ||
            (titleNorm.length >= 8 &&
              (titleNorm.includes(n) || n.includes(titleNorm))))));
    if (nameMatches) return true;

    // same registrable domain under a different scheme/subdomain
    if (candidateDomain) {
      for (const url of [row.site_url, row.feed_url]) {
        try {
          if (rootDomain(new URL(url).host) === candidateDomain) return true;
        } catch {}
      }
    }
  }
  return false;
}

// Probing one candidate = homepage fetch + feed autodiscovery + feed fetch,
// all serial *within* the candidate's host (politeness) but fully parallel
// *across* candidates. Sequential probing was the single largest cost of the
// initial crawl (~150s for 24 candidates on desktop; phones are worse).
export async function probeTopCandidates(
  limit: number,
  deadlineMs: number = Date.now() + 120_000
): Promise<ProbeResult[]> {
  const pool = await loadCandidates();
  const rejected = (await kvGetJson<Record<string, number>>(REJECTED_KEY)) ?? {};

  const ranked = Object.entries(pool)
    .filter(([domain]) => rejected[domain] == null)
    // outbound candidates need ≥2 independent citations: single-link
    // accidents are how share widgets and vendor pages got in before.
    .filter(([, c]) => c.origin === "hn" || c.count >= 2)
    .sort((a, b) => b[1].count - a[1].count);

  const db = await getDb();
  const results: ProbeResult[] = [];
  const network = new HostScheduler(6);
  let cursor = 0;

  const probeOne = async (
    domain: string,
    candidate: CandidatePool[string]
  ): Promise<ProbeResult> => {
    const classification = classifyDomain(domain);
    if (!classification.allowed) {
      rejected[domain] = Date.now();
      return { domain, outcome: "blocked" };
    }

    const known = await db.getFirstAsync(
      `SELECT id FROM sources WHERE feed_url LIKE ? OR site_url LIKE ? LIMIT 1`,
      [`%${domain}%`, `%${domain}%`]
    );
    if (known) {
      delete pool[domain]; // already have it; stop tracking
      poolDirty = true;
      return { domain, outcome: "known" };
    }

    const siteUrl = candidate.siteUrl.startsWith("http")
      ? candidate.siteUrl
      : `https://${candidate.siteUrl}`;
    const feedUrl = await network.run(siteUrl, () => discoverFeedUrl(siteUrl));
    if (!feedUrl) {
      rejected[domain] = Date.now();
      return { domain, outcome: "no-feed" };
    }

    try {
      const res = await network.run(feedUrl, () =>
        fetchText(feedUrl, { timeoutMs: 10000 })
      );
      const feed = res.ok ? parseFeed(res.text, siteUrl) : null;
      if (!feed || feed.entries.length < 2) {
        rejected[domain] = Date.now();
        return { domain, outcome: "no-feed" };
      }
      if (isNonBlogFeedTitle(feed.title)) {
        // archive pages, changelogs, podcast indexes — real feeds, wrong
        // genre for a reading app
        rejected[domain] = Date.now();
        return { domain, outcome: "blocked" };
      }
      if (distinctAuthors(feed.entries) >= EDITORIAL_DISTINCT_AUTHORS) {
        rejected[domain] = Date.now();
        return { domain, outcome: "blocked" };
      }
      if (await isDuplicateVoice(db, feed, domain)) {
        delete pool[domain];
        poolDirty = true;
        return { domain, outcome: "known" };
      }

      await upsertSource({
        siteUrl,
        feedUrl,
        name: feed.title || domain,
        topic: candidate.topic,
        origin: candidate.origin,
      });
      delete pool[domain];
      poolDirty = true;
      return { domain, outcome: "added" };
    } catch {
      return { domain, outcome: "error" };
    }
  };

  const workers = Array.from({ length: Math.min(network.parallelism, ranked.length) }, async () => {
    for (;;) {
      if (Date.now() > deadlineMs || results.length >= limit) return;
      const i = cursor++;
      if (i >= ranked.length) return;
      const [domain, candidate] = ranked[i];
      const result = await probeOne(domain, candidate);
      // `added`/`blocked`/`no-feed` consume a probe slot; `error` doesn't so a
      // flaky host can't starve discovery this run.
      if (result.outcome !== "error") results.push(result);
    }
  });

  await Promise.all(workers);
  await flushCandidates();
  await kvSetJson(REJECTED_KEY, rejected);
  return results;
}
