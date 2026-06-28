import * as cheerio from "cheerio";
import type { Element } from "domhandler";

/**
 * Fetches a web page and extracts its main content, attempting to exclude
 * header, footer, and navigation elements. This is a heuristic, HTML-parsing
 * approach -- not a full headless-browser render, so JS-rendered content
 * won't appear. Good enough for most blog/article/service pages, which is
 * the primary use case here (legal services, SaaS landing pages, etc).
 *
 * Uses cheerio (a real DOM parser) rather than regex for tag removal and
 * content-container selection -- regex matching of nested HTML tags is
 * fundamentally fragile (it can't correctly handle nesting), which is what
 * caused earlier bugs here. Regex is still used downstream only for the
 * narrow, already-tested job of converting a small selected chunk of HTML
 * into markdown-style headings/links.
 */

const REMOVE_TAGS = [
  "script", "style", "nav", "footer", "header", "aside",
  "noscript", "form", "svg", "iframe", "button",
];

const REMOVE_ROLES = ["navigation", "menu", "banner", "contentinfo"];

// Matched as substrings of class/id names. Gated by BOILERPLATE_MAX_CHARS
// below so a substring collision on a large legitimate content block (e.g.
// "sidebarGrid", "related-faqs") can never delete the whole article --
// only genuinely small chrome elements get stripped.
const BOILERPLATE_PATTERN =
  /(nav|navbar|menu|sidebar|side-bar|footer|header|masthead|breadcrumb|cookie|consent|subscribe|newsletter|social|share|sharing|related|recommend|comment|disqus|advert|advertis|sponsor|promo|popup|modal|banner|skip-link|skip-to|reference|references|ref-list|reflist|bibliography|citation|cite-list|footnote|author-info|byline|site-footer|site-header|global-nav|page-footer|page-header)/i;

const BOILERPLATE_MAX_CHARS = 2000;

/**
 * Cleans HTML and selects the richest main-content container, mirroring
 * the approach: remove chrome tags/roles, strip small boilerplate-looking
 * elements (size-guarded), then pick the largest of <main>/<article>/
 * [role=main] if it represents a meaningful share of the page -- falling
 * back to <body> otherwise. Returns the selected container's inner HTML
 * for downstream markdown conversion.
 */
function selectMainContentHtml(html: string): string {
  const $ = cheerio.load(html);

  $(REMOVE_TAGS.join(",")).remove();
  for (const role of REMOVE_ROLES) {
    $(`[role="${role}"]`).remove();
  }

  // Strip small boilerplate-looking elements (class or id match), guarded
  // by size so a substring collision on a real content wrapper can't gut
  // the page.
  $("[class], [id]").each((_, el) => {
    const node = $(el);
    const cls = node.attr("class") || "";
    const id = node.attr("id") || "";
    if (BOILERPLATE_PATTERN.test(cls) || BOILERPLATE_PATTERN.test(id)) {
      if (node.text().trim().length <= BOILERPLATE_MAX_CHARS) {
        node.remove();
      }
    }
  });

  const hasBody = $("body").length > 0;
  const bodyTextLen = hasBody ? $("body").text().trim().length : $.root().text().trim().length;

  let bestEl: Element | null = null;
  let bestLen = 0;
  $("main, article, [role='main']").each((_, el) => {
    const node = $(el);
    const len = node.text().trim().length;
    if (len > bestLen) {
      bestLen = len;
      bestEl = el;
    }
  });

  const threshold = Math.max(400, 0.4 * bodyTextLen);
  if (bestEl && bestLen >= threshold) {
    return $(bestEl).prop("outerHTML") ?? "";
  }
  return hasBody
    ? ($("body").prop("outerHTML") ?? "")
    : ($.root().prop("outerHTML") ?? "");
}

function htmlToText(html: string): string {
  let processed = html;

  // Convert heading tags to markdown-style headings BEFORE stripping all
  // tags, so heading level information survives into the plain-text output.
  // Without this, the structural checker (which expects markdown #/##/###)
  // sees zero headings even on pages with perfectly good heading hierarchy,
  // because the HTML <h1>-<h6> tags get discarded along with everything else.
  for (let level = 1; level <= 6; level++) {
    const openTagPattern = new RegExp(`<h${level}[^>]*>`, "gi");
    processed = processed.replace(openTagPattern, `\n\n${"#".repeat(level)} `);
  }

  // Convert anchor tags to markdown links [text](url) before stripping all
  // tags. Without this, every real link on a fetched page is destroyed,
  // and the structural checker's "contains a link" check always fails
  // even on pages with substantial internal linking.
  processed = processed.replace(
    /<a\s+[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (match, href, linkText) => {
      const cleanText = linkText.replace(/<[^>]+>/g, "").trim();
      if (!cleanText || !href) return cleanText || "";
      return `[${cleanText}](${href})`;
    }
  );

  return processed
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
    // Collapse stray spaces that can appear right after the # markers due
    // to the tag-to-space replacement pass above (e.g. "##  Heading").
    .replace(/^(#{1,6}) +/gm, "$1 ")
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

  const mainHtml = selectMainContentHtml(html);
  const text = htmlToText(mainHtml);
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

export type HeadingOutlineItem = {
  level: number;
  text: string;
};

/**
 * Extracts a simple heading outline (level + text) from markdown-converted
 * page text, for the scrape/summary view -- lets the person see a page's
 * actual heading structure without reading the full extracted text.
 */
export function extractHeadingOutline(text: string): HeadingOutlineItem[] {
  const lines = text.split("\n");
  const outline: HeadingOutlineItem[] = [];

  for (const line of lines) {
    const match = line.match(/^(#{1,6})\s+(.+)/);
    if (match) {
      outline.push({ level: match[1].length, text: match[2].trim() });
    }
  }

  return outline;
}

export type PageSection = {
  heading: string;
  level: number;
  bodyText: string;
};

/**
 * Splits markdown-converted page text into real {heading, level, bodyText}
 * blocks -- the actual sections of the page, not just a flat heading list.
 * This is what entity-to-section placement and the structured optimization
 * table need: a real anchor for "which section should this missing entity
 * go in," rather than handing the whole page as one string to an LLM and
 * letting it guess section boundaries itself.
 *
 * Content before the first heading (if any) is captured as a section
 * titled "Introduction" at level 0, so nothing gets silently dropped.
 */
export function splitIntoSections(text: string): PageSection[] {
  const lines = text.split("\n");
  const sections: PageSection[] = [];

  let currentHeading = "Introduction";
  let currentLevel = 0;
  let currentBody: string[] = [];

  function flush() {
    const body = currentBody.join("\n").trim();
    // Don't emit an empty "Introduction" section if the page starts
    // directly with a heading (nothing to introduce).
    if (body || currentHeading !== "Introduction") {
      sections.push({ heading: currentHeading, level: currentLevel, bodyText: body });
    }
  }

  for (const line of lines) {
    const match = line.match(/^(#{1,6})\s+(.+)/);
    if (match) {
      flush();
      currentHeading = match[2].trim();
      currentLevel = match[1].length;
      currentBody = [];
    } else {
      currentBody.push(line);
    }
  }
  flush();

  return sections.filter((s) => s.bodyText.length > 0 || s.heading !== "Introduction");
}
