import katex from "katex";
import { parseHTML } from "linkedom";

// Pre-render LaTeX to KaTeX HTML during enrichment (katex.renderToString is
// pure tree-building, no DOM measurement), so the reader renders plain spans
// with zero runtime math machinery. Delimiters handled:
//   display: $$...$$  \[...\]
//   inline:  $...$    \(...)
// plus MathJax-v2 style <script type="math/tex"> nodes (Blogger/WordPress).

const KATEX_OPTIONS = {
  throwOnError: false,
  strict: "ignore" as const,
  output: "html" as const,
  trust: false,
};

function renderTex(tex: string, displayMode: boolean): string | null {
  try {
    return katex.renderToString(tex, { ...KATEX_OPTIONS, displayMode });
  } catch {
    return null;
  }
}

function looksLikeLatex(candidate: string): boolean {
  return (
    /\\[a-zA-Z]+/.test(candidate) ||
    /[_^{}]|\d\s*[a-zA-Z]\s*\d|\\$/.test(candidate)
  );
}

interface Segment {
  type: "text" | "inline-math" | "display-math";
  value: string;
}

// Split raw text into plain segments and math segments. Conservative on
// single-$: requires latex-ish content and no whitespace hugging the openers,
// so prices ("it costs $5 and $10") stay untouched.
//
// Single pass with sticky regexes and indexOf — never slices the remaining
// text per character (the naive `text.slice(i)` version is O(n²) in
// allocations and chokes long math-heavy paragraphs).
export function splitMathSegments(text: string): Segment[] {
  const segments: Segment[] = [];
  let buffer = "";
  let i = 0;

  const ddRe = /\$\$([\s\S]+?)\$\$/y;
  const bracketRe = /\\\[([\s\S]+?)\\\]/y;
  const parenRe = /\\\(([\s\S]+?)\\\)/y;

  const flush = () => {
    if (buffer) {
      segments.push({ type: "text", value: buffer });
      buffer = "";
    }
  };

  while (i < text.length) {
    let match: RegExpExecArray | null;

    ddRe.lastIndex = i;
    if ((match = ddRe.exec(text))) {
      flush();
      segments.push({ type: "display-math", value: match[1] });
      i += match[0].length;
      continue;
    }

    bracketRe.lastIndex = i;
    if ((match = bracketRe.exec(text))) {
      flush();
      segments.push({ type: "display-math", value: match[1] });
      i += match[0].length;
      continue;
    }

    parenRe.lastIndex = i;
    if ((match = parenRe.exec(text))) {
      flush();
      segments.push({ type: "inline-math", value: match[1] });
      i += match[0].length;
      continue;
    }

    if (
      text.charCodeAt(i) === 36 /* $ */ &&
      text[i + 1] !== undefined &&
      !/\s/.test(text[i + 1])
    ) {
      const close = text.indexOf("$", i + 1);
      if (close > i + 1 && !/\s$/.test(text.slice(i + 1, close + 1))) {
        const candidate = text.slice(i + 1, close);
        if (looksLikeLatex(candidate)) {
          flush();
          segments.push({ type: "inline-math", value: candidate });
          i = close + 1;
          continue;
        }
      }
    }

    const nextSpecial = Math.max(nextDelimiter(text, i), i + 1);
    buffer += text.slice(i, nextSpecial);
    i = nextSpecial;
  }

  flush();
  return segments;
}

// Jump ahead to the next character that could start a delimiter ($ or \),
// so plain prose is consumed in bulk slices instead of char-by-char.
function nextDelimiter(text: string, from: number): number {
  for (let j = from; j < text.length; j++) {
    const c = text.charCodeAt(j);
    if (c === 36 || c === 92) return j; // $ or backslash
  }
  return text.length;
}

// innerHTML round-trips escape <,>,& inside text nodes; TeX extracted from
// them must be unescaped before hitting the KaTeX parser.
export function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    )
    .replace(/&amp;/g, "&");
}

