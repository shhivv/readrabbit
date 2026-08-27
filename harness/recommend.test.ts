import { describe, expect, test } from "bun:test";
import {
  buildDiverseSlate,
  coolByPersistentExposure,
  hasDiverseOpening,
  persistentExposureCost,
  type PersistentExposureCandidate,
} from "../src/lib/recommend";

function candidate(
  id: number,
  domain: string,
  authorKey: string,
  topic: PersistentExposureCandidate["topic"] = "economics",
  exposure: Partial<
    Pick<
      PersistentExposureCandidate,
      | "authorExposureCount"
      | "authorLastExposedAt"
      | "domainExposureCount"
      | "domainLastExposedAt"
    >
  > = {}
): PersistentExposureCandidate {
  return {
    id,
    domain,
    authorKey,
    topic,
    authorExposureCount: exposure.authorExposureCount ?? 0,
    authorLastExposedAt: exposure.authorLastExposedAt ?? null,
    domainExposureCount: exposure.domainExposureCount ?? 0,
    domainLastExposedAt: exposure.domainLastExposedAt ?? null,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

describe("recommendation slate diversity", () => {
  test("uses twelve different domains on the first screen when available", () => {
    const prolific = Array.from({ length: 20 }, (_, index) =>
      candidate(index + 1, "same.example", `same-${index}`)
    );
    const longTail = Array.from({ length: 12 }, (_, index) =>
      candidate(100 + index, `site-${index}.example`, `writer-${index}`)
    );

    const slate = buildDiverseSlate([...prolific, ...longTail], 12, ["economics"]);
    expect(new Set(slate.map((row) => row.domain)).size).toBe(12);
  });

  test("recognizes the same author across different publications", () => {
    const rows = Array.from({ length: 12 }, (_, index) =>
      candidate(index + 1, `site-${index}.example`, index < 4 ? "same-author" : `author-${index}`)
    );
    const slate = buildDiverseSlate(rows, 8, ["economics"]);
    expect(slate.filter((row) => row.authorKey === "same-author")).toHaveLength(1);
  });

  test("spaces one ecosystem across otherwise diverse publications", () => {
    const python = Array.from({ length: 18 }, (_, index) => ({
      ...candidate(
        index + 1,
        `python-${index}.example`,
        `python-author-${index}`,
        "technology",
      ),
      semanticCluster: "technology:python",
    }));
    const otherTechnology = Array.from({ length: 40 }, (_, index) =>
      candidate(
        100 + index,
        `other-${index}.example`,
        `other-author-${index}`,
        "technology",
      ),
    );

    const slate = buildDiverseSlate(
      [...python, ...otherTechnology],
      36,
      ["technology"],
    );
    for (let start = 0; start <= slate.length - 12; start++) {
      expect(
        slate
          .slice(start, start + 12)
          .filter((row) => row.semanticCluster === "technology:python"),
      ).toHaveLength(1);
    }
  });

  test("keeps semantic spacing soft when no alternative supply exists", () => {
    const pythonOnly = Array.from({ length: 12 }, (_, index) => ({
      ...candidate(
        index + 1,
        `python-${index}.example`,
        `python-author-${index}`,
        "technology",
      ),
      semanticCluster: "technology:python",
    }));

    expect(
      buildDiverseSlate(pythonOnly, 12, ["technology"]),
    ).toHaveLength(12);
  });

  test("keeps ecosystem spacing continuous across a refill boundary", () => {
    const prior = Array.from({ length: 36 }, (_, index) => ({
      ...candidate(
        500 + index,
        `prior-${index}.example`,
        `prior-author-${index}`,
        "technology",
      ),
      semanticCluster:
        index === 0 || index === 12 || index === 24
          ? "technology:python"
          : "",
    }));
    const candidates = [
      ...Array.from({ length: 12 }, (_, index) => ({
        ...candidate(
          index + 1,
          `python-${index}.example`,
          `python-author-${index}`,
          "technology",
        ),
        semanticCluster: "technology:python",
      })),
      ...Array.from({ length: 40 }, (_, index) =>
        candidate(
          100 + index,
          `other-${index}.example`,
          `other-author-${index}`,
          "technology",
        ),
      ),
    ];

    const refill = buildDiverseSlate(
      candidates,
      36,
      ["technology"],
      prior,
    );
    const stream = [...prior, ...refill];
    for (let start = 24; start <= stream.length - 12; start++) {
      expect(
        stream
          .slice(start, start + 12)
          .filter((row) => row.semanticCluster === "technology:python"),
      ).toHaveLength(1);
    }
  });

  test("limits a prolific publication to two cards when the pool supports it", () => {
    const rows = Array.from({ length: 20 }, (_, domain) =>
      Array.from({ length: 3 }, (_, article) =>
        candidate(
          domain * 10 + article,
          `site-${domain}.example`,
          `writer-${domain}-${article}`
        )
      )
    ).flat();
    const slate = buildDiverseSlate(rows, 36, ["economics"]);
    const counts = new Map<string, number>();
    for (const row of slate) {
      counts.set(row.domain, (counts.get(row.domain) ?? 0) + 1);
    }
    expect(Math.max(...counts.values())).toBe(2);
  });

  test("fairly distributes the fallback when every domain exceeds soft caps", () => {
    const rows = Array.from({ length: 5 }, (_, domain) =>
      Array.from({ length: 10 }, (_, article) =>
        candidate(
          domain * 100 + article,
          `site-${domain}.example`,
          `writer-${domain}-${article}`
        )
      )
    ).flat();
    const slate = buildDiverseSlate(rows, 25, ["economics"]);
    const counts = new Map<string, number>();
    for (const row of slate) {
      counts.set(row.domain, (counts.get(row.domain) ?? 0) + 1);
    }
    expect([...counts.values()].sort()).toEqual([5, 5, 5, 5, 5]);
  });

  test("balances the generated batch without forcing topic alternation", () => {
    const rows = [
      ...Array.from({ length: 8 }, (_, index) =>
        candidate(
          index + 1,
          `econ-${index}.example`,
          `econ-${index}`,
          "economics"
        )
      ),
      ...Array.from({ length: 8 }, (_, index) =>
        candidate(100 + index, `math-${index}.example`, `math-${index}`, "math")
      ),
    ];
    const slate = buildDiverseSlate(rows, 8, ["economics", "math"]);
    expect(slate.filter((row) => row.topic === "economics")).toHaveLength(4);
    expect(slate.filter((row) => row.topic === "math")).toHaveLength(4);
    // Quality may create a short run, but the stream never drifts far enough
    // to feel like one selected topic disappeared.
    expect(slate.slice(0, 2).map((row) => row.topic)).toEqual([
      "economics",
      "economics",
    ]);
    for (let end = 1; end <= slate.length; end++) {
      const economics = slate
        .slice(0, end)
        .filter((row) => row.topic === "economics").length;
      const math = end - economics;
      expect(Math.abs(economics - math)).toBeLessThanOrEqual(2);
    }
  });

  test("splits a three-topic generation equally", () => {
    const rows = [
      ...Array.from({ length: 4 }, (_, index) =>
        candidate(
          index + 1,
          `tech-${index}.example`,
          `tech-${index}`,
          "technology"
        )
      ),
      ...Array.from({ length: 4 }, (_, index) =>
        candidate(
          100 + index,
          `econ-${index}.example`,
          `econ-${index}`,
          "economics"
        )
      ),
      ...Array.from({ length: 4 }, (_, index) =>
        candidate(200 + index, `math-${index}.example`, `math-${index}`, "math")
      ),
    ];
    const slate = buildDiverseSlate(rows, 12, [
      "technology",
      "economics",
      "math",
    ]);

    expect(slate.filter((row) => row.topic === "technology")).toHaveLength(4);
    expect(slate.filter((row) => row.topic === "economics")).toHaveLength(4);
    expect(slate.filter((row) => row.topic === "math")).toHaveLength(4);
  });

  test("keeps the topic split exact while reserving a flexible domain", () => {
    const rows = [
      candidate(1, "shared.example", "tech-writer", "technology"),
      candidate(2, "unique.example", "other-tech-writer", "technology"),
      candidate(3, "shared.example", "econ-writer", "economics"),
    ];
    const slate = buildDiverseSlate(rows, 2, ["technology", "economics"]);

    expect(slate.map((row) => row.id)).toEqual([2, 3]);
  });

  test("reserves a cross-topic voice for the topic with less exclusive supply", () => {
    const rows = [
      candidate(1, "shared-tech.example", "shared-writer", "technology"),
      candidate(2, "exclusive-tech.example", "tech-writer", "technology"),
      candidate(3, "shared-econ.example", "shared-writer", "economics"),
    ];
    const slate = buildDiverseSlate(rows, 2, ["technology", "economics"]);

    expect(slate.map((row) => row.id)).toEqual([2, 3]);
    expect(new Set(slate.map((row) => row.authorKey)).size).toBe(2);
  });

  test("fills from available topics after a scarce topic runs out", () => {
    const rows = [
      ...Array.from({ length: 5 }, (_, index) =>
        candidate(
          index + 1,
          `tech-${index}.example`,
          `tech-${index}`,
          "technology"
        )
      ),
      candidate(100, "econ.example", "econ", "economics"),
    ];
    const slate = buildDiverseSlate(rows, 6, ["technology", "economics"]);

    expect(slate).toHaveLength(6);
    expect(slate.filter((row) => row.topic === "technology")).toHaveLength(5);
    expect(slate.filter((row) => row.topic === "economics")).toHaveLength(1);
  });

  test("does not reset author or publication spacing at a batch boundary", () => {
    const prior = [
      candidate(900, "recent-one.example", "recent-one"),
      candidate(901, "recent-two.example", "recent-two"),
    ];
    const rows = [
      candidate(1, "recent-two.example", "different-person"),
      candidate(2, "different.example", "recent-one"),
      ...Array.from({ length: 4 }, (_, index) =>
        candidate(
          100 + index,
          `fresh-${index}.example`,
          `fresh-${index}`
        )
      ),
    ];

    const slate = buildDiverseSlate(rows, 4, ["economics"], prior);
    expect(slate.map((row) => row.id)).toEqual([100, 101, 102, 103]);
  });

  test("waits for a varied, topic-balanced first-run opening", () => {
    const balanced = [
      ...Array.from({ length: 6 }, (_, index) =>
        candidate(
          index + 1,
          `tech-${index}.example`,
          `tech-${index}`,
          "technology"
        )
      ),
      ...Array.from({ length: 6 }, (_, index) =>
        candidate(
          100 + index,
          `econ-${index}.example`,
          `econ-${index}`,
          "economics"
        )
      ),
    ];

    expect(
      hasDiverseOpening(balanced, ["technology", "economics"])
    ).toBe(true);
    expect(
      hasDiverseOpening(
        balanced.map((row, index) =>
          index === 11
            ? { ...row, domain: balanced[0].domain }
            : row
        ),
        ["technology", "economics"]
      )
    ).toBe(false);
    expect(
      hasDiverseOpening(
        balanced.map((row, index) => ({
          ...row,
          topic: index < 8 ? "technology" : "economics",
        })),
        ["technology", "economics"]
      )
    ).toBe(false);
  });

  test("keeps topic shares close without forcing strict alternation", () => {
    const rows = [
      ...Array.from({ length: 12 }, (_, index) =>
        candidate(
          index + 1,
          `tech-${index}.example`,
          `tech-${index}`,
          "technology"
        )
      ),
      ...Array.from({ length: 12 }, (_, index) =>
        candidate(
          100 + index,
          `econ-${index}.example`,
          `econ-${index}`,
          "economics"
        )
      ),
      ...Array.from({ length: 12 }, (_, index) =>
        candidate(
          200 + index,
          `math-${index}.example`,
          `math-${index}`,
          "math"
        )
      ),
    ];

    const slate = buildDiverseSlate(rows, 18, [
      "technology",
      "economics",
      "math",
    ]);
    expect(slate.slice(0, 2).map((row) => row.topic)).toEqual([
      "technology",
      "technology",
    ]);
    expect(
      slate.reduce<Record<string, number>>((counts, row) => {
        counts[row.topic] = (counts[row.topic] ?? 0) + 1;
        return counts;
      }, {})
    ).toEqual({ technology: 6, economics: 6, math: 6 });

    for (let end = 1; end <= slate.length; end++) {
      const counts = ["technology", "economics", "math"].map(
        (topic) => slate.slice(0, end).filter((row) => row.topic === topic).length
      );
      expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(2);
    }
  });

  test("still fills a slate when the eligible pool is small", () => {
    const rows = Array.from({ length: 9 }, (_, index) =>
      candidate(index + 1, `site-${index % 2}.example`, `author-${index % 2}`)
    );
    expect(buildDiverseSlate(rows, 9, ["economics"])).toHaveLength(9);
  });
});

describe("persistent exposure cooling", () => {
  test("treats a no-byline publication as a full-strength voice", () => {
    const now = Date.UTC(2026, 7, 23);
    const anonymousPublication = candidate(
      1,
      "anonymous.example",
      "",
      "economics",
      {
        domainExposureCount: 1,
        domainLastExposedAt: now - DAY_MS,
      }
    );
    const namedWriter = candidate(
      2,
      "named.example",
      "named-writer",
      "economics",
      {
        authorExposureCount: 1,
        authorLastExposedAt: now - DAY_MS,
      }
    );

    expect(persistentExposureCost(anonymousPublication, now)).toBeCloseTo(
      persistentExposureCost(namedWriter, now)
    );
  });

  test("follows a person across publications more strongly than a publication", () => {
    const now = Date.UTC(2026, 7, 23);
    const familiarPerson = candidate(
      1,
      "new-publication.example",
      "familiar-person",
      "economics",
      {
        authorExposureCount: 1,
        authorLastExposedAt: now - DAY_MS,
      }
    );
    const familiarPublication = candidate(
      2,
      "familiar-publication.example",
      "new-person",
      "economics",
      {
        domainExposureCount: 4,
        domainLastExposedAt: now - DAY_MS,
      }
    );

    expect(persistentExposureCost(familiarPerson, now)).toBeGreaterThan(
      persistentExposureCost(familiarPublication, now)
    );
    expect(
      coolByPersistentExposure(
        [familiarPerson, familiarPublication, candidate(3, "unseen.example", "unseen")],
        now
      ).map((row) => row.id)
    ).toEqual([3, 2, 1]);
  });

  test("defers a historically dominant voice beyond the previous 12-card window", () => {
    const now = Date.UTC(2026, 7, 23);
    const dominant = Array.from({ length: 20 }, (_, index) =>
      candidate(
        index + 1,
        `publication-${index}.example`,
        "dominant-person",
        "economics",
        {
          authorExposureCount: 8,
          authorLastExposedAt: now - 60 * DAY_MS,
        }
      )
    );
    const unseen = Array.from({ length: 15 }, (_, index) =>
      candidate(100 + index, `unseen-${index}.example`, `unseen-${index}`)
    );

    const cooled = coolByPersistentExposure([...dominant, ...unseen], now);
    expect(cooled.slice(0, unseen.length).map((row) => row.id)).toEqual(
      unseen.map((row) => row.id)
    );
  });

  test("keeps every candidate as a graceful fallback when all supply is familiar", () => {
    const now = Date.UTC(2026, 7, 23);
    const familiar = Array.from({ length: 12 }, (_, index) =>
      candidate(
        index + 1,
        `site-${index % 3}.example`,
        `author-${index % 4}`,
        "economics",
        {
          authorExposureCount: 12 - index,
          authorLastExposedAt: now - (index + 1) * DAY_MS,
          domainExposureCount: 4,
          domainLastExposedAt: now - (index + 1) * DAY_MS,
        }
      )
    );

    const cooled = coolByPersistentExposure(familiar, now);
    expect(cooled).toHaveLength(familiar.length);
    expect(new Set(cooled.map((row) => row.id)).size).toBe(familiar.length);
    expect(cooled[0].id).toBe(12);
  });
});
