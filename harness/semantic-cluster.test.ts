import { describe, expect, test } from "bun:test";
import { inferSemanticCluster } from "../src/lib/semantic-cluster";

describe("semantic recommendation clusters", () => {
  test("recognizes Planet Python destinations as one ecosystem", () => {
    expect(
      inferSemanticCluster({
        topic: "technology",
        title: "A community post with a generic headline",
        siteDomain: "writer.example",
        sourceName: "Planet Python",
        sourceOrigin: "aggregator",
      }),
    ).toBe("technology:python");
  });

  test("recognizes Python ecosystem titles outside the aggregator", () => {
    expect(
      inferSemanticCluster({
        topic: "technology",
        title: "What I learned migrating a service to Python 3",
        siteDomain: "independent.example",
      }),
    ).toBe("technology:python");
    expect(
      inferSemanticCluster({
        topic: "technology",
        title: "A practical Django deployment guide",
        siteDomain: "independent.example",
      }),
    ).toBe("technology:python");
  });

  test("does not cluster incidental or non-technology material", () => {
    expect(
      inferSemanticCluster({
        topic: "technology",
        title: "Concurrent servers in Rust",
        siteDomain: "independent.example",
      }),
    ).toBe("");
    expect(
      inferSemanticCluster({
        topic: "economics",
        title: "Python imports and the labor market",
        siteDomain: "independent.example",
      }),
    ).toBe("");
  });
});
