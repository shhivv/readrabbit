# publisher

Daily seed-pack crawler for Naturally Curious. Runs on a VPS with
[bun](https://bun.sh), crawls the seed catalog (same engine as the app),
selects a fresh quality-ranked deck, and pushes it to Cloudflare R2 as a
static JSON file the app fetches when its local pool is empty.

## Setup

```sh
cd publisher
bun install        # aws4fetch only
```

Create an R2 bucket + API token (Object Read & Write), then set env vars —
inline, in your shell profile, or `publisher/.env`:

```
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET=naturally-curious
R2_PREFIX=nc            # optional
```

Expose the bucket publicly (R2 → public r2.dev domain or a Worker) and put
the URL into the app: `src/lib/starter.ts` → `STARTER_PACK_URL`.

## Daily run

```sh
bun run all    # crawl + select + upload
```

Cron (once or twice a day):

```
0 6 * * * cd /srv/nc/publisher && /usr/local/bin/bun run all >> publisher.log 2>&1
```

## Output

- `<prefix>/starter.json` — latest pack (~30 articles, ≤2 per author,
  topic-balanced, published within the last 45 days)
- `<prefix>/packs/YYYY-MM-DD.json` — dated history

The app dedupes pack URLs against its own crawl results and re-sanitizes
all pack HTML through the same allow-list, so the pack is a convenience,
never a trust boundary.
