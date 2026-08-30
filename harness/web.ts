// Web interface for visualizing the recommendation algorithm.
// Connects to the same crawled SQLite database the test harness uses,
// runs the real loadDeque pipeline, and serves an interactive UI.
//
//   NC_KEEP_DB=1 bun harness/web.ts
//
// Then open http://localhost:3456

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

const { getDb, kvGet, kvSet, TOPICS } = await import("../src/lib/db");
const { loadDeque } = await import("../src/lib/deque");
const { MIN_TOPIC_RELEVANCE } = await import("../src/lib/crawler/topic");
const { getArticleAttribution } = await import("../src/lib/attribution");
const { inferSemanticCluster } = await import("../src/lib/semantic-cluster");
const {
  persistentExposureCost,
  buildDiverseSlate,
  coolByPersistentExposure,
} = await import("../src/lib/recommend");

const db = await getDb();
const PORT = Number(process.env.PORT ?? 3456);

async function getSelectedTopics(): Promise<string[]> {
  try {
    const raw = await kvGet("topics");
    if (raw != null) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return TOPICS.filter((t) => parsed.includes(t));
    }
  } catch {}
  return [...TOPICS];
}

async function generateSlate(topics: string[]) {
  const previousTopics = await kvGet("topics");
  await kvSet("topics", JSON.stringify(topics));

  try {
    const ids = await loadDeque();
    if (ids.length === 0) return [];

    const rows = await db.getAllAsync(
      `SELECT a.id, a.title, a.topic, a.topic_relevance, a.site_domain,
              a.site_name, a.author, a.author_key, a.excerpt, a.word_count,
              a.quality, a.score, a.lead_image_url, a.url,
              a.published_date, a.fetched_at,
              s.name AS source_name, s.origin AS source_origin,
              s.feed_url AS source_feed_url, s.score AS source_score,
              COALESCE(author_exp.exposure_count, 0) AS author_exposure_count,
              author_exp.last_exposed_at AS author_last_exposed_at,
              COALESCE(domain_exp.exposure_count, 0) AS domain_exposure_count,
              domain_exp.last_exposed_at AS domain_last_exposed_at
       FROM articles AS a
       LEFT JOIN sources AS s ON s.id = a.source_id
       LEFT JOIN identity_exposures AS author_exp
         ON author_exp.identity_kind = 'author'
        AND author_exp.identity_key = a.author_key
       LEFT JOIN identity_exposures AS domain_exp
         ON domain_exp.identity_kind = 'domain'
        AND domain_exp.identity_key = COALESCE(NULLIF(a.site_domain, ''),
              CASE WHEN a.source_id IS NOT NULL THEN 'source:' || a.source_id
                   ELSE 'article:' || a.id END)
       WHERE a.id IN (${ids.map(() => "?").join(", ")})`,
      ids,
    );

    const byId = new Map(rows.map((row: any) => [row.id, row]));
    return ids.map((id, position) => {
      const row = byId.get(id);
      if (!row) return null;
      const attribution = getArticleAttribution(row);
      const cluster = inferSemanticCluster({
        topic: row.topic,
        title: row.title,
        siteDomain: row.site_domain,
        sourceName: row.source_name ?? "",
        sourceOrigin: row.source_origin ?? "",
      });
      const domain = row.site_domain || row.site_name;
      const exposureCost = persistentExposureCost({
        id: row.id,
        topic: row.topic,
        authorKey: row.author_key,
        domain,
        authorExposureCount: row.author_exposure_count,
        authorLastExposedAt: row.author_last_exposed_at,
        domainExposureCount: row.domain_exposure_count,
        domainLastExposedAt: row.domain_last_exposed_at,
      });

      return {
        position,
        id: row.id,
        title: row.title,
        url: row.url,
        topic: row.topic,
        topicRelevance: row.topic_relevance,
        domain,
        siteName: row.site_name,
        author: row.author,
        authorKey: row.author_key,
        attribution,
        excerpt: row.excerpt,
        wordCount: row.word_count,
        quality: row.quality,
        articleScore: row.score,
        leadImageUrl: row.lead_image_url,
        publishedDate: row.published_date,
        fetchedAt: row.fetched_at,
        source: {
          name: row.source_name,
          origin: row.source_origin,
          feedUrl: row.source_feed_url,
          score: row.source_score,
        },
        semanticCluster: cluster || null,
        exposure: {
          authorCount: row.author_exposure_count,
          authorLastAt: row.author_last_exposed_at,
          domainCount: row.domain_exposure_count,
          domainLastAt: row.domain_last_exposed_at,
          cost: exposureCost,
        },
      };
    }).filter(Boolean);
  } finally {
    if (previousTopics == null) {
      await db.runAsync("DELETE FROM kv WHERE key = 'topics'");
    } else {
      await kvSet("topics", previousTopics);
    }
  }
}

