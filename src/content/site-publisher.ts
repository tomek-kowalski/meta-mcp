import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "../config.js";
import { contentHash, loadDraft, type Draft, type Language, type PublisherPaths } from "../publisher/draft.js";
import { approvalValid, logEvent, move, readState, writeState, type DraftState } from "./lifecycle.js";
import { check, type ContentDeps } from "./service.js";

/**
 * Publishing an approved draft to the website (the private portfolio repo,
 * deployed by Vercel from main):
 *
 * 1. a detached git worktree of origin/main in the temp folder (the owner's
 *    working copy is never touched);
 * 2. the articles.json entry (pl at the top level, en/de under translations)
 *    and the three bodies are written there;
 * 3. the site's dependency-free checks run there (every article in three
 *    languages, llms.txt links, URL rules); no node_modules is linked in;
 * 4. one commit, pushed fast-forward to main (refused if main moved);
 * 5. waits until every language URL is live with its canonical and title.
 *
 * Idempotent: an article already on main with the same content is not
 * committed again. --dry-run stops after step 3 and changes nothing.
 */

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type Runner = (command: string, args: string[], cwd: string) => Promise<RunResult>;

export interface SiteDeps {
  run: Runner;
  fetchText: (url: string) => Promise<{ status: number; text: string }>;
  sleep: (ms: number) => Promise<void>;
  /** Website origin, e.g. https://foreachurl.app */
  origin: string;
  newsPaths: Record<Language, string>;
  tmpDir?: string;
  /** How long to wait for the deployment (default 15 min, every 15 s) */
  liveTimeoutMs?: number;
  liveIntervalMs?: number;
}

export const realRunner: Runner = (command, args, cwd) =>
  new Promise((resolve) => {
    execFile(command, args, { cwd, encoding: "utf8", windowsHide: true, maxBuffer: 20 * 1024 * 1024, shell: process.platform === "win32" && command === "npm" }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) }),
    );
  });

const ARTICLES_JSON = join("src", "components", "News", "articles.json");
const bodyPath = (language: Language, slug: string) =>
  join("src", "components", "News", "articles", ...(language === "pl" ? [] : [language]), `${slug}.md`);

/** The website's articles.json entry for a draft. */
export function articleEntry(draft: Draft) {
  const { meta } = draft;
  return {
    slug: meta.pl.slug,
    title: meta.pl.title,
    category: meta.category,
    excerpt: meta.pl.excerpt,
    date: meta.date,
    translations: {
      en: { slug: meta.en.slug, title: meta.en.title, excerpt: meta.en.excerpt },
      de: { slug: meta.de.slug, title: meta.de.title, excerpt: meta.de.excerpt },
    },
  };
}

export const articleUrls = (draft: Draft, deps: Pick<SiteDeps, "origin" | "newsPaths">) =>
  Object.fromEntries((["pl", "en", "de"] as const).map((l) => [l, `${deps.origin}${deps.newsPaths[l]}/${draft.meta[l].slug}`])) as Record<Language, string>;

/** Writes the entry and bodies into a portfolio checkout. Returns false if it already matches exactly. */
export function writeArticle(root: string, draft: Draft): boolean {
  const file = join(root, ARTICLES_JSON);
  const raw = readFileSync(file, "utf8");
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const entries = JSON.parse(raw) as ReturnType<typeof articleEntry>[];
  const entry = articleEntry(draft);
  const index = entries.findIndex((e) => e.slug === entry.slug);
  const bodies = (["pl", "en", "de"] as const).map((l) => ({ path: join(root, bodyPath(l, draft.meta[l].slug)), text: draft.bodies[l] ?? "" }));
  const same =
    index !== -1 &&
    JSON.stringify(entries[index]) === JSON.stringify(entry) &&
    bodies.every((b) => existsSync(b.path) && readFileSync(b.path, "utf8") === b.text);
  if (same) return false;
  if (index === -1) entries.unshift(entry);
  else entries[index] = entry;
  writeFileSync(file, `${JSON.stringify(entries, null, 4)}\n`.replace(/\n/g, eol));
  for (const b of bodies) {
    mkdirSync(join(b.path, ".."), { recursive: true });
    writeFileSync(b.path, b.text);
  }
  return true;
}

export interface WebsiteResult {
  name: string;
  dryRun: boolean;
  changed: boolean;
  commit: string | null;
  urls: Record<Language, string>;
  status: DraftState["status"];
}

