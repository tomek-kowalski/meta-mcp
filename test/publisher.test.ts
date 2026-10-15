import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkDraft, structureOf, type CheckContext } from "../src/publisher/checks.js";
import { denylistFrom, main, parseNewsPaths, runCheck } from "../src/publisher/cli.js";
import { contentHash, loadDraft, publisherPaths, type Draft } from "../src/publisher/draft.js";
import { ConfigError } from "../src/config.js";

const ORIGIN = "https://example.com";
const CODE = "```php\nadd_action( 'init', 'boot' );\n\tif ( $x ) {\n\t\treturn;\n\t}\n```";
const body = (lead: string, extra = "") => `${lead}\n\n## Problem\n\nText.\n\n${CODE}\n\n- one\n- two\n${extra}`;

function draft(overrides: Partial<Draft> = {}): Draft {
  return {
    id: "2026-10-20-ponawianie-zadan",
    dir: "/nowhere",
    meta: {
      id: "2026-10-20-ponawianie-zadan",
      date: "2026-10-20",
      category: "integracje",
      pl: { slug: "ponawianie-zadan", title: "Ponawianie zadań w ForeachURL", excerpt: "Jak ponawiać zadania." },
      en: { slug: "retrying-jobs", title: "Retrying jobs", excerpt: "How to retry jobs." },
      de: { slug: "jobs-wiederholen", title: "Jobs wiederholen", excerpt: "Wie man Jobs wiederholt." },
      facebook: { languages: ["pl"] },
    },
    bodies: { pl: body("Wstęp."), en: body("Intro."), de: body("Einleitung.") },
    facebook: { pl: "Kiedy zadanie w tle się nie powiedzie, warto je ponowić. Pokazujemy jak." },
    ...overrides,
  };
}

const ctx = (overrides: Partial<CheckContext> = {}): CheckContext => ({
  origin: ORIGIN,
  newsPaths: { pl: "/news", en: "/en/news", de: "/de/news" },
  published: [{ slug: "stary-artykul", translations: { en: { slug: "old-article" }, de: { slug: "alter-artikel" } } }],
  categories: ["woocommerce", "integracje"],
  otherDrafts: [],
  registry: {
    version: 2,
    origin: ORIGIN,
    urls: [
      { url: `${ORIGIN}/uslugi`, lang: "pl", http_status: 200, canonical: `${ORIGIN}/uslugi`, alias_of: null, hreflang: {}, anchors: ["integracje"], first_seen: "2026-10-15T00:00:00.000Z", last_seen: "2026-10-15T00:00:00.000Z", last_verified: "2026-10-15T00:00:00.000Z", removed_at: null, last_error: null },
      { url: `${ORIGIN}/en/services`, lang: "en", http_status: 200, canonical: `${ORIGIN}/en/services`, alias_of: null, hreflang: {}, anchors: ["integracje"], first_seen: "2026-10-15T00:00:00.000Z", last_seen: "2026-10-15T00:00:00.000Z", last_verified: "2026-10-15T00:00:00.000Z", removed_at: null, last_error: null },
      { url: `${ORIGIN}/opinia`, lang: "pl", http_status: 200, canonical: `${ORIGIN}/`, alias_of: `${ORIGIN}/`, hreflang: {}, anchors: [], first_seen: "2026-10-15T00:00:00.000Z", last_seen: "2026-10-15T00:00:00.000Z", last_verified: "2026-10-15T00:00:00.000Z", removed_at: null, last_error: null },
    ],
  },
  registryAgeDays: 1,
  staleDays: 14,
  denylist: [],
  ...overrides,
});

const codes = (findings: ReturnType<typeof checkDraft>, level: "error" | "warning") => findings.filter((f) => f.level === level).map((f) => f.code);

test("a complete, clean draft has no errors and no warnings", () => {
  assert.deepEqual(checkDraft(draft(), ctx()), []);
});

