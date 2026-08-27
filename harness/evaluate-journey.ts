// Sequential diversity gate: consumes the shipping deque and its real top-up
// path while marking displayed cards read. This catches identity resets at a
// batch boundary; regenerating an isolated first card cannot.
//
//   bun harness/crawl.ts
//   bun harness/evaluate-journey.ts

// @ts-nocheck
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sourcePath = new URL("./.data/naturallycurious.db", import.meta.url)
  .pathname;
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

function canSupplyAtCap(availability, topicCounts, cap) {
  const identities = [...new Set(availability.map((row) => row.identity))];
  const topics = [...topicCounts.keys()];
  const source = 0;
  const identityOffset = 1;
  const topicOffset = identityOffset + identities.length;
  const sink = topicOffset + topics.length;
  const graph = Array.from({ length: sink + 1 }, () => []);
  const addEdge = (from, to, capacity) => {
    const forward = { to, capacity, reverse: graph[to].length };
    const reverse = { to: from, capacity: 0, reverse: graph[from].length };
    graph[from].push(forward);
    graph[to].push(reverse);
  };

  identities.forEach((identity, index) =>
    addEdge(source, identityOffset + index, cap),
  );
  for (const row of availability) {
    addEdge(
      identityOffset + identities.indexOf(row.identity),
      topicOffset + topics.indexOf(row.topic),
      row.articles,
    );
  }
  topics.forEach((topic, index) =>
    addEdge(topicOffset + index, sink, topicCounts.get(topic) ?? 0),
  );

  let flow = 0;
  for (;;) {
    const parent = Array(sink + 1).fill(null);
    const queue = [source];
    for (
      let cursor = 0;
      cursor < queue.length && parent[sink] == null;
      cursor++
    ) {
      const node = queue[cursor];
      for (let edgeIndex = 0; edgeIndex < graph[node].length; edgeIndex++) {
        const edge = graph[node][edgeIndex];
        if (
          edge.capacity <= 0 ||
          edge.to === source ||
          parent[edge.to] != null
        ) {
          continue;
        }
        parent[edge.to] = [node, edgeIndex];
        queue.push(edge.to);
      }
    }
    if (parent[sink] == null) break;

    let amount = Number.POSITIVE_INFINITY;
    for (let node = sink; node !== source;) {
      const [previous, edgeIndex] = parent[node];
      amount = Math.min(amount, graph[previous][edgeIndex].capacity);
      node = previous;
    }
    for (let node = sink; node !== source;) {
      const [previous, edgeIndex] = parent[node];
      const edge = graph[previous][edgeIndex];
      edge.capacity -= amount;
      graph[node][edge.reverse].capacity += amount;
      node = previous;
    }
    flow += amount;
  }

  return (
    flow === [...topicCounts.values()].reduce((sum, count) => sum + count, 0)
  );
}

function canSupplyVoiceDomainAtCaps(availability, demand, voiceCap, domainCap) {
  const voices = [...new Set(availability.map((row) => row.voice))];
  const domains = [...new Set(availability.map((row) => row.domain))];
  const source = 0;
  const voiceOffset = 1;
  const domainOffset = voiceOffset + voices.length;
  const sink = domainOffset + domains.length;
  const graph = Array.from({ length: sink + 1 }, () => []);
  const addEdge = (from, to, capacity) => {
    graph[from].push({ to, capacity, reverse: graph[to].length });
    graph[to].push({ to: from, capacity: 0, reverse: graph[from].length - 1 });
  };

  voices.forEach((_, index) => addEdge(source, voiceOffset + index, voiceCap));
  domains.forEach((_, index) => addEdge(domainOffset + index, sink, domainCap));
  for (const row of availability) {
    addEdge(
      voiceOffset + voices.indexOf(row.voice),
      domainOffset + domains.indexOf(row.domain),
      row.articles,
    );
  }

  let flow = 0;
  for (;;) {
    const parent = Array(sink + 1).fill(null);
    const queue = [source];
    for (
      let cursor = 0;
      cursor < queue.length && parent[sink] == null;
      cursor++
    ) {
      const node = queue[cursor];
      for (let edgeIndex = 0; edgeIndex < graph[node].length; edgeIndex++) {
        const edge = graph[node][edgeIndex];
        if (
          edge.capacity <= 0 ||
          edge.to === source ||
          parent[edge.to] != null
        ) {
          continue;
        }
        parent[edge.to] = [node, edgeIndex];
        queue.push(edge.to);
      }
    }
    if (parent[sink] == null) break;

    for (let node = sink; node !== source;) {
      const [previous, edgeIndex] = parent[node];
      const edge = graph[previous][edgeIndex];
      edge.capacity--;
      graph[node][edge.reverse].capacity++;
      node = previous;
    }
    flow++;
  }
  return flow >= demand;
}