function mathHtml(segmentValue: string, displayMode: boolean): string | null {
  const rendered = renderTex(decodeEntities(segmentValue).trim(), displayMode);
  if (!rendered) return null;
  return `<nc-math data-nc-display="${displayMode ? 1 : 0}">${rendered}</nc-math>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Runs BEFORE sanitization/preTrim: MathJax-v2 <script type="math/tex"> nodes
// become nc-math placeholders carrying the raw TeX as text, so they survive
// cleanup and get rendered by renderMathInHtml afterwards.
//
// Pure string transformation — MathJax tags are machine-generated with a
// predictable shape, so this avoids a full throwaway DOM parse per article.
const MATHJAX_SCRIPT = /<script\s+type=["']math\/tex(;\s*mode=display)?["'][^>]*>([\s\S]*?)<\/script\s*>/gi;

export function convertMathScripts(html: string): string {
  if (!html.includes("math/tex")) return html;
  return html.replace(MATHJAX_SCRIPT, (_, displayMode: string | undefined, tex: string) =>
    `<nc-math data-nc-display="${displayMode ? 1 : 0}">${tex}</nc-math>`
  );
}

// Same contract as convertMathScripts, for WordPress.com blogs (terrytao,
// gowers, ...) that embed every formula as a remote latex.php PNG. Those PNGs
// bake in bg=ffffff (white box in dark mode), but their querystring carries
// the source TeX in `latex=`, so swap each <img> for an inline nc-math
// placeholder and let renderMathInHtml fill it later. Host is anchored right
// after the scheme so lookalike paths on other domains can't match; the loose
// subdomain wildcard covers s0.wp.com and legacy *.wordpress.com hosts.
const WP_LATEX_IMG =
  /<img\b[^>]*\bsrc\s*=\s*(["'])((?:https?:)?\/\/(?:[a-z0-9-]+\.)*(?:wp|wordpress)\.com\/latex\.php\?.*?)\1/gi;

export function convertLatexImages(html: string): string {
  if (!html.includes("latex.php")) return html;
  return html.replace(WP_LATEX_IMG, (_tag, _quote: string, src: string) => {
    const tex = wpLatexParam(decodeEntities(src));
    // WP always emits s=0 here; display sizing comes from \displaystyle
    // already present in the TeX, so inline (0) is correct for all fixtures.
    if (!tex) return _tag;
    return `<nc-math data-nc-display="0">${escapeHtml(tex)}</nc-math>`;
  });
}

// Pull the URL-decoded `latex` param out of a latex.php querystring.
// Form-encoded: + means space. Malformed %-sequences fall back to the raw
// encoding rather than dropping the formula.
function wpLatexParam(src: string): string | null {
  const query = src.slice(src.indexOf("?") + 1);
  for (const pair of query.split("&")) {
    const eq = pair.indexOf("=");
    if (eq <= 0 || pair.slice(0, eq) !== "latex") continue;
    const encoded = pair.slice(eq + 1).replace(/\+/g, " ");
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
  }
  return null;
}

export function renderMathInHtml(html: string): string {
  let document: Document;
  try {
    const parsed = parseHTML(`<html><body>${html}</body></html>`);
    document = parsed.document;
  } catch {
    return html;
  }

  try {
    // fill nc-math placeholders that still carry raw TeX text (from
    // convertMathScripts) — these are display/inline by attribute
    for (const node of Array.from(
      document.querySelectorAll("nc-math")
    )) {
      const raw = node.textContent ?? "";
      const hasRendered = node.querySelector(".katex") != null;
      if (!raw.trim() || hasRendered) continue;
      const displayMode = node.getAttribute("data-nc-display") === "1";
      const rendered = mathHtml(raw, displayMode);
      if (!rendered) continue;
      const holder = document.createElement("span");
      holder.innerHTML = rendered;
      const parent = node.parentElement;
      if (!parent) continue;
      parent.replaceChild(holder, node);
    }

    // Merge adjacent text nodes — HTML entities (&gt; etc.) create node
    // boundaries that would otherwise split delimiters like \( ... \) in half.
    document.body?.normalize?.();

    // Walk text nodes; skip code/pre so snippets keep their dollars
    const walker = document.createTreeWalker(document.body, 4); // SHOW_TEXT
    const targets: Array<{ node: Text; html: string }> = [];

    let current = walker.nextNode() as Text | null;
    while (current) {
      const value = current.nodeValue ?? "";
      if (value.includes("$") || value.includes("\\(") || value.includes("\\[")) {
        let inCode = false;
        let cursor: Element | null = current.parentElement as Element | null;
        while (cursor) {
          const tag = cursor.tagName?.toLowerCase();
          if (tag === "code" || tag === "pre") {
            inCode = true;
            break;
          }
          cursor = cursor.parentElement;
        }
        if (!inCode) {
          const segments = splitMathSegments(value);
          if (segments.some((s) => s.type !== "text")) {
            const parts = segments.map((segment) => {
              if (segment.type === "text") {
                return escapeText(segment.value);
              }
              const renderedHtml = mathHtml(
                segment.value,
                segment.type === "display-math"
              );
              return renderedHtml ?? escapeText(`$${segment.value}$`);
            });
            targets.push({ node: current, html: parts.join("") });
          }
        }
      }
      current = walker.nextNode() as Text | null;
    }

    for (const target of targets) {
      const parent = target.node.parentElement;
      if (!parent) continue;
      const holder = document.createElement("span");
      holder.innerHTML = target.html;
      target.node.replaceWith(holder);
    }

    return document.body.innerHTML;
  } catch {
    return html;
  }
}

function escapeText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