test("every article needs all three languages; code must be identical in each", () => {
  const missing = checkDraft(draft({ bodies: { pl: body("Wstęp."), en: null, de: "  " } }), ctx());
  assert.deepEqual(codes(missing, "error"), ["body.missing", "body.missing"]);
  const changedCode = body("Intro.").replace("return;", "return 0;");
  assert.deepEqual(codes(checkDraft(draft({ bodies: { pl: body("Wstęp."), en: changedCode, de: body("Einleitung.") } }), ctx()), "error"), ["code.parity"]);
  const missingHeading = body("Intro.").replace("## Problem", "Problem");
  assert.deepEqual(codes(checkDraft(draft({ bodies: { pl: body("Wstęp."), en: missingHeading, de: body("Einleitung.") } }), ctx()), "warning"), ["structure"]);
});

test("structure: code blocks are verbatim (tabs kept) and excluded from prose", () => {
  const s = structureOf(body("Intro."));
  assert.equal(s.code.length, 1);
  assert.equal(s.code[0].lang, "php");
  assert.ok(s.code[0].code.includes("\t\treturn;"));
  assert.ok(!s.prose.includes("add_action"));
  assert.deepEqual(s.headings, ["h2"]);
  assert.equal(s.listItems, 2);
});

test("secrets are errors, in code too; obvious placeholders are not", () => {
  const leaks = [
    "-----BEGIN RSA PRIVATE KEY-----",
    "$key = 'AKIAABCDEFGHIJKLMNOP';",
    "token: ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "ANTHROPIC_API_KEY=sk-ant-abcdefghijklmnopqrstuvwxyz",
    "mysql://admin:hunter22@db.example.com/shop",
    "password = 'S3cr3t-Value!'",
    "define( 'DB_PASSWORD', 'S3cr3t-Value!' );",
  ];
  for (const leak of leaks) {
    const d = draft({ bodies: { pl: body("Wstęp.", `\n\`\`\`\n${leak}\n\`\`\``), en: body("Intro.", `\n\`\`\`\n${leak}\n\`\`\``), de: body("Einleitung.", `\n\`\`\`\n${leak}\n\`\`\``) } });
    assert.ok(codes(checkDraft(d, ctx()), "error").includes("secret"), leak);
  }
  for (const placeholder of ["password = '********'", "api_key = 'your-api-key'", "secret: '<secret>'", "password = '${DB_PASSWORD}'"]) {
    const d = draft({ bodies: { pl: body("Wstęp.", placeholder), en: body("Intro.", placeholder), de: body("Einleitung.", placeholder) } });
    assert.ok(!codes(checkDraft(d, ctx()), "error").includes("secret"), placeholder);
  }
});

test("never-publish terms (editorial/anonymization.json) are errors anywhere, case-insensitive", () => {
  const terms = denylistFrom({ clients: ["Acme Shop", { name: "Bravo", aliases: ["bravo.pl"] }], domains: ["acme.example"], identifiers: [], exclude: [{ term: "Secret Project" }] });
  assert.deepEqual(terms, ["Acme Shop", "Bravo", "bravo.pl", "acme.example", "Secret Project"]);
  const d = draft({ facebook: { pl: "Pracowaliśmy dla ACME SHOP nad tym." } });
  assert.deepEqual(codes(checkDraft(d, ctx({ denylist: terms })), "error"), ["denylist"]);
  assert.deepEqual(codes(checkDraft(draft(), ctx({ denylist: ["Bravo"] })), "error"), [], "Bravissimo ≠ Bravo is not tested here; no false hit");
});

test("brand must be ForeachURL; the domain is fine", () => {
  const d = draft({ facebook: { pl: "ForEachURL pokazuje jak. Więcej na foreachurl.app." } });
  assert.deepEqual(codes(checkDraft(d, ctx()), "error"), ["brand"]);
});

