import type { CrawlResult, PageOutcome } from "./crawler.js";
import type { UrlRecord, UrlRegistry } from "./schema.js";
import { normalizeUrl } from "./urls.js";

/**
 * Merges a crawl into the registry of published URLs.
 *
 * - A failed request (network, timeout, browser error, 5xx) never removes a
 *   URL; it only records last_error.
 * - A URL is marked removed only after a successful check says it's gone:
 *   HTTP 404/410, or (client-rendered site) it now resolves to another page
 *   and the sitemap no longer lists it.
 * - URLs the crawl didn't reach (--limit, robots, cap) stay untouched.
 */

export type ChangeKind = "added" | "verified" | "removed" | "restored" | "alias" | "failed";

export interface PageChange {
  url: string;
  kind: ChangeKind;
  record: UrlRecord;
  outcome: PageOutcome;
}

export interface MergeResult {
  registry: UrlRegistry;
  changes: PageChange[];
}

const blank = (url: string, at: string): UrlRecord => ({
  url,
  lang: "und",
  http_status: null,
  canonical: null,
  alias_of: null,
  hreflang: {},
  anchors: [],
  first_seen: at,
  last_seen: at,
  last_verified: null,
  removed_at: null,
  last_error: null,
});

export function mergeCrawl(previous: UrlRegistry, crawl: CrawlResult, origin: string): MergeResult {
  const at = crawl.finishedAt;
  const byUrl = new Map(previous.urls.map((r) => [r.url, { ...r }]));
  const inSitemap = new Set(crawl.sitemapUrls.map((u) => normalizeUrl(u, origin, origin)?.url ?? u));
  const changes: PageChange[] = [];
  const record = (url: string, kind: ChangeKind, rec: UrlRecord, outcome: PageOutcome) => {
    byUrl.set(url, rec);
    changes.push({ url, kind, record: rec, outcome });
  };

  for (const outcome of crawl.outcomes) {
    const prev = byUrl.get(outcome.url);
    const rec: UrlRecord = prev ? { ...prev } : blank(outcome.url, at);

    if (!outcome.ok) {
      if (!prev) {
        changes.push({ url: outcome.url, kind: "failed", record: rec, outcome }); // nothing to keep
      } else if ((outcome.status === 404 || outcome.status === 410) && !prev.removed_at) {
        record(rec.url, "removed", { ...rec, http_status: outcome.status, removed_at: at, last_verified: at, last_error: null }, outcome);
      } else {
        record(rec.url, "failed", { ...rec, last_error: { at, message: outcome.error } }, outcome);
      }
      continue;
    }

    const { extract } = outcome;
    const target = extract.canonical && extract.canonical !== outcome.url ? extract.canonical : outcome.finalUrl !== outcome.url ? outcome.finalUrl : null;
    Object.assign(rec, {
      lang: extract.lang ?? rec.lang,
      http_status: outcome.status,
      canonical: extract.canonical,
      hreflang: extract.hreflang,
      last_seen: at,
      last_verified: at,
      last_error: null,
    });

    if (target) {
      // An alias, a redirect or a client-side fallback: not publishable itself.
      const wasPage = prev && !prev.alias_of && !prev.removed_at;
      Object.assign(rec, { alias_of: target, anchors: [] });
      if (wasPage && !inSitemap.has(outcome.url)) record(rec.url, "removed", { ...rec, removed_at: at }, outcome);
      else record(rec.url, "alias", rec, outcome);
      continue;
    }
    Object.assign(rec, { alias_of: null, anchors: extract.anchors });
    const kind: ChangeKind = !prev ? "added" : prev.removed_at ? "restored" : "verified";
    record(rec.url, kind, { ...rec, removed_at: null }, outcome);
  }

  return {
    registry: { version: 2, origin, urls: [...byUrl.values()].sort((a, b) => a.url.localeCompare(b.url)) },
    changes,
  };
}

/** The registry entry for a URL (normalized: no fragment, query or trailing slash). */
export function findRecord(registry: UrlRegistry, url: string): UrlRecord | undefined {
  const key = registry.origin ? (normalizeUrl(url, registry.origin, registry.origin)?.url ?? url) : url;
  return registry.urls.find((r) => r.url === key);
}

/** Age of the last complete crawl; older than staleDays means "refresh recommended". */
export function freshness(lastCompleteCrawl: string | null, now: Date, staleDays: number) {
  if (!lastCompleteCrawl) return { lastCompleteCrawl: null, ageDays: null, stale: true };
  const ageDays = Math.floor((now.getTime() - Date.parse(lastCompleteCrawl)) / 86_400_000);
  return { lastCompleteCrawl, ageDays, stale: ageDays > staleDays };
}
