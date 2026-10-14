import { sha256 } from "./extract.js";
import { extractPage, type PageExtract } from "./extract.js";
import type { Renderer } from "./browser.js";
import { createRateLimiter, type Clock } from "./rate-limit.js";
import { robotsPolicy } from "./robots.js";
import { isPageCandidate, normalizeUrl } from "./urls.js";

/**
 * Sequential, polite crawl of one origin. All I/O is injected (fetcher,
 * renderer, rate limiter, clock), so the logic is tested without a network
 * or a browser.
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
  textResources: { path: string; lang: string }[];
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
  | { kind: "page"; url: string; ok: true; status: number | null; finalUrl: string; extract: PageExtract; source: Source }
  | { kind: "text"; url: string; ok: true; status: number; lang: string; text: string; source: Source }
  | { kind: "page" | "text"; url: string; ok: false; status: number | null; error: string; source: Source };

export type Source = "sitemap" | "link" | "known" | "text-resource";

export interface CrawlResult {
  startedAt: string;
  finishedAt: string;
  robotsSha256: string | null;
  sitemapSha256: string | null;
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

export async function crawl(opts: CrawlOptions, deps: CrawlDeps): Promise<CrawlResult> {
  const log = deps.log ?? (() => undefined);
  const now = () => new Date(deps.clock.now()).toISOString();
  const startedAt = now();
  const result: CrawlResult = {
    startedAt,
    finishedAt: startedAt,
    robotsSha256: null,
    sitemapSha256: null,
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
    if (robots.status >= 200 && robots.status < 300) {
      robotsText = robots.text;
      result.robotsSha256 = sha256(robots.text);
    } else if (robots.status >= 500) {
      result.aborted = `robots.txt returned HTTP ${robots.status}; not crawling (treated as disallowed)`;
      return done();
    } else {
      result.warnings.push(`robots.txt returned HTTP ${robots.status}; treated as no restrictions`);
    }
  } catch (err) {
    result.aborted = `robots.txt unreachable (${err instanceof Error ? err.message : String(err)}); not crawling`;
    return done();
  }
  const policy = robotsPolicy(robotsText, opts.userAgent);
  const delayMs = Math.max(opts.minDelayMs, (policy.crawlDelay ?? 0) * 1000);
  if (delayMs > opts.minDelayMs) {
    result.warnings.push(`robots.txt Crawl-delay ${policy.crawlDelay}s is longer than the configured delay; using ${delayMs} ms`);
  }
  const limiter = createRateLimiter(delayMs, deps.clock);
  const politeWait = () => limiter.wait();
  await politeWait(); // counts the robots.txt request: the next one waits the full delay

  // 2. Sitemap(s) from robots.txt, else /sitemap.xml; one level of sitemap index.
  const sitemapSources = policy.sitemaps.filter((s) => normalizeUrl(s, opts.origin, opts.origin)?.sameOrigin);
  if (!sitemapSources.length) sitemapSources.push(`${opts.origin}/sitemap.xml`);
  const sitemapTexts: string[] = [];
  for (const source of sitemapSources) {
    try {
      await politeWait();
      const sm = await deps.fetchText(source);
      if (sm.status !== 200) {
        result.warnings.push(`sitemap ${source} returned HTTP ${sm.status}`);
        continue;
      }
      sitemapTexts.push(sm.text);
      for (const loc of parseSitemap(sm.text)) {
        if (/\.xml$/i.test(loc) && sitemapSources.length < 10 && !sitemapSources.includes(loc)) sitemapSources.push(loc);
        else result.sitemapUrls.push(loc);
      }
    } catch (err) {
      result.warnings.push(`sitemap ${source} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  result.sitemapSha256 = sitemapTexts.length ? sha256(sitemapTexts.join("\n")) : null;

  // 3. Queue: sitemap, then known/extra URLs (to re-verify them), then discovered links.
  const queue: { url: string; source: Source }[] = [];
  const seen = new Set<string>();
  const enqueue = (href: string, source: Source) => {
    const n = normalizeUrl(href, opts.origin, opts.origin);
    if (!n || !isPageCandidate(n) || seen.has(n.url)) return;
    seen.add(n.url);
    queue.push({ url: n.url, source });
  };
  for (const url of result.sitemapUrls) enqueue(url, "sitemap");
  enqueue(`${opts.origin}/`, "link");
  for (const url of opts.extraUrls) enqueue(url, "known");

  const cap = Math.min(opts.limit ?? Number.POSITIVE_INFINITY, opts.maxPages);
  let visited = 0;
  while (queue.length && visited < cap) {
    const { url, source } = queue.shift()!;
    const path = new URL(url).pathname;
    if (!policy.isAllowed(path)) {
      result.skipped.push({ url, reason: "disallowed by robots.txt" });
      continue;
    }
    visited += 1;
    await politeWait();
    log(`render ${url}`);
    try {
      const rendered = await deps.renderer.render(url);
      if (rendered.status !== null && rendered.status >= 400) {
        result.outcomes.push({ kind: "page", url, ok: false, status: rendered.status, error: `HTTP ${rendered.status}`, source });
        continue;
      }
      const finalUrl = normalizeUrl(rendered.finalUrl, url, opts.origin)?.url ?? rendered.finalUrl;
      const extract = extractPage(rendered.html, finalUrl, opts.origin);
      result.outcomes.push({ kind: "page", url, ok: true, status: rendered.status, finalUrl, extract, source });
      for (const link of extract.links) if (link.internal) enqueue(link.href, "link");
    } catch (err) {
      result.outcomes.push({ kind: "page", url, ok: false, status: null, error: err instanceof Error ? err.message.split("\n")[0] : String(err), source });
    }
  }
  if (queue.length) {
    for (const rest of queue) result.skipped.push({ url: rest.url, reason: opts.limit ? "--limit reached" : "KNOWLEDGE_MAX_PAGES reached" });
  }

  // 4. Plain-text resources (e.g. /llms.txt), fetched without the browser.
  for (const resource of opts.textResources) {
    const url = `${opts.origin}${resource.path}`;
    if (!policy.isAllowed(resource.path)) {
      result.skipped.push({ url, reason: "disallowed by robots.txt" });
      continue;
    }
    if (opts.limit !== undefined) {
      result.skipped.push({ url, reason: "--limit run: text resources not fetched" });
      continue;
    }
    await politeWait();
    try {
      const res = await deps.fetchText(url);
      if (res.status === 200) result.outcomes.push({ kind: "text", url, ok: true, status: 200, lang: resource.lang, text: res.text, source: "text-resource" });
      else result.outcomes.push({ kind: "text", url, ok: false, status: res.status, error: `HTTP ${res.status}`, source: "text-resource" });
    } catch (err) {
      result.outcomes.push({ kind: "text", url, ok: false, status: null, error: err instanceof Error ? err.message : String(err), source: "text-resource" });
    }
  }

  result.complete = opts.limit === undefined && queue.length === 0;
  return done();
}
