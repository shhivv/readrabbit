// Domain classification: keep personal/high-signal blogs out of corporate
// media's way. Blocklist first, then platform + TLD heuristics.

const BLOCKED_DOMAINS = new Set([
  // major media
  "nytimes.com", "washingtonpost.com", "wsj.com", "ft.com", "economist.com",
  "bloomberg.com", "theguardian.com", "thetimes.co.uk", "telegraph.co.uk",
  "cnn.com", "foxnews.com", "msnbc.com", "nbcnews.com", "cbsnews.com",
  "abcnews.go.com", "apnews.com", "reuters.com", "bbc.co.uk", "bbc.com",
  "aljazeera.com", "time.com", "newsweek.com", "usatoday.com",
  // tech media
  "wired.com", "arstechnica.com", "theverge.com", "techcrunch.com",
  "engadget.com", "gizmodo.com", "mashable.com", "lifehacker.com",
  "cnet.com", "zdnet.com", "pcworld.com", "macrumors.com", "9to5mac.com",
  "tomshardware.com", "anandtech.com", "theinformation.com",
  "semianalysis.substack.com",
  // business / finance media
  "forbes.com", "businessinsider.com", "cnbc.com", "fortune.com",
  "inc.com", "fastcompany.com", "hbr.org", "marketwatch.com",
  "investopedia.com", "barrons.com",
  // content farms & platforms
  "buzzfeed.com", "huffpost.com", "vox.com", "medium.com", "hackernoon.com",
  "dev.to", "freecodecamp.org", "towardsdatascience.com", "betterprogramming.pub",
  "levelup.gitconnected.com", "uxdesign.cc", "geeksforgeeks.org",
  "tutorialspoint.com", "w3schools.com", "stackoverflow.com",
  "stackexchange.com", "quora.com", "reddit.com", "linkedin.com",
  "facebook.com", "twitter.com", "x.com", "instagram.com", "tiktok.com",
  "youtube.com", "youtu.be", "pinterest.com", "wikipedia.org",
  "github.com", "gitlab.com", "apple.com", "microsoft.com", "google.com",
  "blog.google", "openai.com", "anthropic.com", "deepmind.google",
  "meta.com", "netflixtechblog.com", "eng.uber.com", "netflix.com",
  "amazon.com", "dropbox.tech", "discord.com", "slack.com",
  "engineering.fb.com", "aws.amazon.com", "azure.microsoft.com",
]);

const BLOCKED_TLDS = new Set([".gov", ".mil"]);

// Two-part public suffixes we bother about (minimal set)
const TWO_PART_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "co.jp", "co.in", "com.au",
  "co.nz", "com.br", "co.za", "com.mx", "com.sg", "com.tr",
]);

export interface Classification {
  allowed: boolean;
  reason: string;
}

export function classifyDomain(urlOrDomain: string): Classification {
  let host = urlOrDomain.toLowerCase().trim();
  try {
    host = new URL(urlOrDomain).host.toLowerCase();
  } catch {
    // treat as raw domain
  }
  host = host.replace(/^www\./, "");

  if (!host || !host.includes(".")) {
    return { allowed: false, reason: "not a domain" };
  }

  for (const tld of BLOCKED_TLDS) {
    if (host.endsWith(tld)) {
      return { allowed: false, reason: `blocked tld ${tld}` };
    }
  }

  const domain = rootDomain(host);
  if (BLOCKED_DOMAINS.has(domain) || BLOCKED_DOMAINS.has(host)) {
    return { allowed: false, reason: "blocked domain" };
  }

  return { allowed: true, reason: "" };
}

export function rootDomain(host: string): string {
  const parts = host.replace(/^www\./, "").split(".");
  if (parts.length <= 2) return parts.join(".");
  const lastTwo = parts.slice(-2).join(".");
  if (TWO_PART_SUFFIXES.has(lastTwo)) {
    return parts.slice(-3).join(".");
  }
  return lastTwo;
}

const NON_ARTICLE_EXTENSIONS = [
  ".pdf", ".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".zip",
  ".tar.gz", ".mp3", ".mp4", ".mov", ".wav", ".iso", ".dmg", ".exe",
  ".deb", ".whl", ".jar", ".gz", ".xz", ".7z", ".csv", ".json", ".xml",
];

export function looksLikeArticlePath(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (!/^https?:$/i.test(parsed.protocol)) return false;
    const path = parsed.pathname.toLowerCase();
    if (path === "/" || path === "") return false;
    if (NON_ARTICLE_EXTENSIONS.some((ext) => path.endsWith(ext))) return false;
    if (/\/(tag|tags|category|categories|author|archive|page|search)\//i.test(path)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}
