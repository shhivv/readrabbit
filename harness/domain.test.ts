import { describe, expect, test } from "bun:test";
import { rootDomain } from "../src/lib/crawler/classify";

describe("publication domain identity", () => {
  test("keeps independent hosted publications distinct", () => {
    expect(rootDomain("terrytao.wordpress.com")).toBe("terrytao.wordpress.com");
    expect(rootDomain("gowers.wordpress.com")).toBe("gowers.wordpress.com");
    expect(rootDomain("matklad.github.io")).toBe("matklad.github.io");
  });

  test("still groups ordinary subdomains by registrable domain", () => {
    expect(rootDomain("blog.example.com")).toBe("example.com");
    expect(rootDomain("news.example.co.uk")).toBe("example.co.uk");
  });
});
