import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Renderer } from "../src/knowledge/browser.js";
import type { KnowledgeConfig } from "../src/knowledge/config.js";
import { crawl, type CrawlResult, type Fetcher } from "../src/knowledge/crawler.js";
import { mergeCrawl } from "../src/knowledge/registry.js";
import { curatedFingerprint, refresh } from "../src/knowledge/refresh.js";
import { emptyRegistry } from "../src/knowledge/schema.js";
import { loadManifest, loadRegistry } from "../src/knowledge/store.js";
import { fakeClock, fixture } from "./knowledge-extract.test.js";

const ORIGIN = "https://example.com";
const UA = "meta-mcp-knowledge/0.3.0 (+https://example.com)";

const page = (title: string, body: string, opts: { lang?: string; canonical?: string } = {}) =>
  `<!doctype html><html lang="${opts.lang ?? "pl"}"><head><title>${title}</title>` +
  `${opts.canonical ? `<link rel="canonical" href="${opts.canonical}">` : ""}</head><body><main>${body}</main></body></html>`;

interface FakeSite {
  robots?: { status: number; text: string } | Error;
  sitemap?: string[];
  pages: Record<string, { status?: number; html?: string; finalUrl?: string; error?: string }>;
  texts?: Record<string, string>;
}

function fakes(site: FakeSite) {
  const rendered: string[] = [];
  const fetched: string[] = [];
  const fetchText: Fetcher = async (url) => {
    fetched.push(url);
    if (url.endsWith("/robots.txt")) {
      if (site.robots instanceof Error) throw site.robots;
      return site.robots ?? { status: 200, text: "User-agent: *\nAllow: /\n" };
    }
    if (url.endsWith("/sitemap.xml")) {
      return { status: 200, text: `<urlset>${(site.sitemap ?? []).map((u) => `<url><loc>${u}</loc></url>`).join("")}</urlset>` };
    }
    const text = site.texts?.[new URL(url).pathname];
    return text === undefined ? { status: 404, text: "" } : { status: 200, text };
  };
  const renderer: Renderer = {
    browserName: "fake",
    async render(url) {
      rendered.push(url);
      const p = site.pages[new URL(url).pathname];
      if (!p) return { status: 200, finalUrl: `${ORIGIN}/`, html: page("Home", "<h1>Home</h1>") }; // SPA fallback
      if (p.error) throw new Error(p.error);
      return { status: p.status ?? 200, finalUrl: p.finalUrl ?? url, html: p.html ?? "" };
    },
    async close() {},
  };
  return { fetchText, renderer, rendered, fetched };
}

const SITE: FakeSite = {
  sitemap: [`${ORIGIN}/`, `${ORIGIN}/uslugi`],
  pages: {
    "/": { html: page("Home", '<h1>Home</h1><p>Start.</p><a href="/o-nas">O nas</a><a href="https://other.org/x">x</a>') },
    "/uslugi": { html: fixture("services.html") },
    "/o-nas": { html: page("O nas", '<section id="zespol"><h2>Zespół</h2><p>Kim jesteśmy.</p></section>') },
    "/opinia": { html: page("Home", "<h1>Home</h1>", { canonical: `${ORIGIN}/` }) },
    "/kontakt": { html: page("Kontakt", "<h1>Kontakt</h1>") },
    "/polityka-prywatnosci": { html: page("Polityka", "<h1>Polityka</h1>") },
    "/en/services": { html: page("Services", "<h1>Services</h1>", { lang: "en" }) },
  },
  texts: { "/llms.txt": "# Example\n\n- RAG\n" },
};

const opts = (extra: Partial<Parameters<typeof crawl>[0]> = {}) => ({
  origin: ORIGIN,
  userAgent: UA,
  minDelayMs: 2000,
  maxPages: 100,
  textResources: [{ path: "/llms.txt", lang: "en" }],
  extraUrls: [] as string[],
  ...extra,
});

// ---- crawler ------------------------------------------------------------------

