import { test } from "node:test";
import assert from "node:assert/strict";
import { businessClaim, claimsFile } from "../src/knowledge/schema.js";

const HASH = "a".repeat(64);
const base = {
  id: "service.rag",
  statement: "ForeachURL offers RAG-based solutions.",
  topic: "services",
  patterns: ["RAG"],
  publication: { facebook: "allowed", website: "allowed", editorial: "allowed" },
};

test("owner-confirmed claims need a confirmation record", () => {
  assert.equal(businessClaim.safeParse({ ...base, verification: "owner-confirmed" }).success, false);
  const ok = businessClaim.safeParse({
    ...base,
    verification: "owner-confirmed",
    confirmation: { by: "owner", date: "2026-10-14", note: "confirmed in session" },
  });
  assert.equal(ok.success, true);
});

test("published-unconfirmed claims need website evidence", () => {
  assert.equal(businessClaim.safeParse({ ...base, verification: "published-unconfirmed" }).success, false);
  const ok = businessClaim.safeParse({
    ...base,
    verification: "published-unconfirmed",
    evidence: [{ url: "https://example.com/uslugi", section: "automatyzacja", sha256: HASH }],
  });
  assert.equal(ok.success, true);
});

test("verification and publication are independent: a confirmed claim can still be prohibited per channel", () => {
  const parsed = businessClaim.parse({
    ...base,
    id: "offer.marketplace-x",
    verification: "owner-confirmed",
    confirmation: { by: "owner", date: "2026-10-14", note: "internal offer" },
    publication: { facebook: "prohibited", website: "review-required", editorial: "review-required" },
  });
  assert.equal(parsed.publication.facebook, "prohibited");
  assert.equal(parsed.verification, "owner-confirmed");
});

test("unknown permission values, unstable ids, bad hashes and unknown fields are rejected", () => {
  const pending = { ...base, verification: "pending" };
  assert.equal(businessClaim.safeParse({ ...pending, publication: { ...base.publication, facebook: "maybe" } }).success, false);
  assert.equal(businessClaim.safeParse({ ...pending, id: "Service RAG" }).success, false);
  assert.equal(
    businessClaim.safeParse({ ...pending, evidence: [{ url: "https://example.com", section: "x", sha256: "abc" }] }).success,
    false,
  );
  assert.equal(businessClaim.safeParse({ ...pending, approved: true }).success, false);
});

test("claim ids are unique within claims.json", () => {
  const claim = { ...base, verification: "pending" };
  assert.equal(claimsFile.safeParse({ version: 1, claims: [claim, claim] }).success, false);
  assert.equal(claimsFile.safeParse({ version: 1, claims: [claim] }).success, true);
});
