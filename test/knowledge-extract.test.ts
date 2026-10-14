import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../src/config.js";
import { contentHash, extractPage, normalizeText, sectionHash } from "../src/knowledge/extract.js";
import { createRateLimiter, type Clock } from "../src/knowledge/rate-limit.js";
import { robotsPolicy } from "../src/knowledge/robots.js";
import { parseSnapshot, renderSnapshot } from "../src/knowledge/snapshot.js";
import { evidenceFileFor, isPageCandidate, normalizeUrl } from "../src/knowledge/urls.js";

const ORIGIN = "https://example.com";
export const fixture = (name: string) => readFileSync(join(PROJECT_ROOT, "test", "fixtures", "knowledge", name), "utf8");

// ---- robots.txt -------------------------------------------------------------

test("robots: longest match wins, Allow wins ties, * and $ wildcards", () => {
  const policy = robotsPolicy(
    ["User-agent: *", "Disallow: /private", "Allow: /private/open", "Disallow: /*.pdf$", "Disallow: /tmp/", "Allow: /tmp/"].join("\n"),
    "meta-mcp-knowledge/0.3",
  );
  assert.equal(policy.isAllowed("/"), true);
  assert.equal(policy.isAllowed("/private/x"), false);
  assert.equal(policy.isAllowed("/private/open/page"), true);
  assert.equal(policy.isAllowed("/docs/file.pdf"), false);
  assert.equal(policy.isAllowed("/docs/file.pdf?x"), true);
  assert.equal(policy.isAllowed("/tmp/x"), true);
});

test("robots: a group for our agent replaces *; crawl-delay and sitemaps are read; empty Disallow allows all", () => {
  const text = [
    "User-agent: *",
    "Disallow: /",
    "",
    "User-agent: meta-mcp-knowledge",
    "Disallow:",
    "Crawl-delay: 5",
    "",
    "Sitemap: https://example.com/sitemap.xml",
  ].join("\n");
  const ours = robotsPolicy(text, "meta-mcp-knowledge/0.3 (+https://example.com)");
  assert.equal(ours.isAllowed("/anything"), true);
  assert.equal(ours.crawlDelay, 5);
  assert.deepEqual(ours.sitemaps, ["https://example.com/sitemap.xml"]);
  assert.equal(robotsPolicy(text, "OtherBot/1.0").isAllowed("/anything"), false);
});

test("robots: no robots.txt (404) means everything is allowed", () => {
  assert.equal(robotsPolicy(null, "x/1").isAllowed("/a"), true);
  assert.equal(robotsPolicy(null, "x/1").crawlDelay, undefined);
});

// ---- rate limiting -------------------------------------------------------------

export function fakeClock(start = Date.parse("2026-10-14T10:00:00Z")) {
  let now = start;
  const sleeps: number[] = [];
  const clock: Clock = {
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  };
  return { clock, sleeps, advance: (ms: number) => (now += ms) };
}

test("rate limiter: at least the interval between calls, no wait for the first", async () => {
  const { clock, sleeps, advance } = fakeClock();
  const limiter = createRateLimiter(2000, clock);
  await limiter.wait();
  await limiter.wait();
  advance(500);
  await limiter.wait();
  advance(5000);
  await limiter.wait();
  assert.deepEqual(sleeps, [2000, 1500]);
});

// ---- URLs ----------------------------------------------------------------------

test("URL normalization: fragments are sections, queries are not pages, trailing slashes removed", () => {
  const n = normalizeUrl("/uslugi/#integracje", `${ORIGIN}/`, ORIGIN)!;
  assert.deepEqual([n.url, n.fragment, n.hadQuery, n.sameOrigin], [`${ORIGIN}/uslugi`, "integracje", false, true]);
  assert.equal(normalizeUrl("/kontakt?utm_source=x", ORIGIN, ORIGIN)!.url, `${ORIGIN}/kontakt`);
  assert.equal(normalizeUrl("/kontakt?utm_source=x", ORIGIN, ORIGIN)!.hadQuery, true);
  assert.equal(normalizeUrl("https://EXAMPLE.com//en//services/", ORIGIN, ORIGIN)!.url, `${ORIGIN}/en/services`);
  assert.equal(normalizeUrl("/", ORIGIN, ORIGIN)!.url, `${ORIGIN}/`);
  assert.equal(normalizeUrl("https://other.org/x", ORIGIN, ORIGIN)!.sameOrigin, false);
  for (const bad of ["mailto:a@b.c", "tel:123", "javascript:alert(1)", "data:text/html,x"]) assert.equal(normalizeUrl(bad, ORIGIN, ORIGIN), null);
});

