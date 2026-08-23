// Quality gate for the recommendation engine over a real crawl database.
// Run `bun harness/crawl.ts` first, then this script. It exercises the real
// loadDeque query for single-topic and mixed-interest readers across many
// independently randomized sessions.

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

const { getDb, kvGet, kvSet, muteAuthor, unmuteAuthor } = await import("../src/lib/db");
const { loadDeque } = await import("../src/lib/deque");
const { MIN_TOPIC_RELEVANCE } = await import("../src/lib/crawler/topic");
const { getArticleAttribution } = await import("../src/lib/attribution");
const { isLowValueRoundup } = await import("../src/lib/crawler/editorial");
const db = await getDb();

const SESSION_COUNT = Number.parseInt(process.env.SESSIONS ?? "250", 10);
const HEAD_SIZE = 12;
const WINDOW_SIZE = 36;
const scenarios = [
  ["economics"],
  ["math"],
  ["technology"],
  ["technology", "economics", "math"],
];

function fail(message) {
  throw new Error(`QUALITY GATE: ${message}`);
}

const previousTopics = await kvGet("topics");

try {
  console.log("═".repeat(76));
  console.log(`RECOMMENDATION QUALITY GATE (${SESSION_COUNT} sessions per scenario)`);
  console.log("═".repeat(76));

  for (const selectedTopics of scenarios) {
    await kvSet("topics", JSON.stringify(selectedTopics));
    const placeholders = selectedTopics.map(() => "?").join(", ");
    const pool = await db.getFirstAsync(
      `SELECT COUNT(*) AS articles,
              COUNT(DISTINCT site_domain) AS domains,
              COUNT(DISTINCT CASE WHEN author_key != '' THEN author_key END) AS authors
       FROM articles
       WHERE is_archived = 0 AND is_read = 0 AND word_count >= 250
         AND topic_relevance >= ? AND topic IN (${placeholders})`,
      [MIN_TOPIC_RELEVANCE, ...selectedTopics]
    );
    const domainAvailability = await db.getAllAsync(
      `SELECT COUNT(*) AS articles
       FROM articles
       WHERE is_archived = 0 AND is_read = 0 AND word_count >= 250
         AND topic_relevance >= ? AND topic IN (${placeholders})
       GROUP BY COALESCE(NULLIF(site_domain, ''), site_name)`,
      [MIN_TOPIC_RELEVANCE, ...selectedTopics]
    );
    const evaluatedWindow = Math.min(WINDOW_SIZE, pool.articles);
    let fairDomainCap = 0;
    while (
      domainAvailability.reduce(
        (sum, domain) => sum + Math.min(domain.articles, fairDomainCap),
        0
      ) < evaluatedWindow
    ) {
      fairDomainCap++;
    }

    let complete = 0;
    let uniqueDomains = 0;
    let uniqueAuthors = 0;
    let adjacentDomainRepeats = 0;
    let visiblePairs = 0;
    let worstDistinctDomains = Number.POSITIVE_INFINITY;
    let worstTopDomainShare = 0;
    let topicImbalance = 0;
    let worstWindowDomainCount = 0;
    let sample = [];

    for (let session = 0; session < SESSION_COUNT; session++) {
      const ids = (await loadDeque()).slice(0, WINDOW_SIZE);
      const headIds = ids.slice(0, HEAD_SIZE);
      if (headIds.length === HEAD_SIZE) complete++;
      if (headIds.length === 0) continue;

      const rows = await db.getAllAsync(
        `SELECT id, title, topic, topic_relevance, site_domain, author_key,
                author, site_name
         FROM articles WHERE id IN (${ids.map(() => "?").join(", ")})`,
        ids
      );
      const byId = new Map(rows.map((row) => [row.id, row]));
      const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
      const head = ordered.slice(0, HEAD_SIZE);
      if (session === 0) sample = head;

      const domains = head.map((row) => row.site_domain || row.site_name);
      const authors = head.map(
        (row) => row.author_key || `site:${row.site_domain || row.site_name}`
      );
      const domainCounts = new Map();
      for (const domain of domains) {
        domainCounts.set(domain, (domainCounts.get(domain) ?? 0) + 1);
      }
      const distinctDomains = domainCounts.size;
      uniqueDomains += distinctDomains;
      uniqueAuthors += new Set(authors).size;
      worstDistinctDomains = Math.min(worstDistinctDomains, distinctDomains);
      worstTopDomainShare = Math.max(
        worstTopDomainShare,
        Math.max(...domainCounts.values()) / head.length
      );
      const windowCounts = new Map();
      for (const row of ordered) {
        const domain = row.site_domain || row.site_name;
        windowCounts.set(domain, (windowCounts.get(domain) ?? 0) + 1);
      }
      worstWindowDomainCount = Math.max(
        worstWindowDomainCount,
        ...windowCounts.values()
      );

      for (let index = 1; index < domains.length; index++) {
        visiblePairs++;
        if (domains[index] === domains[index - 1]) adjacentDomainRepeats++;
      }

      const topicCounts = selectedTopics.map(
        (topic) => head.filter((row) => row.topic === topic).length
      );
      if (topicCounts.length > 1) {
        topicImbalance = Math.max(
          topicImbalance,
          Math.max(...topicCounts) - Math.min(...topicCounts)
        );
      }

      if (ordered.some((row) => !selectedTopics.includes(row.topic))) {
        fail(`${selectedTopics.join("+")} served an unselected topic`);
      }
      if (ordered.some((row) => row.topic_relevance < MIN_TOPIC_RELEVANCE)) {
        fail(`${selectedTopics.join("+")} served below-threshold relevance`);
      }
    }

    const expectedDomains = Math.min(HEAD_SIZE, pool.domains);
    const label = selectedTopics.join(" + ");
    console.log(`\n${label}`);
    console.log(
      `  pool ${pool.articles} articles · ${pool.domains} domains · ${pool.authors} named authors`
    );
    console.log(
      `  complete first screens ${complete}/${SESSION_COUNT} · avg domains ${(uniqueDomains / SESSION_COUNT).toFixed(2)} · avg voices ${(uniqueAuthors / SESSION_COUNT).toFixed(2)}`
    );
    console.log(
      `  worst first-screen domains ${worstDistinctDomains} · worst top-domain share ${(worstTopDomainShare * 100).toFixed(1)}% · adjacent repeats ${adjacentDomainRepeats}/${visiblePairs}`
    );
    console.log(
      `  worst publication count in first ${WINDOW_SIZE}: ${worstWindowDomainCount} · fair minimum ${fairDomainCap}`
    );
    console.log("  sample:");
    for (const row of sample) {
      const attribution = getArticleAttribution(row);
      console.log(
        `    [${row.topic.slice(0, 4)} ${(row.topic_relevance * 100).toFixed(0).padStart(2)}] ${row.title.slice(0, 60)} — ${attribution.primary}`
      );
    }

    if (pool.articles >= HEAD_SIZE && complete !== SESSION_COUNT) {
      fail(`${label} produced a short first screen despite a sufficient pool`);
    }
    if (worstDistinctDomains < expectedDomains) {
      fail(`${label} repeated a domain before exhausting available domains`);
    }
    if (adjacentDomainRepeats !== 0) {
      fail(`${label} produced adjacent domain repeats`);
    }
    if (selectedTopics.length > 1 && topicImbalance > 1) {
      fail(`${label} topic imbalance exceeded one card`);
    }
    if (worstWindowDomainCount > fairDomainCap) {
      fail(`${label} exceeded the fairest achievable publication cap of ${fairDomainCap}`);
    }
  }

  const visibleRoundups = await db.getAllAsync(
    `SELECT title FROM articles
     WHERE is_archived = 0 AND word_count >= 250 AND topic_relevance >= ?`,
    [MIN_TOPIC_RELEVANCE]
  );
  const leakedRoundups = visibleRoundups.filter((row) =>
    isLowValueRoundup(row.title)
  );
  if (leakedRoundups.length > 0) {
    fail(`roundup cards leaked into recommendations: ${leakedRoundups.map((row) => row.title).join(", ")}`);
  }

  const suspiciousEconomics = await db.getAllAsync(
    `SELECT title FROM articles
     WHERE topic = 'economics' AND topic_relevance >= ?
       AND LOWER(title) GLOB '*mcp*'`,
    [MIN_TOPIC_RELEVANCE]
  );
  if (suspiciousEconomics.length > 0) {
    fail(`MCP leaked into economics: ${suspiciousEconomics.map((row) => row.title).join(", ")}`);
  }

  const muteTarget = await db.getFirstAsync(
    `SELECT author, author_key FROM articles
     WHERE word_count >= 250 AND topic_relevance >= ? AND author_key != ''
     GROUP BY author_key ORDER BY COUNT(*) DESC LIMIT 1`,
    [MIN_TOPIC_RELEVANCE]
  );
  if (muteTarget) {
    await kvSet("topics", JSON.stringify(["technology", "economics", "math"]));
    const mutedIds = new Set(await muteAuthor(muteTarget.author));
    for (let session = 0; session < 50; session++) {
      if ((await loadDeque()).some((id) => mutedIds.has(id))) {
        fail(`muted author ${muteTarget.author} returned to the deque`);
      }
    }
    await unmuteAuthor(muteTarget.author_key);
    console.log(`✓ mute gate passed for ${muteTarget.author}`);
  }

  const corrected = await db.getFirstAsync(
    `SELECT COUNT(*) AS c FROM articles AS a
     JOIN sources AS s ON s.id = a.source_id
     WHERE a.word_count >= 250 AND a.topic != s.topic`
  );
  console.log(`\n✓ all recommendation gates passed; ${corrected?.c ?? 0} off-topic feed items were reclassified`);
} finally {
  if (previousTopics == null) {
    await db.runAsync("DELETE FROM kv WHERE key = 'topics'");
  } else {
    await kvSet("topics", previousTopics);
  }
}
