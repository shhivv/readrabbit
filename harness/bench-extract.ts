// Micro-bench: extraction memory/time per real article page.
//   bun harness/bench-extract.ts
// @ts-nocheck
Bun.plugin({
  name: "expo-sqlite-shim",
  setup(build) {
    build.module("expo-sqlite", () => ({
      exports: require("./expo-sqlite-shim.ts"),
      loader: "object",
    }));
  },
});

const { extractFromHtml } = await import("../src/lib/crawler/extract");
const { fetchText } = await import("../src/lib/crawler/fetcher");

const URLS = [
  "https://gwern.net/scale",
  "https://paulgraham.com/greatwork.html",
  "https://blog.samaltman.com/the-gentle-singularity",
  "https://www.aaronfrancis.com/2024/so-you-want-to-build-your-own-database-a6d0c06e5cad",
  "https://without.boats/blog/pollsters/",
];

console.log("baseline rss:", (process.memoryUsage.rss() / 1048576).toFixed(0), "MB");

for (const url of URLS) {
  try {
    const res = await fetchText(url, { timeoutMs: 15000 });
    if (!res.ok || !res.text) {
      console.log(`✗ ${url} — fetch ${res.status}`);
      continue;
    }
    const kb = (res.text.length / 1024).toFixed(0);
    const before = process.memoryUsage.rss();
    const t0 = Date.now();
    const out = extractFromHtml(res.text, url);
    const ms = Date.now() - t0;
    const delta = ((process.memoryUsage.rss() - before) / 1048576).toFixed(0);
    console.log(
      `${out ? "✓" : "✗"} ${kb} KB in, ${ms} ms, +${delta} MB rss → words=${out?.wordCount ?? 0}  ${url}`
    );
  } catch (err) {
    console.log(`✗ ${url} — ${err.message}`);
  }
}
