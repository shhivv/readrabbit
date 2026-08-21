import * as SQLite from "expo-sqlite";
import { rootDomain } from "./crawler/classify";

export type Topic = "technology" | "economics" | "math";
export const TOPICS: Topic[] = ["technology", "economics", "math"];

export type SourceOrigin = "seed" | "hn" | "aggregator" | "outbound";
export type SourceStatus = "active" | "failing" | "dead";

export interface SourceRow {
  id: number;
  site_url: string;
  feed_url: string;
  name: string;
  topic: string;
  origin: SourceOrigin;
  status: SourceStatus;
  score: number;
  consecutive_failures: number;
  etag: string | null;
  last_modified: string | null;
  last_fetched_at: number | null;
  avg_update_hours: number;
  next_check_at: number | null;
  created_at: number;
}

export interface ArticleRow {
  id: number;
  source_id: number | null;
  url: string;
  title: string;
  author: string;
  site_name: string;
  published_date: number | null;
  excerpt: string;
  content_html: string;
  text_content: string;
  lead_image_url: string;
  word_count: number;
  topic: string | null;
  fetched_at: number;
  is_read: number;
  is_archived: number;
  is_bookmarked: number;
  read_at: number | null;
  score: number;
  quality: number;
}

export interface InterestRow {
  id: number;
  article_id: number;
  paragraph_index: number;
  paragraph_text: string;
  created_at: number;
}

const DB_VERSION = 3;

let dbInstance: SQLite.SQLiteDatabase | null = null;

export async function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbInstance) {
    dbInstance = await SQLite.openDatabaseAsync("naturallycurious.db");
    await dbInstance.execAsync("PRAGMA journal_mode = WAL");
    await dbInstance.execAsync("PRAGMA foreign_keys = ON");
    await migrate(dbInstance);
  }
  return dbInstance;
}

async function migrate(db: SQLite.SQLiteDatabase) {
  const row = await db.getFirstAsync<{ user_version: number }>(
    "PRAGMA user_version"
  );
  let version = row?.user_version ?? 0;
  if (version >= DB_VERSION) return;

  if (version < 1) {
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        site_url TEXT NOT NULL,
        feed_url TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL DEFAULT '',
        topic TEXT NOT NULL DEFAULT 'technology',
        origin TEXT NOT NULL DEFAULT 'seed',
        status TEXT NOT NULL DEFAULT 'active',
        score REAL NOT NULL DEFAULT 0.5,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        avg_update_hours REAL NOT NULL DEFAULT 24,
        next_check_at INTEGER NOT NULL DEFAULT 0,
        etag TEXT,
        last_modified TEXT,
        last_fetched_at INTEGER,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS articles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL,
        url TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL DEFAULT '',
        author TEXT NOT NULL DEFAULT '',
        site_name TEXT NOT NULL DEFAULT '',
        published_date INTEGER,
        excerpt TEXT NOT NULL DEFAULT '',
        content_html TEXT NOT NULL DEFAULT '',
        text_content TEXT NOT NULL DEFAULT '',
        lead_image_url TEXT NOT NULL DEFAULT '',
        word_count INTEGER NOT NULL DEFAULT 0,
        topic TEXT,
        fetched_at INTEGER NOT NULL,
        is_read INTEGER NOT NULL DEFAULT 0,
        is_archived INTEGER NOT NULL DEFAULT 0,
        is_bookmarked INTEGER NOT NULL DEFAULT 0,
        read_at INTEGER,
        score REAL NOT NULL DEFAULT 0,
        quality REAL NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_articles_queue
        ON articles (is_archived, is_read, word_count);

      CREATE INDEX IF NOT EXISTS idx_articles_source
        ON articles (source_id, fetched_at);

      CREATE TABLE IF NOT EXISTS interests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
        paragraph_index INTEGER NOT NULL,
        paragraph_text TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        UNIQUE(article_id, paragraph_index)
      );

      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    version = 1;
  }

  // v2: repair databases created during the broken v1 window whose sources
  // table is missing bookkeeping columns
  if (version < 2) {
    const info = await db.getAllAsync<{ name: string }>(
      "PRAGMA table_info(sources)"
    );
    const present = new Set(info.map((c) => c.name));
    if (!present.has("last_modified")) {
      await db.execAsync("ALTER TABLE sources ADD COLUMN last_modified TEXT");
    }
    if (!present.has("last_fetched_at")) {
      await db.execAsync("ALTER TABLE sources ADD COLUMN last_fetched_at INTEGER");
    }
  }

  // v3: registrable domain per article. The deque's diversity cap partitions
  // by author-or-domain, which needs a domain key that groups an author's
  // multiple feeds (e.g. johndcook.com/blog + applied-math subblog) into one
  // bucket — source_id can't do that.
  if (version < 3) {
    const artInfo = await db.getAllAsync<{ name: string }>(
      "PRAGMA table_info(articles)"
    );
    const present = new Set(artInfo.map((c) => c.name));
    if (!present.has("site_domain")) {
      await db.execAsync(
        "ALTER TABLE articles ADD COLUMN site_domain TEXT NOT NULL DEFAULT ''"
      );
      // backfill in one pass over distinct URLs
      const urls = await db.getAllAsync<{ id: number; url: string }>(
        "SELECT id, url FROM articles WHERE site_domain = ''"
      );
      await db.withTransactionAsync(async () => {
        for (const row of urls) {
          let domain = "";
          try {
            domain = rootDomain(new URL(row.url).host);
          } catch {}
          if (domain) {
            await db.runAsync("UPDATE articles SET site_domain = ? WHERE id = ?", [
              domain,
              row.id,
            ]);
          }
        }
      });
    }
    version = 3;
  }

  await db.execAsync(`PRAGMA user_version = ${DB_VERSION}`);
}