test("page candidates exclude assets, API endpoints and other origins", () => {
  const c = (href: string) => isPageCandidate(normalizeUrl(href, ORIGIN, ORIGIN)!);
  assert.equal(c("/uslugi"), true);
  assert.equal(c("/assets/logo.png"), false);
  assert.equal(c("/sitemap.xml"), false);
  assert.equal(c("/api/contact"), false);
  assert.equal(c("https://other.org/"), false);
});

test("evidence file names: language prefix dropped, root is index, unsafe characters replaced", () => {
  assert.equal(evidenceFileFor(`${ORIGIN}/`, "pl"), "pl/index.md");
  assert.equal(evidenceFileFor(`${ORIGIN}/en`, "en"), "en/index.md");
  assert.equal(evidenceFileFor(`${ORIGIN}/en/services`, "en"), "en/services.md");
  assert.equal(evidenceFileFor(`${ORIGIN}/news/integracja-erp`, "pl"), "pl/news/integracja-erp.md");
  assert.equal(evidenceFileFor(`${ORIGIN}/llms.txt`, "en"), "en/llms.txt.md");
  assert.equal(evidenceFileFor(`${ORIGIN}/a%20b/..x`, "pl"), "pl/a_b/_x.md");
});

// ---- extraction ----------------------------------------------------------------

test("extraction: metadata, hreflang, canonical, JSON-LD (malformed skipped), no scripts or styles", () => {
  const page = extractPage(fixture("services.html"), `${ORIGIN}/uslugi`, ORIGIN);
  assert.equal(page.lang, "pl");
  assert.equal(page.title, "Usługi – WordPress | Example");
  assert.equal(page.description, "Strony WordPress, integracje i optymalizacja.");
  assert.equal(page.canonical, `${ORIGIN}/uslugi`);
  assert.deepEqual(page.hreflang, { pl: `${ORIGIN}/uslugi`, en: `${ORIGIN}/en/services`, "x-default": `${ORIGIN}/uslugi` });
  assert.deepEqual(page.jsonLd, [{ "@type": "Organization", name: "Example" }]);
  assert.equal(page.og["og:title"], "Usługi");
  const all = JSON.stringify(page.sections);
  assert.ok(!all.includes("should not appear") && !all.includes("color:red"));
});

test("extraction: sections keyed by anchor or heading slug, text in order, duplicates and hidden text dropped", () => {
  const page = extractPage(fixture("services.html"), `${ORIGIN}/uslugi`, ORIGIN);
  assert.deepEqual(
    page.sections.map((s) => [s.key, s.heading, s.anchor]),
    [
      ["intro", "Usługi", "intro"],
      ["integracje", "Integracje", "integracje"],
      ["h-webhooki", "Webhooki", null],
      ["automatyzacja", "Automatyzacja i AI", "automatyzacja"],
      ["h-bez-kotwicy", "Bez kotwicy", null],
    ],
  );
  const intro = page.sections[0];
  assert.deepEqual(intro.blocks, ["Rozwijamy sklepy WooCommerce i strony WordPress.", "Wyceń projekt"]);
  assert.deepEqual(page.sections[1].blocks, ["Integracje z ERP i CRM przez API", "ERP", "CRM i marketplace"]);
  assert.ok(page.sections[2].blocks.includes("# not a heading, just text"));
  assert.ok(!JSON.stringify(page.sections).includes("Hidden text"));
  assert.ok(!JSON.stringify(page.sections).includes("Szanujemy"), "the cookie dialog is not content");
  assert.ok(page.anchors.includes("integracje") && !page.anchors.includes("root"));
});

test("extraction: links from nav, main and footer with their area; CTAs from main only", () => {
  const page = extractPage(fixture("services.html"), `${ORIGIN}/uslugi`, ORIGIN);
  const find = (text: string) => page.links.find((l) => l.text === text);
  assert.deepEqual(find("Integracje"), { href: `${ORIGIN}/uslugi#integracje`, text: "Integracje", internal: true, fragment: "integracje", area: "nav" });
  assert.equal(find("Kontakt")!.href, `${ORIGIN}/kontakt`, "query string dropped");
  assert.equal(find("Polityka prywatności")!.area, "footer");
  assert.equal(find("External")!.internal, false);
  assert.equal(find("Mail"), undefined);
  assert.deepEqual(page.ctas, [
    { text: "Wyceń projekt", href: `${ORIGIN}/kontakt` },
    { text: "Umów rozmowę", href: null },
  ]);
});