test("crawl: seeds from the sitemap, follows same-origin links only, keeps ≥2 s between requests", async () => {
  const f = fakes(SITE);
  const { clock, sleeps } = fakeClock();
  const result = await crawl(opts(), { fetchText: f.fetchText, renderer: f.renderer, clock });
  assert.equal(result.aborted, null);
  assert.equal(result.complete, true);
  assert.deepEqual(f.rendered.slice(0, 2), [`${ORIGIN}/`, `${ORIGIN}/uslugi`]);
  assert.ok(f.rendered.includes(`${ORIGIN}/o-nas`), "discovered through a link");
  assert.ok(f.rendered.includes(`${ORIGIN}/kontakt`), "discovered through a link with a query string");
  assert.ok(!f.rendered.some((u) => u.includes("other.org") || u.includes("/api/") || u.endsWith(".png")));
  const requests = f.rendered.length + f.fetched.length;
  assert.equal(sleeps.length, requests - 1, "every request after the first waits");
  assert.ok(sleeps.every((ms) => ms >= 2000), `sleeps: ${sleeps}`);
  assert.ok(result.outcomes.some((o) => o.kind === "text" && o.ok && o.url === `${ORIGIN}/llms.txt`));
});

test("crawl: robots.txt rules and a longer Crawl-delay are respected", async () => {
  const f = fakes({ ...SITE, robots: { status: 200, text: "User-agent: *\nDisallow: /o-nas\nCrawl-delay: 5\n" } });
  const { clock, sleeps } = fakeClock();
  const result = await crawl(opts(), { fetchText: f.fetchText, renderer: f.renderer, clock });
  assert.ok(!f.rendered.includes(`${ORIGIN}/o-nas`));
  assert.deepEqual(result.skipped.find((s) => s.url.endsWith("/o-nas"))?.reason, "disallowed by robots.txt");
  assert.ok(sleeps.every((ms) => ms >= 5000));
});

test("crawl: unreachable robots.txt or a 5xx aborts before any page is requested", async () => {
  for (const robots of [new Error("ECONNRESET"), { status: 503, text: "" }]) {
    const f = fakes({ ...SITE, robots });
    const result = await crawl(opts(), { fetchText: f.fetchText, renderer: f.renderer, clock: fakeClock().clock });
    assert.ok(result.aborted);
    assert.equal(f.rendered.length, 0);
  }
});

test("crawl: --limit stops early, is never complete and skips text resources", async () => {
  const f = fakes(SITE);
  const result = await crawl(opts({ limit: 2 }), { fetchText: f.fetchText, renderer: f.renderer, clock: fakeClock().clock });
  assert.equal(f.rendered.length, 2);
  assert.equal(result.complete, false);
  assert.ok(result.skipped.some((s) => s.reason === "--limit reached"));
  assert.ok(result.skipped.some((s) => s.url.endsWith("/llms.txt")));
});

// ---- registry ------------------------------------------------------------------

async function crawlSite(site: FakeSite, extra: Partial<Parameters<typeof crawl>[0]> = {}, start?: number): Promise<CrawlResult> {
  const f = fakes(site);
  return crawl(opts(extra), { fetchText: f.fetchText, renderer: f.renderer, clock: fakeClock(start).clock });
}

test("registry: aliases are recorded as not publishable; anchors, sections and hreflang are kept", async () => {
  const result = await crawlSite(SITE, { extraUrls: [`${ORIGIN}/opinia`] });
  const { registry } = mergeCrawl(emptyRegistry(ORIGIN), result, ORIGIN);
  const get = (path: string) => registry.urls.find((r) => r.url === `${ORIGIN}${path}`)!;
  assert.equal(get("/opinia").alias_of, `${ORIGIN}/`);
  assert.equal(get("/opinia").evidence_file, null);
  assert.equal(get("/uslugi").alias_of, null);
  assert.ok(get("/uslugi").anchors.includes("integracje"));
  assert.ok(get("/uslugi").sections.integracje);
  assert.equal(get("/uslugi").hreflang.en, `${ORIGIN}/en/services`);
  assert.equal(get("/llms.txt").kind, "text");
  assert.equal(get("/llms.txt").lang, "en");
});

test("registry: a failed page keeps its record and evidence; it is not marked removed", async () => {
  const first = mergeCrawl(emptyRegistry(ORIGIN), await crawlSite(SITE), ORIGIN).registry;
  for (const failure of [{ error: "Timeout 45000ms exceeded" }, { status: 503 }, { status: 500 }]) {
    const broken = { ...SITE, pages: { ...SITE.pages, "/uslugi": failure } };
    const { registry, changes } = mergeCrawl(first, await crawlSite(broken, {}, Date.parse("2026-10-20T10:00:00Z")), ORIGIN);
    const before = first.urls.find((r) => r.url === `${ORIGIN}/uslugi`)!;
    const after = registry.urls.find((r) => r.url === `${ORIGIN}/uslugi`)!;
    assert.equal(after.removed_at, null);
    assert.equal(after.content_sha256, before.content_sha256);
    assert.equal(after.last_verified, before.last_verified);
    assert.ok(after.last_error);
    assert.equal(changes.find((c) => c.url === after.url)!.kind, "failed");
  }
});

