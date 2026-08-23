import { describe, expect, test } from "bun:test";

// discover.ts imports the local SQLite layer even for its pure link helper.
// Register the same shim as the end-to-end harness before loading it.
Bun.plugin({
  name: "expo-sqlite-shim",
  setup(build) {
    build.module("expo-sqlite", () => ({
      exports: require("./expo-sqlite-shim.ts"),
      loader: "object",
    }));
  },
});

const { collectOutboundLinks } = await import("../src/lib/crawler/discover");
const { parseFeed, parseSyndicationDocument } = await import(
  "../src/lib/crawler/feeds"
);

describe("feed identity", () => {
  test("keeps a plain RSS author element", () => {
    const parsed = parseFeed(`
      <rss version="2.0"><channel><title>Example</title>
        <item>
          <title>An article</title>
          <link>https://writer.example/posts/one</link>
          <author>Jane Writer</author>
          <pubDate>Sun, 23 Aug 2026 01:00:00 GMT</pubDate>
        </item>
      </channel></rss>
    `);

    expect(parsed?.entries[0]?.author).toBe("Jane Writer");
  });

  test("deduplicates Medium tag-feed tracking URLs", () => {
    const parsed = parseFeed(`
      <rss version="2.0"><channel><title>Medium</title>
        <item>
          <title>An article</title>
          <link>https://medium.com/@writer/an-article-abc123?source=rss------economics-5</link>
          <dc:creator>Jane Writer</dc:creator>
        </item>
      </channel></rss>
    `);

    expect(parsed?.entries[0]?.url).toBe(
      "https://medium.com/@writer/an-article-abc123"
    );
  });
});

describe("known community aggregators", () => {
  test("parses canonical economics links, human bylines, and UTC dates", () => {
    const parsed = parseSyndicationDocument(
      `<html><body><ul>
        <LI><B><A HREF="https://writer.example/2026/08/growth?utm_source=ea">Growth &amp; wages</A></B><BR>
        by noreply@blogger.com (Jane Economist) in <I><A HREF="/blogs/jane.html">Jane's blog</A></I>,
        2026-08-20 13:00:00 UTC
        <blockquote>A summary citing <a href="https://citation.example/paper">a paper</a>.</blockquote>
        <LI><B><A HREF="https://other.example/p/inflation">Inflation notes</A></B><BR>
        by ? in <I><A HREF="/blogs/other.html">Other blog</A></I>,
        2026-08-19 09:30:00 UTC<blockquote>Another summary.</blockquote>
      </ul></body></html>`,
      "https://www.econacademics.org/en.html"
    );

    expect(parsed?.title).toBe("EconAcademics");
    expect(parsed?.entries).toHaveLength(2);
    expect(parsed?.entries[0]).toMatchObject({
      url: "https://writer.example/2026/08/growth",
      title: "Growth & wages",
      author: "Jane Economist",
      publishedAt: Date.parse("2026-08-20T13:00:00Z"),
    });
    expect(parsed?.entries[1]?.author).toBe("");
    expect(parsed?.entries.some((entry) =>
      entry.url.includes("citation.example")
    )).toBe(false);
  });

  test("does not reinterpret arbitrary HTML as a feed", () => {
    expect(
      parseSyndicationDocument(
        '<li><b><a href="https://example.com/post">Post</a></b></li>',
        "https://untrusted.example/index.html"
      )
    ).toBeNull();
  });
});

describe("topic-preserving discovery", () => {
  const html = '<a href="https://independent.example/posts/new-result">read</a>';

  test("carries economics and math hints from the source", () => {
    expect(
      collectOutboundLinks(html, "https://seed.example/post", {
        topicHint: "economics",
      })[0]?.topicHint
    ).toBe("economics");
    expect(
      collectOutboundLinks(html, "https://seed.example/post", {
        topicHint: "math",
      })[0]?.topicHint
    ).toBe("math");
  });

  test("retains technology as the backward-compatible unhinted default", () => {
    expect(
      collectOutboundLinks(html, "https://seed.example/post")[0]?.topicHint
    ).toBe("technology");
  });
});
