import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { relative } from "node:path";
import { launchRenderer, type Renderer } from "./browser.js";
import { requireOrigin, type KnowledgeConfig } from "./config.js";
import { crawl, type CrawlResult, type Fetcher } from "./crawler.js";
import { realClock, type Clock } from "./rate-limit.js";
import { mergeCrawl, type ChangeKind, type MergeResult } from "./registry.js";
import { manifest as manifestSchema, urlRegistry, type CrawlRun } from "./schema.js";
import { knowledgePaths, loadManifest, loadRegistry, readJsonFile, stableJson, writeGenerated } from "./store.js";

export interface RefreshOptions {
  dryRun: boolean;
  limit?: number;
  commit: boolean;
}

export interface RefreshDeps {
  fetchText?: Fetcher;
  launch?: () => Promise<Renderer>;
  clock?: Clock;
  log?: (line: string) => void;
}

export interface RefreshOutcome {
  crawl: CrawlResult;
  merge: MergeResult | null;
  summary: string;
  written: string[];
  commit: string | null;
}

const MAX_RUNS = 100;

export function makeFetcher(userAgent: string, timeoutMs = 30_000): Fetcher {
  return async (url) => {
    const res = await fetch(url, { headers: { "User-Agent": userAgent }, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
    return { status: res.status, text: await res.text() };
  };
}

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** A short, human-readable summary of what the crawl found and changed. */
export function summarize(result: CrawlResult, merge: MergeResult | null): string {
  const lines = [`crawl ${result.finishedAt}: ${result.complete ? "complete" : "partial"}`];
  if (result.aborted) return [...lines, `ABORTED: ${result.aborted} (nothing changed)`].join("\n");
  const of = (kind: ChangeKind) => merge?.changes.filter((c) => c.kind === kind) ?? [];
  lines.push(`pages: ${of("verified").length} verified, ${of("added").length} new, ${of("removed").length} removed, ${of("restored").length} restored, ${of("alias").length} aliases, ${of("failed").length} failed, ${result.skipped.length} skipped`);
  for (const c of of("added")) lines.push(`  new      ${c.url} (${c.record.lang})`);
  for (const c of of("removed")) lines.push(`  removed  ${c.url}`);
  for (const c of of("restored")) lines.push(`  restored ${c.url}`);
  for (const c of of("failed")) lines.push(`  FAILED   ${c.url}: ${c.outcome.ok ? "" : c.outcome.error} (earlier entry kept)`);
  for (const w of result.warnings) lines.push(`  warning  ${w}`);
  return lines.join("\n");
}

export async function refresh(config: KnowledgeConfig, opts: RefreshOptions, deps: RefreshDeps = {}): Promise<RefreshOutcome> {
  const origin = requireOrigin(config);
  const paths = knowledgePaths(config.dir);
  if (!existsSync(paths.root)) throw new Error(`Knowledge directory ${paths.root} does not exist.`);
  const log = deps.log ?? (() => undefined);
  const clock = deps.clock ?? realClock;
  const previous = loadRegistry(config.dir, origin);
  const manifest = loadManifest(config.dir, origin);

  let result: CrawlResult;
  let renderer: Renderer | undefined;
  try {
    renderer = await (deps.launch ?? (() => launchRenderer({ origin, userAgent: config.userAgent })))();
    log(`browser: ${renderer.browserName}`);
    result = await crawl(
      {
        origin,
        userAgent: config.userAgent,
        minDelayMs: config.minDelayMs,
        maxPages: config.maxPages,
        limit: opts.limit,
        extraUrls: [
          ...previous.urls.filter((r) => !r.removed_at).map((r) => r.url),
          ...config.extraPaths.map((p) => `${origin}${p}`),
        ],
      },
      { fetchText: deps.fetchText ?? makeFetcher(config.userAgent), renderer, clock, log },
    );
  } catch (err) {
    const at = new Date(clock.now()).toISOString();
    const aborted = err instanceof Error ? err.message : String(err);
    result = { startedAt: at, finishedAt: at, aborted, complete: false, sitemapUrls: [], outcomes: [], skipped: [], warnings: [] };
  } finally {
    await renderer?.close();
  }

  const merge = result.aborted ? null : mergeCrawl(previous, result, origin);
  const summary = summarize(result, merge);
  if (opts.dryRun) return { crawl: result, merge, summary, written: [], commit: null };

  // ---- write evidence/ only -------------------------------------------------
  const failed = result.outcomes.filter((o) => !o.ok).length;
  const run: CrawlRun = {
    started_at: result.startedAt,
    finished_at: result.finishedAt,
    origin,
    user_agent: config.userAgent,
    complete: result.complete && !failed && !result.aborted,
    limit: opts.limit ?? null,
    pages_ok: result.outcomes.length - failed,
    pages_failed: failed,
    pages_skipped: result.skipped.length,
  };
  const nextManifest = {
    version: 2 as const,
    origin,
    last_complete_crawl_at: run.complete ? result.finishedAt : manifest.last_complete_crawl_at,
    runs: [...manifest.runs, run].slice(-MAX_RUNS),
  };
  const writes: { file: string; content: string }[] = [];
  if (merge) writes.push({ file: paths.urls, content: stableJson(merge.registry) });
  writes.push({ file: paths.manifest, content: stableJson(nextManifest) });
  for (const w of writes) writeGenerated(paths.root, w.file, w.content);

  let commit: string | null = null;
  if (opts.commit) {
    // Validate what was written before committing it. Local commit only, never a push.
    if (merge) readJsonFile(paths.urls, urlRegistry);
    readJsonFile(paths.manifest, manifestSchema);
    git(paths.root, ["add", "--", "evidence"]);
    if (git(paths.root, ["diff", "--cached", "--name-only"])) {
      git(paths.root, ["commit", "-q", "-m", `knowledge refresh ${result.finishedAt}${run.complete ? "" : " (partial)"}`, "--", "evidence"]);
      commit = git(paths.root, ["rev-parse", "--short", "HEAD"]);
    }
  }
  return { crawl: result, merge, summary, written: writes.map((w) => relative(paths.root, w.file)), commit };
}
