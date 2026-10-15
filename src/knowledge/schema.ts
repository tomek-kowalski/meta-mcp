import { z } from "zod";

/**
 * Schemas of the generated files in the knowledge repository: the registry of
 * published website URLs (used to check links in content before publishing)
 * and the crawl manifest.
 */

const timestamp = z.iso.datetime();

export const urlRecord = z
  .object({
    url: z.url(),
    lang: z.string().min(2),
    http_status: z.number().int().nullable(),
    canonical: z.string().nullable(),
    /** Set when the page's canonical or final URL is another page: not publishable itself. */
    alias_of: z.string().nullable(),
    hreflang: z.record(z.string(), z.string()),
    /** Element ids on the page: valid #fragments */
    anchors: z.array(z.string()),
    first_seen: timestamp,
    last_seen: timestamp,
    last_verified: timestamp.nullable(),
    removed_at: timestamp.nullable(),
    last_error: z.object({ at: timestamp, message: z.string() }).strict().nullable(),
  })
  .strict();
export type UrlRecord = z.infer<typeof urlRecord>;

export const urlRegistry = z
  .object({ version: z.literal(2), origin: z.string().nullable(), urls: z.array(urlRecord) })
  .strict();
export type UrlRegistry = z.infer<typeof urlRegistry>;

export const crawlRun = z
  .object({
    started_at: timestamp,
    finished_at: timestamp,
    origin: z.string(),
    user_agent: z.string(),
    complete: z.boolean(),
    limit: z.number().int().nullable(),
    pages_ok: z.number().int(),
    pages_failed: z.number().int(),
    pages_skipped: z.number().int(),
  })
  .strict();
export type CrawlRun = z.infer<typeof crawlRun>;

export const manifest = z
  .object({
    version: z.literal(2),
    origin: z.string().nullable(),
    /** Last run that covered the whole site (no --limit, no failures). */
    last_complete_crawl_at: timestamp.nullable(),
    runs: z.array(crawlRun),
  })
  .strict();
export type Manifest = z.infer<typeof manifest>;

export const emptyRegistry = (origin: string | null): UrlRegistry => ({ version: 2, origin, urls: [] });
export const emptyManifest = (origin: string | null): Manifest => ({ version: 2, origin, last_complete_crawl_at: null, runs: [] });