async function getPoolStats(topics: string[]) {
  const placeholders = topics.map(() => "?").join(", ");
  const pool = await db.getFirstAsync(
    `SELECT COUNT(*) AS articles,
            COUNT(DISTINCT COALESCE(NULLIF(site_domain, ''), site_name)) AS domains,
            COUNT(DISTINCT CASE WHEN author_key != '' THEN author_key END) AS authors
     FROM articles
     WHERE is_archived = 0 AND is_read = 0 AND word_count >= 250
       AND topic_relevance >= ? AND topic IN (${placeholders})`,
    [MIN_TOPIC_RELEVANCE, ...topics],
  );

  const byTopic = await db.getAllAsync(
    `SELECT topic, COUNT(*) AS articles,
            COUNT(DISTINCT COALESCE(NULLIF(site_domain, ''), site_name)) AS domains,
            COUNT(DISTINCT CASE WHEN author_key != '' THEN author_key END) AS authors
     FROM articles
     WHERE is_archived = 0 AND is_read = 0 AND word_count >= 250
       AND topic_relevance >= ? AND topic IN (${placeholders})
     GROUP BY topic`,
    [MIN_TOPIC_RELEVANCE, ...topics],
  );

  const topDomains = await db.getAllAsync(
    `SELECT COALESCE(NULLIF(site_domain, ''), site_name) AS domain,
            topic, COUNT(*) AS articles
     FROM articles
     WHERE is_archived = 0 AND is_read = 0 AND word_count >= 250
       AND topic_relevance >= ? AND topic IN (${placeholders})
     GROUP BY domain, topic
     ORDER BY articles DESC
     LIMIT 30`,
    [MIN_TOPIC_RELEVANCE, ...topics],
  );

  const sourceOrigins = await db.getAllAsync(
    `SELECT s.origin, COUNT(DISTINCT s.id) AS sources, COUNT(a.id) AS articles
     FROM sources AS s
     JOIN articles AS a ON a.source_id = s.id
     WHERE a.is_archived = 0 AND a.is_read = 0 AND a.word_count >= 250
       AND a.topic_relevance >= ? AND a.topic IN (${placeholders})
     GROUP BY s.origin
     ORDER BY articles DESC`,
    [MIN_TOPIC_RELEVANCE, ...topics],
  );

  return { pool, byTopic, topDomains, sourceOrigins };
}

