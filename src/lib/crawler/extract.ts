import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { renderMathInHtml, convertMathScripts } from "./math";

export interface ExtractedArticle {
  title: string;
  author: string;
  siteName: string;
  publishedDate: number | null;
  excerpt: string;
  contentHtml: string;
  textContent: string;
  leadImageUrl: string;
  wordCount: number;
}

const MAX_CONTENT_HTML_BYTES = 300_000;
// Cap on the HTML fed into parsing/extraction. linkedom DOM nodes cost
// ~35× the raw HTML in heap, so an uncapped multi-MB page parsed by several
// workers at once spikes memory hard on phones. Long tail beyond this is
// comments/boilerplate that Readability discards anyway.
const MAX_EXTRACT_INPUT_BYTES = 600_000;

const ALLOWED_TAGS = new Set([
  "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li", "blockquote", "pre", "code",
  "em", "i", "strong", "b", "u", "s", "del", "mark", "kbd", "sup", "sub",
  "a", "img", "figure", "figcaption",
  "table", "thead", "tbody", "tr", "th", "td", "caption",
  "nc-math",
]);

const DROP_TAGS = new Set([
  "script", "style", "iframe", "object", "embed", "form", "input",
  "button", "select", "textarea", "nav", "aside", "footer", "noscript",
  "svg", "canvas", "video", "audio", "dialog", "template", "link", "meta",
]);

function safeUrl(raw: string | undefined, base: string): string {
  if (!raw) return "";
  try {
    const resolved = new URL(raw, base);
    if (!/^https?:$/i.test(resolved.protocol)) return "";
    return resolved.toString();
  } catch {
    return "";
  }
}

// Strip script/style/svg/comment blocks at the string level, before DOM
// construction. They carry no article content but become thousands of DOM
// nodes (linkedom nodes cost ~35× their source bytes in heap), so removing
// them here is the single biggest extraction-memory lever. Head/meta/tags
// stay — metadata extraction reads them.
const PRE_TRIM_BLOCK = /<(script|style|noscript|template|svg|iframe|form)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const PRE_TRIM_VOID = /<(script|style|noscript|iframe)\b[^>]*\/?>/gi;
const PRE_TRIM_COMMENT = /<!--[\s\S]*?-->/g;

export function preTrim(html: string): string {
  return html
    .replace(PRE_TRIM_COMMENT, " ")
    .replace(PRE_TRIM_BLOCK, " ")
    .replace(PRE_TRIM_VOID, " ");
}

function sanitizeDocument(document: Document, baseUrl: string): void {
  for (const el of Array.from(document.querySelectorAll("*"))) {
    const tag = el.tagName.toLowerCase();

    if (DROP_TAGS.has(tag)) {
      el.remove();
      continue;
    }

    if (!ALLOWED_TAGS.has(tag) && tag !== "html" && tag !== "body" && tag !== "head") {
      // unwrap: replace with its children
      const parent = el.parentElement;
      if (parent) {
        while (el.firstChild) parent.insertBefore(el.firstChild, el);
        el.remove();
      } else {
        el.remove();
      }
      continue;
    }

    for (const attr of Array.from(el.attributes ?? [])) {
      const name = attr.name.toLowerCase();
      if (tag === "nc-math" && name === "data-nc-display") continue;

      const drop =
        name.startsWith("on") ||
        name === "style" ||
        name === "class" ||
        name === "id" ||
        name === "srcset" ||
        name === "sizes" ||
        name === "loading" ||
        name.startsWith("data-") ||
        name.startsWith("aria-");
      if (drop) {
        el.removeAttribute(attr.name);
        continue;
      }
      if (tag === "a" && name === "href") {
        const abs = safeUrl(attr.value, baseUrl);
        if (!abs) el.removeAttribute(attr.name);
        else el.setAttribute("href", abs);
      }
      if (name === "src") {
        const abs = safeUrl(attr.value, baseUrl);
        if (!abs) el.remove();
        else el.setAttribute("src", abs);
      }
    }
  }

  // strip empty containers that would render as stray boxes
  for (const el of Array.from(document.querySelectorAll("p, li"))) {
    if (!el.textContent?.trim() && !el.querySelector("img")) el.remove();
  }
}

