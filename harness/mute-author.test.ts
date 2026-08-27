import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  getArticleAttribution,
  normalizeAuthorKey,
} from "../src/lib/attribution";

const testDbDir = mkdtempSync(join(tmpdir(), "naturally-curious-mute-"));
process.env.NC_HARNESS_DB_DIR = testDbDir;

// Begin from the previously shipped schema so this also exercises the v5 →
// v6 migration and its author-key backfill, not only fresh installs.
const legacyDb = new Database(join(testDbDir, "naturallycurious.db"));
legacyDb.exec(`
  CREATE TABLE sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_url TEXT NOT NULL,
    feed_url TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL DEFAULT '',
    topic TEXT,
    origin TEXT NOT NULL DEFAULT 'seed',
    status TEXT NOT NULL DEFAULT 'active',
    score REAL NOT NULL DEFAULT 0.5,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    etag TEXT,
    last_modified TEXT,
    last_fetched_at INTEGER,
    avg_update_hours REAL NOT NULL DEFAULT 24,
    next_check_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER,
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
    quality REAL NOT NULL DEFAULT 0,
    site_domain TEXT NOT NULL DEFAULT ''
  );
  INSERT INTO articles (url, title, author, fetched_at, is_read, read_at)
    VALUES (
      'https://legacy.example/essay',
      'Legacy essay',
      '  Joan   Robinson ',
      1,
      1,
      123456
    );
  PRAGMA user_version = 5;
`);
legacyDb.close();

Bun.plugin({
  name: "expo-sqlite-mute-author-test-shim",
  setup(build) {
    build.module("expo-sqlite", () => ({
      exports: require("./expo-sqlite-shim.ts"),
      loader: "object",
    }));
  },
});

const {
  getDb,
  getIdentityExposure,
  getMutedAuthors,
  kvGet,
  kvSet,
  markRead,
  muteAuthor,
  setArticleContent,
  unmuteAuthor,
  upsertArticleMeta,
} = await import("../src/lib/db");
const { countEligibleByTopic, loadDeque } = await import("../src/lib/deque");

describe("article attribution", () => {
  test("promotes the author while retaining the publication as context", () => {
    expect(
      getArticleAttribution({
        author: "  Claudia Goldin ",
        site_name: "Economics Observatory",
      }),
    ).toEqual({
      primary: "Claudia Goldin",
      secondary: "Economics Observatory",
      hasAuthor: true,
    });
  });

  test("falls back to the publication when no byline exists", () => {
    expect(
      getArticleAttribution({ author: "", site_name: "Quanta Magazine" }),
    ).toEqual({
      primary: "Quanta Magazine",
      secondary: "",
      hasAuthor: false,
    });
  });

  test("rejects scraper labels and cleans aggregator bylines", () => {
    expect(
      getArticleAttribution({ author: "Posted on", site_name: "FRED Blog" }),
    ).toEqual({ primary: "FRED Blog", secondary: "", hasAuthor: false });
    expect(
      getArticleAttribution({
        author: "Denise Gaskins commented on Math Blog",
        site_name: "Mathblogging.org",
      }).primary,
    ).toBe("Denise Gaskins");
    expect(
      getArticleAttribution({
        author: "burakemir.ch via abhin4v",
        site_name: "burakemir.ch",
      }),
    ).toEqual({ primary: "burakemir.ch", secondary: "", hasAuthor: false });
    expect(
      getArticleAttribution({
        author:
          "Simon Little · CBC News · Posted: Aug 22, 2026 | Last Updated: August 22",
        site_name: "CBC",
      }).primary,
    ).toBe("Simon Little");
    expect(
      getArticleAttribution({
        author: "serendipity@perrotta.dev Thiago Perrotta",
        site_name: "Thiago's notes",
      }).primary,
    ).toBe("Thiago Perrotta");
    expect(
      getArticleAttribution({
        author: "Published by Boaz Barak View all posts by Boaz Barak",
        site_name: "Windows on Theory",
      }).primary,
    ).toBe("Boaz Barak");
    expect(
      getArticleAttribution({
        author: "Featuring Mark L. Egan. By Rachel Layne on",
        site_name: "EconoFact",
      }).primary,
    ).toBe("Rachel Layne");
    expect(
      getArticleAttribution({
        author: "Rachel Layne on",
        site_name: "EconoFact",
      }).primary,
    ).toBe("Rachel Layne");
    expect(
      getArticleAttribution({
        author: "Al Jazeera Staff",
        site_name: "Al Jazeera",
      }),
    ).toEqual({ primary: "Al Jazeera", secondary: "", hasAuthor: false });
    expect(
      getArticleAttribution({
        author: "pyfound.blogspot.com",
        site_name: "Python Software Foundation",
      }),
    ).toEqual({
      primary: "Python Software Foundation",
      secondary: "",
      hasAuthor: false,
    });
    expect(
      getArticleAttribution({
        author: "Joseph Zeballos-Roig Wed,",
        site_name: "Yahoo Finance",
      }).primary
    ).toBe("Joseph Zeballos-Roig");
    expect(
      getArticleAttribution({
        author: "Brad ReedBrad Reed is a staff writer for Common Dreams.",
        site_name: "Common Dreams",
      }).primary
    ).toBe("Brad Reed");
    expect(
      getArticleAttribution({
        author: "Simons Foundation Hosts Pivot Fellowship Annual Meeting By Jane Beaufore",
        site_name: "Simons Foundation",
      }).primary
    ).toBe("Jane Beaufore");
    expect(
      getArticleAttribution({
        author: "2026-08-25 - By EVE Online Team",
        site_name: "EVE Online",
      })
    ).toEqual({ primary: "EVE Online", secondary: "", hasAuthor: false });
  });
});

