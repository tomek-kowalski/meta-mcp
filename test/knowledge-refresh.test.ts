import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Renderer } from "../src/knowledge/browser.js";
import type { KnowledgeConfig } from "../src/knowledge/config.js";
import { crawl, type CrawlResult, type Fetcher } from "../src/knowledge/crawler.js";
import { findRecord, freshness, mergeCrawl } from "../src/knowledge/registry.js";
import { refresh } from "../src/knowledge/refresh.js";
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
    return { status: 404, text: "" };
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
    "/": { html: page("Home", '<h1>Home</h1><a href="/o-nas">O nas</a><a href="https://other.org/x">x</a>') },
    "/uslugi": { html: fixture("services.html") },
    "/o-nas": { html: page("O nas", '<section id="zespol"><h2>Zespół</h2></section>') },
    "/opinia": { html: page("Home", "<h1>Home</h1>", { canonical: `${ORIGIN}/` }) },
    "/kontakt": { html: page("Kontakt", "<h1>Kontakt</h1>") },
    "/polityka-prywatnosci": { html: page("Polityka", "<h1>Polityka</h1>") },
    "/en/services": { html: page("Services", "<h1>Services</h1>", { lang: "en" }) },
  },
};

const opts = (extra: Partial<Parameters<typeof crawl>[0]> = {}) => ({
  origin: ORIGIN,
  userAgent: UA,
  minDelayMs: 2000,
  maxPages: 100,
  extraUrls: [] as string[],
  ...extra,
});

async function crawlSite(site: FakeSite, extra: Partial<Parameters<typeof crawl>[0]> = {}, start?: number): Promise<CrawlResult> {
  const f = fakes(site);
  return crawl(opts(extra), { fetchText: f.fetchText, renderer: f.renderer, clock: fakeClock(start).clock });
}

// ---- crawler ------------------------------------------------------------------

test("crawl: seeds from the sitemap, follows same-origin links only, keeps ≥2 s between requests", async () => {
  const f = fakes(SITE);
  const { clock, sleeps } = fakeClock();
  const result = await crawl(opts(), { fetchText: f.fetchText, renderer: f.renderer, clock });
  assert.equal(result.aborted, null);
  assert.equal(result.complete, true);
  assert.deepEqual(f.rendered.slice(0, 2), [`${ORIGIN}/`, `${ORIGIN}/uslugi`]);
  assert.ok(f.rendered.includes(`${ORIGIN}/o-nas`) && f.rendered.includes(`${ORIGIN}/kontakt`), "discovered through links");
  assert.ok(!f.rendered.some((u) => u.includes("other.org") || u.includes("/api/") || u.endsWith(".png")));
  assert.equal(sleeps.length, f.rendered.length + f.fetched.length - 1, "every request after the first waits");
  assert.ok(sleeps.every((ms) => ms >= 2000), `sleeps: ${sleeps}`);
});

test("crawl: robots.txt rules and a longer Crawl-delay are respected", async () => {
  const f = fakes({ ...SITE, robots: { status: 200, text: "User-agent: *\nDisallow: /o-nas\nCrawl-delay: 5\n" } });
  const { clock, sleeps } = fakeClock();
  const result = await crawl(opts(), { fetchText: f.fetchText, renderer: f.renderer, clock });
  assert.ok(!f.rendered.includes(`${ORIGIN}/o-nas`));
  assert.equal(result.skipped.find((s) => s.url.endsWith("/o-nas"))?.reason, "disallowed by robots.txt");
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

test("crawl: --limit stops early and is never complete", async () => {
  const f = fakes(SITE);
  const result = await crawl(opts({ limit: 2 }), { fetchText: f.fetchText, renderer: f.renderer, clock: fakeClock().clock });
  assert.equal(f.rendered.length, 2);
  assert.equal(result.complete, false);
  assert.ok(result.skipped.some((s) => s.reason === "--limit reached"));
});

// ---- registry ------------------------------------------------------------------

test("registry: language, hreflang and anchors per URL; aliases recorded as not publishable", async () => {
  const { registry } = mergeCrawl(emptyRegistry(ORIGIN), await crawlSite(SITE, { extraUrls: [`${ORIGIN}/opinia`] }), ORIGIN);
  const get = (path: string) => findRecord(registry, `${ORIGIN}${path}`)!;
  assert.equal(get("/opinia").alias_of, `${ORIGIN}/`);
  assert.equal(get("/uslugi").alias_of, null);
  assert.ok(get("/uslugi").anchors.includes("integracje"));
  assert.equal(get("/uslugi").hreflang.en, `${ORIGIN}/en/services`);
  assert.equal(get("/en/services").lang, "en");
  assert.equal(findRecord(registry, `${ORIGIN}/uslugi/#integracje`)?.url, `${ORIGIN}/uslugi`, "lookup normalizes the URL");
});

test("registry: a failed page keeps its entry and is never marked removed", async () => {
  const first = mergeCrawl(emptyRegistry(ORIGIN), await crawlSite(SITE), ORIGIN).registry;
  for (const failure of [{ error: "Timeout 45000ms exceeded" }, { status: 503 }, { status: 500 }]) {
    const broken = { ...SITE, pages: { ...SITE.pages, "/uslugi": failure } };
    const { registry, changes } = mergeCrawl(first, await crawlSite(broken, {}, Date.parse("2026-10-20T10:00:00Z")), ORIGIN);
    const before = findRecord(first, `${ORIGIN}/uslugi`)!;
    const after = findRecord(registry, `${ORIGIN}/uslugi`)!;
    assert.equal(after.removed_at, null);
    assert.equal(after.last_verified, before.last_verified);
    assert.deepEqual(after.anchors, before.anchors);
    assert.ok(after.last_error);
    assert.equal(changes.find((c) => c.url === after.url)!.kind, "failed");
  }
});

test("registry: removed only after a successful check (404/410, or a redirect away while gone from the sitemap)", async () => {
  const first = mergeCrawl(emptyRegistry(ORIGIN), await crawlSite(SITE), ORIGIN).registry;
  const gone404 = { ...SITE, pages: { ...SITE.pages, "/o-nas": { status: 404 } } };
  let { registry } = mergeCrawl(first, await crawlSite(gone404, { extraUrls: [`${ORIGIN}/o-nas`] }), ORIGIN);
  assert.ok(findRecord(registry, `${ORIGIN}/o-nas`)!.removed_at);

  const spaGone = { ...SITE, pages: { ...SITE.pages, "/o-nas": { html: page("Home", "<h1>Home</h1>"), finalUrl: `${ORIGIN}/` } } };
  ({ registry } = mergeCrawl(first, await crawlSite(spaGone, { extraUrls: [`${ORIGIN}/o-nas`] }), ORIGIN));
  const rec = findRecord(registry, `${ORIGIN}/o-nas`)!;
  assert.ok(rec.removed_at);
  assert.equal(rec.alias_of, `${ORIGIN}/`);
});

test("freshness: age in days, stale over the threshold, never crawled is stale", () => {
  const at = "2026-10-14T10:00:00.000Z";
  assert.deepEqual(freshness(at, new Date("2026-10-30T10:00:00Z"), 14), { lastCompleteCrawl: at, ageDays: 16, stale: true });
  assert.equal(freshness(at, new Date("2026-10-20T10:00:00Z"), 14).stale, false);
  assert.equal(freshness(null, new Date(), 14).stale, true);
});

// ---- refresh (end to end with fakes) --------------------------------------------

function knowledgeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-repo-"));
  mkdirSync(join(dir, "evidence"), { recursive: true });
  writeFileSync(join(dir, "README.md"), "# Knowledge\n");
  return dir;
}

const config = (dir: string): KnowledgeConfig => ({
  dir,
  origin: ORIGIN,
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
      if (name === ".git") continue;
      const full = join(p, name);
      if (statSync(full).isDirectory()) visit(full);
      else out.push(`${full}:${readFileSync(full, "utf8")}`);
    }
  };
  visit(dir);
  return out.join("\n");
}

