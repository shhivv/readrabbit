// End-to-end crawl harness: runs the REAL engine (fetcher, feeds, extract,
// quality, discover, engine) against a real SQLite database via the shim.
//
//   bun harness/crawl.ts                 # full run, all topics
//   FEED_LIMIT=8 bun harness/crawl.ts    # quick smoke
//   NC_KEEP_DB=1 bun harness/crawl.ts    # reuse last run's db (tests 304 path)
//
// Measures wall-clock per phase and verifies serving readiness (deque query).

// @ts-nocheck
import { mkdirSync, rmSync, statSync } from "node:fs";

const DB_DIR = new URL("./.data", import.meta.url).pathname;

Bun.plugin({
  name: "expo-sqlite-shim",
  setup(build) {
    build.module("expo-sqlite", () => ({
      exports: require("./expo-sqlite-shim.ts"),
      loader: "object",
    }));
  },
});

if (!process.env.NC_KEEP_DB) {
  rmSync(DB_DIR, { recursive: true, force: true });
}
mkdirSync(DB_DIR, { recursive: true });

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

async function main() {
  const t0 = Date.now();

  // ---- migration + schema regression checks ----
  const dbModule = await import("../src/lib/db");
  const db = await dbModule.getDb();
  const srcCols = (
    await db.getAllAsync<{ name: string }>("PRAGMA table_info(sources)")
  ).map((c) => c.name);
  for (const col of ["last_modified", "last_fetched_at", "next_check_at", "avg_update_hours"]) {
    if (!srcCols.includes(col)) fail(`sources missing column: ${col}`);
  }
  const artCols = (
    await db.getAllAsync<{ name: string }>("PRAGMA table_info(articles)")
  ).map((c) => c.name);
  for (const col of ["quality", "word_count", "content_html"]) {
    if (!artCols.includes(col)) fail(`articles missing column: ${col}`);
  }
  console.log("✓ schema check");

  // ---- seed catalog ----
  const topics = ["technology", "economics", "math"];
  const seeded = await dbModule.seedCatalogSources(topics as any);
  let sources = await dbModule.getActiveSources(500);
  const limit = parseInt(process.env.FEED_LIMIT ?? "", 10);
  if (!Number.isNaN(limit) && sources.length > limit) {
    // mark the rest as dead so getDueSources skips them
    const keep = new Set(sources.slice(0, limit).map((s) => s.id));
    const d = await dbModule.getDb();
    for (const s of sources) {
      if (!keep.has(s.id)) {
        await d.runAsync("UPDATE sources SET status = 'dead' WHERE id = ?", [s.id]);
      }
    }
    sources = sources.filter((s) => keep.has(s.id));
  }
  console.log(`✓ catalog seeded (+${seeded}), crawling ${sources.length} sources`);

  // ---- crawl ----
  const phases: Record<string, { start: number; end?: number }> = {};
  let lastPhase = "";
  const { runCrawl } = await import("../src/lib/crawler/engine");
  const ok = await runCrawl({
    mode: "initial",
    onProgress: (p) => {
      if (!(p.phase in phases)) {
        // close out the previous phase on transition
        if (lastPhase && phases[lastPhase] && phases[lastPhase].end == null) {
          phases[lastPhase].end = Date.now();
        }
        phases[p.phase] = { start: Date.now() };
        lastPhase = p.phase;
      }
      process.stdout.write(
        `\r  ${p.phase.padEnd(9)} ${String(p.done).padStart(3)}/${String(p.total).padEnd(3)}`
      );
    },
  });
  if (lastPhase && phases[lastPhase]?.end == null) {
    phases[lastPhase].end = Date.now();
  }
  console.log("");
  if (!ok) fail("engine reported lock contention — is another harness running?");

  // ---- report ----
  const [{ c: articleCount }] = await db.getAllAsync<{ c: number }>(
    "SELECT COUNT(*) AS c FROM articles"
  );
  const [{ c: enriched }] = await db.getAllAsync<{ c: number }>(
    "SELECT COUNT(*) AS c FROM articles WHERE word_count >= 250"
  );
  const [{ c: failedCount }] = await db.getAllAsync<{ c: number }>(
    "SELECT COUNT(*) AS c FROM articles WHERE word_count = -1"
  );
  const [{ avgQ }] = await db.getAllAsync<{ avgQ: number | null }>(
    "SELECT AVG(quality) AS avgQ FROM articles WHERE word_count >= 250"
  );
  const withMath = await db.getAllAsync<{ c: number }>(
    "SELECT COUNT(*) AS c FROM articles WHERE content_html LIKE '%katex%'"
  );

  console.log(`\n✓ crawl complete in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`  articles discovered : ${articleCount}`);
  console.log(`  enriched (≥250 wds) : ${enriched}  (failed: ${failedCount})`);
  console.log(`  avg quality score   : ${(avgQ ?? 0).toFixed(2)}`);
  console.log(`  with rendered math  : ${withMath[0]?.c ?? 0}`);

  if (enriched === 0) fail("no articles were enriched");

  // ---- serving readiness: deque + hydration ----
  const { loadDeque } = await import("../src/lib/deque");
  const dequeT0 = Date.now();
  const ids = await loadDeque();
  console.log(
    `  deque ready         : ${ids.length} ids in ${Date.now() - dequeT0}ms`
  );

  const samples = await db.getAllAsync(
    `SELECT title, site_name, word_count, quality FROM articles
     WHERE word_count >= 250 ORDER BY quality DESC LIMIT 5`
  );
  console.log("\n  top-quality sample:");
  for (const row of samples as any[]) {
    console.log(
      `   q=${row.quality.toFixed(2)} w=${String(row.word_count).padStart(5)}  "${row.title.slice(0, 52)}" — ${row.site_name}`
    );
  }

  const size = statSync(new URL("./.data/naturallycurious.db", import.meta.url)).size;
  console.log(`\n  db size: ${(size / 1024 / 1024).toFixed(2)} MB`);

  for (const name of ["feeds", "enrich", "discover"]) {
    const ph = phases[name];
    if (!ph) continue;
    const ms = (ph.end ?? Date.now()) - ph.start;
    console.log(`  ${name.padEnd(9)} phase: ${(ms / 1000).toFixed(1)}s`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