test("Base.com: error on Facebook, warning in the article", () => {
  const onFacebook = checkDraft(draft({ facebook: { pl: "Integracja z BaseLinker krok po kroku." } }), ctx());
  assert.deepEqual(codes(onFacebook, "error"), ["base-com"]);
  const inArticle = checkDraft(draft({ bodies: { pl: body("Wstęp o Base.com."), en: body("Intro."), de: body("Einleitung.") } }), ctx());
  assert.deepEqual(codes(inArticle, "error"), []);
  assert.deepEqual(codes(inArticle, "warning"), ["base-com"]);
});

test("numbers and client wording are warnings to confirm against the case (not in code)", () => {
  const d = draft({ bodies: { pl: body("Czas spadł o 40%, a 100+ zamówień dla klienta przeszło."), en: body("Intro."), de: body("Einleitung.") } });
  const w = codes(checkDraft(d, ctx()), "warning");
  assert.ok(w.includes("claim.number") && w.includes("claim.client"));
  assert.equal(w.filter((c) => c === "claim.number").length, 2);
});

test("links: published page in the same language, no aliases, real anchors; own URLs per language", () => {
  const withLink = (pl: string, en = "Intro.") => draft({ bodies: { pl: body(pl), en: body(en), de: body("Einleitung.") } });
  assert.deepEqual(codes(checkDraft(withLink(`Zobacz ${ORIGIN}/uslugi#integracje.`), ctx()), "error"), []);
  assert.deepEqual(codes(checkDraft(withLink(`Zobacz ${ORIGIN}/en/services.`), ctx()), "error"), ["link.language"]);
  assert.deepEqual(codes(checkDraft(withLink(`Zobacz ${ORIGIN}/nie-ma`), ctx()), "error"), ["link.unknown"]);
  assert.deepEqual(codes(checkDraft(withLink(`Zobacz ${ORIGIN}/opinia`), ctx()), "error"), ["link.alias"]);
  assert.deepEqual(codes(checkDraft(withLink(`Zobacz ${ORIGIN}/uslugi#brak`), ctx()), "error"), ["link.anchor"]);
  assert.deepEqual(codes(checkDraft(withLink("Wstęp.", `See ${ORIGIN}/en/news/retrying-jobs`), ctx()), "error"), [], "own English URL from English text");
  assert.deepEqual(codes(checkDraft(withLink(`Zobacz ${ORIGIN}/en/news/retrying-jobs`), ctx()), "error"), ["link.language"]);
  assert.deepEqual(codes(checkDraft(withLink(`Zobacz https://other.org/x`), ctx()), "error"), [], "external links aren't checked");
});

test("Facebook: Polish by default; chosen languages need a post; length, hashtags and links in text", () => {
  assert.deepEqual(codes(checkDraft(draft({ facebook: {} }), ctx()), "error"), ["facebook.missing"]);
  const english = draft();
  english.meta.facebook = { languages: ["en"] };
  english.facebook = { en: "When a background job fails, retry it." };
  assert.deepEqual(codes(checkDraft(english, ctx()), "warning"), ["facebook.language"]);
  const noisy = checkDraft(draft({ facebook: { pl: `${"x".repeat(1600)} #a #b #c #d ${ORIGIN}/news/x` } }), ctx());
  assert.deepEqual(codes(noisy, "warning").sort(), ["facebook.hashtags", "facebook.length", "facebook.link"]);
  assert.deepEqual(codes(checkDraft(draft({ facebook: { pl: "Tekst.", en: "Text." } }), ctx()), "warning"), ["facebook.unused"]);
});

test("slugs: taken by another published article or draft is an error; same Polish slug means an update", () => {
  const taken = draft();
  taken.meta.en = { ...taken.meta.en, slug: "old-article" };
  assert.deepEqual(codes(checkDraft(taken, ctx()), "error"), ["slug.taken"]);
  const other = draft().meta;
  assert.deepEqual(codes(checkDraft(draft(), ctx({ otherDrafts: [{ ...other, id: "x" }] })), "error"), ["slug.draft", "slug.draft", "slug.draft"]);
  const update = draft();
  update.meta.pl = { ...update.meta.pl, slug: "stary-artykul" };
  update.meta.en = { ...update.meta.en, slug: "old-article" };
  update.meta.de = { ...update.meta.de, slug: "alter-artikel" };
  assert.deepEqual(codes(checkDraft(update, ctx()), "error"), []);
  assert.deepEqual(codes(checkDraft(update, ctx()), "warning"), ["published"]);
});

