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
  INSERT INTO articles (url, title, author, fetched_at)
    VALUES ('https://legacy.example/essay', 'Legacy essay', '  Joan   Robinson ', 1);
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
  getMutedAuthors,
  muteAuthor,
  setArticleContent,
  unmuteAuthor,
  upsertArticleMeta,
} = await import("../src/lib/db");

describe("article attribution", () => {
  test("promotes the author while retaining the publication as context", () => {
    expect(
      getArticleAttribution({
        author: "  Claudia Goldin ",
        site_name: "Economics Observatory",
      })
    ).toEqual({
      primary: "Claudia Goldin",
      secondary: "Economics Observatory",
      hasAuthor: true,
    });
  });

  test("falls back to the publication when no byline exists", () => {
    expect(
      getArticleAttribution({ author: "", site_name: "Quanta Magazine" })
    ).toEqual({
      primary: "Quanta Magazine",
      secondary: "",
      hasAuthor: false,
    });
  });

  test("rejects scraper labels and cleans aggregator bylines", () => {
    expect(
      getArticleAttribution({ author: "Posted on", site_name: "FRED Blog" })
    ).toEqual({ primary: "FRED Blog", secondary: "", hasAuthor: false });
    expect(
      getArticleAttribution({
        author: "Denise Gaskins commented on Math Blog",
        site_name: "Mathblogging.org",
      }).primary
    ).toBe("Denise Gaskins");
  });
});

describe("muted author persistence", () => {
  test("migrates and backfills existing bylines", async () => {
    const db = await getDb();
    const version = await db.getFirstAsync<{ user_version: number }>(
      "PRAGMA user_version"
    );
    const row = await db.getFirstAsync<{ author_key: string }>(
      "SELECT author_key FROM articles WHERE url = ?",
      ["https://legacy.example/essay"]
    );

    expect(version?.user_version).toBeGreaterThanOrEqual(6);
    expect(row?.author_key).toBe("joan robinson");
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
      [articleId!]
    );

    expect(row?.author_key).toBe(normalizeAuthorKey("Grace Hopper"));
  });
});