test("refresh writes the registry and manifest only (nothing outside evidence/)", async () => {
  const dir = knowledgeRepo();
  const readme = readFileSync(join(dir, "README.md"), "utf8");
  const out = await refresh(config(dir), { dryRun: false, commit: false }, deps(SITE));
  assert.deepEqual(out.written.map((w) => w.replace(/\\/g, "/")).sort(), ["evidence/manifest.json", "evidence/urls.json"]);
  assert.equal(readFileSync(join(dir, "README.md"), "utf8"), readme);
  assert.ok(loadRegistry(dir).urls.length >= 6);
  assert.ok(loadManifest(dir).last_complete_crawl_at);
  assert.match(out.summary, /new +https:\/\/example\.com\/uslugi \(pl\)/);
});

test("refresh --dry-run changes nothing on disk", async () => {
  const dir = knowledgeRepo();
  const before = treeHash(dir);
  const out = await refresh(config(dir), { dryRun: true, commit: false }, deps(SITE));
  assert.equal(treeHash(dir), before);
  assert.deepEqual(out.written, []);
});

test("a failed page keeps the earlier entry; an aborted crawl changes no registry", async () => {
  const dir = knowledgeRepo();
  await refresh(config(dir), { dryRun: false, commit: false }, deps(SITE));
  const broken = { ...SITE, pages: { ...SITE.pages, "/uslugi": { error: "net::ERR_CONNECTION_RESET" } } };
  const out = await refresh(config(dir), { dryRun: false, commit: false }, deps(broken, Date.parse("2026-10-16T10:00:00Z")));
  assert.match(out.summary, /FAILED +https:\/\/example\.com\/uslugi/);
  assert.equal(findRecord(loadRegistry(dir), `${ORIGIN}/uslugi`)!.removed_at, null);
  const manifest = loadManifest(dir);
  assert.equal(manifest.runs.at(-1)!.complete, false);
  assert.equal(manifest.last_complete_crawl_at, manifest.runs[0].finished_at, "freshness keeps the last complete crawl");

  const registryBefore = readFileSync(join(dir, "evidence", "urls.json"), "utf8");
  const aborted = await refresh(config(dir), { dryRun: false, commit: false }, deps({ ...SITE, robots: new Error("down") }));
  assert.ok(aborted.crawl.aborted);
  assert.match(aborted.summary, /ABORTED/);
  assert.equal(readFileSync(join(dir, "evidence", "urls.json"), "utf8"), registryBefore);
});

test("refresh --commit commits only evidence/, locally", async () => {
  const dir = knowledgeRepo();
  const env = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, ...env } }).trim();
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  writeFileSync(join(dir, "README.md"), "# Knowledge\n\nuncommitted edit\n");
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    assert.ok((await refresh(config(dir), { dryRun: false, commit: true }, deps(SITE))).commit);
  } finally {
    process.env = saved;
  }
  const files = git("show", "--name-only", "--format=", "HEAD").split("\n");
  assert.ok(files.every((f) => f.startsWith("evidence/")), files.join(","));
  assert.match(git("status", "--porcelain"), /README\.md/, "other edits stay uncommitted");
  assert.equal(git("remote"), "");
});
