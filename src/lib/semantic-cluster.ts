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
const PYTHON_DOMAINS = new Set([
  "djangoproject.com",
  "lernerpython.com",
  "planetpython.org",
  "pycoders.com",
  "pyfound.blogspot.com",
  "pythonbytes.fm",
]);

const PYTHON_TITLE =
  /\b(?:django|pip|polars|pycharm|pycon|pyodide|pypi|pytest|python(?:\s*3)?)\b/i;

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
  if (PYTHON_DOMAINS.has(domain) || PYTHON_TITLE.test(input.title)) {
    return "technology:python";
  }

  return "";
}