async function getSourcesList(topics: string[]) {
  const placeholders = topics.map(() => "?").join(", ");
  return db.getAllAsync(
    `SELECT s.id, s.name, s.site_url, s.feed_url, s.topic, s.origin,
            s.status, s.score, s.avg_update_hours,
            COUNT(a.id) AS article_count,
            COUNT(CASE WHEN a.is_read = 0 AND a.is_archived = 0
                       AND a.word_count >= 250 AND a.topic_relevance >= ?
                       THEN 1 END) AS eligible_count
     FROM sources AS s
     LEFT JOIN articles AS a ON a.source_id = s.id
     WHERE s.topic IN (${placeholders})
     GROUP BY s.id
     ORDER BY eligible_count DESC, s.score DESC`,
    [MIN_TOPIC_RELEVANCE, ...topics],
  );
}

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ReadRabbit Algorithm Inspector</title>
<style>
  :root {
    --bg: #0d1117;
    --surface: #161b22;
    --surface2: #1c2129;
    --border: #30363d;
    --text: #e6edf3;
    --text2: #8b949e;
    --accent: #58a6ff;
    --green: #3fb950;
    --orange: #d29922;
    --red: #f85149;
    --purple: #bc8cff;
    --pink: #f778ba;
    --tech: #58a6ff;
    --econ: #3fb950;
    --math: #d29922;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.5;
  }

  .header {
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    padding: 16px 24px;
    display: flex;
    align-items: center;
    gap: 16px;
    flex-wrap: wrap;
    position: sticky;
    top: 0;
    z-index: 100;
  }
  .header h1 { font-size: 18px; font-weight: 600; white-space: nowrap; }
  .header h1 span { color: var(--text2); font-weight: 400; }

  .controls {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  .topic-btn {
    padding: 6px 14px;
    border-radius: 20px;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text2);
    cursor: pointer;
    font-size: 13px;
    transition: all 0.15s;
  }
  .topic-btn.active { border-color: currentColor; color: var(--text); font-weight: 600; }
  .topic-btn[data-topic="technology"].active { color: var(--tech); background: rgba(88,166,255,0.1); }
  .topic-btn[data-topic="economics"].active { color: var(--econ); background: rgba(63,185,80,0.1); }
  .topic-btn[data-topic="math"].active { color: var(--math); background: rgba(210,153,34,0.1); }
  .topic-btn:hover { border-color: var(--text2); }

  .action-btn {
    padding: 6px 16px;
    border-radius: 6px;
    border: 1px solid var(--accent);
    background: rgba(88,166,255,0.1);
    color: var(--accent);
    cursor: pointer;
    font-size: 13px;
    font-weight: 600;
  }
  .action-btn:hover { background: rgba(88,166,255,0.2); }
  .action-btn:disabled { opacity: 0.5; cursor: wait; }

  .tabs {
    display: flex;
    gap: 0;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
    padding: 0 24px;
  }
  .tab {
    padding: 10px 20px;
    border: none;
    background: none;
    color: var(--text2);
    cursor: pointer;
    font-size: 14px;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
  }
  .tab.active { color: var(--text); border-bottom-color: var(--accent); font-weight: 600; }
  .tab:hover { color: var(--text); }

  .main { padding: 20px 24px; max-width: 1400px; }

  .stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 12px;
    margin-bottom: 20px;
  }
  .stat-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 14px 16px;
  }
  .stat-card .label { font-size: 12px; color: var(--text2); text-transform: uppercase; letter-spacing: 0.5px; }
  .stat-card .value { font-size: 24px; font-weight: 700; margin-top: 2px; }

  .slate-list { display: flex; flex-direction: column; gap: 2px; }

  .article-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 14px 18px;
    display: grid;
    grid-template-columns: 36px 1fr auto;
    gap: 14px;
    align-items: start;
    transition: border-color 0.15s;
  }
  .article-card:hover { border-color: var(--text2); }

  .card-position {
    font-size: 13px;
    font-weight: 700;
    color: var(--text2);
    width: 36px;
    height: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--surface2);
    border-radius: 8px;
    flex-shrink: 0;
  }

  .card-body { min-width: 0; }
  .card-title {
    font-size: 15px;
    font-weight: 600;
    margin-bottom: 4px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .card-title a { color: inherit; text-decoration: none; }
  .card-title a:hover { color: var(--accent); }
  .card-meta {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
    font-size: 12px;
    color: var(--text2);
  }
  .card-meta .sep { color: var(--border); }

  .badge {
    display: inline-block;
    padding: 1px 8px;
    border-radius: 10px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.3px;
  }
  .badge-tech { color: var(--tech); background: rgba(88,166,255,0.12); }
  .badge-econ { color: var(--econ); background: rgba(63,185,80,0.12); }
  .badge-math { color: var(--math); background: rgba(210,153,34,0.12); }
  .badge-cluster { color: var(--purple); background: rgba(188,140,255,0.12); }
  .badge-origin { color: var(--pink); background: rgba(247,120,186,0.12); }

  .card-signals {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 4px;
    font-size: 11px;
    color: var(--text2);
    white-space: nowrap;
    min-width: 140px;
  }
  .signal-row { display: flex; gap: 6px; align-items: center; }
  .signal-bar {
    width: 60px;
    height: 5px;
    background: var(--surface2);
    border-radius: 3px;
    overflow: hidden;
  }
  .signal-fill {
    height: 100%;
    border-radius: 3px;
    transition: width 0.3s;
  }

  .sources-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }
  .sources-table th {
    text-align: left;
    padding: 10px 12px;
    border-bottom: 2px solid var(--border);
    color: var(--text2);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .sources-table td {
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    vertical-align: top;
  }
  .sources-table tr:hover td { background: var(--surface2); }

  .domain-chart {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 8px;
  }
  .domain-bar-row {
    display: grid;
    grid-template-columns: 180px 1fr 40px;
    gap: 8px;
    align-items: center;
    font-size: 12px;
  }
  .domain-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text2);
  }
  .domain-bar {
    height: 18px;
    border-radius: 3px;
    transition: width 0.3s;
  }
  .domain-count { color: var(--text2); text-align: right; }

  .section-title {
    font-size: 14px;
    font-weight: 600;
    margin: 20px 0 10px;
    color: var(--text2);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .diversity-strip {
    display: flex;
    gap: 2px;
    margin-bottom: 16px;
    flex-wrap: wrap;
  }
  .diversity-cell {
    width: 28px;
    height: 28px;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 9px;
    font-weight: 700;
    color: rgba(255,255,255,0.8);
    cursor: default;
    position: relative;
  }
  .diversity-cell[title]:hover::after {
    content: attr(title);
    position: absolute;
    bottom: 100%;
    left: 50%;
    transform: translateX(-50%);
    background: var(--surface);
    border: 1px solid var(--border);
    padding: 4px 8px;
    border-radius: 4px;
    font-size: 11px;
    white-space: nowrap;
    color: var(--text);
    z-index: 10;
    pointer-events: none;
  }

  .loading {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 60px;
    color: var(--text2);
    font-size: 14px;
  }
  .spin { animation: spin 1s linear infinite; display: inline-block; margin-right: 8px; }
  @keyframes spin { to { transform: rotate(360deg); } }

  .screen-marker {
    grid-column: 1 / -1;
    font-size: 11px;
    color: var(--text2);
    padding: 6px 0;
    border-top: 1px dashed var(--border);
    text-transform: uppercase;
    letter-spacing: 1px;
  }

  .hidden { display: none; }
</style>
</head>
<body>
<div class="header">
  <h1>ReadRabbit <span>Algorithm Inspector</span></h1>
  <div class="controls">
    <button class="topic-btn active" data-topic="technology">Technology</button>
    <button class="topic-btn active" data-topic="economics">Economics</button>
    <button class="topic-btn active" data-topic="math">Math</button>
    <button class="action-btn" id="regenerate">Regenerate</button>
  </div>
</div>

<div class="tabs">
  <button class="tab active" data-tab="slate">Feed Slate</button>
  <button class="tab" data-tab="sources">Sources</button>
  <button class="tab" data-tab="analysis">Analysis</button>
</div>

<div class="main">
  <div id="slate-tab">
    <div class="loading" id="loading"><span class="spin">&#8635;</span> Generating slate...</div>
    <div id="slate-content" class="hidden"></div>
  </div>
  <div id="sources-tab" class="hidden"></div>
  <div id="analysis-tab" class="hidden"></div>
</div>

<script>
let currentSlate = [];
let currentStats = {};
let currentSources = [];

const topicBtns = document.querySelectorAll('.topic-btn');
const regenBtn = document.getElementById('regenerate');
const tabs = document.querySelectorAll('.tab');

function getTopics() {
  return [...topicBtns].filter(b => b.classList.contains('active')).map(b => b.dataset.topic);
}

topicBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    btn.classList.toggle('active');
    if (getTopics().length === 0) btn.classList.add('active');
  });
});

tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    tabs.forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    document.querySelectorAll('.main > div').forEach(d => d.classList.add('hidden'));
    document.getElementById(tab.dataset.tab + '-tab').classList.remove('hidden');
  });
});

regenBtn.addEventListener('click', loadSlate);

async function loadSlate() {
  const topics = getTopics();
  regenBtn.disabled = true;
  document.getElementById('loading').classList.remove('hidden');
  document.getElementById('slate-content').classList.add('hidden');

  try {
    const [slateRes, statsRes, sourcesRes] = await Promise.all([
      fetch('/api/slate?topics=' + topics.join(',')),
      fetch('/api/stats?topics=' + topics.join(',')),
      fetch('/api/sources?topics=' + topics.join(',')),
    ]);
    currentSlate = await slateRes.json();
    currentStats = await statsRes.json();
    currentSources = await sourcesRes.json();
    renderSlate();
    renderSources();
    renderAnalysis();
  } catch (err) {
    document.getElementById('slate-content').innerHTML =
      '<div class="loading" style="color:var(--red)">Error: ' + err.message + '</div>';
    document.getElementById('slate-content').classList.remove('hidden');
  } finally {
    regenBtn.disabled = false;
    document.getElementById('loading').classList.add('hidden');
  }
}

function topicClass(topic) {
  return topic === 'technology' ? 'badge-tech' : topic === 'economics' ? 'badge-econ' : 'badge-math';
}
function topicColor(topic) {
  return topic === 'technology' ? 'var(--tech)' : topic === 'economics' ? 'var(--econ)' : 'var(--math)';
}

