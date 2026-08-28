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

  test("recognizes Rust ecosystem", () => {
    expect(
      inferSemanticCluster({
        topic: "technology",
        title: "Concurrent servers in Rust",
        siteDomain: "independent.example",
      }),
    ).toBe("technology:rust");
    expect(
      inferSemanticCluster({
        topic: "technology",
        title: "Understanding the borrow checker",
        siteDomain: "independent.example",
      }),
    ).toBe("technology:rust");
  });

  test("recognizes JavaScript/TypeScript ecosystem", () => {
    expect(
      inferSemanticCluster({
        topic: "technology",
        title: "Building a React app with Next.js",
        siteDomain: "independent.example",
      }),
    ).toBe("technology:javascript");
    expect(
      inferSemanticCluster({
        topic: "technology",
        title: "TypeScript generics explained",
        siteDomain: "independent.example",
      }),
    ).toBe("technology:javascript");
  });

  test("recognizes AI/ML ecosystem", () => {
    expect(
      inferSemanticCluster({
        topic: "technology",
        title: "Fine-tuning a language model for code",
        siteDomain: "independent.example",
      }),
    ).toBe("technology:ai-ml");
    expect(
      inferSemanticCluster({
        topic: "technology",
        title: "Understanding transformer attention mechanisms",
        siteDomain: "independent.example",
      }),
    ).toBe("technology:ai-ml");
  });

  test("recognizes systems/low-level ecosystem", () => {
    expect(
      inferSemanticCluster({
        topic: "technology",
        title: "Writing a Linux kernel module",
        siteDomain: "independent.example",
      }),
    ).toBe("technology:systems");
    expect(
      inferSemanticCluster({
        topic: "technology",
        title: "Understanding io_uring for async I/O",
        siteDomain: "independent.example",
      }),
    ).toBe("technology:systems");
  });

  test("recognizes Go ecosystem", () => {
    expect(
      inferSemanticCluster({
        topic: "technology",
        title: "Goroutine patterns for concurrent processing",
        siteDomain: "independent.example",
      }),
    ).toBe("technology:go");
  });

  test("recognizes security ecosystem", () => {
    expect(
      inferSemanticCluster({
        topic: "technology",
        title: "Analyzing a zero-day exploit in the wild",
        siteDomain: "independent.example",
      }),
    ).toBe("technology:security");
  });

  test("recognizes database ecosystem", () => {
    expect(
      inferSemanticCluster({
        topic: "technology",
        title: "PostgreSQL query optimizer internals",
        siteDomain: "independent.example",
      }),
    ).toBe("technology:databases");
  });

  test("recognizes functional programming ecosystem", () => {
    expect(
      inferSemanticCluster({
        topic: "technology",
        title: "Monads in Haskell for beginners",
        siteDomain: "independent.example",
      }),
    ).toBe("technology:functional");
  });

  test("does not cluster generic or non-technology material", () => {
    expect(
      inferSemanticCluster({
        topic: "technology",
        title: "How to run a better engineering team",
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
