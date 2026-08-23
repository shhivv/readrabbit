export interface ArticleAttribution {
  primary: string;
  secondary: string;
  hasAuthor: boolean;
}

function compactWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

const NON_AUTHOR_LABEL = /^(?:posted on|published by|written by|admin|administrator|editor|staff|unknown|anonymous|\?)$/i;

export function cleanAuthorName(value: string): string {
  let author = compactWhitespace(value).replace(/^by\s+/i, "");
  author = author.replace(/\s+commented(?:\s+on.*)?$/i, "");
  if (NON_AUTHOR_LABEL.test(author)) return "";
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
    siteName.length > 0 && normalizeAuthorKey(author) === normalizeAuthorKey(siteName);

  return {
    primary: author,
    secondary: sameAsSite ? "" : siteName,
    hasAuthor: true,
  };
}
