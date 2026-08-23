import * as SQLite from "expo-sqlite";
import { rootDomain } from "./crawler/classify";
import { convertLatexImages, renderMathInHtml } from "./crawler/math";
import { cleanAuthorName, normalizeAuthorKey } from "./attribution";
import { assessTopic } from "./crawler/topic";
import { isLowValueRoundup } from "./crawler/editorial";
import { noteExposureChanged } from "./exposure";

export { normalizeAuthorKey } from "./attribution";

export type Topic = "technology" | "economics" | "math";
export const TOPICS: Topic[] = ["technology", "economics", "math"];

export type SourceOrigin = "seed" | "hn" | "aggregator" | "outbound";
export type SourceStatus = "active" | "failing" | "dead" | "paused";

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
  author_key: string;
  site_name: string;
  published_date: number | null;
  excerpt: string;
  content_html: string;
  text_content: string;
  lead_image_url: string;
  word_count: number;
  topic: string | null;
  topic_relevance: number;
  fetched_at: number;
  is_read: number;
  is_archived: number;
  is_bookmarked: number;
  read_at: number | null;
  score: number;
  quality: number;
}

export interface MutedAuthorRow {
  author_key: string;
  display_name: string;
  muted_at: number;
}

export interface InterestRow {
  id: number;
  article_id: number;
  paragraph_index: number;
  paragraph_text: string;
  created_at: number;
}

const DB_VERSION = 11;

let dbInstance: SQLite.SQLiteDatabase | null = null;