test("extraction without <main>: body minus header, nav and footer; links still collected", () => {
  const page = extractPage(fixture("no-main.html"), `${ORIGIN}/en/about`, ORIGIN);
  assert.equal(page.lang, "en");
  assert.deepEqual(page.sections.map((s) => [s.heading, s.blocks]), [["About us", ["We build things."]]]);
  assert.deepEqual(page.links.map((l) => l.area), ["header", "footer"]);
});

test("extraction: adjacent inline elements don't glue words; a section id wins over its heading's id", () => {
  const html =
    '<html lang="pl"><body><main><section id="strony"><h2 id="strony-title">Strony</h2>' +
    '<a class="pill"><span>Strony</span><span>WordPress</span></a><p><strong>WooCommerce</strong>, <em>React</em> i Wo<b>rd</b>Press.</p>' +
    '<h3 id="own">Pod</h3><p>x</p></section></main>' +
    '<nav><a href="/o-nas"><div>O nas</div><div>Inżynieria dla e-commerce</div></a></nav></body></html>';
  const page = extractPage(html, `${ORIGIN}/uslugi`, ORIGIN);
  assert.deepEqual(page.sections.map((s) => s.key), ["strony", "own"]);
  assert.deepEqual(page.sections[0].blocks, ["Strony WordPress", "WooCommerce, React i WordPress."]);
  assert.equal(page.links[0].text, "O nas Inżynieria dla e-commerce");
});

test("extraction skips text the renderer marked unstable (animations)", () => {
  const html = '<html lang="en"><body><main><h1>We build <span class="tw"><span data-knowledge-unstable>Scal</span></span></h1><p>Stable text.</p></main></body></html>';
  const page = extractPage(html, `${ORIGIN}/en`, ORIGIN);
  assert.equal(page.sections[0].heading, "We build");
  assert.deepEqual(page.sections[0].blocks, ["Stable text."]);
});

// ---- hashing ---------------------------------------------------------------------

test("hashes ignore cosmetic whitespace and markup, change with the text", () => {
  const a = extractPage(fixture("services.html"), `${ORIGIN}/uslugi`, ORIGIN);
  const cosmetic = fixture("services.html").replace("<p>Agenci AI i RAG dla procesów sklepu.</p>", "<p>\n   Agenci  AI i <b>RAG</b>\tdla procesów&nbsp;sklepu.\n</p>");
  const b = extractPage(cosmetic, `${ORIGIN}/uslugi`, ORIGIN);
  assert.equal(contentHash(a), contentHash(b));
  const edited = extractPage(fixture("services.html").replace("Agenci AI i RAG", "Agenci AI"), `${ORIGIN}/uslugi`, ORIGIN);
  assert.notEqual(contentHash(a), contentHash(edited));
  assert.equal(sectionHash(a.sections[1]), sectionHash(edited.sections[1]), "other sections keep their hash");
  assert.notEqual(sectionHash(a.sections[3]), sectionHash(edited.sections[3]));
  assert.equal(normalizeText(" a \n b "), "a b");
});

// ---- snapshot ----------------------------------------------------------------------

test("snapshot round trip: sections, hashes and escaped lines read back exactly; timestamps outside the hash", () => {
  const page = extractPage(fixture("services.html"), `${ORIGIN}/uslugi`, ORIGIN);
  const meta = (at: string) => ({ url: `${ORIGIN}/uslugi`, lang: "pl", kind: "page" as const, http_status: 200, canonical: page.canonical, content_sha256: contentHash(page), captured_at: at });
  const text = renderSnapshot(meta("2026-10-14T10:00:00.000Z"), page);
  const parsed = parseSnapshot(text);
  assert.equal(parsed.meta.url, `${ORIGIN}/uslugi`);
  assert.equal(parsed.meta.content_sha256, contentHash(page), "keys with digits are read back");
  assert.deepEqual(parsed.meta.anchors, page.anchors);
  assert.deepEqual(parsed.sections.map((s) => s.key), page.sections.map((s) => s.key));
  assert.deepEqual(parsed.sections.map((s) => s.sha256), page.sections.map((s) => sectionHash(s)));
  assert.deepEqual(parsed.sections.map((s) => s.lines), page.sections.map((s) => s.blocks));
  assert.ok(text.includes("\\# not a heading"), "a text line starting with # is escaped");
  const later = parseSnapshot(renderSnapshot(meta("2026-11-01T10:00:00.000Z"), page));
  assert.deepEqual(later.sections, parsed.sections);
});