async function git(deps: SiteDeps, cwd: string, ...args: string[]): Promise<string> {
  const r = await deps.run("git", args, cwd);
  if (r.code !== 0) throw new ConfigError(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ")}`);
  return r.stdout.trim();
}

export async function publishWebsite(
  paths: PublisherPaths,
  name: string,
  options: { dryRun: boolean },
  deps: ContentDeps & SiteDeps,
): Promise<WebsiteResult> {
  const dir = join(paths.draftsDir, name);
  let state = readState(dir);
  const draft = loadDraft(paths, name);
  const urls = articleUrls(draft, deps);

  if (state.website && ["WEBSITE_PUBLISHED", "PARTIALLY_PUBLISHED", "FACEBOOK_PUBLISHED"].includes(state.status)) {
    return { name, dryRun: options.dryRun, changed: false, commit: state.website.commit, urls, status: state.status }; // already published
  }
  if (state.status !== "APPROVED") throw new ConfigError(`"${name}" is ${state.status}; only an approved draft can be published.`);
  const outcome = check(paths, name, deps); // revalidated right before publishing
  if (outcome.errors) throw new ConfigError(`"${name}" now has ${outcome.errors} error(s); nothing was published.`);
  if (!approvalValid(state, contentHash(draft), deps.pageId)) {
    throw new ConfigError(`"${name}" changed after it was approved (or the Page changed); submit and approve it again.`);
  }

  const worktree = join(deps.tmpDir ?? tmpdir(), `foreachurl-news-${name}`);
  const portfolio = paths.portfolioDir;
  await git(deps, portfolio, "fetch", "origin", "main");
  await deps.run("git", ["worktree", "remove", "--force", worktree], portfolio); // a leftover from an earlier run
  rmSync(worktree, { recursive: true, force: true });
  await git(deps, portfolio, "worktree", "add", "--detach", worktree, "origin/main");
  try {
    const changed = writeArticle(worktree, draft);
    const tests = await deps.run("node", ["--test", "tests/unit/routes.test.js", "tests/unit/llms.test.js"], worktree);
    if (tests.code !== 0) throw new ConfigError(`The website's checks failed with this article: ${tests.stdout.split("\n").filter((l) => /not ok|Error|fail/i.test(l)).slice(0, 5).join(" | ")}`);
    let commit: string | null = null;
    if (changed) {
      await git(deps, worktree, "add", "--", ARTICLES_JSON, ...(["pl", "en", "de"] as const).map((l) => bodyPath(l, draft.meta[l].slug)));
      await git(deps, worktree, "commit", "-q", "-m", `News: ${draft.meta.pl.title}\n\nPublished from the editorial draft "${name}" (content ${outcome.content_sha256.slice(0, 12)}).`);
      commit = await git(deps, worktree, "rev-parse", "--short", "HEAD");
    }
    if (options.dryRun) return { name, dryRun: true, changed, commit, urls, status: state.status };

    if (changed) await git(deps, worktree, "push", "origin", "HEAD:main"); // fast-forward only: refused if main moved
    await waitLive(urls, draft, deps);
    const now = deps.now();
    state = move(state, "WEBSITE_PUBLISHED", now, "article live in pl, en and de");
    state = { ...state, website: { content_sha256: outcome.content_sha256, urls, commit, published_at: now.toISOString() }, last_error: null };
    writeState(dir, state);
    logEvent(paths.logsDir, { event: "website_published", name, content_sha256: outcome.content_sha256, urls, commit }, now);
    return { name, dryRun: false, changed, commit, urls, status: state.status };
  } catch (err) {
    if (!options.dryRun) {
      const message = err instanceof Error ? err.message : String(err);
      writeState(dir, { ...readState(dir), last_error: message });
      logEvent(paths.logsDir, { event: "website_failed", name, error: message }, deps.now());
    }
    throw err;
  } finally {
    await deps.run("git", ["worktree", "remove", "--force", worktree], portfolio);
    rmSync(worktree, { recursive: true, force: true });
  }
}

/** Waits until every language URL answers 200 with its canonical and title (the prerendered page). */
export async function waitLive(urls: Record<Language, string>, draft: Draft, deps: SiteDeps): Promise<void> {
  const deadline = Date.now() + (deps.liveTimeoutMs ?? 15 * 60_000);
  const pending = new Set(Object.keys(urls) as Language[]);
  while (pending.size) {
    for (const l of [...pending]) {
      try {
        const res = await deps.fetchText(urls[l]);
        if (res.status === 200 && res.text.includes(`<link rel="canonical" href="${urls[l]}">`) && res.text.includes(escapeHtml(draft.meta[l].title))) pending.delete(l);
      } catch {
        /* not yet */
      }
    }
    if (!pending.size) return;
    if (Date.now() >= deadline) {
      throw new ConfigError(`Pushed, but not live after waiting: ${[...pending].map((l) => urls[l]).join(", ")}. Check the Vercel deployment, then run publish again.`);
    }
    await deps.sleep(deps.liveIntervalMs ?? 15_000);
  }
}

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