describe("author preference and exposure persistence", () => {
  test("migrates and backfills existing bylines", async () => {
    const db = await getDb();
    const version = await db.getFirstAsync<{ user_version: number }>(
      "PRAGMA user_version",
    );
    const row = await db.getFirstAsync<{ author_key: string }>(
      "SELECT author_key FROM articles WHERE url = ?",
      ["https://legacy.example/essay"],
    );

    expect(version?.user_version).toBeGreaterThanOrEqual(13);
    expect(row?.author_key).toBe("joan robinson");
    expect(await getIdentityExposure("author", "joan robinson")).toEqual({
      identity_kind: "author",
      identity_key: "joan robinson",
      exposure_count: 1,
      last_exposed_at: 123456,
    });
  });

  test("normalizes bylines, persists the mute, and supports unmuting", async () => {
    const firstId = await upsertArticleMeta({
      sourceId: null,
      url: "https://example.com/ada-one",
      title: "One",
      author: "Ada   Lovelace",
      siteName: "Example Review",
      publishedDate: Date.now(),
      excerpt: "",
      topic: "math",
      score: 0.5,
    });
    const secondId = await upsertArticleMeta({
      sourceId: null,
      url: "https://example.net/ada-two",
      title: "Two",
      author: "ada lovelace",
      siteName: "Another Publication",
      publishedDate: Date.now(),
      excerpt: "",
      topic: "math",
      score: 0.5,
    });

    expect(firstId).not.toBeNull();
    expect(secondId).not.toBeNull();

    const matchingIds = await muteAuthor("  ADA LOVELACE ");
    expect(new Set(matchingIds)).toEqual(new Set([firstId!, secondId!]));
    expect(await getMutedAuthors()).toEqual([
      {
        author_key: "ada lovelace",
        display_name: "ADA LOVELACE",
        muted_at: expect.any(Number),
      },
    ]);

    await unmuteAuthor("Ada Lovelace");
    expect(await getMutedAuthors()).toEqual([]);
  });

  test("keeps the normalized key in sync when enrichment adds a byline", async () => {
    const articleId = await upsertArticleMeta({
      sourceId: null,
      url: "https://example.org/grace",
      title: "Compiler Notes",
      author: "",
      siteName: "Example",
      publishedDate: Date.now(),
      excerpt: "",
      topic: "technology",
      score: 0.5,
    });
    expect(articleId).not.toBeNull();

    await setArticleContent(articleId!, { author: " Grace   Hopper " });
    const db = await getDb();
    const row = await db.getFirstAsync<{ author_key: string }>(
      "SELECT author_key FROM articles WHERE id = ?",
      [articleId!],
    );

    expect(row?.author_key).toBe(normalizeAuthorKey("Grace Hopper"));
  });

  test("records each article exposure once for its person and publication", async () => {
    const firstId = await upsertArticleMeta({
      sourceId: null,
      url: "https://person-first.example/one",
      title: "First essay",
      author: "Elinor Ostrom",
      siteName: "Institutional Notes",
      publishedDate: Date.now(),
      excerpt: "",
      topic: "economics",
      score: 0.5,
    });
    const secondId = await upsertArticleMeta({
      sourceId: null,
      url: "https://person-first.example/two",
      title: "Second essay",
      author: "Elinor Ostrom",
      siteName: "Institutional Notes",
      publishedDate: Date.now(),
      excerpt: "",
      topic: "economics",
      score: 0.5,
    });
    expect(firstId).not.toBeNull();
    expect(secondId).not.toBeNull();

    await markRead(firstId!);
    await markRead(firstId!); // restored/backtracked card: not a new exposure
    await markRead(secondId!);

    const author = await getIdentityExposure("author", "elinor ostrom");
    const domain = await getIdentityExposure("domain", "person-first.example");
    expect(author?.exposure_count).toBe(2);
    expect(domain?.exposure_count).toBe(2);
    expect(author?.last_exposed_at).toBeGreaterThan(0);
    expect(domain?.last_exposed_at).toBe(author?.last_exposed_at);

    const db = await getDb();
    await db.runAsync("DELETE FROM articles WHERE id IN (?, ?)", [
      firstId!,
      secondId!,
    ]);
    expect(
      (await getIdentityExposure("author", "elinor ostrom"))?.exposure_count,
    ).toBe(2);
  });

  test("the real deque cools a previously exposed person across domains", async () => {
    const seenId = await upsertArticleMeta({
      sourceId: null,
      url: "https://old-home.example/seen",
      title: "Seen essay",
      author: "Persistent Person",
      siteName: "Old Home",
      publishedDate: Date.now(),
      excerpt: "economics policy markets incentives",
      topic: "economics",
      score: 0.8,
    });
    const familiarId = await upsertArticleMeta({
      sourceId: null,
      url: "https://new-home.example/familiar",
      title: "Familiar person at a new publication",
      author: "Persistent Person",
      siteName: "New Home",
      publishedDate: Date.now(),
      excerpt: "economics policy markets incentives",
      topic: "economics",
      score: 0.9,
    });
    const freshIds = await Promise.all(
      ["Fresh One", "Fresh Two", "Fresh Three"].map((author, index) =>
        upsertArticleMeta({
          sourceId: null,
          url: `https://fresh-${index}.example/essay`,
          title: `${author} essay`,
          author,
          siteName: `Fresh ${index}`,
          publishedDate: Date.now(),
          excerpt: "economics policy markets incentives",
          topic: "economics",
          score: 0.4,
        }),
      ),
    );
    expect(seenId).not.toBeNull();
    expect(familiarId).not.toBeNull();
    expect(freshIds.every((id) => id != null)).toBe(true);

    for (const id of [seenId!, familiarId!, ...freshIds.map((id) => id!)]) {
      await setArticleContent(id, {
        wordCount: 900,
        quality: id === familiarId ? 0.95 : 0.6,
        topic: "economics",
        topicRelevance: 0.95,
      });
    }
    await markRead(seenId!);

    const deque = await loadDeque();
    const familiarIndex = deque.indexOf(familiarId!);
    const freshIndices = freshIds.map((id) => deque.indexOf(id!));
    expect(familiarIndex).toBeGreaterThan(-1);
    expect(freshIndices.every((index) => index >= 0)).toBe(true);
    expect(Math.max(...freshIndices)).toBeLessThan(familiarIndex);
  });

  test("a prolific publication cannot consume the SQL candidate limit", async () => {
    const db = await getDb();
    const longTailIds: number[] = [];
    await db.withTransactionAsync(async () => {
      for (let index = 0; index < 400; index++) {
        await db.runAsync(
          `INSERT INTO articles (
             url, title, author, author_key, site_name, site_domain,
             published_date, excerpt, word_count, topic, topic_relevance,
             fetched_at, score, quality
           ) VALUES (?, ?, ?, ?, ?, ?, ?, '', 900, 'economics', 0.95, ?, 0.9, 0.98)`,
          [
            `https://prolific.example/essay-${index}`,
            `Prolific essay ${index}`,
            `Writer ${index}`,
            `writer ${index}`,
            "Prolific",
            "prolific.example",
            Date.now(),
            Date.now(),
          ],
        );
      }
      for (let index = 0; index < 12; index++) {
        const result = await db.runAsync(
          `INSERT INTO articles (
             url, title, author, author_key, site_name, site_domain,
             published_date, excerpt, word_count, topic, topic_relevance,
             fetched_at, score, quality
           ) VALUES (?, ?, ?, ?, ?, ?, ?, '', 900, 'economics', 0.95, ?, 0.4, 0.55)`,
          [
            `https://long-tail-${index}.example/essay`,
            `Long-tail essay ${index}`,
            `Long-tail writer ${index}`,
            `long-tail writer ${index}`,
            `Long Tail ${index}`,
            `long-tail-${index}.example`,
            Date.now(),
            Date.now(),
          ],
        );
        longTailIds.push(result.lastInsertRowId);
      }
    });

    const deque = await loadDeque();
    expect(longTailIds.every((id) => deque.includes(id))).toBe(true);
    const firstDomains = await db.getAllAsync<{ site_domain: string }>(
      `SELECT DISTINCT site_domain FROM articles
       WHERE id IN (${deque
         .slice(0, 12)
         .map(() => "?")
         .join(", ")})`,
      deque.slice(0, 12),
    );
    expect(firstDomains).toHaveLength(12);
  });

  test("rescues an underrepresented topic from a much larger candidate pool", async () => {
    const db = await getDb();
    await db.execAsync(
      "CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    const previousTopics = await kvGet("topics");
    await kvSet("topics", JSON.stringify(["technology", "math"]));

    await db.withTransactionAsync(async () => {
      for (let index = 0; index < 400; index++) {
        await db.runAsync(
          `INSERT INTO articles (
             url, title, author, author_key, site_name, site_domain,
             published_date, excerpt, word_count, topic, topic_relevance,
             fetched_at, score, quality
           ) VALUES (?, ?, ?, ?, ?, ?, ?, '', 900, 'technology', 0.95, ?, 0.9, 0.99)`,
          [
            `https://dominant-tech-${index}.example/essay`,
            `Dominant technology essay ${index}`,
            `Technology writer ${index}`,
            `technology writer ${index}`,
            `Dominant Tech ${index}`,
            `dominant-tech-${index}.example`,
            Date.now(),
            Date.now(),
          ],
        );
      }
      for (let index = 0; index < 18; index++) {
        await db.runAsync(
          `INSERT INTO articles (
             url, title, author, author_key, site_name, site_domain,
             published_date, excerpt, word_count, topic, topic_relevance,
             fetched_at, score, quality
           ) VALUES (?, ?, ?, ?, ?, ?, ?, '', 900, 'math', 0.95, ?, 0.4, 0.05)`,
          [
            `https://scarce-math-${index}.example/essay`,
            `Scarce math essay ${index}`,
            `Math writer ${index}`,
            `math writer ${index}`,
            `Scarce Math ${index}`,
            `scarce-math-${index}.example`,
            Date.now(),
            Date.now(),
          ],
        );
      }
    });

    const deque = await loadDeque();
    const counts = await db.getAllAsync<{ topic: string; count: number }>(
      `SELECT topic, COUNT(*) AS count FROM articles
       WHERE id IN (${deque.map(() => "?").join(", ")})
       GROUP BY topic`,
      deque,
    );
    expect(
      Object.fromEntries(counts.map((row) => [row.topic, row.count])),
    ).toEqual({
      math: 18,
      technology: 18,
    });
    const eligibleByTopic = await countEligibleByTopic();
    expect(eligibleByTopic.get("math")).toBeGreaterThanOrEqual(18);
    expect(eligibleByTopic.get("technology")).toBeGreaterThanOrEqual(18);

    if (previousTopics == null) {
      await db.runAsync("DELETE FROM kv WHERE key = 'topics'");
    } else {
      await kvSet("topics", previousTopics);
    }
  });
});