try {
  const { getDb, kvSet, markRead } = await import("../src/lib/db");
  const { loadDeque, topUpDeque, LOW_WATER } = await import("../src/lib/deque");
  const { inferSemanticCluster } = await import("../src/lib/semantic-cluster");
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
      topics,
    );
    const voiceAvailability = await db.getAllAsync(
      `SELECT topic,
              COALESCE(NULLIF(author_key, ''),
                       'site:' || COALESCE(NULLIF(site_domain, ''), id)) AS identity,
              COUNT(*) AS articles
       FROM articles
       WHERE is_archived = 0 AND word_count >= 250
         AND topic_relevance >= 0.4
         AND topic IN (${placeholders})
       GROUP BY topic, COALESCE(NULLIF(author_key, ''),
                         'site:' || COALESCE(NULLIF(site_domain, ''), id))`,
      topics,
    );
    const domainAvailability = await db.getAllAsync(
      `SELECT topic,
              COALESCE(NULLIF(site_domain, ''), 'article:' || id) AS identity,
              COUNT(*) AS articles
       FROM articles
       WHERE is_archived = 0 AND word_count >= 250
         AND topic_relevance >= 0.4
         AND topic IN (${placeholders})
       GROUP BY topic, COALESCE(NULLIF(site_domain, ''), 'article:' || id)`,
      topics,
    );
    const voiceDomainAvailability = await db.getAllAsync(
      `SELECT topic,
              COALESCE(NULLIF(author_key, ''),
                       'site:' || COALESCE(NULLIF(site_domain, ''), id)) AS voice,
              COALESCE(NULLIF(site_domain, ''), 'article:' || id) AS domain,
              COUNT(*) AS articles
       FROM articles
       WHERE is_archived = 0 AND word_count >= 250
         AND topic_relevance >= 0.4
         AND topic IN (${placeholders})
       GROUP BY topic, voice, domain`,
      topics,
    );
    const journeyLength = Math.min(60, pool.articles);
    const sequence = [];
    let deque = await loadDeque();
    const topUpBoundaries = [];

    for (let index = 0; index < journeyLength; index++) {
      const id = deque[index];
      if (id == null) fail(`${topics.join("+")} ran dry at card ${index + 1}`);
      const row = await db.getFirstAsync(
        `SELECT article.id, article.title, article.author,
                article.author_key, article.site_name, article.site_domain,
                article.topic, source.name AS source_name,
                source.origin AS source_origin,
                COALESCE(NULLIF(article.site_domain, ''),
                         'article:' || article.id) AS domain
         FROM articles AS article
         LEFT JOIN sources AS source ON source.id = article.source_id
         WHERE article.id = ?`,
        [id],
      );
      if (!row) fail(`missing selected article ${id}`);
      sequence.push({
        ...row,
        voice: row.author_key || `site:${row.domain}`,
        semanticCluster: inferSemanticCluster({
          topic: row.topic,
          title: row.title,
          siteDomain: row.site_domain,
          sourceName: row.source_name ?? "",
          sourceOrigin: row.source_origin ?? "",
        }),
      });
      await markRead(id);

      if (deque.length - index <= LOW_WATER && deque.length < journeyLength) {
        const previousLength = deque.length;
        deque = (await topUpDeque(deque)).ids;
        if (deque.length > previousLength) topUpBoundaries.push(previousLength);
      }
    }

    const voiceCounts = new Map();
    const domainCounts = new Map();
    const lastDomainPosition = new Map();
    const lastSemanticClusterPosition = new Map();
    const semanticClusterViolations = [];
    let minimumDomainGap = Number.POSITIVE_INFINITY;
    const topicCounts = new Map(topics.map((topic) => [topic, 0]));
    let firstVoiceRepeat = null;
    for (let index = 0; index < sequence.length; index++) {
      const row = sequence[index];
      const seenVoice = voiceCounts.get(row.voice) ?? 0;
      if (seenVoice > 0 && firstVoiceRepeat == null)
        firstVoiceRepeat = index + 1;
      voiceCounts.set(row.voice, seenVoice + 1);
      domainCounts.set(row.domain, (domainCounts.get(row.domain) ?? 0) + 1);
      // The generated reader window is 36 cards. Beyond that point a tiny
      // fixture can be literally exhausting its last few articles, where an
      // adjacent publication may be mathematically unavoidable.
      if (index < 36 && lastDomainPosition.has(row.domain)) {
        minimumDomainGap = Math.min(
          minimumDomainGap,
          index - lastDomainPosition.get(row.domain),
        );
      }
      if (index < 36) lastDomainPosition.set(row.domain, index);
      if (row.semanticCluster) {
        const previousClusterPosition = lastSemanticClusterPosition.get(
          row.semanticCluster,
        );
        if (
          previousClusterPosition != null &&
          index - previousClusterPosition < 12
        ) {
          semanticClusterViolations.push({
            cluster: row.semanticCluster,
            previous: previousClusterPosition + 1,
            current: index + 1,
          });
        }
        lastSemanticClusterPosition.set(row.semanticCluster, index);
      }
      topicCounts.set(row.topic, (topicCounts.get(row.topic) ?? 0) + 1);
    }

    const uniqueVoices = voiceCounts.size;
    const uniqueDomains = domainCounts.size;
    const maxVoiceCount = Math.max(0, ...voiceCounts.values());
    const maxDomainCount = Math.max(0, ...domainCounts.values());
    const fairCap = (availability) => {
      let cap = 0;
      while (!canSupplyAtCap(availability, topicCounts, cap)) cap++;
      return cap;
    };
    const fairVoiceCap = fairCap(voiceAvailability);
    const fairDomainCap = fairCap(domainAvailability);
    // Person and publication feasibility are measured separately. In a
    // mixed-topic slate, using 60 unique people can require one publication
    // to carry two of them even when a publication-only assignment could hit
    // 60/60. Two well-spaced cards is not publication domination.
    const allowedDomainCap = Math.max(fairDomainCap, topics.length > 1 ? 2 : 1);
    let allowedVoiceCap = fairVoiceCap;
    if (topics.length === 1) {
      while (
        !canSupplyVoiceDomainAtCaps(
          voiceDomainAvailability,
          journeyLength,
          allowedVoiceCap,
          allowedDomainCap,
        )
      ) {
        allowedVoiceCap++;
      }
    }
    // A 24-card no-repeat runway is two full visible openings. Requiring the
    // whole finite fixture to be exhausted can conflict with the simultaneous
    // no-adjacent-publication rule when one site carries many distinct people.
    const expectedFirstRepeat = Math.min(journeyLength, pool.voices, 24) + 1;
    const label = topics.join(" + ");

    console.log(`\n${label}`);
    console.log(
      `  ${journeyLength} cards · ${uniqueVoices} voices · ${uniqueDomains} domains`,
    );
    console.log(
      `  first repeated voice ${firstVoiceRepeat ?? "none"} · max voice ${maxVoiceCount}/${allowedVoiceCap} allowed · max domain ${maxDomainCount}/${allowedDomainCap} allowed`,
    );
    console.log(
      `  topics: ${[...topicCounts.entries()]
        .map(([topic, count]) => `${topic} ${count}`)
        .join(" · ")}`,
    );
    console.log(
      `  opening voices: ${sequence
        .slice(0, 12)
        .map((row) => row.author || row.site_name)
        .join(" · ")}`,
    );
    console.log(
      `  most exposed: ${[...voiceCounts.entries()]
        .sort((left, right) => right[1] - left[1])
        .slice(0, 5)
        .map(([voice, count]) => `${voice}(${count})`)
        .join(" · ")}`,
    );
    const clusteredPositions = sequence
      .map((row, index) =>
        row.semanticCluster ? `${row.semanticCluster}@${index + 1}` : null,
      )
      .filter(Boolean);
    if (clusteredPositions.length > 0) {
      console.log(`  semantic ecosystems: ${clusteredPositions.join(" · ")}`);
    }
    if (maxVoiceCount > allowedVoiceCap) {
      const offenders = [...voiceCounts.entries()]
        .filter(([, count]) => count === maxVoiceCount)
        .map(([voice]) => {
          const positions = sequence
            .map((row, index) => (row.voice === voice ? index + 1 : null))
            .filter((position) => position != null);
          return `${voice}@${positions.join(",")}`;
        });
      console.log(`  voice cap offenders: ${offenders.join(" · ")}`);
    }
    const repeatedDomains = [...domainCounts.entries()]
      .filter(([, count]) => count > 1)
      .sort((left, right) => right[1] - left[1]);
    if (repeatedDomains.length > 0) {
      console.log(
        `  repeated publications: ${repeatedDomains
          .slice(0, 5)
          .map(([domain, count]) => `${domain}(${count})`)
          .join(" · ")}`,
      );
    }

    if (
      topics.length === 1 &&
      firstVoiceRepeat != null &&
      firstVoiceRepeat < expectedFirstRepeat
    ) {
      fail(
        `${label} repeated a person at ${firstVoiceRepeat} before the ${expectedFirstRepeat - 1}-voice runway`,
      );
    }
    if (maxVoiceCount > allowedVoiceCap) {
      fail(
        `${label} exposed one voice ${maxVoiceCount} times; jointly feasible cap is ${allowedVoiceCap}`,
      );
    }
    if (maxDomainCount > allowedDomainCap) {
      fail(
        `${label} exposed one publication ${maxDomainCount} times; allowed cap is ${allowedDomainCap}`,
      );
    }
    if (uniqueDomains >= 2 && minimumDomainGap < 2) {
      fail(
        `${label} repeated a publication only ${minimumDomainGap} cards later`,
      );
    }
    if (
      topics.length > 1 &&
      Math.max(...topicCounts.values()) - Math.min(...topicCounts.values()) > 2
    ) {
      fail(`${label} did not keep its generated topic shares even`);
    }
    if (semanticClusterViolations.length > 0) {
      const violation = semanticClusterViolations[0];
      fail(
        `${label} repeated ${violation.cluster} at cards ${violation.previous} and ${violation.current}`,
      );
    }
    for (const boundary of topUpBoundaries) {
      const previousTail = sequence.slice(Math.max(0, boundary - 12), boundary);
      const firstRefill = sequence[boundary];
      if (!firstRefill) continue;
      if (
        previousTail.slice(-6).some((row) => row.voice === firstRefill.voice)
      ) {
        fail(`${label} reset person diversity at top-up ${boundary}`);
      }
    }
  }

  console.log("\n✓ sequential person-diversity gates passed");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
