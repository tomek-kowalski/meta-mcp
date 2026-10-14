import type { CrawlResult, PageOutcome } from "./crawler.js";
import { contentHash, sectionHash, sha256 } from "./extract.js";
import type { UrlRecord, UrlRegistry } from "./schema.js";
import { sectionsOf } from "./snapshot.js";
import { evidenceFileFor } from "./urls.js";

/**
 * Merges a crawl into the published-URL registry.
 *
 * Preservation rules:
 * - A failed request (network, timeout, browser error, 5xx) never removes a
 *   URL and never replaces its evidence; it records last_error only.
 * - A URL is marked removed only after a successful check says it's gone:
 *   HTTP 404/410, or (for a client-rendered site) it now resolves to another
 *   page and the sitemap no longer lists it.
 * - URLs the crawl didn't reach (--limit, robots, cap) stay untouched.
 */

export interface PageChange {
  url: string;
  lang: string;
  kind: "added" | "changed" | "unchanged" | "removed" | "alias" | "failed" | "restored";
  previous?: UrlRecord;
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
  kind: "page",
  http_status: null,
  canonical: null,
  alias_of: null,
  hreflang: {},
  anchors: [],
  sections: {},
  content_sha256: null,
  evidence_file: null,
  first_seen: at,
  last_seen: at,
  last_verified: null,
  removed_at: null,
  last_error: null,
});

export function mergeCrawl(previous: UrlRegistry, crawl: CrawlResult, origin: string): MergeResult {
  const at = crawl.finishedAt;
  const byUrl = new Map(previous.urls.map((r) => [r.url, { ...r }]));
  const inSitemap = new Set(crawl.sitemapUrls.map((u) => u.replace(/\/+$/, "") || u));
  const changes: PageChange[] = [];

  for (const outcome of crawl.outcomes) {
    const prev = byUrl.get(outcome.url);
    const record: UrlRecord = prev ? { ...prev } : blank(outcome.url, at);

    if (!outcome.ok) {
      const gone = outcome.status === 404 || outcome.status === 410;
      if (gone && prev && !prev.removed_at) {
        record.http_status = outcome.status;
        record.removed_at = at;
        record.last_verified = at;
        record.last_error = null;
        byUrl.set(record.url, record);
        changes.push({ url: record.url, lang: record.lang, kind: "removed", previous: prev, record, outcome });
      } else if (prev) {
        record.last_error = { at, message: outcome.error };
        byUrl.set(record.url, record);
        changes.push({ url: record.url, lang: record.lang, kind: "failed", previous: prev, record, outcome });
      } else {
        // Never seen and failing: nothing to preserve, nothing to add.
        changes.push({ url: outcome.url, lang: "und", kind: "failed", record, outcome });
      }
      continue;
    }

    record.last_seen = at;
    record.last_verified = at;
    record.last_error = null;

    if (outcome.kind === "text") {
      record.kind = "text";
      record.lang = outcome.lang;
      record.http_status = outcome.status;
      record.canonical = outcome.url;
      record.alias_of = null;
      record.sections = { _text: sectionHash({ heading: null, blocks: [outcome.text] }) };
      record.content_sha256 = sha256(outcome.text);
      record.evidence_file = evidenceFileFor(outcome.url, outcome.lang);
    } else {
      const { extract } = outcome;
      const canonical = extract.canonical;
      const target = canonical && canonical !== outcome.url ? canonical : outcome.finalUrl !== outcome.url ? outcome.finalUrl : null;
      record.kind = "page";
      record.lang = extract.lang ?? record.lang;
      record.http_status = outcome.status;
      record.canonical = canonical;
      record.hreflang = extract.hreflang;
      if (target) {
        // An alias, a redirect or a client-side fallback: not publishable itself.
        const wasPage = prev && !prev.alias_of && !prev.removed_at && prev.content_sha256 !== null;
        record.alias_of = target;
        record.anchors = [];
        record.sections = {};
        if (wasPage && !inSitemap.has(outcome.url)) {
          record.removed_at = at;
          byUrl.set(record.url, record);
          changes.push({ url: record.url, lang: record.lang, kind: "removed", previous: prev, record, outcome });
        } else {
          byUrl.set(record.url, record);
          changes.push({ url: record.url, lang: record.lang, kind: "alias", previous: prev, record, outcome });
        }
        continue;
      }
      record.alias_of = null;
      record.anchors = extract.anchors;
      record.sections = sectionsOf(extract.sections);
      record.content_sha256 = contentHash(extract);
      record.evidence_file = evidenceFileFor(outcome.url, record.lang);
    }

    let kind: PageChange["kind"];
    if (!prev) kind = "added";
    else if (prev.removed_at) kind = "restored";
    else kind = prev.content_sha256 === record.content_sha256 ? "unchanged" : "changed";
    record.removed_at = null;
    byUrl.set(record.url, record);
    changes.push({ url: record.url, lang: record.lang, kind, previous: prev, record, outcome });
  }

  return {
    registry: {
      version: 1,
      origin,
      urls: [...byUrl.values()].sort((a, b) => a.url.localeCompare(b.url)),
    },
    changes,
  };
}
