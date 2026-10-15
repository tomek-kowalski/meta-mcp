import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../src/config.js";
import { extractPage } from "../src/knowledge/extract.js";
import { createRateLimiter, type Clock } from "../src/knowledge/rate-limit.js";
import { robotsPolicy } from "../src/knowledge/robots.js";
import { isPageCandidate, normalizeUrl } from "../src/knowledge/urls.js";

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
  const text = ["User-agent: *", "Disallow: /", "", "User-agent: meta-mcp-knowledge", "Disallow:", "Crawl-delay: 5", "", "Sitemap: https://example.com/sitemap.xml"].join("\n");
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

// ---- extraction ----------------------------------------------------------------

test("extraction: language, title, canonical and hreflang (normalized)", () => {
  const page = extractPage(fixture("services.html"), `${ORIGIN}/uslugi`, ORIGIN);
  assert.equal(page.lang, "pl");
  assert.equal(page.title, "Usługi – WordPress | Example");
  assert.equal(page.canonical, `${ORIGIN}/uslugi`);
  assert.deepEqual(page.hreflang, { pl: `${ORIGIN}/uslugi`, en: `${ORIGIN}/en/services`, "x-default": `${ORIGIN}/uslugi` });
});

test("extraction: anchors are element ids (framework ids ignored); links are same-origin, without fragment or query", () => {
  const page = extractPage(fixture("services.html"), `${ORIGIN}/uslugi`, ORIGIN);
  assert.ok(page.anchors.includes("integracje") && page.anchors.includes("automatyzacja"));
  assert.ok(!page.anchors.includes("root"));
  assert.ok(page.links.includes(`${ORIGIN}/uslugi`), "#fragment dropped");
  assert.ok(page.links.includes(`${ORIGIN}/kontakt`), "?query dropped");
  assert.ok(page.links.includes(`${ORIGIN}/polityka-prywatnosci`), "footer links count");
  assert.ok(!page.links.some((l) => l.includes("external.example.org") || l.startsWith("mailto")));
});

test("extraction without <main> or canonical still works", () => {
  const page = extractPage(fixture("no-main.html"), `${ORIGIN}/en/about`, ORIGIN);
  assert.equal(page.lang, "en");
  assert.equal(page.canonical, null);
  assert.deepEqual(page.links, [`${ORIGIN}/en`, `${ORIGIN}/en/contact`]);
});