// ---------- kv ----------

export async function kvGet(key: string): Promise<string | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>(
    "SELECT value FROM kv WHERE key = ?",
    [key]
  );
  return row?.value ?? null;
}

export async function kvSet(key: string, value: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, value]
  );
}

export async function kvGetJson<T>(key: string): Promise<T | null> {
  const raw = await kvGet(key);
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function kvSetJson(key: string, value: unknown): Promise<void> {
  await kvSet(key, JSON.stringify(value));
}

// ---------- sources ----------

export async function upsertSource(input: {
  siteUrl: string;
  feedUrl: string;
  name: string;
  topic: Topic;
  origin: SourceOrigin;
}): Promise<number> {
  const db = await getDb();
  // Independent-writer prior: seeded personal blogs outrank HN-mined domains,
  // which outrank anything else we might pick up along the way.
  const priorByOrigin: Record<SourceOrigin, number> = {
    seed: 0.65,
    outbound: 0.55,
    hn: 0.5,
    aggregator: 0.45,
  };
  await db.runAsync(
    `INSERT INTO sources (site_url, feed_url, name, topic, origin, score, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(feed_url) DO UPDATE SET
       name = CASE WHEN excluded.name != '' THEN excluded.name ELSE sources.name END`,
    [
      input.siteUrl,
      input.feedUrl,
      input.name,
      input.topic,
      input.origin,
      priorByOrigin[input.origin] ?? 0.5,
      Date.now(),
    ]
  );
  const row = await db.getFirstAsync<{ id: number }>(
    "SELECT id FROM sources WHERE feed_url = ?",
    [input.feedUrl]
  );
  return row!.id;
}

export async function seedCatalogSources(topics: Topic[]): Promise<number> {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const catalog: Array<{
    name: string;
    siteUrl: string;
    feedUrl: string;
    topic: Topic;
  }> = require("../../assets/seed-sources.json");

  let added = 0;
  for (const entry of catalog) {
    if (!topics.includes(entry.topic)) continue;
    const db = await getDb();
    const existing = await db.getFirstAsync(
      "SELECT id FROM sources WHERE feed_url = ?",
      [entry.feedUrl]
    );
    if (existing) continue;
    await upsertSource({
      siteUrl: entry.siteUrl,
      feedUrl: entry.feedUrl,
      name: entry.name,
      topic: entry.topic,
      origin: "seed",
    });
    added++;
  }
  return added;
}

export async function getActiveSources(limit = 100): Promise<SourceRow[]> {
  const db = await getDb();
  return db.getAllAsync<SourceRow>(
    `SELECT * FROM sources
     WHERE status IN ('active', 'failing')
     ORDER BY last_fetched_at ASC NULLS FIRST
     LIMIT ?`,
    [limit]
  );
}

export async function recordSourceSuccess(
  sourceId: number,
  etag: string | null,
  lastModified: string | null,
  newEntries: number
): Promise<void> {
  const db = await getDb();
  const now = Date.now();
  const prev = await db.getFirstAsync<{
    last_fetched_at: number | null;
    avg_update_hours: number;
  }>("SELECT last_fetched_at, avg_update_hours FROM sources WHERE id = ?", [
    sourceId,
  ]);

  // Adaptive polling (Urbansky et al. ICWSM'11; Olston & Pandey TODS'06):
  // EMA of observed inter-update gaps sets the next check time. Empty checks
  // grow the interval, fresh content shrinks it toward the learned rhythm.
  let intervalHours = prev?.avg_update_hours ?? 24;
  if (newEntries > 0 && prev?.last_fetched_at) {
    const gapHours =
      (now - prev.last_fetched_at) / (1000 * 60 * 60);
    if (gapHours >= 0.5 && gapHours <= 24 * 30) {
      intervalHours = gapHours;
    }
    intervalHours = Math.min(intervalHours, 24 * 7);
  } else {
    intervalHours = Math.min(intervalHours * 1.3, 24 * 7);
  }
  const clampedInterval = Math.max(intervalHours, 0.5); // floor: 30 min
  const jitter = 0.85 + Math.random() * 0.3;

  await db.runAsync(
    `UPDATE sources
     SET status = 'active', consecutive_failures = 0,
         etag = COALESCE(?, etag), last_modified = COALESCE(?, last_modified),
         last_fetched_at = ?, avg_update_hours = ?,
         next_check_at = ?
     WHERE id = ?`,
    [
      etag,
      lastModified,
      now,
      clampedInterval,
      now + clampedInterval * jitter * 60 * 60 * 1000,
      sourceId,
    ]
  );
}

export async function recordSourceFailure(sourceId: number): Promise<void> {
  const db = await getDb();
  const now = Date.now();
  await db.runAsync(
    `UPDATE sources
     SET consecutive_failures = consecutive_failures + 1,
         status = CASE WHEN consecutive_failures + 1 >= 8 THEN 'dead' ELSE 'failing' END,
         last_fetched_at = ?,
         next_check_at = ?
     WHERE id = ?`,
    [now, now + 6 * 60 * 60 * 1000, sourceId]
  );
}

export async function getDueSources(limit = 100): Promise<SourceRow[]> {
  const db = await getDb();
  const now = Date.now();
  return db.getAllAsync<SourceRow>(
    `SELECT * FROM sources
     WHERE status IN ('active', 'failing')
       AND (next_check_at IS NULL OR next_check_at <= ?)
     ORDER BY next_check_at ASC NULLS FIRST
     LIMIT ?`,
    [now, limit]
  );
}

// ---------- articles ----------

export async function upsertArticleMeta(input: {
  sourceId: number | null;
  url: string;
  title: string;
  author: string;
  siteName: string;
  publishedDate: number | null;
  excerpt: string;
  topic: string | null;
  score: number;
}): Promise<number | null> {
  // Insert-only fast path: one round-trip for new entries (the common case on
  // first crawl), with `changes` telling us definitively whether the row was
  // new — the engine relies on that for adaptive feed polling. Backfill of
  // title/date on known entries costs a second round-trip only on re-crawls.
  const db = await getDb();
  let siteDomain = "";
  try {
    siteDomain = rootDomain(new URL(input.url).host);
  } catch {}
  const result = await db.runAsync(
    `INSERT INTO articles
       (source_id, url, title, author, site_name, published_date, excerpt,
        topic, fetched_at, score, site_domain)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(url) DO NOTHING`,
    [
      input.sourceId,
      input.url,
      input.title,
      input.author,
      input.siteName,
      input.publishedDate,
      input.excerpt,
      input.topic,
      Date.now(),
      input.score,
      siteDomain,
    ]
  );
  if (result.changes > 0) return result.lastInsertRowId;

  await db.runAsync(
    `UPDATE articles SET
       title = CASE WHEN title = '' AND ? != '' THEN ? ELSE title END,
       published_date = COALESCE(published_date, ?)
     WHERE url = ?`,
    [input.title, input.title, input.publishedDate, input.url]
  );
  return null;
}

export async function setArticleContent(
  articleId: number,
  content: {
    title?: string;
    author?: string;
    siteName?: string;
    publishedDate?: number | null;
    excerpt?: string;
    contentHtml?: string;
    textContent?: string;
    leadImageUrl?: string;
    wordCount?: number;
    quality?: number;
  }
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `UPDATE articles SET
       title = COALESCE(NULLIF(?, ''), title),
       author = COALESCE(NULLIF(?, ''), author),
       site_name = COALESCE(NULLIF(?, ''), site_name),
       published_date = COALESCE(published_date, ?),
       excerpt = COALESCE(NULLIF(?, ''), excerpt),
       content_html = ?,
       text_content = ?,
       lead_image_url = ?,
       word_count = ?,
       quality = ?
     WHERE id = ?`,
    [
      content.title ?? "",
      content.author ?? "",
      content.siteName ?? "",
      content.publishedDate ?? null,
      content.excerpt ?? "",
      content.contentHtml ?? "",
      content.textContent ?? "",
      content.leadImageUrl ?? "",
      content.wordCount ?? 0,
      content.quality ?? 0,
      articleId,
    ]
  );
}

