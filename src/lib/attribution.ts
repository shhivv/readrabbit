export interface ArticleAttribution {
  primary: string;
  secondary: string;
  hasAuthor: boolean;
}

function compactWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

const NON_AUTHOR_LABEL =
  /^(?:posted on|published by|written by|admin|administrator|editor|staff|unknown|anonymous|\?)$/i;
const AGGREGATOR_SUBMITTER = /^[^\s]+\.[a-z]{2,}\s+(?:via|by)\s+\S+$/i;
const TRAILING_NEWS_DATE =
  /\s+(?:·\s*)?(?:posted|published|updated|last updated)\b.*$/i;
const TRAILING_CALENDAR_DATE =
  /\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2},\s+\d{4}.*$/i;
const HOSTNAME_BYLINE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/.*)?$/i;

export function cleanAuthorName(value: string): string {
  let author = compactWhitespace(value).replace(/^by\s+/i, "");
  const featuredBy = author.match(/^featuring\b.*?\.\s*by\s+(.+?)(?:\s+on)?$/i);
  if (featuredBy) author = featuredBy[1];
  const publishedBy = author.match(
    /^published by\s+(.+?)\s+view all posts by\b/i,
  );
  if (publishedBy) author = publishedBy[1];
  const transportedName = author.match(/^\S+@\S+\s+\(([^)]+)\)$/i);
  if (transportedName) author = transportedName[1];
  else author = author.replace(/^\S+@\S+\s+/, "");
  author = author.replace(/\s+commented(?:\s+on.*)?$/i, "");
  author = author.replace(TRAILING_NEWS_DATE, "");
  author = author.replace(TRAILING_CALENDAR_DATE, "");
  const newsSegments = author.split(/\s+·\s+/);
  if (
    newsSegments.length > 1 &&
    newsSegments
      .slice(1)
      .some((part) => /\b(?:news|posted|updated)\b/i.test(part))
  ) {
    author = newsSegments[0];
  }
  author = compactWhitespace(author);
  if (AGGREGATOR_SUBMITTER.test(author)) return "";
  if (NON_AUTHOR_LABEL.test(author)) return "";
  author = author.replace(/\s+on$/i, "");
  if (/\bstaff$/i.test(author) || /(?:'s|s)?\s*blog$/i.test(author)) return "";
  if (HOSTNAME_BYLINE.test(author)) return "";
  return author;
}

/**
 * Stable key used for author preferences. Display casing and accidental feed
 * whitespace should not create separate identities for the same byline.
 */
export function normalizeAuthorKey(author: string): string {
  return cleanAuthorName(author).toLocaleLowerCase("en-US");
}

/**
 * Prefer a real byline over the publication name. Multi-author publications
 * remain identifiable through the quieter secondary label.
 */
export function getArticleAttribution(article: {
  author: string;
  site_name: string;
}): ArticleAttribution {
  const author = cleanAuthorName(article.author);
  const siteName = compactWhitespace(article.site_name);

  if (!author) {
    return { primary: siteName, secondary: "", hasAuthor: false };
  }

  const sameAsSite =
    siteName.length > 0 &&
    normalizeAuthorKey(author) === normalizeAuthorKey(siteName);

  return {
    primary: author,
    secondary: sameAsSite ? "" : siteName,
    hasAuthor: true,
  };
}