function renderSlate() {
  const el = document.getElementById('slate-content');
  if (!currentSlate.length) {
    el.innerHTML = '<div class="loading">No articles in pool for selected topics.</div>';
    el.classList.remove('hidden');
    return;
  }

  const pool = currentStats.pool || {};
  const byTopic = currentStats.byTopic || [];

  let statsHtml = '<div class="stats-grid">';
  statsHtml += '<div class="stat-card"><div class="label">Slate Size</div><div class="value">' + currentSlate.length + '</div></div>';
  statsHtml += '<div class="stat-card"><div class="label">Pool Articles</div><div class="value">' + (pool.articles || 0) + '</div></div>';
  statsHtml += '<div class="stat-card"><div class="label">Pool Domains</div><div class="value">' + (pool.domains || 0) + '</div></div>';
  statsHtml += '<div class="stat-card"><div class="label">Pool Authors</div><div class="value">' + (pool.authors || 0) + '</div></div>';
  statsHtml += '</div>';

  // Diversity strip
  statsHtml += '<div class="section-title">Topic &amp; Domain Diversity Strip</div>';
  statsHtml += '<div class="diversity-strip">';
  const seenDomains = new Map();
  let domainIdx = 0;
  const domainHues = {};
  currentSlate.forEach((a, i) => {
    if (!domainHues[a.domain]) {
      domainHues[a.domain] = (domainIdx * 37) % 360;
      domainIdx++;
    }
    const hue = domainHues[a.domain];
    const bg = 'hsl(' + hue + ', 55%, 30%)';
    const topicLetter = a.topic[0].toUpperCase();
    statsHtml += '<div class="diversity-cell" style="background:' + bg + '" title="#' + (i+1) + ' ' + a.domain + ' [' + a.topic + ']">' + topicLetter + '</div>';
  });
  statsHtml += '</div>';

  statsHtml += '<div class="slate-list">';
  const SCREEN_SIZE = 12;
  currentSlate.forEach((article, i) => {
    if (i > 0 && i % SCREEN_SIZE === 0) {
      statsHtml += '<div class="screen-marker">Screen ' + (Math.floor(i / SCREEN_SIZE) + 1) + '</div>';
    }

    const qPct = Math.min(100, Math.round(article.quality * 100));
    const rPct = Math.min(100, Math.round(article.topicRelevance * 100));
    const ePct = Math.min(100, Math.round(Math.min(article.exposure.cost, 200) / 2));
    const age = article.publishedDate ? Math.max(0, (Date.now() - article.publishedDate) / 86400000).toFixed(1) + 'd' : '?';

    statsHtml += '<div class="article-card">';
    statsHtml += '<div class="card-position">' + (i + 1) + '</div>';
    statsHtml += '<div class="card-body">';
    statsHtml += '<div class="card-title"><a href="' + (article.url || '#') + '" target="_blank">' + esc(article.title) + '</a></div>';
    statsHtml += '<div class="card-meta">';
    statsHtml += '<span class="badge ' + topicClass(article.topic) + '">' + article.topic + '</span>';
    if (article.semanticCluster) {
      statsHtml += '<span class="badge badge-cluster">' + article.semanticCluster.split(':')[1] + '</span>';
    }
    statsHtml += '<span>' + esc(article.attribution.primary) + '</span>';
    if (article.attribution.secondary) {
      statsHtml += '<span class="sep">/</span><span>' + esc(article.attribution.secondary) + '</span>';
    }
    statsHtml += '<span class="sep">|</span><span>' + esc(article.domain) + '</span>';
    if (article.source.origin) {
      statsHtml += '<span class="badge badge-origin">' + article.source.origin + '</span>';
    }
    statsHtml += '<span class="sep">|</span><span>' + article.wordCount + ' words</span>';
    statsHtml += '<span class="sep">|</span><span>' + age + ' ago</span>';
    statsHtml += '</div></div>';

    statsHtml += '<div class="card-signals">';
    statsHtml += signalBar('quality', qPct, 'var(--green)');
    statsHtml += signalBar('relevance', rPct, 'var(--accent)');
    statsHtml += signalBar('exposure', ePct, ePct > 30 ? 'var(--orange)' : 'var(--text2)');
    if (article.exposure.authorCount > 0) {
      statsHtml += '<div class="signal-row"><span>author seen ' + article.exposure.authorCount + 'x</span></div>';
    }
    if (article.exposure.domainCount > 0) {
      statsHtml += '<div class="signal-row"><span>domain seen ' + article.exposure.domainCount + 'x</span></div>';
    }
    statsHtml += '</div>';
    statsHtml += '</div>';
  });
  statsHtml += '</div>';
  el.innerHTML = statsHtml;
  el.classList.remove('hidden');
}

