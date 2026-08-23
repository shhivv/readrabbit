// End-to-end local ranking benchmark: real app migration + real loadDeque()
// against a 20k-row SQLite cache with concentrated authors/publications.
//
//   bun harness/bench-recommend.ts

// @ts-nocheck
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const benchDir = mkdtempSync(join(tmpdir(), "readrabbit-ranking-"));
process.env.NC_HARNESS_DB_DIR = benchDir;

Bun.plugin({
  name: "expo-sqlite-ranking-benchmark-shim",
  setup(build) {
    build.module("expo-sqlite", () => ({
      exports: require("./expo-sqlite-shim.ts"),
      loader: "object",
    }));
  },
});

const { getDb, kvSet } = await import("../src/lib/db");
const { loadDeque } = await import("../src/lib/deque");
await getDb();
await kvSet("topics", JSON.stringify(["technology", "economics", "math"]));

const db = new Database(join(benchDir, "naturallycurious.db"));
const insertArticle = db.prepare(`
  INSERT INTO articles (
    url, title, author, author_key, site_name, site_domain,
    published_date, excerpt, word_count, topic, topic_relevance,
    fetched_at, score, quality
  ) VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?)
`);
const insertExposure = db.prepare(`
  INSERT OR IGNORE INTO identity_exposures (
    identity_kind, identity_key, exposure_count, last_exposed_at
  ) VALUES (?, ?, ?, ?)
`);

const articleCount = 20_000;
const now = Date.now();
const topics = ["technology", "economics", "math"];
const seed = db.transaction(() => {
  for (let index = 0; index < articleCount; index++) {
    // The first 8k rows deliberately come from a tiny prolific cluster. A
    // quality-only LIMIT would mostly return this cluster and hide the tail.
    const concentrated = index < 8_000;
    const authorIndex = concentrated ? index % 20 : 20 + (index % 2_000);
    const domainIndex = concentrated ? index % 10 : 10 + (index % 1_200);
    const authorKey = `author-${authorIndex}`;
    const domain = `publication-${domainIndex}.example`;
    const topic = topics[index % topics.length];
    insertArticle.run(
      `https://${domain}/essay-${index}`,
      `Essay ${index}`,
      `Author ${authorIndex}`,
      authorKey,
      `Publication ${domainIndex}`,
      domain,
      now - (index % 75) * 86_400_000,
      600 + (index % 2_000),
      topic,
      0.45 + (index % 55) / 100,
      now,
      0.45 + (index % 40) / 100,
      0.5 + (index % 45) / 100
    );

    if (authorIndex % 3 === 0) {
      insertExposure.run(
        "author",
        authorKey,
        1 + (authorIndex % 12),
        now - (authorIndex % 100) * 86_400_000
      );
    }
    if (domainIndex % 4 === 0) {
      insertExposure.run(
        "domain",
        domain,
        1 + (domainIndex % 8),
        now - (domainIndex % 60) * 86_400_000
      );
    }
  }
});
seed();

for (let index = 0; index < 3; index++) await loadDeque();

const samples = [];
for (let index = 0; index < 30; index++) {
  const started = performance.now();
  const ids = await loadDeque();
  samples.push(performance.now() - started);
  if (ids.length !== 36) throw new Error(`Expected 36 cards, got ${ids.length}`);
}
samples.sort((left, right) => left - right);
const percentile = (p) => samples[Math.floor((samples.length - 1) * p)];
const average = samples.reduce((sum, value) => sum + value, 0) / samples.length;

console.log(`eligible cache : ${articleCount.toLocaleString()} articles`);
console.log(`iterations     : ${samples.length}`);
console.log(`average        : ${average.toFixed(2)} ms`);
console.log(`p50            : ${percentile(0.5).toFixed(2)} ms`);
console.log(`p95            : ${percentile(0.95).toFixed(2)} ms`);
console.log(`max            : ${samples.at(-1).toFixed(2)} ms`);

db.close();
