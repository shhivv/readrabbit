// Daily seed publisher — runs on a VPS (bun + cron), NOT in the app.
//
//   cd publisher
//   bun run crawl.ts          # fresh crawl -> .data/naturallycurious.db
//   bun run upload.ts         # select pack -> R2 (starter.json + dated copy)
//   # or: bun run all
//
// The output is the static JSON the app fetches when its local pool is
// empty, so new installs read instantly instead of waiting on the first
// on-device crawl. Selection mirrors the app's own taste: fresh, enriched,
// quality-ranked, capped per source so one prolific author can't own the
// whole deck.

// @ts-nocheck
import { mkdirSync, rmSync } from "node:fs";

const DB_DIR = new URL("./.data", import.meta.url).pathname;
const KEEP_DB = process.env.NC_KEEP_DB === "1";

Bun.plugin({
  name: "expo-sqlite-shim",
  setup(build) {
    build.module("expo-sqlite", () => ({
      exports: require("../harness/expo-sqlite-shim.ts"),
      loader: "object",
    }));
  },
});

if (!KEEP_DB) {
  rmSync(DB_DIR, { recursive: true, force: true });
}
mkdirSync(DB_DIR, { recursive: true });

async function main() {
  const dbModule = await import("../src/lib/db");
  await dbModule.seedCatalogSources(["technology", "economics", "math"]);

  const { runCrawl } = await import("../src/lib/crawler/engine");
  const ok = await runCrawl({ mode: "initial" });
  if (!ok) {
    console.error("✗ crawl failed (lock contention?)");
    process.exit(1);
  }

  const db = await dbModule.getDb();
  const now = Date.now();
  const [{ c: enriched }] = await db.getAllAsync<{ c: number }>(
    "SELECT COUNT(*) AS c FROM articles WHERE word_count >= 250"
  );
  console.log(`✓ crawl done: ${enriched} enriched articles`);

  // ---- selection: fresh, quality-ranked, ≤2 per voice, topic-balanced ----
  const rows = await db.getAllAsync(
    `SELECT id, url, title, author, site_name, published_date, excerpt,
            content_html, text_content, word_count, topic, score, quality,
            site_domain,
            ROW_NUMBER() OVER (
              PARTITION BY COALESCE(NULLIF(LOWER(TRIM(author)), ''),
                                   NULLIF(site_domain, ''), 's' || source_id)
              ORDER BY MAX(quality, 0.05) * POWER(0.5,
                MAX((strftime('%s','now')*1000 - COALESCE(published_date, fetched_at)) / 86400000.0, -30) / 14.0
              ) DESC
            ) AS voice_rank
     FROM articles
     WHERE word_count >= 250 AND is_archived = 0
       AND COALESCE(published_date, fetched_at) > ? 
     ORDER BY quality DESC`,
    [now - 45 * 24 * 60 * 60 * 1000]
  );

  const seenTopics: Record<string, number> = {};
  const picked = [];
  for (const row of rows) {
    if (row.voice_rank > 2) continue; // ≤2 per author/domain
    const topic = row.topic ?? "technology";
    if ((seenTopics[topic] ?? 0) >= 12) continue; // rough balance
    seenTopics[topic] = (seenTopics[topic] ?? 0) + 1;
    picked.push(row);
    if (picked.length >= 30) break;
  }

  const pack = {
    generated_at: now,
    articles: picked.map((r) => ({
      url: r.url,
      title: r.title,
      author: r.author,
      site_name: r.site_name,
      published_date: r.published_date,
      content_html: r.content_html,
      text_content: r.text_content,
      word_count: r.word_count,
      quality: r.quality,
      topic: r.topic,
      score: r.score,
    })),
  };

  const outPath = new URL("./.data/starter-pack.json", import.meta.url).pathname;
  await Bun.write(outPath, JSON.stringify(pack));
  console.log(
    `✓ selected ${picked.length} articles (${Object.entries(seenTopics)
      .map(([t, n]) => `${t}:${n}`)
      .join(", ")}) -> ${outPath}`
  );

  // keep text_content out of stale rows check above? no — pruneStorage never
  // runs in initial mode, so everything selected still has full text.
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