function signalBar(label, pct, color) {
  return '<div class="signal-row"><span>' + label + ' ' + pct + '%</span>'
    + '<div class="signal-bar"><div class="signal-fill" style="width:' + pct + '%;background:' + color + '"></div></div></div>';
}

function renderSources() {
  const el = document.getElementById('sources-tab');
  if (!currentSources.length) {
    el.innerHTML = '<div class="loading">No sources found.</div>';
    return;
  }

  const origins = currentStats.sourceOrigins || [];
  let html = '<div class="stats-grid">';
  origins.forEach(o => {
    html += '<div class="stat-card"><div class="label">' + esc(o.origin) + ' sources</div><div class="value">' + o.sources + '</div><div style="font-size:12px;color:var(--text2)">' + o.articles + ' eligible articles</div></div>';
  });
  html += '</div>';

  html += '<table class="sources-table"><thead><tr>';
  html += '<th>Name</th><th>Topic</th><th>Origin</th><th>Status</th><th>Score</th><th>Eligible</th><th>Total</th><th>Avg Update (h)</th>';
  html += '</tr></thead><tbody>';
  currentSources.forEach(s => {
    const scoreColor = s.score >= 0.6 ? 'var(--green)' : s.score >= 0.5 ? 'var(--text)' : 'var(--red)';
    html += '<tr>';
    html += '<td><a href="' + esc(s.site_url) + '" target="_blank" style="color:var(--accent);text-decoration:none">' + esc(s.name || s.site_url) + '</a></td>';
    html += '<td><span class="badge ' + topicClass(s.topic) + '">' + s.topic + '</span></td>';
    html += '<td><span class="badge badge-origin">' + s.origin + '</span></td>';
    html += '<td>' + s.status + '</td>';
    html += '<td style="color:' + scoreColor + '">' + (s.score || 0).toFixed(2) + '</td>';
    html += '<td>' + (s.eligible_count || 0) + '</td>';
    html += '<td>' + (s.article_count || 0) + '</td>';
    html += '<td>' + (s.avg_update_hours || 0).toFixed(1) + '</td>';
    html += '</tr>';
  });
  html += '</tbody></table>';
  el.innerHTML = html;
}

