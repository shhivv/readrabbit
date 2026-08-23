import { describe, expect, test } from "bun:test";
import {
  buildDiverseSlate,
  deferRecentlySeen,
  type RecommendationCandidate,
} from "../src/lib/recommend";

function candidate(
  id: number,
  domain: string,
  authorKey: string,
  topic: RecommendationCandidate["topic"] = "economics"
): RecommendationCandidate {
  return { id, domain, authorKey, topic };
}

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

  test("defers publications and authors from recent reading history", () => {
    const ranked = [
      candidate(1, "familiar.example", "familiar-writer"),
      candidate(2, "fresh-a.example", "fresh-a"),
      candidate(3, "fresh-b.example", "fresh-b"),
      candidate(4, "another.example", "familiar-writer"),
    ];
    const recent = [candidate(99, "familiar.example", "familiar-writer")];
    expect(deferRecentlySeen(ranked, recent).map((row) => row.id)).toEqual([
      2,
      3,
      1,
      4,
    ]);
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

  test("balances selected topics while each has candidates", () => {
    const rows = [
      ...Array.from({ length: 8 }, (_, index) =>
        candidate(index + 1, `econ-${index}.example`, `econ-${index}`, "economics")
      ),
      ...Array.from({ length: 8 }, (_, index) =>
        candidate(100 + index, `math-${index}.example`, `math-${index}`, "math")
      ),
    ];
    const slate = buildDiverseSlate(rows, 8, ["economics", "math"]);
    expect(slate.filter((row) => row.topic === "economics")).toHaveLength(4);
    expect(slate.filter((row) => row.topic === "math")).toHaveLength(4);
  });

  test("still fills a slate when the eligible pool is small", () => {
    const rows = Array.from({ length: 9 }, (_, index) =>
      candidate(index + 1, `site-${index % 2}.example`, `author-${index % 2}`)
    );
    expect(buildDiverseSlate(rows, 9, ["economics"])).toHaveLength(9);
  });
});
