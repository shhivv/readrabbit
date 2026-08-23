// Local performance guard for the recommendation changes.
// Run after `bun harness/crawl.ts`; benchmarks a disposable copy so migration
// timing cannot mutate or invalidate the quality-gate database.

// @ts-nocheck
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const sourcePath = new URL("./.data/naturallycurious.db", import.meta.url).pathname;
if (!existsSync(sourcePath)) {
  throw new Error("Run bun harness/crawl.ts before this benchmark");
}

const tempDir = mkdtempSync(join(tmpdir(), "naturally-curious-perf-"));
const tempPath = join(tempDir, "naturallycurious.db");

for (const suffix of ["", "-wal", "-shm"]) {
  const source = `${sourcePath}${suffix}`;
  if (existsSync(source)) copyFileSync(source, `${tempPath}${suffix}`);
}

// Re-run the potentially expensive article reclassification plus later
// migrations on the copy to measure upgrade-time impact.
const raw = new Database(tempPath);
raw.exec("PRAGMA user_version = 6");
raw.close();
process.env.NC_HARNESS_DB_DIR = tempDir;

Bun.plugin({
  name: "expo-sqlite-performance-shim",
  setup(build) {
    build.module("expo-sqlite", () => ({
      exports: require("./expo-sqlite-shim.ts"),
      loader: "object",
    }));
  },
});

function percentile(values, fraction) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function legacyDequeQuery() {
  const age = `(strftime('%s','now') * 1000 - COALESCE(published_date, fetched_at)) / 86400000.0`;
  const recency = `POWER(0.5, MAX(${age}, -30) / 14.0)`;
  const random = `((ABS(RANDOM()) % 1000000) + 1) / 1000001.0`;
  const trust = `(0.75 + 0.5 * MIN(MAX(score, 0.0), 1.0))`;
  const key = `(MAX(quality, 0.05) * ${recency} * ${trust} * ${random})`;
  const domain = `COALESCE(NULLIF(site_domain, ''), LOWER(TRIM(author)), 'd' || source_id)`;
  const author = `COALESCE(NULLIF(LOWER(TRIM(author)), ''), site_domain, 'a' || source_id)`;
  return `
    SELECT id FROM (
      SELECT id, key,
             ROW_NUMBER() OVER (PARTITION BY COALESCE(topic, 'unknown') ORDER BY key DESC) AS rank_in_topic
      FROM (
        SELECT id, topic, ${key} AS key,
               ROW_NUMBER() OVER (PARTITION BY ${domain} ORDER BY ${key} DESC) AS rank_in_domain,
               ROW_NUMBER() OVER (PARTITION BY ${author} ORDER BY ${key} DESC) AS rank_in_author
        FROM articles
        WHERE is_archived = 0 AND is_read = 0 AND word_count >= 250
          AND COALESCE(published_date, fetched_at)
                > strftime('%s','now') * 1000 - 120 * 86400000
      )
      WHERE rank_in_domain <= 3 AND rank_in_author <= 3
    )
    WHERE rank_in_topic <= 30
    ORDER BY key DESC LIMIT 60`;
}

try {
  const dbModule = await import("../src/lib/db");
  const migrationStart = performance.now();
  const db = await dbModule.getDb();
  const migrationMs = performance.now() - migrationStart;
  await dbModule.kvSet(
    "topics",
    JSON.stringify(["technology", "economics", "math"])
  );

  const { assessTopic } = await import("../src/lib/crawler/topic");
  const articles = await db.getAllAsync(
    `SELECT title, excerpt, text_content, topic FROM articles
     WHERE word_count >= 250`
  );
  const scoringStart = performance.now();
  for (let pass = 0; pass < 100; pass++) {
    for (const article of articles) {
      assessTopic(
        article,
        article.topic === "economics" || article.topic === "math"
          ? article.topic
          : "technology"
      );
    }
  }
  const scoringMs = performance.now() - scoringStart;
  const scorePerArticleMs = scoringMs / Math.max(1, articles.length * 100);

  const { loadDeque } = await import("../src/lib/deque");
  for (let index = 0; index < 25; index++) await loadDeque();
  const samples = [];
  for (let index = 0; index < 1000; index++) {
    const start = performance.now();
    await loadDeque();
    samples.push(performance.now() - start);
  }

  const p50 = percentile(samples, 0.5);
  const p95 = percentile(samples, 0.95);
  const maximum = Math.max(...samples);

  const legacySql = legacyDequeQuery();
  for (let index = 0; index < 25; index++) await db.getAllAsync(legacySql);
  const legacySamples = [];
  for (let index = 0; index < 1000; index++) {
    const start = performance.now();
    await db.getAllAsync(legacySql);
    legacySamples.push(performance.now() - start);
  }
  const legacyP95 = percentile(legacySamples, 0.95);

  console.log(`migration/reclassification : ${migrationMs.toFixed(1)} ms (${articles.length} articles)`);
  console.log(`topic scoring             : ${(scorePerArticleMs * 1000).toFixed(1)} µs/article`);
  console.log(`loadDeque (1000 runs)     : p50 ${p50.toFixed(2)} ms · p95 ${p95.toFixed(2)} ms · max ${maximum.toFixed(2)} ms`);
  console.log(`legacy deque SQL          : p95 ${legacyP95.toFixed(2)} ms`);

  if (scorePerArticleMs > 0.2) {
    throw new Error("topic scoring exceeded 0.2 ms/article");
  }
  if (p95 > 25) {
    throw new Error("loadDeque p95 exceeded 25 ms on the desktop harness");
  }
  if (p95 > legacyP95 * 1.25) {
    throw new Error("new loadDeque is materially slower than the legacy sampler");
  }
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