function renderAnalysis() {
  const el = document.getElementById('analysis-tab');
  if (!currentSlate.length) {
    el.innerHTML = '<div class="loading">Generate a slate first.</div>';
    return;
  }

  let html = '';

  // Topic distribution
  const topicCounts = {};
  const domainCounts = {};
  const authorCounts = {};
  const clusterCounts = {};
  const originCounts = {};
  let adjacentRepeats = 0;
  let adjacentVoiceRepeats = 0;
  const firstScreen = currentSlate.slice(0, 12);

  currentSlate.forEach((a, i) => {
    topicCounts[a.topic] = (topicCounts[a.topic] || 0) + 1;
    domainCounts[a.domain] = (domainCounts[a.domain] || 0) + 1;
    const voice = a.authorKey || 'site:' + a.domain;
    authorCounts[voice] = (authorCounts[voice] || 0) + 1;
    if (a.semanticCluster) clusterCounts[a.semanticCluster] = (clusterCounts[a.semanticCluster] || 0) + 1;
    if (a.source.origin) originCounts[a.source.origin] = (originCounts[a.source.origin] || 0) + 1;
    if (i > 0 && a.domain === currentSlate[i-1].domain) adjacentRepeats++;
    if (i > 0) {
      const prevVoice = currentSlate[i-1].authorKey || 'site:' + currentSlate[i-1].domain;
      if (voice === prevVoice) adjacentVoiceRepeats++;
    }
  });

  // Health checks
  const firstScreenDomains = new Set(firstScreen.map(a => a.domain)).size;
  const firstScreenVoices = new Set(firstScreen.map(a => a.authorKey || 'site:' + a.domain)).size;
  html += '<div class="section-title">Diversity Health</div>';
  html += '<div class="stats-grid">';
  html += healthCard('First-screen domains', firstScreenDomains, firstScreenDomains >= firstScreen.length);
  html += healthCard('First-screen voices', firstScreenVoices, firstScreenVoices >= firstScreen.length);
  html += healthCard('Adjacent domain repeats', adjacentRepeats, adjacentRepeats === 0);
  html += healthCard('Adjacent voice repeats', adjacentVoiceRepeats, adjacentVoiceRepeats === 0);
  html += healthCard('Unique domains', Object.keys(domainCounts).length, true);
  html += healthCard('Unique voices', Object.keys(authorCounts).length, true);
  html += '</div>';

  // Topic balance
  html += '<div class="section-title">Topic Distribution</div>';
  html += '<div class="domain-chart">';
  const maxTopicCount = Math.max(...Object.values(topicCounts));
  Object.entries(topicCounts).sort((a,b) => b[1] - a[1]).forEach(([topic, count]) => {
    html += '<div class="domain-bar-row">';
    html += '<div class="domain-name" style="color:' + topicColor(topic) + '">' + topic + '</div>';
    html += '<div class="domain-bar" style="width:' + (count/maxTopicCount*100) + '%;background:' + topicColor(topic) + ';opacity:0.6"></div>';
    html += '<div class="domain-count">' + count + '</div>';
    html += '</div>';
  });
  html += '</div>';

  // Domain distribution
  html += '<div class="section-title">Domain Distribution (in slate)</div>';
  html += '<div class="domain-chart">';
  const sortedDomains = Object.entries(domainCounts).sort((a,b) => b[1] - a[1]).slice(0, 25);
  const maxDomainCount = sortedDomains[0]?.[1] || 1;
  sortedDomains.forEach(([domain, count]) => {
    html += '<div class="domain-bar-row">';
    html += '<div class="domain-name">' + esc(domain) + '</div>';
    html += '<div class="domain-bar" style="width:' + (count/maxDomainCount*100) + '%;background:var(--accent);opacity:0.5"></div>';
    html += '<div class="domain-count">' + count + '</div>';
    html += '</div>';
  });
  html += '</div>';

  // Semantic clusters
  if (Object.keys(clusterCounts).length > 0) {
    html += '<div class="section-title">Semantic Clusters</div>';
    html += '<div class="domain-chart">';
    const sortedClusters = Object.entries(clusterCounts).sort((a,b) => b[1] - a[1]);
    const maxCluster = sortedClusters[0]?.[1] || 1;
    sortedClusters.forEach(([cluster, count]) => {
      html += '<div class="domain-bar-row">';
      html += '<div class="domain-name" style="color:var(--purple)">' + esc(cluster) + '</div>';
      html += '<div class="domain-bar" style="width:' + (count/maxCluster*100) + '%;background:var(--purple);opacity:0.4"></div>';
      html += '<div class="domain-count">' + count + '</div>';
      html += '</div>';
    });
    html += '</div>';
  }

  // Source origin breakdown
  html += '<div class="section-title">Source Origins (in slate)</div>';
  html += '<div class="domain-chart">';
  const sortedOrigins = Object.entries(originCounts).sort((a,b) => b[1] - a[1]);
  const maxOrigin = sortedOrigins[0]?.[1] || 1;
  sortedOrigins.forEach(([origin, count]) => {
    html += '<div class="domain-bar-row">';
    html += '<div class="domain-name" style="color:var(--pink)">' + esc(origin) + '</div>';
    html += '<div class="domain-bar" style="width:' + (count/maxOrigin*100) + '%;background:var(--pink);opacity:0.4"></div>';
    html += '<div class="domain-count">' + count + '</div>';
    html += '</div>';
  });
  html += '</div>';

  // Top domains from pool
  if (currentStats.topDomains?.length) {
    html += '<div class="section-title">Top Domains in Pool (eligible articles)</div>';
    html += '<div class="domain-chart">';
    const maxPoolDomain = currentStats.topDomains[0]?.articles || 1;
    currentStats.topDomains.forEach(d => {
      html += '<div class="domain-bar-row">';
      html += '<div class="domain-name">' + esc(d.domain) + ' <span style="color:' + topicColor(d.topic) + '">[' + d.topic[0] + ']</span></div>';
      html += '<div class="domain-bar" style="width:' + (d.articles/maxPoolDomain*100) + '%;background:' + topicColor(d.topic) + ';opacity:0.4"></div>';
      html += '<div class="domain-count">' + d.articles + '</div>';
      html += '</div>';
    });
    html += '</div>';
  }

  el.innerHTML = html;
}

function healthCard(label, value, ok) {
  return '<div class="stat-card"><div class="label">' + label + '</div><div class="value" style="color:' + (ok ? 'var(--green)' : 'var(--red)') + '">' + value + '</div></div>';
}

function esc(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

loadSlate();
</script>
</body>
</html>`;

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/api/slate") {
      const topics = (url.searchParams.get("topics") || "").split(",").filter(Boolean);
      if (topics.length === 0) return Response.json([]);
      const slate = await generateSlate(topics);
      return Response.json(slate);
    }

    if (url.pathname === "/api/stats") {
      const topics = (url.searchParams.get("topics") || "").split(",").filter(Boolean);
      if (topics.length === 0) return Response.json({});
      const stats = await getPoolStats(topics);
      return Response.json(stats);
    }

    if (url.pathname === "/api/sources") {
      const topics = (url.searchParams.get("topics") || "").split(",").filter(Boolean);
      if (topics.length === 0) return Response.json([]);
      const sources = await getSourcesList(topics);
      return Response.json(sources);
    }

    return new Response(HTML, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  },
});

console.log(`\n  ReadRabbit Algorithm Inspector`);
console.log(`  http://localhost:${server.port}\n`);
