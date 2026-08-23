import { describe, expect, test } from "bun:test";
import { buildDiverseSlate, type RecommendationCandidate } from "../src/lib/recommend";

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
