import { getDb, kvGet, kvSet, setArticleContent, upsertArticleMeta } from "./db";
import { sanitizeContentHtml } from "./crawler/extract";

// Starter pack: a daily static JSON of pre-enriched articles, published
// anywhere cheap (GitHub Pages / R2 / S3 — no API, no keys). Fetched only
// when the local pool is empty so new installs read instantly instead of
// waiting for the first crawl. Content is sanitized through the same
// allow-list as crawled pages and deduped by URL against future crawls.

// Publish the pack and point this at it. Empty = feature off.
export const STARTER_PACK_URL = "";

const ATTEMPT_KEY = "starter:last_attempt_at";
const THROTTLE_MS = 12 * 60 * 60 * 1000;
const MAX_ENTRIES = 40;

interface PackEntry {
  url: string;
  title: string;
  author?: string;
  site_name?: string;
  published_date?: number | null;
  content_html?: string;
  text_content?: string;
  word_count?: number;
  quality?: number;
  topic?: string;
  score?: number;
}

interface Pack {
  generated_at?: number;
  articles?: PackEntry[];
}

function validEntry(entry: PackEntry): boolean {
  return (
    typeof entry?.url === "string" &&
    /^https?:\/\//i.test(entry.url) &&
    typeof entry?.title === "string" &&
    entry.title.trim().length > 0 &&
    typeof entry?.content_html === "string" &&
    entry.content_html.length >= 200 &&
    typeof entry?.word_count === "number" &&
    entry.word_count >= 120
  );
}

// Returns how many pack articles landed in the DB (0 = nothing fetched).
// Never throws: a missing/broken pack must degrade to plain crawling.
export async function maybeFetchStarterPack(
  packUrl?: string
): Promise<number> {
  const url = packUrl ?? STARTER_PACK_URL;
  if (!url) return 0;
  try {
    const lastRaw = await kvGet(ATTEMPT_KEY);
    if (lastRaw && Date.now() - parseInt(lastRaw, 10) < THROTTLE_MS) return 0;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    let pack: Pack;
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) return 0;
      pack = (await res.json()) as Pack;
    } finally {
      clearTimeout(timer);
    }
    await kvSet(ATTEMPT_KEY, String(Date.now()));

    const entries = (pack.articles ?? []).filter(validEntry).slice(0, MAX_ENTRIES);
    if (entries.length === 0) return 0;

    const db = await getDb();
    let inserted = 0;
    await db.withTransactionAsync(async () => {
      for (const entry of entries) {
        const id = await upsertArticleMeta({
          sourceId: null,
          url: entry.url,
          title: entry.title,
          author: entry.author ?? "",
          siteName: entry.site_name ?? "",
          publishedDate: entry.published_date ?? null,
          excerpt: "",
          topic: entry.topic ?? null,
          score: entry.score ?? 0.6,
        });
        // upsertArticleMeta returns non-null ids only for NEW rows; refresh
        // content even on known urls so re-published packs stay readable
        const rowId =
          id ??
          (
            await db.getFirstAsync<{ id: number }>(
              "SELECT id FROM articles WHERE url = ?",
              [entry.url]
            )
          )?.id;
        if (!rowId) continue;
        const cleanHtml = sanitizeContentHtml(entry.content_html!, entry.url);
        if (!cleanHtml) continue;
        await setArticleContent(rowId, {
          title: entry.title,
          author: entry.author,
          siteName: entry.site_name,
          publishedDate: entry.published_date ?? null,
          contentHtml: cleanHtml,
          textContent: entry.text_content ?? "",
          wordCount: entry.word_count,
          quality: entry.quality ?? 0.7,
        });
        inserted++;
      }
    });
    return inserted;
  } catch {
    return 0; // offline / bad pack: crawl path still carries the load
  }
}