test("category must be a News category; a stale or missing registry is a warning", () => {
  const d = draft();
  d.meta.category = "marketing";
  assert.deepEqual(codes(checkDraft(d, ctx()), "error"), ["meta.category"]);
  assert.deepEqual(codes(checkDraft(draft(), ctx({ registryAgeDays: 30 })), "warning"), ["links.stale"]);
  assert.deepEqual(codes(checkDraft(draft(), ctx({ registry: null })), "warning"), ["links.registry"]);
});

test("news paths are configurable; malformed entries rejected", () => {
  assert.deepEqual(parseNewsPaths("en=/en/blog/"), { pl: "/news", en: "/en/blog", de: "/de/news" });
  assert.throws(() => parseNewsPaths("en:/x"), ConfigError);
});

// ---- end to end on temporary folders ---------------------------------------------

test("check: loads the draft and context from disk, writes check.json tied to the content hash", async () => {
  const root = mkdtempSync(join(tmpdir(), "publisher-"));
  const editorial = join(root, "editorial");
  const portfolio = join(root, "portfolio");
  const knowledge = join(root, "knowledge");
  const id = "2026-10-20-ponawianie-zadan";
  const dir = join(editorial, "articles", id);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(portfolio, "src", "components", "News"), { recursive: true });
  mkdirSync(join(knowledge, "evidence"), { recursive: true });
  const d = draft();
  writeFileSync(join(dir, "meta.json"), JSON.stringify(d.meta));
  writeFileSync(join(dir, "case.md"), "Private: from a client project, ACME SHOP.");
  for (const l of ["pl", "en", "de"] as const) writeFileSync(join(dir, `article.${l}.md`), d.bodies[l]!);
  writeFileSync(join(dir, "facebook.pl.txt"), d.facebook.pl!);
  writeFileSync(join(editorial, "anonymization.json"), JSON.stringify({ version: 1, clients: ["ACME SHOP"], domains: [], identifiers: [], exclude: [] }));
  writeFileSync(join(portfolio, "src", "components", "News", "articles.json"), "[]");
  writeFileSync(join(portfolio, "src", "components", "News", "categories.js"), 'export const NEWS_CATEGORIES = [{ slug: "integracje", label: "Integracje" }];');
  const env = { PUBLISHER_CONTENT_DIR: editorial, PORTFOLIO_DIR: portfolio, KNOWLEDGE_DIR: knowledge, KNOWLEDGE_SITE_ORIGIN: ORIGIN };

  const paths = publisherPaths(env);
  const result = runCheck(paths, id, env, new Date("2026-10-20T10:00:00Z"));
  assert.equal(result.errors, 0, JSON.stringify(result.findings));
  assert.deepEqual(result.findings.map((f) => f.code), ["links.registry"], "case.md is private: its client name doesn't count");
  const saved = JSON.parse(readFileSync(join(dir, "check.json"), "utf8"));
  assert.equal(saved.content_sha256, contentHash(loadDraft(paths, id)));

  const lines: string[] = [];
  const out = { log: (l: string) => lines.push(l), error: (l: string) => lines.push(l) };
  assert.equal(await main(["list"], out, env), 0);
  assert.match(lines.at(-1)!, /0 error\(s\), 1 warning\(s\)$/);
  writeFileSync(join(dir, "article.en.md"), `${d.bodies.en} More.`);
  await main(["list"], out, env);
  assert.match(lines.at(-1)!, /changed since the last check/);
  writeFileSync(join(dir, "facebook.pl.txt"), "Robiliśmy to dla Acme Shop.");
  assert.equal(await main(["check", id], out, env), 1, "the never-publish term blocks it");
});
