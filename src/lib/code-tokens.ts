import Prism from "prismjs";
import type { Grammar, TokenStream } from "prismjs";
// grammars — imported explicitly so the bundler includes them
import "prismjs/components/prism-rust";
import "prismjs/components/prism-c";
import "prismjs/components/prism-cpp";
import "prismjs/components/prism-javascript";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-python";
import "prismjs/components/prism-go";
import "prismjs/components/prism-java";
import "prismjs/components/prism-sql";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-yaml";
import "prismjs/components/prism-toml";
import "prismjs/components/prism-json";
import "prismjs/components/prism-markdown";

// Syntax coloring for reader code blocks via prismjs (fully local). The
// language comes from the highlighter hint preserved at extraction time
// (data-nc-lang); blocks without one go through a small content-based
// detector. Tokens render as plain RN <Text> spans — no WebView.

export interface FlatToken {
  text: string;
  type: string; // prism token type ("keyword", "string", …) or ""
  depth: number;
}

interface FlatLine {
  tokens: FlatToken[];
}

const ALIASES: Record<string, string> = {
  rs: "rust", cxx: "cpp", cc: "cpp", hpp: "cpp", "c++": "cpp",
  js: "javascript", jsx: "javascript", mjs: "javascript", node: "javascript",
  ts: "typescript", tsx: "typescript",
  py: "python", python3: "python", golang: "go",
  sh: "bash", shell: "bash", zsh: "bash", console: "bash", terminal: "bash",
  yml: "yaml",
};

function grammarFor(langHint?: string): { lang: string; grammar?: Grammar } {
  const key = (langHint ?? "").toLowerCase();
  const canonical = ALIASES[key] ?? key;
  if (canonical && Prism.languages[canonical]) {
    return { lang: canonical, grammar: Prism.languages[canonical] };
  }
  return { lang: "", grammar: undefined };
}

// Content sniffing for blocks crawled without a highlighter hint.
// Each language needs one distinctive anchor (weight 2) or two weak ones.
export function detectLanguage(code: string): string {
  const scores: Record<string, number> = {};
  const bump = (name: string, re: RegExp, weight = 1) => {
    if (re.test(code)) scores[name] = (scores[name] ?? 0) + weight;
  };
  bump("rust", /\b(fn\s+\w+|impl\s+\w|let\s+mut|vec!)/, 2);
  bump("rust", /\b(unsafe|trait|crate)::?/, 1);
  bump("python", /^\s*def\s+\w+\(/m, 2);
  bump("python", /^\s*from\s+\S+\s+import\s/m, 1);
  bump("go", /\bfunc\s+(\(\w+\s+\*?\w+\)\s+)?\w+\(/, 2);
  bump("go", /:=/);
  bump("javascript", /\bconsole\.log\b/, 2);
  bump("javascript", /\b(const|let)\s+\w+\s*=/);
  bump("javascript", /=>/);
  bump("c", /#include\s*[<"]/, 2);
  bump("sql", /\b(SELECT|INSERT INTO|CREATE TABLE)\b/i, 2);
  bump("bash", /^\$\s/m, 2);
  let best = "";
  let bestScore = 0;
  for (const [name, score] of Object.entries(scores)) {
    if (score > bestScore) {
      best = name;
      bestScore = score;
    }
  }
  return bestScore >= 2 ? best : "";
}

function flatten(stream: TokenStream, type: string, out: FlatToken[]): void {
  if (typeof stream === "string") {
    if (stream.length > 0) out.push({ text: stream, type, depth: 0 });
    return;
  }
  if (Array.isArray(stream)) {
    for (const item of stream) flatten(item, type, out);
    return;
  }
  // Prism.Token
  const tokenType = typeof stream.type === "string" ? stream.type : "";
  if (typeof stream.content === "string") {
    out.push({ text: stream.content, type: tokenType, depth: 0 });
  } else {
    // nested constructs (e.g. template strings): flatten with parent type as
    // fallback so nested untyped pieces inherit the container color
    const nested: FlatToken[] = [];
    flatten(stream.content as TokenStream, tokenType, nested);
    let buffer = "";
    for (const piece of nested) {
      if (piece.type === "" || piece.type === tokenType) {
        buffer += piece.text;
      } else {
        if (buffer) {
          out.push({ text: buffer, type: tokenType, depth: 0 });
          buffer = "";
        }
        out.push(piece);
      }
    }
    if (buffer) out.push({ text: buffer, type: tokenType, depth: 0 });
  }
}

export function tokenizeLines(code: string, langHint?: string): FlatLine[] {
  const { lang, grammar } = grammarFor(langHint);
  const effectiveLang = lang || detectLanguage(code);
  const activeGrammar =
    grammar ?? (effectiveLang ? Prism.languages[effectiveLang] : undefined);

  const flat: FlatToken[] = [];
  try {
    if (activeGrammar) {
      flatten(Prism.tokenize(code, activeGrammar), "", flat);
    } else {
      flat.push({ text: code, type: "", depth: 0 });
    }
  } catch {
    flat.length = 0;
    flat.push({ text: code, type: "", depth: 0 });
  }

  // split the token stream into lines
  const lines: FlatLine[] = [{ tokens: [] }];
  for (const token of flat) {
    const pieces = token.text.split("\n");
    pieces.forEach((piece, i) => {
      if (i > 0) lines.push({ tokens: [] });
      if (piece.length > 0) {
        lines[lines.length - 1].tokens.push({
          text: piece,
          type: token.type,
          depth: token.depth,
        });
      }
    });
  }
  return lines;
}
