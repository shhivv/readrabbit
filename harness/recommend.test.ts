import { describe, expect, test } from "bun:test";
import {
  buildDiverseSlate,
  coolByPersistentExposure,
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
