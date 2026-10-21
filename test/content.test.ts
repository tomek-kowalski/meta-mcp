import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "../src/config.js";
import { cliOptions, main, parseArgs, type CliDeps } from "../src/content/cli.js";
import { publishFacebook, type PageClient } from "../src/content/facebook.js";
import { draftName, parseSource, readSourceFile, resolveInboxFile } from "../src/content/intake.js";
import { runFlow, type FlowDeps } from "../src/content/flow.js";
import { approvalValid, canMove, move, readState, writeState } from "../src/content/lifecycle.js";
import * as service from "../src/content/service.js";
import { publishWebsite, type Runner, type SiteDeps } from "../src/content/site-publisher.js";
import { MetaApiError, MetaClient } from "../src/meta-client.js";
import type { CheckContext } from "../src/publisher/checks.js";
import { contentHash, loadDraft, type PublisherPaths } from "../src/publisher/draft.js";

const ORIGIN = "https://example.com";
const PAGE = "123456789";
const SOURCE = [
  "TITLE: Ponawianie zadań w Action Scheduler",
  "LANGUAGE: pl",
  "CHANNELS: website, facebook",
  "",
  "PROBLEM:",
  "Zadania synchronizacji kończyły się błędem przy timeoutach API.",
  "",
  "IMPLEMENTATION:",
  "Ponawianie z rosnącym odstępem, maksymalnie 3 próby.",
  "",
  "CODE:",
  "as_schedule_single_action( time() + 60, 'my_sync', array( 'attempt' => 2 ) );",
  "",
  "RESULT:",
  "Liczba nieudanych synchronizacji spadła o 40% w ciągu tygodnia.",
  "",
  "NOTES:",
  "Bez nazwy klienta.",
].join("\n");

// ---- sandbox ------------------------------------------------------------------

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "content-"));
  const editorial = join(root, "editorial");
  const paths: PublisherPaths = {
    editorialDir: editorial,
    inboxDir: join(editorial, "inbox"),
    draftsDir: join(editorial, "drafts"),
    rejectedDir: join(editorial, "rejected"),
    logsDir: join(editorial, "logs"),
    portfolioDir: join(root, "portfolio"),
  };
  mkdirSync(paths.inboxDir, { recursive: true });
  // the website repository as "the remote": articles.json + the dependency-free tests
  const remote = join(root, "remote");
  mkdirSync(join(remote, "src", "components", "News", "articles"), { recursive: true });
  writeFileSync(join(remote, "src", "components", "News", "articles.json"), "[]\n");
  mkdirSync(paths.portfolioDir, { recursive: true });
  return { root, paths, remote };
}

let clock = Date.parse("2026-10-20T10:00:00Z");
const content = (pageId: string | null = PAGE): service.ContentDeps => ({
  now: () => new Date((clock += 1000)),
  pageId,
  context: (): CheckContext => ({
    origin: ORIGIN,
    newsPaths: { pl: "/news", en: "/en/news", de: "/de/news" },
    published: [],
    categories: ["woocommerce", "integracje"],
    otherDrafts: [],
    registry: null,
    registryAgeDays: null,
    staleDays: 14,
    denylist: ["Acme Shop"],
  }),
});

const META = (name: string, facebookLang = "pl") => ({
  id: name,
  date: "2026-10-20",
  category: "integracje",
  pl: { slug: "ponawianie-zadan", title: "Ponawianie zadań w Action Scheduler", excerpt: "Jak ponawiać zadania." },
  en: { slug: "retrying-jobs", title: "Retrying jobs in Action Scheduler", excerpt: "How to retry jobs." },
  de: { slug: "jobs-wiederholen", title: "Jobs in Action Scheduler wiederholen", excerpt: "Wie man Jobs wiederholt." },
  facebook: { languages: [facebookLang] },
});
const CODE = "```php\nas_schedule_single_action( time() + 60, 'my_sync', array( 'attempt' => 2 ) );\n```";
const body = (lead: string) => `${lead}\n\n## Problem\n\nTekst.\n\n${CODE}\n`;
const FILES = (name: string, facebookLang = "pl") => ({
  "meta.json": JSON.stringify(META(name, facebookLang)),
  "article.pl.md": body("Nieudanych synchronizacji było o 40% mniej."),
  "article.en.md": body("There were 40% fewer failed syncs."),
  "article.de.md": body("Es gab 40% weniger fehlgeschlagene Synchronisierungen."),
  "image.svg": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1080"><rect width="1080" height="1080" fill="#0a0416"/><text x="80" y="540" fill="#fff">Ponawianie</text></svg>`,
  [`facebook.${facebookLang}.txt`]: "Gdy API nie odpowiada, zadanie warto ponowić. Pokazujemy jak.",
});

