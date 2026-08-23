// Sequential diversity gate: unlike repeated snapshot sampling, this marks
// each displayed card as read so the shipping persistent-exposure path is
// exercised across a real multi-session-length journey.
//
//   bun harness/crawl.ts
//   bun harness/evaluate-journey.ts

// @ts-nocheck
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sourcePath = new URL("./.data/naturallycurious.db", import.meta.url).pathname;
if (!existsSync(sourcePath)) throw new Error("Run bun harness/crawl.ts first");

// Flush the harness WAL before taking a disposable snapshot.
const source = new Database(sourcePath);
source.exec("PRAGMA wal_checkpoint(TRUNCATE)");
source.close();

const tempDir = mkdtempSync(join(tmpdir(), "readrabbit-journey-"));
copyFileSync(sourcePath, join(tempDir, "naturallycurious.db"));
process.env.NC_HARNESS_DB_DIR = tempDir;

Bun.plugin({
  name: "expo-sqlite-journey-shim",
  setup(build) {
    build.module("expo-sqlite", () => ({
      exports: require("./expo-sqlite-shim.ts"),
      loader: "object",
    }));
  },
});

function fail(message: string): never {
  throw new Error(`JOURNEY GATE: ${message}`);
}

try {
  const { getDb, kvSet, markRead } = await import("../src/lib/db");
  const { loadDeque } = await import("../src/lib/deque");
  const db = await getDb();
  const scenarios = [
    ["economics"],
    ["math"],
    ["technology"],
    ["technology", "economics", "math"],
  ];

  console.log("═".repeat(76));
  console.log("SEQUENTIAL PERSON-DIVERSITY GATE");
  console.log("═".repeat(76));

  for (const topics of scenarios) {
    await db.runAsync("UPDATE articles SET is_read = 0, read_at = NULL");
    await db.runAsync("DELETE FROM identity_exposures");
    await kvSet("topics", JSON.stringify(topics));

    const placeholders = topics.map(() => "?").join(", ");
    const pool = await db.getFirstAsync(
      `SELECT COUNT(*) AS articles,
              COUNT(DISTINCT COALESCE(NULLIF(author_key, ''),
                                      'site:' || COALESCE(NULLIF(site_domain, ''), id))) AS voices,
              COUNT(DISTINCT COALESCE(NULLIF(site_domain, ''),
                                      'article:' || id)) AS domains
       FROM articles
       WHERE is_archived = 0 AND word_count >= 250
         AND topic_relevance >= 0.4
         AND topic IN (${placeholders})`,
      topics
    );
    const voiceAvailability = await db.getAllAsync(
      `SELECT COUNT(*) AS articles
       FROM articles
       WHERE is_archived = 0 AND word_count >= 250
         AND topic_relevance >= 0.4
         AND topic IN (${placeholders})
       GROUP BY COALESCE(NULLIF(author_key, ''),
                         'site:' || COALESCE(NULLIF(site_domain, ''), id))`,
      topics
    );
    const domainAvailability = await db.getAllAsync(
      `SELECT COUNT(*) AS articles
       FROM articles
       WHERE is_archived = 0 AND word_count >= 250
         AND topic_relevance >= 0.4
         AND topic IN (${placeholders})
       GROUP BY COALESCE(NULLIF(site_domain, ''), 'article:' || id)`,
      topics
    );
    const journeyLength = Math.min(60, pool.articles);
    const sequence = [];

    for (let index = 0; index < journeyLength; index++) {
      const [id] = await loadDeque();
      if (id == null) fail(`${topics.join("+")} ran dry at card ${index + 1}`);
      const row = await db.getFirstAsync(
        `SELECT id, title, author, author_key, site_name,
                COALESCE(NULLIF(site_domain, ''), 'article:' || id) AS domain
         FROM articles WHERE id = ?`,
        [id]
      );
      if (!row) fail(`missing selected article ${id}`);
      sequence.push({
        ...row,
        voice: row.author_key || `site:${row.domain}`,
      });
      await markRead(id);
    }

    const voiceCounts = new Map();
    const domainCounts = new Map();
    let firstVoiceRepeat = null;
    for (let index = 0; index < sequence.length; index++) {
      const row = sequence[index];
      const seenVoice = voiceCounts.get(row.voice) ?? 0;
      if (seenVoice > 0 && firstVoiceRepeat == null) firstVoiceRepeat = index + 1;
      voiceCounts.set(row.voice, seenVoice + 1);
      domainCounts.set(row.domain, (domainCounts.get(row.domain) ?? 0) + 1);
    }

    const uniqueVoices = voiceCounts.size;
    const uniqueDomains = domainCounts.size;
    const maxVoiceCount = Math.max(0, ...voiceCounts.values());
    const maxDomainCount = Math.max(0, ...domainCounts.values());
    const fairCap = (availability) => {
      let cap = 0;
      while (
        availability.reduce(
          (sum, identity) => sum + Math.min(identity.articles, cap),
          0
        ) < journeyLength
      ) {
        cap++;
      }
      return cap;
    };
    const fairVoiceCap = fairCap(voiceAvailability);
    const fairDomainCap = fairCap(domainAvailability);
    const expectedFirstRepeat = Math.min(journeyLength, pool.voices) + 1;
    const label = topics.join(" + ");

    console.log(`\n${label}`);
    console.log(
      `  ${journeyLength} cards · ${uniqueVoices} voices · ${uniqueDomains} domains`
    );
    console.log(
      `  first repeated voice ${firstVoiceRepeat ?? "none"} · max voice ${maxVoiceCount}/${fairVoiceCap} fair · max domain ${maxDomainCount}/${fairDomainCap} fair`
    );
    console.log(
      `  opening voices: ${sequence.slice(0, 12).map((row) => row.author || row.site_name).join(" · ")}`
    );
    console.log(
      `  most exposed: ${[...voiceCounts.entries()]
        .sort((left, right) => right[1] - left[1])
        .slice(0, 5)
        .map(([voice, count]) => `${voice}(${count})`)
        .join(" · ")}`
    );

    if (firstVoiceRepeat != null && firstVoiceRepeat < expectedFirstRepeat) {
      fail(
        `${label} repeated a person at ${firstVoiceRepeat} before exhausting ${pool.voices} available voices`
      );
    }
    if (maxVoiceCount > fairVoiceCap) {
      fail(
        `${label} exposed one voice ${maxVoiceCount} times; fair cap is ${fairVoiceCap}`
      );
    }
    if (maxDomainCount > fairDomainCap) {
      fail(
        `${label} exposed one publication ${maxDomainCount} times; fair cap is ${fairDomainCap}`
      );
    }
  }

  console.log("\n✓ sequential person-diversity gates passed");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
