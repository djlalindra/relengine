/**
 * Fetches a web page and extracts its main content, attempting to exclude
 * header, footer, and navigation elements. This is a heuristic, HTML-parsing
 * approach -- not a full headless-browser render, so JS-rendered content
 * won't appear. Good enough for most blog/article/service pages, which is
 * the primary use case here (legal services, SaaS landing pages, etc).
 */

const HEADER_FOOTER_TAG_PATTERNS = [
  /<header[\s\S]*?<\/header>/gi,
  /<footer[\s\S]*?<\/footer>/gi,
  /<nav[\s\S]*?<\/nav>/gi,
  /<script[\s\S]*?<\/script>/gi,
  /<style[\s\S]*?<\/style>/gi,
  /<noscript[\s\S]*?<\/noscript>/gi,
  // Common class/id-based header/footer/nav wrappers that aren't semantic tags
  /<[^>]+\b(?:class|id)\s*=\s*["'][^"']*\b(?:site-header|page-header|main-header|site-footer|page-footer|main-footer|navbar|nav-menu|main-nav|cookie-banner|cookie-consent)\b[^"']*["'][^>]*>[\s\S]*?<\/(?:div|section|aside)>/gi,
];

function stripHeaderFooterNav(html: string): string {
  let cleaned = html;
  for (const pattern of HEADER_FOOTER_TAG_PATTERNS) {
    cleaned = cleaned.replace(pattern, " ");
  }
  return cleaned;
}

function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<\/h[1-6]>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export type PageContent = {
  url: string;
  title: string;
  text: string;
  wordCount: number;
  fetchError?: string;
};

function getFetchserpApiKey(): string | undefined {
  return process.env.FETCHSERP_API_KEY;
}

/**
 * Fetches the FULL body content of a page (not a snippet), with header/
 * footer/nav stripped out. Tries fetchSERP's no-JS scraping endpoint first
 * if a key is configured (better at getting past basic bot protection),
 * falls back to a direct fetch otherwise.
 */
export async function fetchFullPageContent(url: string): Promise<PageContent> {
  const apiKey = getFetchserpApiKey();

  let html = "";
  let fetchError: string | undefined;

  try {
    if (apiKey) {
      const response = await fetch(
        `https://www.fetchserp.com/api/v1/scrape_webpage_nojs?` +
          new URLSearchParams({ url }),
        {
          headers: {
            accept: "application/json",
            authorization: `Bearer ${apiKey}`,
          },
        }
      );
      if (response.ok) {
        const data = await response.json();
        html = data?.web_page?.html ?? "";
      }
    }

    if (!html) {
      const direct = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; ContentAuditBot/1.0)",
        },
      });
      if (direct.ok) {
        html = await direct.text();
      } else {
        fetchError = `HTTP ${direct.status} when fetching page directly.`;
      }
    }
  } catch (err) {
    fetchError = err instanceof Error ? err.message : "Unknown fetch error.";
  }

  if (!html) {
    return {
      url,
      title: url,
      text: "",
      wordCount: 0,
      fetchError: fetchError ?? "Could not retrieve page content.",
    };
  }

  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : url;

  const stripped = stripHeaderFooterNav(html);
  const text = htmlToText(stripped);
  const wordCount = text.split(/\s+/).filter(Boolean).length;

  return { url, title, text, wordCount };
}

/**
 * Fetches full content for multiple URLs sequentially (to avoid hammering
 * fetchSERP rate limits / multiple simultaneous outbound requests from one
 * serverless invocation). Each URL's failure is captured independently.
 */
export async function fetchMultiplePages(urls: string[]): Promise<PageContent[]> {
  const results: PageContent[] = [];
  for (const url of urls) {
    results.push(await fetchFullPageContent(url));
  }
  return results;
}