export function extractFromHtml(rawHtml: string, url: string): ExtractedArticle | null {
  try {
    const html = rawHtml.slice(0, MAX_EXTRACT_INPUT_BYTES);
    // MathJax script tags → nc-math placeholders before any sanitization
    // (they must survive preTrim, which strips everything else script-y)
    const prepared = preTrim(convertMathScripts(html));
    const { document } = parseHTML(prepared);

    // metadata first — Readability then reuses and mutates this same tree,
    // saving a full second DOM construction per article (measurable on phones)
    const meta = extractMetadata(document, url);

    let extracted: ReturnType<Readability["parse"]> = null;
    try {
      const reader = new Readability(document as unknown as globalThis.Document);
      extracted = reader.parse() as ReturnType<Readability["parse"]>;
    } catch {
      extracted = null;
    }

    let contentHtml = "";
    let textContent = "";

    if (
      extracted &&
      extracted.content &&
      typeof extracted.textContent === "string" &&
      extracted.textContent.trim().length >= 200
    ) {
      contentHtml = extracted.content;
      textContent = extracted.textContent;
      // sanitize through linkedom
      const { document: sanitizeDoc } = parseHTML(
        `<html><body>${contentHtml}</body></html>`
      );
      sanitizeDocument(sanitizeDoc, url);
      contentHtml = sanitizeDoc.body.innerHTML;
      textContent = sanitizeDoc.body.textContent ?? textContent;
    } else {
      const heuristic = heuristicExtract(prepared, url);
      if (!heuristic) return null;
      contentHtml = heuristic.html;
      textContent = heuristic.text;
    }

    // markdown-only bodies (rare, but some blogs serve raw md)
    if (looksLikeMarkdown(contentHtml)) {
      contentHtml = markdownToHtml(contentHtml);
    }

    // pre-render LaTeX now so the reader never pays for math
    contentHtml = renderMathInHtml(contentHtml);

    textContent = normalizeWhitespace(textContent);
    const wordCount = textContent ? textContent.split(/\s+/).length : 0;
    if (wordCount < 80) return null;

    const title = cleanTitle(
      normalizeWhitespace(meta.title || extracted?.title || ""),
      meta.siteName || extracted?.siteName || ""
    );
    if (!title) return null;

    return {
      title,
      author: normalizeWhitespace(meta.author || extracted?.byline || ""),
      siteName: normalizeWhitespace(
        meta.siteName || extracted?.siteName || hostLabel(url)
      ),
      publishedDate: meta.publishedDate,
      excerpt: makeExcerpt(textContent),
      contentHtml: contentHtml.slice(0, MAX_CONTENT_HTML_BYTES),
      textContent: textContent.slice(0, 60_000),
      leadImageUrl: meta.leadImage,
      wordCount,
    };
  } catch {
    return null;
  }
}

interface PageMeta {
  title: string;
  author: string;
  siteName: string;
  publishedDate: number | null;
  leadImage: string;
}

