import { describe, expect, test } from "bun:test";
import catalog from "../assets/seed-sources.json";

describe("starting source catalog", () => {
  test("has broad, unique starting points for every topic", () => {
    const feedUrls = catalog.map((source) => source.feedUrl);
    expect(new Set(feedUrls).size).toBe(feedUrls.length);
    expect(feedUrls).not.toContain("https://planetpython.org/rss20.xml");

    const minimums = { technology: 35, economics: 25, math: 22 };
    for (const [topic, minimum] of Object.entries(minimums)) {
      const sources = catalog.filter((source) => source.topic === topic);
      expect(sources.length).toBeGreaterThanOrEqual(minimum);
      expect(new Set(sources.map((source) => new URL(source.siteUrl).host)).size)
        .toBeGreaterThanOrEqual(minimum);
    }
  });
});