export async function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbInstance) {
    dbInstance = await SQLite.openDatabaseAsync("readrabbit.db");
    await dbInstance.execAsync("PRAGMA journal_mode = WAL");
    // WAL + NORMAL is the standard pairing on mobile flash: commits skip
    // the fsync (the WAL absorbs them), which matters during crawls writing
    // dozens of batches. Crash-safe; only OS power loss can drop the last
    // transactions — acceptable for a rebuildable content cache.
    await dbInstance.execAsync("PRAGMA synchronous = NORMAL");
    // window-function sorts (deque sampling) and larger write bursts
    await dbInstance.execAsync("PRAGMA cache_size = -8000");
    await dbInstance.execAsync("PRAGMA temp_store = MEMORY");
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
        topic_relevance REAL NOT NULL DEFAULT 0,
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

  // v4: WordPress.com articles stored formulas as remote latex.php PNGs
  // (white boxes in the dark-mode reader). Rewrite affected bodies to
  // nc-math placeholders and fill them with pre-rendered KaTeX — the same
  // composition fresh crawls produce via extractFromHtml. Both steps are
  // idempotent, and the LIKE guard keeps untouched rows out of the pass.
  if (version < 4) {
    const rows = await db.getAllAsync<{ id: number; content_html: string }>(
      "SELECT id, content_html FROM articles WHERE content_html LIKE '%latex.php%'"
    );
    await db.withTransactionAsync(async () => {
      for (const row of rows) {
        const converted = renderMathInHtml(convertLatexImages(row.content_html));
        if (converted !== row.content_html) {
          await db.runAsync(
            "UPDATE articles SET content_html = ? WHERE id = ?",
            [converted, row.id]
          );
        }
      }
    });
    version = 4;
  }

  // v5: v4's regex only consumed through the src attribute, leaving
  // trailing alt="…"> fragments as visible text. Re-run with the fixed
  // regex that consumes the full <img …> tag.
  if (version < 5) {
    const rows = await db.getAllAsync<{ id: number; content_html: string }>(
      "SELECT id, content_html FROM articles WHERE content_html LIKE '%latex.php%' OR content_html LIKE '%alt=\"%'"
    );
    await db.withTransactionAsync(async () => {
      for (const row of rows) {
        const converted = renderMathInHtml(convertLatexImages(row.content_html));
        if (converted !== row.content_html) {
          await db.runAsync(
            "UPDATE articles SET content_html = ? WHERE id = ?",
            [converted, row.id]
          );
        }
      }
    });
    version = 5;
  }

  // v6: persistent author preferences. Keep the normalized key on each
  // article so recommendation queries can exclude muted authors cheaply and
  // consistently even when feed bylines vary in case or whitespace.
  if (version < 6) {
    const artInfo = await db.getAllAsync<{ name: string }>(
      "PRAGMA table_info(articles)"
    );
    const present = new Set(artInfo.map((c) => c.name));
    if (!present.has("author_key")) {
      await db.execAsync(
        "ALTER TABLE articles ADD COLUMN author_key TEXT NOT NULL DEFAULT ''"
      );
    }

    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS muted_authors (
        author_key TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        muted_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_articles_author_key
        ON articles (author_key);
    `);

    const authors = await db.getAllAsync<{
      id: number;
      author: string;
      author_key: string;
    }>("SELECT id, author, author_key FROM articles WHERE author != ''");
    await db.withTransactionAsync(async () => {
      for (const article of authors) {
        const authorKey = normalizeAuthorKey(article.author);
        if (authorKey && authorKey !== article.author_key) {
          await db.runAsync(
            "UPDATE articles SET author_key = ? WHERE id = ?",
            [authorKey, article.id]
          );
        }
      }
    });
    version = 6;
  }

  // v7: article-level topic evidence. A feed is only a source hint: writers
  // regularly publish outside their usual subject, so treating every post on
  // an economics blog as economics is the direct cause of off-topic cards.
  if (version < 7) {
    const artInfo = await db.getAllAsync<{ name: string }>(
      "PRAGMA table_info(articles)"
    );
    const present = new Set(artInfo.map((column) => column.name));
    if (!present.has("topic_relevance")) {
      await db.execAsync(
        "ALTER TABLE articles ADD COLUMN topic_relevance REAL NOT NULL DEFAULT 0"
      );
    }

    let afterId = 0;
    for (;;) {
      const rows = await db.getAllAsync<{
        id: number;
        title: string;
        excerpt: string;
        text_content: string;
        topic: string | null;
      }>(
        `SELECT id, title, excerpt, text_content, topic
         FROM articles
         WHERE id > ? AND word_count > 0
         ORDER BY id
         LIMIT 100`,
        [afterId]
      );
      if (rows.length === 0) break;

      await db.withTransactionAsync(async () => {
        for (const article of rows) {
          const hint = isTopic(article.topic) ? article.topic : "technology";
          const assessment = assessTopic(
            {
              title: article.title,
              excerpt: article.excerpt,
              textContent: article.text_content,
            },
            hint
          );
          await db.runAsync(
            "UPDATE articles SET topic = ?, topic_relevance = ? WHERE id = ?",
            [assessment.topic, assessment.relevance, article.id]
          );
        }
      });
      afterId = rows[rows.length - 1].id;
    }
    version = 7;
  }

  // v8: hosted publications are distinct sources. The old registrable-domain
  // backfill collapsed every wordpress.com or github.io writer into one site.
  if (version < 8) {
    const rows = await db.getAllAsync<{
      id: number;
      url: string;
      site_domain: string;
    }>(
      `SELECT id, url, site_domain FROM articles
       WHERE site_domain IN ('wordpress.com', 'substack.com', 'github.io',
                             'blogspot.com', 'ghost.io', 'write.as',
                             'bearblog.dev', 'mataroa.blog', 'omg.lol')`
    );
    await db.withTransactionAsync(async () => {
      for (const article of rows) {
        try {
          const domain = rootDomain(new URL(article.url).host);
          if (domain !== article.site_domain) {
            await db.runAsync(
              "UPDATE articles SET site_domain = ? WHERE id = ?",
              [domain, article.id]
            );
          }
        } catch {}
      }
    });
    version = 8;
  }

  // v9: normalize noisy aggregator bylines ("Posted on", "By …",
  // "… commented on …") so attribution and mute identities stay human.
  if (version < 9) {
    const articles = await db.getAllAsync<{
      id: number;
      author: string;
      author_key: string;
    }>("SELECT id, author, author_key FROM articles WHERE author != ''");
    await db.withTransactionAsync(async () => {
      for (const article of articles) {
        const authorKey = normalizeAuthorKey(article.author);
        if (authorKey !== article.author_key) {
          await db.runAsync(
            "UPDATE articles SET author_key = ? WHERE id = ?",
            [authorKey, article.id]
          );
        }
      }

      const muted = await db.getAllAsync<MutedAuthorRow>(
        "SELECT author_key, display_name, muted_at FROM muted_authors"
      );
      for (const author of muted) {
        const displayName = cleanAuthorName(author.display_name);
        const authorKey = normalizeAuthorKey(displayName);
        if (!authorKey) {
          await db.runAsync(
            "DELETE FROM muted_authors WHERE author_key = ?",
            [author.author_key]
          );
        } else if (authorKey !== author.author_key || displayName !== author.display_name) {
          await db.runAsync(
            `INSERT INTO muted_authors (author_key, display_name, muted_at)
             VALUES (?, ?, ?)
             ON CONFLICT(author_key) DO UPDATE SET
               display_name = excluded.display_name,
               muted_at = MAX(muted_authors.muted_at, excluded.muted_at)`,
            [authorKey, displayName, author.muted_at]
          );
          if (authorKey !== author.author_key) {
            await db.runAsync(
              "DELETE FROM muted_authors WHERE author_key = ?",
              [author.author_key]
            );
          }
        }
      }
    });
    version = 9;
  }

  // v10: the reader queries this exact prefix on every load/top-up. Keeping
  // topic and relevance in the queue index makes serving cost stay flat as
  // the local cache grows; ranking still touches at most 360 eligible rows.
  if (version < 10) {
    await db.execAsync(`
      CREATE INDEX IF NOT EXISTS idx_articles_recommend
        ON articles (is_archived, is_read, topic, topic_relevance);
    `);
    version = 10;
  }

  // v11: link roundups are discovery material, not reader cards. Archive
  // previously ingested recurring series (notably Martin Fowler's
  // "Fragments") and index the small rolling exposure query used to keep
  // publication diversity stable across app restarts.
  if (version < 11) {
    const articles = await db.getAllAsync<{ id: number; title: string }>(
      "SELECT id, title FROM articles WHERE is_archived = 0"
    );
    const roundupIds = articles
      .filter((article) => isLowValueRoundup(article.title))
      .map((article) => article.id);

    await db.withTransactionAsync(async () => {
      for (const id of roundupIds) {
        await db.runAsync(
          "UPDATE articles SET is_archived = 1 WHERE id = ? AND is_bookmarked = 0",
          [id]
        );
      }
    });
    await db.execAsync(`
      CREATE INDEX IF NOT EXISTS idx_articles_recent_read
        ON articles (is_read, read_at DESC);
    `);
    version = 11;
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
    origin?: SourceOrigin;
  }> = require("../../assets/seed-sources.json");

  let added = 0;
  for (const entry of catalog) {
    if (!topics.includes(entry.topic)) continue;
    const db = await getDb();
    const existing = await db.getFirstAsync<{ id: number; status: SourceStatus }>(
      "SELECT id, status FROM sources WHERE feed_url = ?",
      [entry.feedUrl]
    );
    if (existing) {
      // Topic removal pauses every source in that topic. Re-selecting it must
      // revive catalog sources instead of silently leaving their old rows dead.
      if (existing.status === "dead" || existing.status === "paused") {
        await db.runAsync(
          `UPDATE sources
           SET status = 'active', consecutive_failures = 0,
               next_check_at = 0, topic = ?, origin = ?
           WHERE id = ?`,
          [entry.topic, entry.origin ?? "seed", existing.id]
        );
        added++;
      }
      continue;
    }
    await upsertSource({
      siteUrl: entry.siteUrl,
      feedUrl: entry.feedUrl,
      name: entry.name,
      topic: entry.topic,
      origin: entry.origin ?? "seed",
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
       (source_id, url, title, author, author_key, site_name, published_date,
        excerpt, topic, fetched_at, score, site_domain)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(url) DO NOTHING`,
    [
      input.sourceId,
      input.url,
      input.title,
      input.author,
      normalizeAuthorKey(input.author),
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
       author = CASE WHEN author = '' AND ? != '' THEN ? ELSE author END,
       author_key = CASE WHEN author_key = '' AND ? != '' THEN ? ELSE author_key END,
       published_date = COALESCE(published_date, ?)
     WHERE url = ?`,
    [
      input.title,
      input.title,
      input.author,
      input.author,
      input.author,
      normalizeAuthorKey(input.author),
      input.publishedDate,
      input.url,
    ]
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
    topic?: Topic;
    topicRelevance?: number;
  }
): Promise<void> {
  const db = await getDb();
  const author = content.author ?? "";
  await db.runAsync(
    `UPDATE articles SET
       title = COALESCE(NULLIF(?, ''), title),
       author = COALESCE(NULLIF(?, ''), author),
       author_key = CASE WHEN ? != '' THEN ? ELSE author_key END,
       site_name = COALESCE(NULLIF(?, ''), site_name),
       published_date = COALESCE(published_date, ?),
       excerpt = COALESCE(NULLIF(?, ''), excerpt),
       content_html = ?,
       text_content = ?,
       lead_image_url = ?,
       word_count = ?,
       quality = ?,
       topic = COALESCE(?, topic),
       topic_relevance = COALESCE(?, topic_relevance)
     WHERE id = ?`,
    [
      content.title ?? "",
      author,
      author,
      normalizeAuthorKey(author),
      content.siteName ?? "",
      content.publishedDate ?? null,
      content.excerpt ?? "",
      content.contentHtml ?? "",
      content.textContent ?? "",
      content.leadImageUrl ?? "",
      content.wordCount ?? 0,
      content.quality ?? 0,
      content.topic ?? null,
      content.topicRelevance ?? null,
      articleId,
    ]
  );
}

function isTopic(value: string | null): value is Topic {
  return value === "technology" || value === "economics" || value === "math";
}

export async function markArticleFailed(articleId: number): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    "UPDATE articles SET word_count = -1 WHERE id = ?",
    [articleId]
  );
}

// Adaptive source trust: each enriched article nudges its source's score an
// EMA step toward the article's measured quality. Sources consistently
// publishing substantive prose earn stream weight; sources drifting into
// listicle territory sink — slowly enough that one bad post isn't punished.
export async function bumpSourceTrust(
  sourceId: number,
  quality: number
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `UPDATE sources
     SET score = MAX(0.3, MIN(0.85, score * 0.9 + ? * 0.1))
     WHERE id = ?`,
    [quality, sourceId]
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
  noteExposureChanged();
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

export async function getBookmarkedArticles(): Promise<
  Pick<ArticleRow, "id" | "title" | "author" | "site_name" | "url">[]
> {
  const db = await getDb();
  return db.getAllAsync(
    "SELECT id, title, author, site_name, url FROM articles WHERE is_bookmarked = 1 ORDER BY read_at DESC"
  );
}

// ---------- author preferences ----------

export async function getMutedAuthors(): Promise<MutedAuthorRow[]> {
  const db = await getDb();
  return db.getAllAsync<MutedAuthorRow>(
    "SELECT author_key, display_name, muted_at FROM muted_authors ORDER BY muted_at DESC"
  );
}

/**
 * Persist an author mute and return every matching article id so an already
 * loaded in-memory deque can remove those cards immediately.
 */
export async function muteAuthor(author: string): Promise<number[]> {
  const displayName = cleanAuthorName(author);
  const authorKey = normalizeAuthorKey(displayName);
  if (!authorKey) return [];

  const db = await getDb();
  await db.runAsync(
    `INSERT INTO muted_authors (author_key, display_name, muted_at)
     VALUES (?, ?, ?)
     ON CONFLICT(author_key) DO UPDATE SET
       display_name = excluded.display_name,
       muted_at = excluded.muted_at`,
    [authorKey, displayName, Date.now()]
  );

  const rows = await db.getAllAsync<{ id: number }>(
    "SELECT id FROM articles WHERE author_key = ?",
    [authorKey]
  );
  return rows.map((row) => row.id);
}

export async function unmuteAuthor(authorKey: string): Promise<void> {
  const normalizedKey = normalizeAuthorKey(authorKey);
  if (!normalizedKey) return;
  const db = await getDb();
  await db.runAsync("DELETE FROM muted_authors WHERE author_key = ?", [
    normalizedKey,
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