/** Inbox file → ingested → drafted → submitted → approved (code from the service). */
function approvedDraft(s = sandbox(), opts: service.IngestOptions = {}, deps = content()) {
  writeFileSync(join(s.paths.inboxDir, "Ponawianie Zadań.txt"), SOURCE);
  const r = service.ingest(s.paths, "Ponawianie Zadań.txt", opts, deps);
  service.save(s.paths, r.file, FILES(r.name, r.state.facebook_lang), deps);
  service.submit(s.paths, r.file, deps);
  service.approve(s.paths, r.file, service.pendingApprovalCode(s.paths, r.file, deps), deps);
  return { ...s, name: r.name, file: r.file, deps };
}

// ---- intake ---------------------------------------------------------------------

test("TXT parsing: optional headers, the five sections, plain text, invalid header values", () => {
  const p = parseSource(SOURCE);
  assert.equal(p.title, "Ponawianie zadań w Action Scheduler");
  assert.equal(p.language, "pl");
  assert.deepEqual(p.channels, ["website", "facebook"]);
  assert.deepEqual(Object.keys(p.sections), ["PROBLEM", "IMPLEMENTATION", "CODE", "RESULT", "NOTES"]);
  assert.match(p.sections.CODE!, /as_schedule_single_action/);
  const plain = parseSource("Just some notes about a WooCommerce fix.\nSecond line.");
  assert.deepEqual([plain.title, plain.language, plain.channels, plain.sections], [null, null, null, {}]);
  assert.match(plain.body, /Second line/);
  assert.deepEqual(parseSource("CHANNELS: facebook\n\nx").channels, ["facebook"]);
  assert.deepEqual(parseSource("AUTHOR: me\nTITLE: t\n\nx").ignoredHeaders, ["AUTHOR"]);
  assert.throws(() => parseSource("LANGUAGE: fr\n\nx"), ConfigError);
  assert.throws(() => parseSource("CHANNELS: twitter\n\nx"), ConfigError);
});

test("draft names come from file names", () => {
  assert.equal(draftName("Ponawianie Zadań.txt"), "ponawianie-zadan");
  assert.equal(draftName("woo_Action-Scheduler.TXT"), "woo-action-scheduler");
  assert.throws(() => draftName("___.txt"), ConfigError);
});

test("reading a source: UTF-8 only, no binary, size limit, BOM and CRLF normalized, hash of the original bytes", () => {
  const { paths } = sandbox();
  const file = (name: string, data: string | Buffer) => {
    writeFileSync(join(paths.inboxDir, name), data);
    return join(paths.inboxDir, name);
  };
  const ok = readSourceFile(file("ok.txt", "﻿a\r\nb"));
  assert.equal(ok.text, "a\nb");
  assert.throws(() => readSourceFile(file("latin2.txt", Buffer.from([0x50, 0xb3, 0x6f]))), /UTF-8/);
  assert.throws(() => readSourceFile(file("nul.txt", "a\u0000b")), /binary/);
  assert.throws(() => readSourceFile(file("big.txt", "x".repeat(300 * 1024))), /limit/);
  assert.throws(() => readSourceFile(file("empty.txt", "")), /empty/);
  assert.throws(() => readSourceFile(file("blank.txt", "  \n ")), /no text/);
});

