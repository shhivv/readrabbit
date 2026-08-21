# Naturally Curious

A fully local, on-device blog discovery + reading app. No server, no accounts —
you pick your interests, the phone itself crawls high-signal personal blogs,
extracts clean reader-mode text (with LaTeX, markdown and code blocks), and
serves an endless deque of worthwhile posts. Discovery branches outward: HN for
technology, outbound-link mining from everything you already read. Mainstream
media is filtered out by design.

## Architecture

```
src/
  app/            expo-router screens (onboarding → reader)
  lib/
    db.ts         expo-sqlite: sources / articles / interests / kv (+migrations)
    deque.ts      weighted-sampling feed ordering (quality × recency × U(0,1))
    prune.ts      storage budget: 30d text TTL, bookmark immortality, size ceiling
    crawler/
      fetcher.ts  timeouts, UA, ≤3 concurrent, per-host politeness delays
      feeds.ts    RSS/Atom/RDF parsing + feed autodiscovery
      extract.ts  Readability-over-linkedom + CETD-style heuristic fallback
      math.ts     KaTeX pre-rendering at enrichment time ($…$, $$…$$, MathJax tags)
      quality.ts  shallow-feature quality scoring (Kohlschütter; Potthast clickbait)
      classify.ts mainstream-media blocklist + article-path heuristics
      discover.ts HN Algolia channel + outbound-link candidate pool + feed probes
      engine.ts   bounded crawl bursts, adaptive per-source polling, locking
    background.ts expo-background-task registration (6h minimum interval)
```

### Design decisions grounded in literature

- **Adaptive polling** — each source's next-check is an EMA of its observed
  update rhythm (Urbansky et al., ICWSM 2011; Olston & Pandey, TODS 2006):
  ~60% fewer fetches at equal freshness vs fixed intervals.
- **Tight transfer bursts** — cellular tail energy dominates (~60% of transfer
  cost), so crawl work happens in back-to-back batches with a bounded budget
  per run (Balasubramanian et al., MobiSys 2009 — TailEnder).
- **Extraction** — Readability first (F1 ≈ 0.93 on articles per the WCXB
  benchmark), with a text-density heuristic fallback using Kohlschütter's
  shallow features (stopword ratio, link density, caps ratio).
- **Quality scoring** — cheap on-device features from boilerplate-detection
  and clickbait-detection work (Potthast et al. 2016) rank the deque.
- **LaTeX** — rendered to HTML at *enrichment* time via `katex.renderToString`
  (pure tree-building, no DOM), so reading costs nothing extra offline.

## Develop

```sh
bun install
bun start        # expo dev server
```

Always use `bun` instead of npm/npx.

Typecheck: `bunx tsc --noEmit`

## Status

v0.1 — onboarding, crawling, reader, discovery all local. Not yet
device-tested in TestFlight; background-task behavior needs a physical device
(iOS simulator never fires BGTaskScheduler).