test("registry: removed only after a successful check (404/410, or a redirect away while gone from the sitemap)", async () => {
  const first = mergeCrawl(emptyRegistry(ORIGIN), await crawlSite(SITE), ORIGIN).registry;
  const gone404 = { ...SITE, pages: { ...SITE.pages, "/o-nas": { status: 404 } } };
  let { registry } = mergeCrawl(first, await crawlSite(gone404, { extraUrls: [`${ORIGIN}/o-nas`] }), ORIGIN);
  assert.ok(registry.urls.find((r) => r.url === `${ORIGIN}/o-nas`)!.removed_at);

  // client-side fallback (SPA): the page now renders the home page and isn't in the sitemap
  const spaGone = { ...SITE, pages: { ...SITE.pages, "/o-nas": { html: page("Home", "<h1>Home</h1>"), finalUrl: `${ORIGIN}/` } } };
  ({ registry } = mergeCrawl(first, await crawlSite(spaGone, { extraUrls: [`${ORIGIN}/o-nas`] }), ORIGIN));
  const rec = registry.urls.find((r) => r.url === `${ORIGIN}/o-nas`)!;
  assert.ok(rec.removed_at);
  assert.equal(rec.alias_of, `${ORIGIN}/`);
});

// ---- refresh (end to end with fakes) --------------------------------------------

function knowledgeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-repo-"));
  for (const d of ["evidence/pages/pl", "facts", "recommendations", "reports"]) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, "claims.json"), '{\n  "version": 1,\n  "claims": []\n}\n');
  writeFileSync(join(dir, "facts", "services.md"), "# Services\n\nCurated text that must never change.\n");
  writeFileSync(join(dir, "recommendations", "recommendations.md"), "# Recommendations\n");
  return dir;
}

const config = (dir: string): KnowledgeConfig => ({
  dir,
  origin: ORIGIN,
  textResources: [{ path: "/llms.txt", lang: "en" }],
  extraPaths: ["/opinia"],
  userAgent: UA,
  minDelayMs: 2000,
  maxPages: 100,
  staleDays: 14,
  editorialDir: join(dir, "..", "editorial-not-used"),
});

const deps = (site: FakeSite, start?: number) => {
  const f = fakes(site);
  return { fetchText: f.fetchText, launch: async () => f.renderer, clock: fakeClock(start).clock };
};

function treeHash(dir: string): string {
  const out: string[] = [];
  const visit = (p: string) => {
    for (const name of readdirSync(p).sort()) {
      const full = join(p, name);
      if (statSync(full).isDirectory()) visit(full);
      else out.push(`${full}:${readFileSync(full, "utf8")}`);
    }
  };
  visit(dir);
  return out.join("\n");
}

test("refresh writes evidence, registry, manifest and a report; curated files stay byte-identical", async () => {
  const dir = knowledgeRepo();
  const curated = curatedFingerprint(dir);
  const curatedBytes = readFileSync(join(dir, "facts", "services.md"));
  const out = await refresh(config(dir), { dryRun: false, commit: false, extraPaths: ["/opinia"] }, deps(SITE));
  assert.equal(curatedFingerprint(dir), curated);
  assert.deepEqual(readFileSync(join(dir, "facts", "services.md")), curatedBytes);
  assert.ok(existsSync(join(dir, "evidence", "pages", "pl", "uslugi.md")));
  assert.ok(existsSync(join(dir, "evidence", "pages", "en", "llms.txt.md")));
  assert.ok(!existsSync(join(dir, "evidence", "pages", "pl", "opinia.md")), "aliases get no snapshot");
  const registry = loadRegistry(dir);
  assert.ok(registry.urls.length >= 7);
  const manifest = loadManifest(dir);
  assert.ok(manifest.last_complete_crawl_at);
  assert.equal(manifest.runs.length, 1);
  assert.ok(out.reportFile && readFileSync(out.reportFile, "utf8").includes("## New pages"));
});

test("refresh --dry-run changes nothing on disk", async () => {
  const dir = knowledgeRepo();
  const before = treeHash(dir);
  const out = await refresh(config(dir), { dryRun: true, commit: false }, deps(SITE));
  assert.equal(treeHash(dir), before);
  assert.equal(out.reportFile, null);
  assert.ok(out.report.includes("dry run"));
});