test("only regular .txt files directly in the inbox: traversal, other folders, links and other types refused", (t) => {
  const { root, paths } = sandbox();
  writeFileSync(join(paths.inboxDir, "a.txt"), "x");
  assert.equal(resolveInboxFile(paths.inboxDir, "a.txt"), resolveInboxFile(paths.inboxDir, "a"));
  assert.ok(resolveInboxFile(paths.inboxDir, join(paths.inboxDir, "a.txt")).endsWith("a.txt"));
  writeFileSync(join(root, "outside.txt"), "x");
  mkdirSync(join(paths.inboxDir, "sub"));
  writeFileSync(join(paths.inboxDir, "sub", "b.txt"), "x");
  writeFileSync(join(paths.inboxDir, "c.md"), "x");
  for (const bad of ["../outside.txt", join(root, "outside.txt"), "sub/b.txt", "c.md", "missing.txt"]) {
    assert.throws(() => resolveInboxFile(paths.inboxDir, bad), ConfigError, bad);
  }
  try {
    symlinkSync(join(root, "outside.txt"), join(paths.inboxDir, "link.txt"), "file");
  } catch {
    t.diagnostic("can't create a file symlink here; link case skipped");
    return;
  }
  assert.throws(() => resolveInboxFile(paths.inboxDir, "link.txt"), /link/);
});

// ---- ingest -----------------------------------------------------------------------

test("ingest: defaults (pl, Facebook pl, both channels), the source moved byte for byte, logged without its text", () => {
  const { paths } = sandbox();
  writeFileSync(join(paths.inboxDir, "plain.txt"), "Notatka o optymalizacji zapytań WooCommerce.");
  const original = readFileSync(join(paths.inboxDir, "plain.txt"));
  const r = service.ingest(paths, "plain.txt", {}, content());
  assert.deepEqual([r.name, r.state.status, r.state.lang, r.state.facebook_lang, r.state.channels], ["plain", "VALIDATED", "pl", "pl", ["website", "facebook"]]);
  assert.ok(!existsSync(join(paths.inboxDir, "plain.txt")));
  assert.deepEqual(readFileSync(join(paths.draftsDir, "plain", "source.txt")), original);
  const log = readFileSync(join(paths.logsDir, "publications.jsonl"), "utf8");
  assert.match(log, /"event":"ingested"/);
  assert.ok(!log.includes("optymalizacji"), "no source text in the log");
});

test("ingest: --lang and --facebook-lang are validated; the source's headers apply when not given", () => {
  const { paths } = sandbox();
  writeFileSync(join(paths.inboxDir, "a.txt"), SOURCE.replace("LANGUAGE: pl", "LANGUAGE: en"));
  const r = service.ingest(paths, "a.txt", { facebookLang: "de" }, content());
  assert.deepEqual([r.state.lang, r.state.facebook_lang], ["en", "de"]);
  writeFileSync(join(paths.inboxDir, "b.txt"), "text b");
  assert.throws(() => service.ingest(paths, "b.txt", { facebookLang: "fr" as "pl" }, content()));
  assert.throws(() => service.ingest(paths, "b.txt", { lang: "xx" as "pl" }, content()));
  assert.ok(existsSync(join(paths.inboxDir, "b.txt")), "a refused ingest leaves the file in the inbox");
});

test("ingest: the same file name or the same content twice is refused", () => {
  const { paths } = sandbox();
  writeFileSync(join(paths.inboxDir, "a.txt"), "same text");
  service.ingest(paths, "a.txt", {}, content());
  writeFileSync(join(paths.inboxDir, "a.txt"), "other text");
  assert.throws(() => service.ingest(paths, "a.txt", {}, content()), /already ingested/);
  writeFileSync(join(paths.inboxDir, "b.txt"), "same text");
  assert.throws(() => service.ingest(paths, "b.txt", {}, content()), /same content/);
});

// ---- lifecycle, checks, approval ------------------------------------------------------

test("lifecycle: only the defined moves are allowed", () => {
  assert.ok(canMove("REVIEW", "APPROVED"));
  assert.ok(canMove("WEBSITE_PUBLISHED", "PARTIALLY_PUBLISHED"));
  assert.ok(!canMove("DRAFT", "APPROVED"), "no approval without review");
  assert.ok(!canMove("APPROVED", "FACEBOOK_PUBLISHED"), "no Facebook before the website");
  assert.ok(!canMove("FACEBOOK_PUBLISHED", "DRAFT"));
});

