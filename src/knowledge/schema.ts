import { z } from "zod";

/**
 * Schemas of the knowledge repository files. Verification (is it true?) and
 * publication permission (may a channel say it?) are independent dimensions.
 */

export const CHANNELS = ["facebook", "website", "editorial"] as const;
export type Channel = (typeof CHANNELS)[number];

export const VERIFICATION = ["owner-confirmed", "published-unconfirmed", "pending"] as const;
export type VerificationStatus = (typeof VERIFICATION)[number];

export const PERMISSIONS = ["allowed", "review-required", "prohibited"] as const;
export type PublicationPermission = (typeof PERMISSIONS)[number];

const timestamp = z.iso.datetime();
const day = z.iso.date();

/** Stable claim id: lowercase words joined by dots or dashes, e.g. service.rag */
export const claimId = z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/, "claim id must be lowercase words joined by . or -");

export const evidenceRef = z
  .object({
    /** Canonical page URL as in evidence/urls.json */
    url: z.url(),
    /** Section key from the evidence snapshot (anchor id, or h-<slug>, or _top) */
    section: z.string().min(1),
    /** sha256 of that section's normalized text when the claim was reviewed */
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    /** Optional supporting excerpt (verbatim from the evidence) */
    excerpt: z.string().optional(),
  })
  .strict();
export type EvidenceRef = z.infer<typeof evidenceRef>;

export const businessClaim = z
  .object({
    id: claimId,
    statement: z.string().min(1),
    topic: z.enum(["company", "services", "technologies", "segments", "positioning", "messaging", "restrictions"]),
    /**
     * Terms that mean a text makes or touches this claim (case-insensitive
     * literals; a value written as /regex/flags is a regular expression).
     */
    patterns: z.array(z.string().min(1)).default([]),
    verification: z.enum(VERIFICATION),
    confirmation: z
      .object({ by: z.literal("owner"), date: day, note: z.string().min(1) })
      .strict()
      .optional(),
    publication: z.object({ facebook: z.enum(PERMISSIONS), website: z.enum(PERMISSIONS), editorial: z.enum(PERMISSIONS) }).strict(),
    evidence: z.array(evidenceRef).default([]),
    reviewed_at: day.optional(),
    notes: z.string().optional(),
  })
  .strict()
  .superRefine((claim, ctx) => {
    if (claim.verification === "owner-confirmed" && !claim.confirmation) {
      ctx.addIssue({ code: "custom", message: `${claim.id}: owner-confirmed claims need a confirmation record` });
    }
    if (claim.verification === "published-unconfirmed" && claim.evidence.length === 0) {
      ctx.addIssue({ code: "custom", message: `${claim.id}: published-unconfirmed claims need website evidence` });
    }
  });
export type BusinessClaim = z.infer<typeof businessClaim>;

export const claimsFile = z
  .object({ version: z.literal(1), claims: z.array(businessClaim) })
  .strict()
  .superRefine((file, ctx) => {
    const seen = new Set<string>();
    for (const claim of file.claims) {
      if (seen.has(claim.id)) ctx.addIssue({ code: "custom", message: `duplicate claim id ${claim.id}` });
      seen.add(claim.id);
    }
  });
export type ClaimsFile = z.infer<typeof claimsFile>;

export const urlRecord = z
  .object({
    url: z.url(),
    lang: z.string().min(2),
    kind: z.enum(["page", "text"]),
    http_status: z.number().int().nullable(),
    canonical: z.string().nullable(),
    /** Set when the page's canonical or final URL is another page: not publishable itself. */
    alias_of: z.string().nullable(),
    hreflang: z.record(z.string(), z.string()),
    anchors: z.array(z.string()),
    sections: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)),
    content_sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    evidence_file: z.string().nullable(),
    first_seen: timestamp,
    last_seen: timestamp,
    last_verified: timestamp.nullable(),
    removed_at: timestamp.nullable(),
    last_error: z.object({ at: timestamp, message: z.string() }).strict().nullable(),
  })
  .strict();
export type UrlRecord = z.infer<typeof urlRecord>;

export const urlRegistry = z
  .object({ version: z.literal(1), origin: z.string().nullable(), urls: z.array(urlRecord) })
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
    robots_sha256: z.string().nullable(),
    sitemap_sha256: z.string().nullable(),
    pages_ok: z.number().int(),
    pages_failed: z.number().int(),
    pages_skipped: z.number().int(),
    report: z.string().nullable(),
  })
  .strict();
export type CrawlRun = z.infer<typeof crawlRun>;

export const manifest = z
  .object({
    version: z.literal(1),
    origin: z.string().nullable(),
    /** Last run that covered the whole site (no --limit) without aborting. */
    last_complete_crawl_at: timestamp.nullable(),
    runs: z.array(crawlRun),
  })
  .strict();
export type Manifest = z.infer<typeof manifest>;

/** editorial/anonymization.json (read-only for the knowledge system). */
export const anonymization = z
  .object({
    version: z.literal(1),
    _comment: z.string().optional(),
    clients: z.array(z.union([z.string(), z.object({ name: z.string(), aliases: z.array(z.string()).optional(), note: z.string().optional() })])),
    domains: z.array(z.string()),
    identifiers: z.array(z.string()),
    exclude: z.array(z.union([z.string(), z.object({ term: z.string(), note: z.string().optional() })])),
  })
  .passthrough();
export type Anonymization = z.infer<typeof anonymization>;

export const emptyRegistry = (origin: string | null): UrlRegistry => ({ version: 1, origin, urls: [] });
export const emptyManifest = (origin: string | null): Manifest => ({ version: 1, origin, last_complete_crawl_at: null, runs: [] });
