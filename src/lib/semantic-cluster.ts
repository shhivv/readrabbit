import type { Topic } from "./db";

export interface SemanticClusterInput {
  topic: Topic;
  title: string;
  siteDomain?: string;
  sourceName?: string;
  sourceOrigin?: string;
}

// These are deliberately narrow ecosystem labels, not a second topic
// classifier. Topic balance answers "technology vs economics vs math";
// semantic clusters stop one programming ecosystem from occupying several
// otherwise-distinct authors and publications on the same screen.

interface ClusterRule {
  cluster: string;
  domains: Set<string>;
  title: RegExp;
}

const TECH_CLUSTERS: readonly ClusterRule[] = [
  {
    cluster: "technology:python",
    domains: new Set([
      "djangoproject.com",
      "lernerpython.com",
      "planetpython.org",
      "pycoders.com",
      "pyfound.blogspot.com",
      "pythonbytes.fm",
    ]),
    title:
      /\b(?:django|pip|polars|pycharm|pycon|pyodide|pypi|pytest|python(?:\s*3)?)\b/i,
  },
  {
    cluster: "technology:rust",
    domains: new Set([
      "blog.rust-lang.org",
      "rustup.rs",
      "crates.io",
      "rustwasm.github.io",
    ]),
    title:
      /\b(?:rust(?:lang|acean|up)?|cargo|crate|borrow checker|lifetime(?:s)?|tokio|actix|wasm.?pack)\b/i,
  },
  {
    cluster: "technology:javascript",
    domains: new Set([
      "nodejs.org",
      "deno.land",
      "bun.sh",
      "tc39.es",
    ]),
    title:
      /\b(?:javascript|typescript|node\.?js|deno|bun(?:\.sh)?|react|vue|svelte|angular|next\.?js|nuxt|astro|vite|webpack|esbuild|tc39|ecmascript|npm|pnpm|jsx|tsx)\b/i,
  },
  {
    cluster: "technology:ai-ml",
    domains: new Set([
      "openai.com",
      "deepmind.google",
      "huggingface.co",
    ]),
    title:
      /\b(?:llm|gpt|transformer|diffusion model|neural net(?:work)?|deep learning|machine learning|training (?:a |the )?model|fine.?tun(?:e|ing)|rlhf|rag|embedding|tokeniz(?:er|ation)|attention (?:mechanism|head)|language model|chatgpt|claude|llama|mistral|stable diffusion|midjourney|generative ai)\b/i,
  },
  {
    cluster: "technology:systems",
    domains: new Set([
      "lwn.net",
      "kernelnewbies.org",
    ]),
    title:
      /\b(?:kernel|syscall|linux|freebsd|openbsd|operating system|file ?system|ext4|btrfs|zfs|memory manag(?:er|ement)|page table|scheduler|interrupt|eBPF|io_uring|mmap|ptrace|strace|assembly|x86|arm64|risc.?v|simd|avx)\b/i,
  },
  {
    cluster: "technology:go",
    domains: new Set([
      "go.dev",
      "golang.org",
    ]),
    title:
      /\b(?:golang|go(?:\s+)?(?:1\.\d+|module|routine|channel|interface)|goroutine|go.?channel)\b/i,
  },
  {
    cluster: "technology:security",
    domains: new Set([
      "krebsonsecurity.com",
      "schneier.com",
    ]),
    title:
      /\b(?:vulnerabilit(?:y|ies)|CVE-\d|exploit|malware|ransomware|zero.?day|buffer overflow|SQL injection|XSS|CSRF|penetration test|ctf|cryptograph(?:y|ic)|TLS|certificate|authentication bypass)\b/i,
  },
  {
    cluster: "technology:databases",
    domains: new Set([
      "use-the-index-luke.com",
      "pganalyze.com",
    ]),
    title:
      /\b(?:postgres(?:ql)?|mysql|sqlite|redis|mongodb|cassandra|DynamoDB|database|query (?:plan|optimizer)|B.?tree|LSM.?tree|WAL|MVCC|index(?:ing)?|sharding|replication)\b/i,
  },
  {
    cluster: "technology:functional",
    domains: new Set([
      "haskell.org",
      "elm-lang.org",
      "elixir-lang.org",
      "ocaml.org",
      "clojure.org",
    ]),
    title:
      /\b(?:haskell|ocaml|elixir|erlang|clojure|lisp|scheme|monad|functor|algebraic data type|pattern matching|type class|lambda calculus|purely functional)\b/i,
  },
];

export function inferSemanticCluster(
  input: SemanticClusterInput,
): string {
  if (input.topic !== "technology") return "";

  const sourceName = input.sourceName?.trim().toLowerCase() ?? "";
  if (
    input.sourceOrigin === "aggregator" &&
    sourceName === "planet python"
  ) {
    return "technology:python";
  }

  const domain = input.siteDomain?.trim().toLowerCase() ?? "";

  for (const rule of TECH_CLUSTERS) {
    if (rule.domains.has(domain) || rule.title.test(input.title)) {
      return rule.cluster;
    }
  }

  return "";
}
