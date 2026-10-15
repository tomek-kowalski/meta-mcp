import { extractPage, type PageExtract } from "./extract.js";
import type { Renderer } from "./browser.js";
import { createRateLimiter, type Clock } from "./rate-limit.js";
import { robotsPolicy } from "./robots.js";
import { isPageCandidate, normalizeUrl } from "./urls.js";

/**
 * Sequential, polite crawl of one origin to list its published pages. All I/O
 * is injected (fetcher, renderer, clock), so the logic is tested without a
 * network or a browser.
 */

export interface Fetched {
  status: number;
  text: string;
}
export type Fetcher = (url: string) => Promise<Fetched>;

export interface CrawlOptions {
  origin: string;
  userAgent: string;
  minDelayMs: number;
  maxPages: number;
  /** --limit: crawl at most N pages (a partial run, never "complete") */
  limit?: number;
  /** URLs to (re)verify besides the sitemap: known registry URLs, configured extra paths */
  extraUrls: string[];
}

export interface CrawlDeps {
  fetchText: Fetcher;
  renderer: Renderer;
  /** Time source and sleep, for the politeness delay (fake in tests) */
  clock: Clock;
  log?: (line: string) => void;
}

export type PageOutcome =
  | { url: string; ok: true; status: number | null; finalUrl: string; extract: PageExtract }
  | { url: string; ok: false; status: number | null; error: string };

export interface CrawlResult {
  startedAt: string;
  finishedAt: string;
  /** Set when the crawl couldn't run at all; nothing may be changed then. */
  aborted: string | null;
  /** All discovered pages were visited (no --limit, no cap, not aborted). */
  complete: boolean;
  sitemapUrls: string[];
  outcomes: PageOutcome[];
  skipped: { url: string; reason: string }[];
  warnings: string[];
}

/** <loc> values of a sitemap (or sitemap index). */
export function parseSitemap(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, "&"));
}

const message = (err: unknown) => (err instanceof Error ? err.message.split("\n")[0] : String(err));

export async function crawl(opts: CrawlOptions, deps: CrawlDeps): Promise<CrawlResult> {
  const log = deps.log ?? (() => undefined);
  const now = () => new Date(deps.clock.now()).toISOString();
  const result: CrawlResult = {
    startedAt: now(),
    finishedAt: now(),
    aborted: null,
    complete: false,
    sitemapUrls: [],
    outcomes: [],
    skipped: [],
    warnings: [],
  };
  const done = () => ({ ...result, finishedAt: now() });

  // 1. robots.txt. Unreachable (network error / 5xx) means "assume disallowed" (RFC 9309).
  let robotsText: string | null = null;
  try {
    const robots = await deps.fetchText(`${opts.origin}/robots.txt`);
    if (robots.status >= 200 && robots.status < 300) robotsText = robots.text;
    else if (robots.status >= 500) {
      result.aborted = `robots.txt returned HTTP ${robots.status}; not crawling (treated as disallowed)`;
      return done();
    } else result.warnings.push(`robots.txt returned HTTP ${robots.status}; treated as no restrictions`);
  } catch (err) {
    result.aborted = `robots.txt unreachable (${message(err)}); not crawling`;
    return done();
  }
  const policy = robotsPolicy(robotsText, opts.userAgent);
  const delayMs = Math.max(opts.minDelayMs, (policy.crawlDelay ?? 0) * 1000);
  if (delayMs > opts.minDelayMs) result.warnings.push(`robots.txt Crawl-delay ${policy.crawlDelay}s: using ${delayMs} ms between requests`);
  const limiter = createRateLimiter(delayMs, deps.clock);
  await limiter.wait(); // counts the robots.txt request: the next one waits the full delay

  // 2. Sitemap(s) from robots.txt, else /sitemap.xml; one level of sitemap index.
  const sources = policy.sitemaps.filter((s) => normalizeUrl(s, opts.origin, opts.origin)?.sameOrigin);
  if (!sources.length) sources.push(`${opts.origin}/sitemap.xml`);
  for (const source of sources) {
    try {
      await limiter.wait();
      const sm = await deps.fetchText(source);
      if (sm.status !== 200) {
        result.warnings.push(`sitemap ${source} returned HTTP ${sm.status}`);
        continue;
      }
      for (const loc of parseSitemap(sm.text)) {
        if (/\.xml$/i.test(loc) && sources.length < 10 && !sources.includes(loc)) sources.push(loc);
        else result.sitemapUrls.push(loc);
      }
    } catch (err) {
      result.warnings.push(`sitemap ${source} failed: ${message(err)}`);
    }
  }

  // 3. Queue: sitemap, then known/extra URLs (to re-verify them), then discovered links.
  const queue: string[] = [];
  const seen = new Set<string>();
  const enqueue = (href: string) => {
    const n = normalizeUrl(href, opts.origin, opts.origin);
    if (!n || !isPageCandidate(n) || seen.has(n.url)) return;
    seen.add(n.url);
    queue.push(n.url);
  };
  for (const url of result.sitemapUrls) enqueue(url);
  enqueue(`${opts.origin}/`);
  for (const url of opts.extraUrls) enqueue(url);

  const cap = Math.min(opts.limit ?? Number.POSITIVE_INFINITY, opts.maxPages);
  let visited = 0;
  while (queue.length && visited < cap) {
    const url = queue.shift()!;
    if (!policy.isAllowed(new URL(url).pathname)) {
      result.skipped.push({ url, reason: "disallowed by robots.txt" });
      continue;
    }
    visited += 1;
    await limiter.wait();
    log(`render ${url}`);
    try {
      const rendered = await deps.renderer.render(url);
      if (rendered.status !== null && rendered.status >= 400) {
        result.outcomes.push({ url, ok: false, status: rendered.status, error: `HTTP ${rendered.status}` });
        continue;
      }
      const finalUrl = normalizeUrl(rendered.finalUrl, url, opts.origin)?.url ?? rendered.finalUrl;
      const extract = extractPage(rendered.html, finalUrl, opts.origin);
      result.outcomes.push({ url, ok: true, status: rendered.status, finalUrl, extract });
      for (const link of [...extract.links, ...Object.values(extract.hreflang)]) enqueue(link); // language versions too
    } catch (err) {
      result.outcomes.push({ url, ok: false, status: null, error: message(err) });
    }
  }
  for (const rest of queue) result.skipped.push({ url: rest, reason: opts.limit ? "--limit reached" : "KNOWLEDGE_MAX_PAGES reached" });

  result.complete = opts.limit === undefined && queue.length === 0;
  return done();
}