function extractMetadata(document: Document, url: string): PageMeta {
  const meta: PageMeta = {
    title: "",
    author: "",
    siteName: "",
    publishedDate: null,
    leadImage: "",
  };

  const metaValue = (selectors: string[]): string => {
    for (const selector of selectors) {
      for (const el of Array.from(document.querySelectorAll(selector))) {
        const content = el.getAttribute?.("content") ?? "";
        if (content.trim()) return content.trim();
      }
    }
    return "";
  };

  meta.title =
    metaValue(['meta[property="og:title"]', 'meta[name="twitter:title"]']) ||
    document.querySelector("title")?.textContent?.trim() ||
    "";

  meta.author =
    metaValue([
      'meta[name="author"]',
      'meta[property="article:author"]',
      'meta[name="twitter:creator"]',
    ]) || "";
  if (meta.author.startsWith("@")) meta.author = "";
  if (/^https?:\/\//.test(meta.author)) meta.author = "";

  meta.siteName =
    metaValue(['meta[property="og:site_name"]']) || hostLabel(url);

  const dateRaw =
    metaValue([
      'meta[property="article:published_time"]',
      'meta[name="date"]',
      'meta[itemprop="datePublished"]',
    ]) || "";
  if (dateRaw) {
    const parsed = Date.parse(dateRaw);
    if (!Number.isNaN(parsed)) meta.publishedDate = parsed;
  }
  if (meta.publishedDate == null) {
    const timeEl = document.querySelector(
      "time[datetime]"
    ) as HTMLElement | null;
    const dt = timeEl?.getAttribute?.("datetime") ?? "";
    if (dt) {
      const parsed = Date.parse(dt);
      if (!Number.isNaN(parsed)) meta.publishedDate = parsed;
    }
  }

  meta.leadImage = safeUrl(
    metaValue(['meta[property="og:image"]', 'meta[name="twitter:image"]']),
    url
  );

  return meta;
}

// Heuristic extraction: pick the DOM region with the most long-form paragraph
// text (Readability-style density scoring, much simpler).
function heuristicExtract(
  html: string,
  baseUrl: string
): { html: string; text: string } | null {
  try {
    const { document } = parseHTML(html);
    sanitizeDocument(document, baseUrl);

    const candidates = Array.from(
      document.querySelectorAll("p, pre, blockquote, nc-math")
    ) as HTMLElement[];

    const scored = candidates
      .map((node) => {
        const text = normalizeWhitespace(node.textContent ?? "");
        const anchorText = Array.from(node.querySelectorAll("a")).reduce(
          (sum, a) => sum + (a.textContent ?? "").length,
          0
        );
        return {
          node,
          path: domPath(node),
          len: text.length,
          linkRatio: text.length > 0 ? anchorText / text.length : 1,
          text,
        };
      })
      .filter((c) => c.len >= 40 && c.linkRatio < 0.55 && !isBoilerplate(c.text));

    if (scored.length === 0) return null;

    // majority-vote LCA over candidate paths
    const paths = scored.map((c) => c.path).sort();
    const lcaPath = commonPrefix(paths[0], paths[paths.length - 1]);
    let container: HTMLElement | null = resolvePath(document, lcaPath);
    if (!container || container === document.documentElement || container === document.body) {
      container = document.body;
    }

    // serialize the chosen container's relevant children
    const parts: string[] = [];
    const seen = new Set<Node>();
    for (const c of scored) {
      let inContainer = false;
      let cursor: Node | null = c.node;
      while (cursor) {
        if (cursor === container) {
          inContainer = true;
          break;
        }
        cursor = cursor.parentElement as Node | null;
      }
      if (!inContainer) continue;
      if (seen.has(c.node)) continue;

      const tag = c.node.tagName.toLowerCase();
      seen.add(c.node);
      if (tag === "nc-math") {
        // pre-converted math placeholder — carry through untouched
        parts.push(c.node.outerHTML);
      } else if (tag === "pre" || tag === "blockquote") {
        parts.push(`<${tag}>${escapeHtml(c.text)}</${tag}>`);
      } else {
        const innerHtml = (c.node as HTMLElement).innerHTML ?? escapeHtml(c.text);
        parts.push(`<p>${innerHtml}</p>`);
      }
    }

    if (parts.length === 0) return null;

    // pull headings near the top of the container into the output
    const heading = container.querySelector("h1, h2")?.outerHTML ?? "";

    const htmlOut = `${heading}${parts.join("\n")}`;
    const text = normalizeWhitespace(container.textContent ?? "");
    return { html: htmlOut, text };
  } catch {
    return null;
  }
}

type DomNode = HTMLElement;

function domPath(el: DomNode): string[] {
  const path: string[] = [];
  let cursor: HTMLElement | null = el;
  while (cursor && path.length < 24) {
    const parent: HTMLElement | null = cursor.parentElement;
    if (!parent) break;
    const siblings = Array.from(parent.children).filter(
      (child) => child.tagName === cursor!.tagName
    );
    const index = siblings.indexOf(cursor);
    path.unshift(`${cursor.tagName}:${index}`);
    cursor = parent;
  }
  return path;
}

function resolvePath(document: Document, path: string[]): HTMLElement | null {
  let current: HTMLElement = document.documentElement as unknown as HTMLElement;
  for (const step of path.slice(1)) {
    const [tag, indexStr] = step.split(":");
    const index = parseInt(indexStr, 10);
    const matches = (Array.from(current.children) as HTMLElement[]).filter(
      (child) => child.tagName === tag.toUpperCase()
    );
    const next: HTMLElement | undefined = matches[index];
    if (!next) return null;
    current = next;
  }
  return current;
}

function commonPrefix(a: string[], b: string[]): string[] {
  const result: string[] = [];
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) break;
    result.push(a[i]);
  }
  return result;
}

const BOILERPLATE_PATTERNS = [
  /^(share|tweet|follow|subscribe|sign up|log in|login|menu|search|comments?|related posts?|leave a (reply|comment)|advertisement|cookie)/i,
  /^(copyright|all rights reserved|privacy policy|terms of service)/i,
];

function isBoilerplate(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length > 120) return false;
  return BOILERPLATE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function normalizeWhitespace(text: string): string {
  return text.replace(/[ \t\r\n]+/g, " ").trim();
}

function looksLikeMarkdown(html: string): boolean {
  if (/<(p|div|h[1-6]|ul|ol|blockquote|pre)\b/i.test(html)) return false;
  const mdMarkers = [
    /^#{1,6}\s/m,
    /\*\*[^*\n]+\*\*/,
    /^[-*]\s+\S/m,
    /```/,
    /\[[^\]]+\]\([^)]+\)/,
  ];
  return mdMarkers.some((pattern) => pattern.test(html));
}

function markdownToHtml(markdown: string): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { marked } = require("marked") as typeof import("marked");
    return marked.parse(markdown, { async: false, gfm: true }) as string;
  } catch {
    return markdown;
  }
}

function cleanTitle(title: string, siteName: string): string {
  if (!siteName) return title.trim();
  const separators = [" | ", " – ", " — ", " - ", " :: ", " » "];
  for (const sep of separators) {
    const idx = title.lastIndexOf(sep);
    if (idx > 0) {
      const tail = title.slice(idx + sep.length).trim();
      if (tail && tail.toLowerCase().includes(siteName.toLowerCase())) {
        return title.slice(0, idx).trim();
      }
    }
  }
  return title.trim();
}

function makeExcerpt(text: string): string {
  if (text.length <= 220) return text;
  const slice = text.slice(0, 220);
  const lastStop = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("! "));
  if (lastStop > 100) return slice.slice(0, lastStop + 1);
  return slice.replace(/\s\S*$/, "") + "…";
}

function hostLabel(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return "";
  }
}
