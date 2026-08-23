import { describe, expect, test } from "bun:test";

// engine/discover import the local SQLite layer. The focused tests inject a
// metadata writer and never open the database, but module resolution still
// needs the same shim as the end-to-end harness.
Bun.plugin({
  name: "expo-sqlite-shim",
  setup(build) {
    build.module("expo-sqlite", () => ({
      exports: require("./expo-sqlite-shim.ts"),
      loader: "object",
    }));
  },
});

const {
  parseHnStories,
  selectRedditEconomicsStories,
  selectSmallWebStories,
} = await import(
  "../src/lib/crawler/discover"
);
const {
  ingestHnStories,
  ingestRedditEconomicsStories,
  ingestSmallWebStories,
  maxEntriesForSourceOrigin,
  requiresVerifiedPublicationDate,
  selectEnrichmentCandidates,
  siteNameForFeedEntry,
} = await import("../src/lib/crawler/engine");

describe("direct Hacker News article discovery", () => {
  test("keeps external story metadata without requiring an allowed feed domain", () => {
    const createdAt = 1_787_460_000;
    const stories = parseHnStories(
      {
        hits: [
          {
            url: "https://medium.com/@writer/an-essay#discussion",
            title: "  An essay HN readers recommended  ",
            created_at_i: createdAt,
          },
          {
            url: "https://news.ycombinator.com/item?id=123",
            title: "Ask HN: self post",
            created_at_i: createdAt,
          },
          {
            url: "https://writer.example/posts/two",
            title: "Second article",
            created_at: "2026-08-22T10:00:00Z",
          },
          {
            url: "https://writer.example/posts/two",
            title: "Duplicate URL",
            created_at_i: createdAt,
          },
        ],
      },
      12
    );

    expect(stories).toEqual([
      {
        url: "https://medium.com/@writer/an-essay",
        title: "An essay HN readers recommended",
        publishedAt: createdAt * 1000,
      },
      {
        url: "https://writer.example/posts/two",
        title: "Second article",
        publishedAt: Date.parse("2026-08-22T10:00:00Z"),
      },
    ]);
  });

  test("persists title/date/topic metadata for enrichment in the same crawl", async () => {
    const captured: unknown[] = [];
    const inserted = await ingestHnStories(
      [
        {
          url: "https://writer.example/posts/fresh",
          title: "A fresh systems essay",
          publishedAt: 1_787_460_000_000,
        },
        {
          url: "https://known.example/posts/existing",
          title: "Already present",
          publishedAt: null,
        },
      ],
      async (metadata) => {
        captured.push(metadata);
        return metadata.url.includes("known.example") ? null : 42;
      }
    );

    expect(inserted).toBe(1);
    expect(captured[0]).toMatchObject({
      sourceId: null,
      url: "https://writer.example/posts/fresh",
      title: "A fresh systems essay",
      author: "",
      siteName: "writer.example",
      publishedDate: 1_787_460_000_000,
      topic: "technology",
      score: 0.5,
    });
  });

  test("hard-caps direct ingestion even when called with an oversized batch", async () => {
    let writes = 0;
    const stories = Array.from({ length: 20 }, (_, index) => ({
      url: `https://publisher-${index}.example/story`,
      title: `Story ${index}`,
      publishedAt: null,
    }));

    const inserted = await ingestHnStories(stories, async () => {
      writes++;
      return writes;
    });

    expect(inserted).toBe(12);
    expect(writes).toBe(12);
  });
});

