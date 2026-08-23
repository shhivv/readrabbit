import { describe, expect, test } from "bun:test";
import { isLowValueRoundup } from "../src/lib/crawler/editorial";

describe("reader-card editorial filter", () => {
  test("rejects recurring fragment and link-dump series", () => {
    for (const title of [
      "Fragments: August 18",
      "Some Links",
      "Friday links: databases and compilers",
      "Reading List 08/22/26",
      "Roundup #86: Unintended consequences",
      "Weekly roundup: applied mathematics",
    ]) {
      expect(isLowValueRoundup(title)).toBe(true);
    }
  });

  test("keeps substantive essays whose titles happen to mention links", () => {
    for (const title of [
      "The Link Between Inflation and Expectations",
      "Fragments of a Forgotten Proof",
      "How Hyperlinks Changed the Web",
      "Reading Lists as a Data Structure",
    ]) {
      expect(isLowValueRoundup(title)).toBe(false);
    }
  });
});
