import { test } from "node:test";
import assert from "node:assert/strict";
import { claimEvidence, evidenceState, factCitations, findPatterns, freshness, parseTerms } from "../src/knowledge/knowledge.js";
import type { BusinessClaim, UrlRecord, UrlRegistry } from "../src/knowledge/schema.js";

const ORIGIN = "https://example.com";
const H = (c: string) => c.repeat(64);
const at = "2026-10-14T10:00:00.000Z";

export function record(path: string, extra: Partial<UrlRecord> = {}): UrlRecord {
  return {
    url: `${ORIGIN}${path}`,
    lang: "pl",
    kind: "page",
    http_status: 200,
    canonical: `${ORIGIN}${path}`,
    alias_of: null,
    hreflang: {},
    anchors: ["automatyzacja"],
    sections: { automatyzacja: H("a") },
    content_sha256: H("c"),
    evidence_file: "pl/x.md",
    first_seen: at,
    last_seen: at,
    last_verified: at,
    removed_at: null,
    last_error: null,
    ...extra,
  };
}

const registry = (records: UrlRecord[]): UrlRegistry => ({ version: 1, origin: ORIGIN, urls: records });
const ref = (path: string, section = "automatyzacja", sha = H("a")) => ({ url: `${ORIGIN}${path}`, section, sha256: sha });

test("evidence state: valid, changed, section-missing, removed, alias, unknown", () => {
  const reg = registry([
    record("/uslugi"),
    record("/old", { removed_at: at }),
    record("/opinia", { alias_of: `${ORIGIN}/`, sections: {} }),
  ]);
  assert.equal(evidenceState(ref("/uslugi"), reg).state, "valid");
  assert.equal(evidenceState(ref("/uslugi/"), reg).state, "valid", "URL normalized");
  assert.equal(evidenceState(ref("/uslugi", "automatyzacja", H("b")), reg).state, "changed");
  assert.equal(evidenceState(ref("/uslugi", "gone"), reg).state, "section-missing");
  assert.equal(evidenceState(ref("/old"), reg).state, "page-removed");
  assert.equal(evidenceState(ref("/opinia"), reg).state, "alias");
  assert.equal(evidenceState(ref("/never"), reg).state, "page-unknown");
});

test("a failed re-check makes evidence stale (unverifiable), not invalid", () => {
  const reg = registry([record("/uslugi", { last_error: { at, message: "Timeout" } })]);
  const claim = { id: "x", evidence: [ref("/uslugi")] } as unknown as BusinessClaim;
  const ev = claimEvidence(claim, reg);
  assert.equal(ev.refs[0].state, "unverifiable");
  assert.equal(ev.invalidated, false);
});

test("a changed section invalidates the claim until it's re-verified", () => {
  const reg = registry([record("/uslugi", { sections: { automatyzacja: H("d") } })]);
  const claim = { id: "x", evidence: [ref("/uslugi")] } as unknown as BusinessClaim;
  assert.equal(claimEvidence(claim, reg).invalidated, true);
});

test("freshness: age in days, stale over the threshold, never crawled is stale", () => {
  const now = new Date("2026-10-30T10:00:00Z");
  assert.deepEqual(freshness({ version: 1, origin: ORIGIN, last_complete_crawl_at: at, runs: [] }, now, 14), {
    lastCompleteCrawl: at,
    ageDays: 16,
    stale: true,
  });
  assert.equal(freshness({ version: 1, origin: ORIGIN, last_complete_crawl_at: at, runs: [] }, new Date("2026-10-20T10:00:00Z"), 14).stale, false);
  assert.equal(freshness({ version: 1, origin: ORIGIN, last_complete_crawl_at: null, runs: [] }, now, 14).stale, true);
});

test("patterns: case-insensitive literals with letter boundaries (Polish-aware), or /regex/", () => {
  const text = "Wdrażamy RAG i agentów AI. Base.com oraz BaseLinker. Słowo FRAGMENT nie liczy się.";
  assert.deepEqual(findPatterns(["rag"], text).map((m) => m.match), ["RAG"]);
  assert.deepEqual(findPatterns(["Base.com"], text).map((m) => m.match), ["Base.com"]);
  assert.deepEqual(findPatterns(["/base\\s?linker/i"], text).map((m) => m.match), ["BaseLinker"]);
  assert.deepEqual(findPatterns(["agent"], text), [], "agentów is a different word");
  assert.deepEqual(findPatterns(["/agent(?:ów|y|i)?/i"], text).map((m) => m.match), ["agentów"]);
});

test("technology dictionary: parsed from the knowledge-terms block; invalid entries rejected", () => {
  const md = "# T\n\n```json knowledge-terms\n[{\"term\":\"WooCommerce\",\"aliases\":[\"Woo\"]},{\"term\":\"RAG\",\"claim\":\"service.rag\"}]\n```\n";
  assert.deepEqual(parseTerms(md), [{ term: "WooCommerce", aliases: ["Woo"] }, { term: "RAG", claim: "service.rag" }]);
  assert.deepEqual(parseTerms("# no block"), []);
  assert.throws(() => parseTerms("```json knowledge-terms\n[{\"name\":\"x\"}]\n```"));
});

test("fact citations: [claim: id] and [ev: url#section], ignoring examples in code", () => {
  const md = "RAG [claim: service.rag], see [ev: https://example.com/uslugi#automatyzacja].\n\nFormat: `[claim: id]`\n```\n[claim: fenced]\n```";
  assert.deepEqual(factCitations(md), {
    claims: ["service.rag"],
    evidence: [{ url: "https://example.com/uslugi", section: "automatyzacja" }],
  });
});