describe("bounded community breadth", () => {
  test("extracts Reddit economics destinations instead of discussion URLs", async () => {
    const publishedAt = Date.UTC(2026, 7, 22);
    const stories = selectRedditEconomicsStories([
      {
        url: "https://www.reddit.com/r/Economics/comments/abc/a_story/",
        title: "A story about housing supply",
        author: "/u/submitter-is-not-the-author",
        publishedAt,
        summaryHtml:
          '<a href="https://www.reddit.com/r/Economics/comments/abc/a_story/">comments</a>' +
          '<a href="https://writer.example/economics/housing">article</a>',
      },
    ]);
    expect(stories).toEqual([
      {
        url: "https://writer.example/economics/housing",
        title: "A story about housing supply",
        author: "",
        publishedAt,
        topic: "economics",
      },
    ]);

    const captured: unknown[] = [];
    await ingestRedditEconomicsStories(stories, async (metadata) => {
      captured.push(metadata);
      return 9;
    });
    expect(captured[0]).toMatchObject({
      url: "https://writer.example/economics/housing",
      author: "",
      publishedDate: publishedAt,
      topic: "economics",
    });
  });

  test("takes one Small Web article per publisher and keeps the selected-topic hint", () => {
    const stories = selectSmallWebStories(
      [
        {
          url: "https://first.example/posts/one",
          title: "A first essay",
          author: "First Writer",
          publishedAt: Date.now(),
          summaryHtml: "",
        },
        {
          url: "https://first.example/posts/two",
          title: "Same publisher again",
          author: "Second Writer",
          publishedAt: Date.now(),
          summaryHtml: "",
        },
        {
          url: "https://second.example/notes/result",
          title: "A mathematical result",
          author: "Second Writer",
          publishedAt: Date.now(),
          summaryHtml: "",
        },
      ],
      ["math"],
      30
    );

    expect(stories).toEqual([
      {
        url: "https://first.example/posts/one",
        title: "A first essay",
        author: "First Writer",
        publishedAt: null,
        topic: "math",
      },
      {
        url: "https://second.example/notes/result",
        title: "A mathematical result",
        author: "Second Writer",
        publishedAt: null,
        topic: "math",
      },
    ]);
  });

  test("persists Small Web bylines but leaves rediscovery dates to extraction", async () => {
    const captured: unknown[] = [];
    await ingestSmallWebStories(
      [
        {
          url: "https://small.example/posts/essay",
          title: "An independent essay",
          author: "Small Writer",
          publishedAt: 1,
          topic: "economics",
        },
      ],
      async (metadata) => {
        captured.push(metadata);
        return 7;
      }
    );

    expect(captured[0]).toMatchObject({
      sourceId: null,
      author: "Small Writer",
      siteName: "small.example",
      publishedDate: null,
      topic: "economics",
      score: 0.45,
    });
  });

  test("requires a real page date for undated direct Small Web discoveries", () => {
    expect(requiresVerifiedPublicationDate(null, null, null)).toBe(true);
    expect(requiresVerifiedPublicationDate(null, null, Date.now())).toBe(false);
    expect(requiresVerifiedPublicationDate(null, Date.now(), null)).toBe(false);
    expect(requiresVerifiedPublicationDate(4, null, null)).toBe(false);
  });

  test("allows more aggregator entries while retaining a hard cap", () => {
    expect(maxEntriesForSourceOrigin("seed")).toBe(12);
    expect(maxEntriesForSourceOrigin("outbound")).toBe(12);
    expect(maxEntriesForSourceOrigin("aggregator")).toBe(24);
  });

  test("uses the destination publisher identity for aggregator entries", () => {
    expect(
      siteNameForFeedEntry(
        "aggregator",
        "https://writer.example/posts/a-result",
        "Mathblogging.org",
        "Mathblogging.org"
      )
    ).toBe("writer.example");
    expect(
      siteNameForFeedEntry(
        "seed",
        "https://writer.example/posts/a-result",
        "Jane's Notes",
        "Jane Writer"
      )
    ).toBe("Jane's Notes");
  });

  test("round-robins enrichment by publisher, not aggregator source id", () => {
    const row = (id: number, domain: string) => ({
      id,
      source_id: 7,
      url: `https://${domain}/posts/${id}`,
      site_domain: domain,
    });
    const selected = selectEnrichmentCandidates(
      [
        row(1, "prolific.example"),
        row(2, "prolific.example"),
        row(3, "prolific.example"),
        row(4, "second.example"),
        row(5, "second.example"),
        row(6, "third.example"),
      ],
      5
    );

    expect(selected.map((candidate) => candidate.id)).toEqual([1, 4, 6, 2, 5]);
  });
});
