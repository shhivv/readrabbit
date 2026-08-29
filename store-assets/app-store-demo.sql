BEGIN;

UPDATE articles SET is_archived = 1;
UPDATE sources SET status = 'paused';
DELETE FROM identity_exposures;
DELETE FROM interests;

INSERT INTO articles (
  source_id,
  url,
  title,
  author,
  author_key,
  site_name,
  site_domain,
  published_date,
  excerpt,
  content_html,
  text_content,
  lead_image_url,
  word_count,
  topic,
  topic_relevance,
  fetched_at,
  is_read,
  is_archived,
  is_bookmarked,
  read_at,
  score,
  quality
) VALUES (
  NULL,
  'https://example.invalid/readrabbit-preview',
  'The Shape of a Useful Question',
  'Mara Vale',
  'mara vale',
  'The Quiet Index',
  'example.invalid',
  CAST(strftime('%s', 'now') AS INTEGER) * 1000,
  'The best questions do not close a subject. They give it somewhere to go.',
  '<p>A useful question changes the shape of the room. It makes familiar facts look unfinished and gives everyone permission to notice what they had been stepping around.</p><p>Good questions are often smaller than grand answers. They begin with a detail: a pattern that repeats, an assumption no one remembers choosing, or a result that feels slightly too neat.</p><h2>Leave room for surprise</h2><p>The point is not to sound clever. It is to create enough space for an honest answer. A question earns its keep when it reveals a new path, even if that path leads away from the idea that started it.</p><p>Curiosity is less like collecting conclusions and more like learning where to place the next doorway.</p>',
  'A useful question changes the shape of the room. It makes familiar facts look unfinished and gives everyone permission to notice what they had been stepping around. Good questions are often smaller than grand answers. They begin with a detail: a pattern that repeats, an assumption no one remembers choosing, or a result that feels slightly too neat. Leave room for surprise. The point is not to sound clever. It is to create enough space for an honest answer. A question earns its keep when it reveals a new path, even if that path leads away from the idea that started it. Curiosity is less like collecting conclusions and more like learning where to place the next doorway.',
  '',
  780,
  'math',
  0.98,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000,
  0,
  0,
  0,
  NULL,
  0.95,
  0.95
)
ON CONFLICT(url) DO UPDATE SET
  title = excluded.title,
  author = excluded.author,
  author_key = excluded.author_key,
  site_name = excluded.site_name,
  site_domain = excluded.site_domain,
  published_date = excluded.published_date,
  excerpt = excluded.excerpt,
  content_html = excluded.content_html,
  text_content = excluded.text_content,
  lead_image_url = excluded.lead_image_url,
  word_count = excluded.word_count,
  topic = excluded.topic,
  topic_relevance = excluded.topic_relevance,
  fetched_at = excluded.fetched_at,
  is_read = 0,
  is_archived = 0,
  is_bookmarked = 0,
  read_at = NULL,
  score = excluded.score,
  quality = excluded.quality;

INSERT INTO kv (key, value) VALUES ('onboarded', '1')
ON CONFLICT(key) DO UPDATE SET value = excluded.value;

INSERT INTO kv (key, value) VALUES ('topics', '["math"]')
ON CONFLICT(key) DO UPDATE SET value = excluded.value;

INSERT INTO kv (key, value) VALUES ('diverse_opening_ready_v1', '1')
ON CONFLICT(key) DO UPDATE SET value = excluded.value;

INSERT INTO kv (key, value) VALUES (
  'last_crawl_at',
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
)
ON CONFLICT(key) DO UPDATE SET value = excluded.value;

COMMIT;
