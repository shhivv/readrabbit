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
export function splitMathSegments(text: string): Segment[] {
  const segments: Segment[] = [];
  let buffer = "";
  let i = 0;

  const flush = () => {
    if (buffer) {
      segments.push({ type: "text", value: buffer });
      buffer = "";
    }
  };

  while (i < text.length) {
    const rest = text.slice(i);

    const dd = rest.match(/^\$\$([\s\S]+?)\$\$/);
    if (dd) {
      flush();
      segments.push({ type: "display-math", value: dd[1] });
      i += dd[0].length;
      continue;
    }

    const bracket = rest.match(/^\\\[([\s\S]+?)\\\]/);
    if (bracket) {
      flush();
      segments.push({ type: "display-math", value: bracket[1] });
      i += bracket[0].length;
      continue;
    }

    const paren = rest.match(/^\\\(([\s\S]+?)\\\)/);
    if (paren) {
      flush();
      segments.push({ type: "inline-math", value: paren[1] });
      i += paren[0].length;
      continue;
    }

    if (rest[0] === "$" && rest[1] !== undefined && !/\s/.test(rest[1])) {
      const close = rest.slice(1).indexOf("$");
      if (close > 0 && !/\s$/.test(rest.slice(1, close + 1))) {
        const candidate = rest.slice(1, close + 1);
        if (looksLikeLatex(candidate)) {
          flush();
          segments.push({ type: "inline-math", value: candidate });
          i += close + 2;
          continue;
        }
      }
    }

    buffer += text[i];
    i += 1;
  }

  flush();
  return segments;
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

// Runs BEFORE sanitization: MathJax-v2 <script type="math/tex"> nodes become
// nc-math placeholders carrying the raw TeX as text, so they survive cleanup
// and get rendered by renderMathInHtml afterwards.
export function convertMathScripts(html: string): string {
  try {
    const { document } = parseHTML(`<html><body>${html}</body></html>`);
    let changed = false;

    for (const script of Array.from(
      document.querySelectorAll('script[type^="math/tex"]')
    )) {
      const modeAttr = script.getAttribute("type") ?? "";
      const displayMode = modeAttr.includes("mode=display");
      const tex = script.textContent ?? "";
      if (!tex.trim()) continue;
      const holder = document.createElement("nc-math");
      holder.setAttribute("data-nc-display", displayMode ? "1" : "0");
      holder.textContent = tex;
      script.replaceWith(holder);
      changed = true;
    }

    return changed ? document.body.innerHTML : html;
  } catch {
    return html;
  }
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