export async function markArticleFailed(articleId: number): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    "UPDATE articles SET word_count = -1 WHERE id = ?",
    [articleId]
  );
}

export async function getArticleById(id: number): Promise<ArticleRow | null> {
  const db = await getDb();
  return db.getFirstAsync<ArticleRow>("SELECT * FROM articles WHERE id = ?", [
    id,
  ]);
}

export async function markRead(articleId: number): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    "UPDATE articles SET is_read = 1, read_at = ? WHERE id = ?",
    [Date.now(), articleId]
  );
}

export async function archiveArticle(articleId: number): Promise<void> {
  const db = await getDb();
  await db.runAsync("UPDATE articles SET is_archived = 1 WHERE id = ?", [
    articleId,
  ]);
}

export async function setBookmarked(
  articleId: number,
  bookmarked: boolean
): Promise<void> {
  const db = await getDb();
  await db.runAsync("UPDATE articles SET is_bookmarked = ? WHERE id = ?", [
    bookmarked ? 1 : 0,
    articleId,
  ]);
}

// ---------- interests ----------

export async function getInterestIndices(
  articleId: number
): Promise<Set<number>> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ paragraph_index: number }>(
    "SELECT paragraph_index FROM interests WHERE article_id = ?",
    [articleId]
  );
  return new Set(rows.map((r) => r.paragraph_index));
}

export async function toggleInterest(
  articleId: number,
  paragraphIndex: number,
  paragraphText: string
): Promise<boolean> {
  const db = await getDb();
  const existing = await db.getFirstAsync<{ id: number }>(
    "SELECT id FROM interests WHERE article_id = ? AND paragraph_index = ?",
    [articleId, paragraphIndex]
  );
  if (existing) {
    await db.runAsync("DELETE FROM interests WHERE id = ?", [existing.id]);
    return false;
  }
  await db.runAsync(
    "INSERT INTO interests (article_id, paragraph_index, paragraph_text, created_at) VALUES (?, ?, ?, ?)",
    [articleId, paragraphIndex, paragraphText, Date.now()]
  );
  return true;
}
