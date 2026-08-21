// Post-crawl analysis: measures the things the product brief cares about.
//
//   bun harness/analyze.ts
//
// Reads harness/.data/naturallycurious.db (run harness/crawl.ts first).
// Reports: deque simulation (what the user actually sees), per-source
// concentration, article age distribution, and mainstream-media leakage.

// @ts-nocheck
Bun.plugin({
  name: "expo-sqlite-shim",
  setup(build) {
    build.module("expo-sqlite", () => ({
      exports: require("./expo-sqlite-shim.ts"),
      loader: "object",
    }));
  },
});

// The deque simulation imports the REAL loadDeque so the harness always
// measures the shipping sampling code, not a drifted copy.
const { loadDeque } = await import("../src/lib/deque");

const { Database } = require("bun:sqlite");
const db = new Database(
  new URL("./.data/naturallycurious.db", import.meta.url).pathname,
  { readonly: true }
);

function q(sql, params = []) {
  return db.query(sql).all(...params);
}

const now = Date.now();

const MIN_WORDS = 250; // must match src/lib/deque.ts

// ---- deque simulation: sample 5x like 5 app sessions ----
console.log("═".repeat(72));
console.log("DEQUE SIMULATION (5 sessions × first 12 cards) — real loadDeque()");
console.log("═".repeat(72));

let allSampled = [];
for (let s = 0; s < 5; s++) {
  const ids = await loadDeque();
  allSampled.push(...ids);
  if (s === 0 && ids.length > 0) {
    // preserve the sampled ranking order (WHERE IN returns arbitrary order)
    const order = ids.map((id, i) => `WHEN ${id} THEN ${i}`).join(" ");
    const rows = q(
      `SELECT id, title, site_name, author, word_count, quality,
              COALESCE(published_date, fetched_at) AS ts
       FROM articles WHERE id IN (${ids.map(() => "?").join(",")})
       ORDER BY CASE id ${order} END`,
      ids
    );
    console.log("\n session 1:");
    for (const r of rows.slice(0, 12)) {
      const age = ((now - r.ts) / 86400000).toFixed(0);
      console.log(
        `   ${String(age).padStart(4)}d  q=${r.quality.toFixed(2)}  "${r.title.slice(0, 44)}" — ${r.site_name}`
      );
    }
  }
}

// ---- concentration: how dominated is the stream by one source? ----
console.log("\n" + "═".repeat(72));
console.log("CONCENTRATION (deque window of 60)");
console.log("═".repeat(72));

const uniq = [...new Set(allSampled)];
const counts = q(
  `SELECT COALESCE(NULLIF(site_domain,''), site_name) AS src, COUNT(*) AS c
   FROM articles
   WHERE id IN (${uniq.map(() => "?").join(",")})
   GROUP BY src ORDER BY c DESC`,
  uniq
);
const top = counts[0];
const total = counts.reduce((s, r) => s + r.c, 0);
console.log(` distinct sources in window : ${counts.length}`);
console.log(` top source share           : ${top.src} = ${((top.c / total) * 100).toFixed(0)}% (${top.c}/${total})`);
console.log(` sources with ≥5 slots      : ${counts.filter((r) => r.c >= 5).map((r) => `${r.src}(${r.c})`).join(", ") || "none"}`);

// ---- age distribution of eligible pool vs deque ----
console.log("\n" + "═".repeat(72));
console.log("AGE DISTRIBUTION");
console.log("═".repeat(72));

const buckets = [
  ["≤7d", 7],
  ["8–30d", 30],
  ["31–90d", 90],
  ["91–180d", 180],
  [">180d", Infinity],
];
const poolAges = q(
  `SELECT COALESCE(published_date, fetched_at) AS ts FROM articles WHERE word_count >= ${MIN_WORDS}`
);
const dequeAges = q(
  `SELECT COALESCE(published_date, fetched_at) AS ts FROM articles
   WHERE id IN (${uniq.map(() => "?").join(",")})`,
  uniq
);
function bucketOf(ts) {
  const d = (now - ts) / 86400000;
  for (const [label, max] of buckets) if (d <= max) return label;
  return ">180d";
}
function dist(rows) {
  const m = {};
  for (const r of rows) {
    const b = bucketOf(r.ts);
    m[b] = (m[b] ?? 0) + 1;
  }
  return m;
}
const pd = dist(poolAges);
const dd = dist(dequeAges);
console.log("  bucket     pool%   deque%");
for (const [label] of buckets) {
  const p = ((pd[label] ?? 0) / Math.max(poolAges.length, 1)) * 100;
  const d = ((dd[label] ?? 0) / Math.max(dequeAges.length, 1)) * 100;
  console.log(`  ${label.padEnd(9)}  ${p.toFixed(0).padStart(3)}%    ${d.toFixed(0).padStart(3)}%`);
}
const nullDates = q(`SELECT COUNT(*) AS c FROM articles WHERE published_date IS NULL AND word_count >= ${MIN_WORDS}`)[0].c;
console.log(`  enriched articles with no publish date: ${nullDates}`);

// ---- mainstream leakage ----
console.log("\n" + "═".repeat(72));
console.log("SOURCE ROSTER (all crawled sources)");
console.log("═".repeat(72));

const sources = q(`SELECT name, topic, origin, status FROM sources ORDER BY origin, name`);
const byOrigin = {};
for (const s of sources) (byOrigin[s.origin] ??= []).push(s);
for (const [origin, list] of Object.entries(byOrigin)) {
  console.log(`\n ${origin} (${list.length}):`);
  console.log("   " + list.map((s) => s.name).join(", "));
}

// enrichment failure modes
const failed = q(`SELECT url, title FROM articles WHERE word_count = -1 LIMIT 10`);
if (failed.length) {
  console.log("\n failed enrichments:");
  for (const f of failed) console.log(`   ${f.url}`);
}
