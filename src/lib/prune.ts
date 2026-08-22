import { getDb } from "./db";

// Storage budget: full article text is the only heavy payload we keep.
// - Read + unbookmarked posts lose their stored text after 30 days
//   (title/excerpt/url/flags stay forever — cheap rows).
// - Bookmarked posts are immortal.
// - Hard ceiling: if the database still exceeds ~120MB, drop the heaviest
//   pruned-candidate rows entirely, oldest first.

const TEXT_TTL_DAYS = 30;
const CEILING_BYTES = 120 * 1024 * 1024;
// Unenriched rows past this age can never be enriched again (the enrich
// query only considers recent discoveries), so they're pure dead weight.
const DEAD_META_AGE_DAYS = 45;

export async function pruneStorage(): Promise<void> {
  try {
    const db = await getDb();
    const cutoff = Date.now() - TEXT_TTL_DAYS * 24 * 60 * 60 * 1000;

    await db.runAsync(
      `UPDATE articles
       SET content_html = '', text_content = '', lead_image_url = ''
       WHERE is_bookmarked = 0
         AND is_read = 1
         AND content_html != ''
         AND COALESCE(read_at, fetched_at) < ?`,
      [cutoff]
    );

    // rows that never got full text and are now outside the enrich window:
    // feed entries for posts we skipped (too old at ingest) or pages that
    // kept failing transiently until they went stale
    const deadCutoff = Date.now() - DEAD_META_AGE_DAYS * 24 * 60 * 60 * 1000;
    await db.runAsync(
      `DELETE FROM articles
       WHERE is_bookmarked = 0 AND is_read = 0
         AND word_count <= 0
         AND fetched_at < ?`,
      [deadCutoff]
    );

    await enforceCeiling(db);
  } catch {
    // pruning must never take the app down
  }
}

async function enforceCeiling(db: Awaited<ReturnType<typeof getDb>>): Promise<void> {
  const sizeRow = await db.getFirstAsync<{
    pages: number;
    page_size: number;
  }>("PRAGMA page_count AS pages, PRAGMA page_size AS page_size");
  if (!sizeRow) return;
  const totalBytes = sizeRow.pages * sizeRow.page_size;
  if (totalBytes <= CEILING_BYTES) return;

  // Oldest fully-consumed posts first; bookmarks untouched.
  await db.runAsync(
    `DELETE FROM articles
     WHERE id IN (
       SELECT id FROM articles
       WHERE is_bookmarked = 0 AND is_read = 1
       ORDER BY COALESCE(read_at, fetched_at) ASC
       LIMIT 200
     )`
  );
}