test("a second refresh with unchanged content rewrites no snapshot; a changed section is reported", async () => {
  const dir = knowledgeRepo();
  await refresh(config(dir), { dryRun: false, commit: false }, deps(SITE));
  const snapshot = join(dir, "evidence", "pages", "pl", "uslugi.md");
  const first = readFileSync(snapshot, "utf8");

  const later = Date.parse("2026-10-15T10:00:00Z");
  const again = await refresh(config(dir), { dryRun: false, commit: false }, deps(SITE, later));
  assert.equal(readFileSync(snapshot, "utf8"), first, "same content: snapshot untouched (no timestamp churn)");
  assert.ok(!again.written.some((w) => w.includes("uslugi.md")));

  const edited = { ...SITE, pages: { ...SITE.pages, "/uslugi": { html: fixture("services.html").replace("Agenci AI i RAG", "Agenci AI") } } };
  const changed = await refresh(config(dir), { dryRun: false, commit: false }, deps(edited, later + 86_400_000));
  assert.match(changed.report, /### https:\/\/example\.com\/uslugi[\s\S]*\*\*automatyzacja\*\* \(changed\)/);
  assert.match(changed.report, /− Agenci AI i RAG dla procesów sklepu\./);
  assert.notEqual(readFileSync(snapshot, "utf8"), first);
});

test("a failed crawl keeps earlier evidence; an aborted crawl changes no evidence", async () => {
  const dir = knowledgeRepo();
  await refresh(config(dir), { dryRun: false, commit: false }, deps(SITE));
  const snapshot = readFileSync(join(dir, "evidence", "pages", "pl", "uslugi.md"), "utf8");
  const registryBefore = readFileSync(join(dir, "evidence", "urls.json"), "utf8");

  const broken = { ...SITE, pages: { ...SITE.pages, "/uslugi": { error: "net::ERR_CONNECTION_RESET" } } };
  const out = await refresh(config(dir), { dryRun: false, commit: false }, deps(broken, Date.parse("2026-10-16T10:00:00Z")));
  assert.equal(readFileSync(join(dir, "evidence", "pages", "pl", "uslugi.md"), "utf8"), snapshot);
  assert.match(out.report, /FAILED https:\/\/example\.com\/uslugi/);
  assert.equal(loadManifest(dir).runs.at(-1)!.complete, false);
  assert.equal(loadManifest(dir).last_complete_crawl_at, loadManifest(dir).runs[0].finished_at, "freshness keeps the last complete crawl");

  assert.notEqual(registryBefore, "");
  const registryBeforeAbort = readFileSync(join(dir, "evidence", "urls.json"), "utf8");
  const aborted = await refresh(config(dir), { dryRun: false, commit: false }, { ...deps({ ...SITE, robots: new Error("down") }) });
  assert.ok(aborted.crawl.aborted);
  assert.equal(readFileSync(join(dir, "evidence", "urls.json"), "utf8"), registryBeforeAbort, "aborted crawl: registry untouched");
  assert.equal(readFileSync(join(dir, "evidence", "pages", "pl", "uslugi.md"), "utf8"), snapshot);
  assert.match(aborted.report, /Crawl aborted/);
});

test("refresh --commit commits only evidence and reports, locally", async () => {
  const dir = knowledgeRepo();
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "init");
  writeFileSync(join(dir, "facts", "services.md"), "# Services\n\nuncommitted curated edit\n");
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    const out = await refresh(config(dir), { dryRun: false, commit: true }, deps(SITE));
    assert.ok(out.commit);
  } finally {
    process.env = saved;
  }
  const files = git("show", "--name-only", "--format=", "HEAD").split("\n");
  assert.ok(files.every((f) => f.startsWith("evidence/") || f.startsWith("reports/")), files.join(","));
  assert.match(git("status", "--porcelain"), /facts\/services\.md/, "the curated edit stays uncommitted");
  assert.equal(git("remote"), "");
});

test("the curated-file guard catches any change to facts/, claims.json or recommendations/", () => {
  const dir = knowledgeRepo();
  const before = curatedFingerprint(dir);
  cpSync(join(dir, "claims.json"), join(dir, "claims.json.bak"));
  assert.equal(curatedFingerprint(dir), before, "files outside the curated set don't count");
  writeFileSync(join(dir, "recommendations", "new.md"), "x");
  assert.notEqual(curatedFingerprint(dir), before);
});
