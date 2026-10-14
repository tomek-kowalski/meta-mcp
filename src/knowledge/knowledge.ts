import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { KnowledgeConfig } from "./config.js";
import type { Anonymization, BusinessClaim, EvidenceRef, Manifest, UrlRecord, UrlRegistry } from "./schema.js";
import { knowledgePaths, loadAnonymization, loadClaims, loadManifest, loadRegistry } from "./store.js";
import { normalizeUrl } from "./urls.js";

/** Everything a validator or agent needs, loaded once. Read-only. */
export interface KnowledgeBase {
  config: KnowledgeConfig;
  claims: BusinessClaim[];
  registry: UrlRegistry;
  manifest: Manifest;
  anonymization: { rules: Anonymization; found: boolean };
  terms: Term[];
}

export interface Term {
  term: string;
  aliases?: string[];
  claim?: string;
}

export function loadKnowledge(config: KnowledgeConfig): KnowledgeBase {
  const paths = knowledgePaths(config.dir);
  const techFile = join(paths.facts, "technologies.md");
  return {
    config,
    claims: loadClaims(config.dir).claims,
    registry: loadRegistry(config.dir, config.origin ?? null),
    manifest: loadManifest(config.dir, config.origin ?? null),
    anonymization: loadAnonymization(config.editorialDir),
    terms: existsSync(techFile) ? parseTerms(readFileSync(techFile, "utf8")) : [],
  };
}

/** The ```json knowledge-terms block in facts/technologies.md (the curated technology dictionary). */
export function parseTerms(markdown: string): Term[] {
  const match = /```json knowledge-terms\r?\n([\s\S]*?)\r?\n```/.exec(markdown);
  if (!match) return [];
  const parsed: unknown = JSON.parse(match[1]);
  if (!Array.isArray(parsed)) throw new Error("knowledge-terms must be a JSON array");
  return parsed.map((entry, i) => {
    if (!entry || typeof entry !== "object" || typeof (entry as Term).term !== "string") {
      throw new Error(`knowledge-terms[${i}] needs a "term" string`);
    }
    return entry as Term;
  });
}

/** Claim ids and evidence cited in a curated Markdown file: [claim: id], [ev: url#section]. */
export function factCitations(markdown: string): { claims: string[]; evidence: { url: string; section: string }[] } {
  // Citations in code (`[claim: id]` examples, fenced blocks) are documentation, not citations.
  markdown = markdown.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  const claims = [...markdown.matchAll(/\[claim:\s*([a-z0-9.-]+)\]/g)].map((m) => m[1]);
  const evidence = [...markdown.matchAll(/\[ev:\s*(\S+?)#([^\]\s]+)\]/g)].map((m) => ({ url: m[1], section: m[2] }));
  return { claims, evidence };
}

// ---- evidence state -----------------------------------------------------------

/**
 * valid           the cited section still has the reviewed hash
 * changed         the section text changed since review: re-verify (invalidates the claim until then)
 * section-missing the page exists but the section is gone: invalidated
 * page-removed    the page was removed: invalidated
 * alias           the URL is now an alias of another page: invalidated
 * page-unknown    the URL isn't in the registry: invalidated
 * unverifiable    the page's last check failed; the earlier evidence still stands (stale, not invalid)
 */
export type EvidenceState = "valid" | "changed" | "section-missing" | "page-removed" | "alias" | "page-unknown" | "unverifiable";
export const INVALIDATING: ReadonlySet<EvidenceState> = new Set(["changed", "section-missing", "page-removed", "alias", "page-unknown"]);

export function findRecord(registry: UrlRegistry, url: string): UrlRecord | undefined {
  const n = registry.origin ? normalizeUrl(url, registry.origin, registry.origin) : null;
  const key = n?.url ?? url;
  return registry.urls.find((r) => r.url === key);
}

export function evidenceState(ref: EvidenceRef, registry: UrlRegistry): { state: EvidenceState; record?: UrlRecord } {
  const record = findRecord(registry, ref.url);
  if (!record) return { state: "page-unknown" };
  if (record.removed_at) return { state: "page-removed", record };
  if (record.alias_of) return { state: "alias", record };
  const hash = record.sections[ref.section];
  if (!hash) return { state: "section-missing", record };
  if (hash !== ref.sha256) return { state: "changed", record };
  if (record.last_error) return { state: "unverifiable", record };
  return { state: "valid", record };
}

export function claimEvidence(claim: BusinessClaim, registry: UrlRegistry) {
  const refs = claim.evidence.map((ref) => ({ ref, ...evidenceState(ref, registry) }));
  const invalid = refs.filter((r) => INVALIDATING.has(r.state));
  return { refs, invalid, invalidated: invalid.length > 0 };
}

// ---- freshness ------------------------------------------------------------------

export function freshness(manifest: Manifest, now: Date, staleDays: number) {
  const last = manifest.last_complete_crawl_at;
  if (!last) return { lastCompleteCrawl: null, ageDays: null, stale: true };
  const ageDays = Math.floor((now.getTime() - Date.parse(last)) / 86_400_000);
  return { lastCompleteCrawl: last, ageDays, stale: ageDays > staleDays };
}

// ---- pattern matching ------------------------------------------------------------

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A claim/term pattern as a RegExp: "/re/flags" is a regular expression,
 * anything else a case-insensitive literal bounded by non-letters.
 */
export function patternRegExp(pattern: string): RegExp {
  const re = /^\/(.+)\/([gimsuy]*)$/s.exec(pattern);
  if (re) return new RegExp(re[1], re[2].includes("g") ? re[2] : `${re[2]}g`);
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(pattern)}(?![\\p{L}\\p{N}])`, "giu");
}

/** Matches of any pattern in text: [{ pattern, match, index }] */
export function findPatterns(patterns: string[], text: string) {
  const found: { pattern: string; match: string; index: number }[] = [];
  for (const pattern of patterns) {
    for (const m of text.matchAll(patternRegExp(pattern))) found.push({ pattern, match: m[0], index: m.index ?? 0 });
  }
  return found;
}

/** The text around a match, for reports. */
export const excerptAt = (text: string, index: number, length: number, radius = 70) =>
  `${index > radius ? "…" : ""}${text.slice(Math.max(0, index - radius), index + length + radius).replace(/\s+/g, " ").trim()}${index + length + radius < text.length ? "…" : ""}`;