test("checks: numbers must be in the source; one Facebook language; never-publish terms", () => {
  const { paths } = sandbox();
  writeFileSync(join(paths.inboxDir, "a.txt"), SOURCE);
  const r = service.ingest(paths, "a.txt", {}, content());
  service.save(paths, "a.txt", FILES(r.name), content());
  assert.equal(service.check(paths, "a.txt", content()).errors, 0, "40% is in the source");
  service.save(paths, "a.txt", { "article.de.md": body("Es gab 45% weniger Fehler.") }, content());
  const invented = service.check(paths, "a.txt", content());
  assert.ok(invented.findings.some((f) => f.code === "claim.source" && f.where === "article.de.md"));
  service.save(paths, "a.txt", { "article.de.md": body("Es gab 40% weniger Fehler."), "facebook.pl.txt": "Projekt dla Acme Shop." }, content());
  assert.ok(service.check(paths, "a.txt", content()).findings.some((f) => f.code === "denylist"));
  assert.throws(() => service.save(paths, "a.txt", { "meta.json": JSON.stringify(META(r.name, "en")) }, content()), /facebook.languages/);
  assert.throws(() => service.save(paths, "a.txt", { "notes.txt": "x" }, content()), /not a draft file/);
});

test("approval: only with the code for this exact content; any edit voids it", () => {
  const s = approvedDraft();
  let state = readState(join(s.paths.draftsDir, s.name));
  assert.equal(state.status, "APPROVED");
  assert.ok(approvalValid(state, contentHash(loadDraft(s.paths, s.name)), PAGE));
  assert.ok(!approvalValid(state, contentHash(loadDraft(s.paths, s.name)), "999"), "another Page needs a new approval");
  service.save(s.paths, s.file, { "facebook.pl.txt": "Zmieniony tekst posta o ponawianiu zadań." }, s.deps);
  state = readState(join(s.paths.draftsDir, s.name));
  assert.equal(state.status, "DRAFT");
  assert.equal(state.approval, null);
  service.submit(s.paths, s.file, s.deps);
  assert.throws(() => service.approve(s.paths, s.file, "WRONG1", s.deps), /doesn't match/);
  assert.equal(readState(join(s.paths.draftsDir, s.name)).status, "REVIEW");
});

test("reject: the draft and its source move to rejected/; the name can't be ingested again", () => {
  const { paths } = sandbox();
  writeFileSync(join(paths.inboxDir, "a.txt"), "x");
  service.ingest(paths, "a.txt", {}, content());
  service.reject(paths, "a.txt", "not relevant", content());
  assert.ok(existsSync(join(paths.rejectedDir, "a", "source.txt")));
  writeFileSync(join(paths.inboxDir, "a.txt"), "y");
  assert.throws(() => service.ingest(paths, "a.txt", {}, content()), /rejected/);
});

// ---- website ----------------------------------------------------------------------------

function fakeSite(s: ReturnType<typeof sandbox>, opts: { testsFail?: boolean; live?: (url: string) => boolean } = {}) {
  const calls: string[] = [];
  const run: Runner = async (command, args, cwd) => {
    calls.push(`${command} ${args.join(" ")}`);
    if (command === "git" && args[0] === "worktree" && args[1] === "add") cpSync(s.remote, args[3], { recursive: true });
    if (command === "git" && args[0] === "push") cpSync(join(cwd, "src"), join(s.remote, "src"), { recursive: true });
    if (command === "git" && args[0] === "rev-parse") return { code: 0, stdout: "abc1234\n", stderr: "" };
    if (command === "node") return { code: opts.testsFail ? 1 : 0, stdout: opts.testsFail ? "not ok 1 - every article in three languages" : "ok", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const site: SiteDeps = {
    run,
    origin: ORIGIN,
    newsPaths: { pl: "/news", en: "/en/news", de: "/de/news" },
    tmpDir: join(s.root, "tmp"),
    sleep: async () => {},
    liveTimeoutMs: 0,
    fetchText: async (url) => {
      const live = opts.live ? opts.live(url) : true;
      const lang = url.includes("/en/") ? "en" : url.includes("/de/") ? "de" : "pl";
      const title = META("x")[lang].title;
      return live ? { status: 200, text: `<title>${title} | ForeachURL</title><link rel="canonical" href="${url}">` } : { status: 404, text: "" };
    },
  };
  return { site, calls };
}

test("website: only an approved, unchanged draft; dry run pushes nothing", async () => {
  const s = approvedDraft();
  const { site, calls } = fakeSite(s);
  const dry = await publishWebsite(s.paths, s.name, { dryRun: true }, { ...s.deps, ...site });
  assert.equal(dry.dryRun, true);
  assert.ok(!calls.some((c) => c.startsWith("git push")));
  assert.equal(readState(join(s.paths.draftsDir, s.name)).status, "APPROVED");
  writeFileSync(join(s.paths.draftsDir, s.name, "article.en.md"), body("Edited after approval: 40% fewer."));
  await assert.rejects(publishWebsite(s.paths, s.name, { dryRun: false }, { ...s.deps, ...site }), /changed after it was approved/);
});

test("website: entry and three bodies pushed to main; live in pl/en/de; a second run changes nothing", async () => {
  const s = approvedDraft();
  const { site, calls } = fakeSite(s);
  const r = await publishWebsite(s.paths, s.name, { dryRun: false }, { ...s.deps, ...site });
  assert.equal(r.status, "WEBSITE_PUBLISHED");
  assert.deepEqual(r.urls, { pl: `${ORIGIN}/news/ponawianie-zadan`, en: `${ORIGIN}/en/news/retrying-jobs`, de: `${ORIGIN}/de/news/jobs-wiederholen` });
  assert.equal(calls.filter((c) => c === "git push origin HEAD:main").length, 1);
  const entries = JSON.parse(readFileSync(join(s.remote, "src", "components", "News", "articles.json"), "utf8"));
  assert.deepEqual(entries[0].translations.en.slug, "retrying-jobs");
  assert.ok(existsSync(join(s.remote, "src", "components", "News", "articles", "de", "jobs-wiederholen.md")));
  const again = await publishWebsite(s.paths, s.name, { dryRun: false }, { ...s.deps, ...site });
  assert.equal(again.changed, false);
  assert.equal(calls.filter((c) => c === "git push origin HEAD:main").length, 1, "no second push");
  assert.ok(!readdirSync(join(s.root, "tmp")).length, "the worktree is cleaned up");
});

test("website: failing site checks push nothing; not live in time keeps it unpublished, a rerun finishes without pushing again", async () => {
  const s = approvedDraft();
  const failing = fakeSite(s, { testsFail: true });
  await assert.rejects(publishWebsite(s.paths, s.name, { dryRun: false }, { ...s.deps, ...failing.site }), /checks failed/);
  assert.ok(!failing.calls.some((c) => c.startsWith("git push")));
  assert.equal(readState(join(s.paths.draftsDir, s.name)).status, "APPROVED");

  const slow = fakeSite(s, { live: () => false });
  await assert.rejects(publishWebsite(s.paths, s.name, { dryRun: false }, { ...s.deps, ...slow.site }), /not live/);
  assert.equal(readState(join(s.paths.draftsDir, s.name)).status, "APPROVED");
  const later = fakeSite(s);
  const r = await publishWebsite(s.paths, s.name, { dryRun: false }, { ...s.deps, ...later.site });
  assert.equal(r.status, "WEBSITE_PUBLISHED");
  assert.ok(!later.calls.some((c) => c.startsWith("git push")), "already on main: not pushed twice");
});

// ---- Facebook ---------------------------------------------------------------------------

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const fakePng = async (svg: string) => (assert.match(svg, /^<svg/), PNG);

function fakePage(behaviour: ("ok" | "refused" | "network")[] = ["ok"]) {
  const posted: { message: string; image: Uint8Array }[] = [];
  const existing: { id: string; message: string }[] = [];
  const client: PageClient = {
    getPageAccessToken: async () => "page-token-xyz",
    list: (async () => ({ data: existing, paging: { has_next_page: false } })) as PageClient["list"],
    postPagePhoto: async (_page, post) => {
      const mode = behaviour.shift() ?? "ok";
      if (mode === "refused") throw new MetaApiError("(#200) Permissions error", { code: 200 });
      if (mode === "network") {
        existing.push({ id: `${PAGE}_777`, message: post.message }); // it did arrive
        throw new MetaApiError("Network error calling Meta Graph API", { network: true });
      }
      posted.push(post);
      return { id: `${PAGE}_${posted.length}` };
    },
  };
  return { client, posted };
}

async function websiteDone(opts: service.IngestOptions = {}) {
  const s = approvedDraft(sandbox(), opts);
  await publishWebsite(s.paths, s.name, { dryRun: false }, { ...s.deps, ...fakeSite(s).site });
  return s;
}

test("Facebook: refused before the website is live; refused when the article in the post's language isn't live", async () => {
  const s = approvedDraft();
  const page = fakePage();
  const fb = { client: () => page.client, fetchText: fakeSite(s).site.fetchText, renderImage: fakePng };
  await assert.rejects(publishFacebook(s.paths, s.name, { dryRun: false }, { ...s.deps, ...fb }), /must be live on the website/);
  const done = await websiteDone();
  const down = { client: () => page.client, fetchText: async () => ({ status: 404, text: "" }), renderImage: fakePng };
  await assert.rejects(publishFacebook(done.paths, done.name, { dryRun: false }, { ...done.deps, ...down }), /isn't live/);
  assert.equal(page.posted.length, 0);
});

test("Facebook: the post in its one chosen language links the article in that language; dry run posts nothing", async () => {
  const s = await websiteDone({ facebookLang: "en" });
  const page = fakePage();
  const fb = { client: () => page.client, fetchText: fakeSite(s).site.fetchText, renderImage: fakePng };
  const dry = await publishFacebook(s.paths, s.name, { dryRun: true }, { ...s.deps, ...fb });
  assert.equal(dry.link, `${ORIGIN}/en/news/retrying-jobs`);
  assert.equal(page.posted.length, 0);
  const r = await publishFacebook(s.paths, s.name, { dryRun: false }, { ...s.deps, ...fb });
  assert.equal(r.status, "FACEBOOK_PUBLISHED");
  assert.deepEqual(page.posted, [{ message: `Gdy API nie odpowiada, zadanie warto ponowić. Pokazujemy jak.\n\n${ORIGIN}/en/news/retrying-jobs`, image: PNG }], "the link at the bottom, with the image");
  const again = await publishFacebook(s.paths, s.name, { dryRun: false }, { ...s.deps, ...fb });
  assert.equal(again.note, "already posted");
  assert.equal(page.posted.length, 1);
  const log = readFileSync(join(s.paths.logsDir, "publications.jsonl"), "utf8");
  assert.match(log, /"event":"facebook_published","name":"ponawianie-zadan","lang":"en"/);
});

test("Facebook: a refusal keeps the website published (PARTIALLY_PUBLISHED); a retry posts once", async () => {
  const s = await websiteDone();
  const page = fakePage(["refused", "ok"]);
  const fb = { client: () => page.client, fetchText: fakeSite(s).site.fetchText, renderImage: fakePng };
  await assert.rejects(publishFacebook(s.paths, s.name, { dryRun: false }, { ...s.deps, ...fb }), /refused the post/);
  const state = readState(join(s.paths.draftsDir, s.name));
  assert.equal(state.status, "PARTIALLY_PUBLISHED");
  assert.ok(state.website?.urls.pl);
  const r = await publishFacebook(s.paths, s.name, { dryRun: false }, { ...s.deps, ...fb });
  assert.equal(r.status, "FACEBOOK_PUBLISHED");
  assert.equal(page.posted.length, 1);
});

test("Facebook: a lost answer becomes 'unknown'; the retry finds the post instead of posting twice", async () => {
  const s = await websiteDone();
  const page = fakePage(["network"]);
  const fb = { client: () => page.client, fetchText: fakeSite(s).site.fetchText, renderImage: fakePng };
  await assert.rejects(publishFacebook(s.paths, s.name, { dryRun: false }, { ...s.deps, ...fb }), /may exist/);
  assert.equal(readState(join(s.paths.draftsDir, s.name)).facebook?.status, "unknown");
  const r = await publishFacebook(s.paths, s.name, { dryRun: false }, { ...s.deps, ...fb });
  assert.equal(r.post_id, `${PAGE}_777`);
  assert.equal(page.posted.length, 0, "never posted a second time");
});

// ---- CLI and client -----------------------------------------------------------------------

test("CLI options: --lang and --facebook-lang validated, file name positional or --file", () => {
  assert.deepEqual(parseArgs(["ingest", "a.txt", "--facebook-lang", "en"]).file, "a.txt");
  assert.deepEqual(parseArgs(["ingest", "--file", "../editorial/inbox/a.txt"]).file, "../editorial/inbox/a.txt");
  assert.equal(cliOptions.parse({ "facebook-lang": "de" })["facebook-lang"], "de");
  assert.throws(() => cliOptions.parse({ "facebook-lang": "fr" }));
  assert.throws(() => cliOptions.parse({ lang: "PL" }));
  assert.deepEqual(cliOptions.parse({ channels: "website" }).channels, ["website"]);
  assert.throws(() => cliOptions.parse({ unknown: "x" }));
});

test("CLI: an invalid language is reported as a readable message, not a schema dump", async () => {
  const unused = () => {
    throw new Error("not used");
  };
  const deps = { paths: sandbox().paths, content: content(), site: unused, facebook: unused } as CliDeps;
  const out = { log: () => {}, error: () => {} };
  await assert.rejects(main(["ingest", "a.txt", "--facebook-lang", "fr"], out, deps), (err: Error) => /^--facebook-lang: /.test(err.message) && !err.message.includes("{"));
});

test("CLI approve: refused without the owner's terminal; the typed code must match", async () => {
  const s = sandbox();
  writeFileSync(join(s.paths.inboxDir, "a.txt"), SOURCE);
  const deps = content();
  const r = service.ingest(s.paths, "a.txt", {}, deps);
  service.save(s.paths, "a.txt", FILES(r.name), deps);
  const lines: string[] = [];
  const out = { log: (l: string) => lines.push(l), error: (l: string) => lines.push(l) };
  const cli = (ask?: (q: string) => Promise<string>): CliDeps => ({
    paths: s.paths,
    content: deps,
    site: () => {
      throw new Error("not used");
    },
    facebook: () => {
      throw new Error("not used");
    },
    ask,
  });
  assert.equal(await main(["approve", "a.txt"], out, cli()), 1);
  assert.match(lines.at(-1)!, /your own interactive terminal/);
  assert.equal(await main(["approve", "a.txt"], out, cli(async () => "nope")), 1);
  assert.equal(readState(join(s.paths.draftsDir, r.name)).status, "REVIEW");
  let shown = "";
  assert.equal(await main(["approve", "a.txt"], out, cli(async (q) => ((shown = q), q.match(/Type (\w+)/)![1]))), 0);
  assert.match(shown, /Type [0-9A-F]{6} to approve/);
  assert.equal(readState(join(s.paths.draftsDir, r.name)).status, "APPROVED");
  assert.ok(lines.some((l) => l.includes("Facebook post (pl)")) && lines.some((l) => l.includes(`${ORIGIN}/en/news/retrying-jobs`)));
});

test("CLI ingest in the owner's terminal: Claude writes, the owner asks for a rewrite, then accepts and it publishes", async () => {
  const s = sandbox();
  writeFileSync(join(s.paths.inboxDir, "a.txt"), SOURCE);
  const deps = content();
  const writes: (string | null)[] = [];
  const published: string[] = [];
  const publishTo = (to: "WEBSITE_PUBLISHED" | "FACEBOOK_PUBLISHED") => (name: string) => {
    const dir = join(s.paths.draftsDir, name);
    writeState(dir, move(readState(dir), to, deps.now()));
    published.push(to);
  };
  const answers = ["r", "make it shorter", "000000"]; // a wrong code is asked again, then the right one
  const ask = async (q: string) => answers.shift() ?? q.match(/(?:Type|match) ([0-9A-F]{6})/)![1];
  const write: FlowDeps["write"] = async (file, notes) => {
    writes.push(notes);
    service.save(s.paths, file, FILES(service.nameOf(file)), deps);
  };
  const lines: string[] = [];
  const out = { log: (l: string) => lines.push(l), error: (l: string) => lines.push(l) };
  // the real publishers are covered above; here only the order and the gate matter
  const fd: FlowDeps = {
    paths: s.paths,
    content: deps,
    ask,
    write,
    publishWebsite: async (name) => (publishTo("WEBSITE_PUBLISHED")(name), { status: "WEBSITE_PUBLISHED", urls: { pl: `${ORIGIN}/news/x` } }),
    publishFacebook: async (name) => (publishTo("FACEBOOK_PUBLISHED")(name), { status: "FACEBOOK_PUBLISHED", post_id: `${PAGE}_1` }),
    refreshKnowledge: async () => "refreshed",
    printSummary: () => lines.push("SUMMARY"),
    preview: async () => null,
  };
  const r = service.ingest(s.paths, "a.txt", {}, deps);
  assert.equal(await runFlow("a.txt", out, fd), 0);
  assert.deepEqual(writes, [null, "make it shorter"]);
  assert.equal(lines.filter((l) => l === "SUMMARY").length, 2, "shown again after the rewrite");
  assert.deepEqual(published, ["WEBSITE_PUBLISHED", "FACEBOOK_PUBLISHED"]);
  assert.equal(readState(join(s.paths.draftsDir, r.name)).status, "FACEBOOK_PUBLISHED");
});

test("CLI review: Enter publishes nothing; c cancels into rejected/", async () => {
  const s = sandbox();
  writeFileSync(join(s.paths.inboxDir, "a.txt"), SOURCE);
  const deps = content();
  const r = service.ingest(s.paths, "a.txt", {}, deps);
  const never = () => {
    throw new Error("must not publish");
  };
  const cli = (answers: string[]): CliDeps => ({
    paths: s.paths,
    content: deps,
    site: never,
    facebook: never,
    ask: async () => answers.shift() ?? "",
    write: async (file) => void service.save(s.paths, file, FILES(service.nameOf(file)), deps),
    preview: async () => null,
  });
  const out = { log: () => {}, error: () => {} };
  assert.equal(await main(["review", "a.txt"], out, cli([""])), 0);
  assert.equal(readState(join(s.paths.draftsDir, r.name)).status, "REVIEW");
  assert.equal(await main(["review", "a.txt"], out, cli(["c", "not now"])), 0);
  assert.ok(existsSync(join(s.paths.rejectedDir, r.name)));
});

test("MetaClient: the one write is a multipart photo post to /<page>/photos with the Page token; a lost answer is flagged", async () => {
  const requests: { url: string; method: string; body: unknown; auth: string }[] = [];
  const ok: typeof fetch = async (url, init) => {
    requests.push({ url: String(url), method: String(init?.method), body: init?.body, auth: String((init?.headers as Record<string, string>).Authorization) });
    return new Response(JSON.stringify({ id: "photo_9", post_id: `${PAGE}_1` }), { status: 200 });
  };
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
  const client = new MetaClient({ token: "system-user-token-123", apiVersion: "v26.0", fetchImpl: ok });
  assert.deepEqual(await client.postPagePhoto(PAGE, { message: `Hej\n\n${ORIGIN}/news/x`, image: png }, "page-token-456"), { id: `${PAGE}_1` });
  assert.equal(requests[0].method, "POST");
  assert.match(requests[0].url, new RegExp(`/v26\\.0/${PAGE}/photos$`));
  assert.equal(requests[0].auth, "Bearer page-token-456");
  const form = requests[0].body as FormData;
  assert.equal(form.get("message"), `Hej\n\n${ORIGIN}/news/x`);
  assert.equal(form.get("published"), "true");
  assert.equal((form.get("source") as Blob).type, "image/png");
  await assert.rejects(client.postPagePhoto("me", { message: "x", image: png }, "t"), /Invalid Page ID/);
  await assert.rejects(client.postPagePhoto(PAGE, { message: "x", image: new Uint8Array([1, 2, 3]) }, "t"), /PNG/);
  const lost = new MetaClient({ token: "system-user-token-123", apiVersion: "v26.0", fetchImpl: async () => { throw new TypeError("fetch failed"); } });
  await assert.rejects(lost.postPagePhoto(PAGE, { message: "x", image: png }, "t"), (err: unknown) => err instanceof MetaApiError && err.network === true);
});
test("cleanup of sandboxes", () => {
  rmSync(join(tmpdir(), "content-nonexistent"), { recursive: true, force: true });
});
