import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { launchRenderer, type Renderer } from "./browser.js";
import { requireOrigin, type KnowledgeConfig } from "./config.js";
import { crawl, type CrawlResult, type Fetcher } from "./crawler.js";
import { realClock, type Clock } from "./rate-limit.js";
import { mergeCrawl, type MergeResult } from "./registry.js";
import { buildReport, diffSections, type ReportExtras, type SectionDiff } from "./report.js";
import { manifest as manifestSchema, urlRegistry, type CrawlRun } from "./schema.js";
import { parseSnapshot, renderSnapshot, type ParsedSnapshot } from "./snapshot.js";
import { CURATED, knowledgePaths, loadManifest, loadRegistry, readJsonFile, stableJson, writeGenerated } from "./store.js";

export interface RefreshOptions {
  dryRun: boolean;
  limit?: number;
  commit: boolean;
  /** Extra seed paths to verify, e.g. known aliases (KNOWLEDGE_EXTRA_PATHS) */
  extraPaths?: string[];
}

export interface RefreshDeps {
  fetchText?: Fetcher;
  launch?: () => Promise<Renderer>;
  clock?: Clock;
  log?: (line: string) => void;
  /** Report sections computed from curated knowledge (K4: claims, facts, technologies). */
  extras?: (ctx: { merge: MergeResult; snapshots: Map<string, ParsedSnapshot> }) => ReportExtras;
}

export interface RefreshOutcome {
  crawl: CrawlResult;
  merge: MergeResult | null;
  report: string;
  reportFile: string | null;
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

/** sha256 over every curated file (path + bytes): proves a refresh left them untouched. */
export function curatedFingerprint(root: string): string {
  const hash = createHash("sha256");
  const visit = (path: string) => {
    if (!existsSync(path)) return;
    if (statSync(path).isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(join(path, name));
    } else {
      hash.update(relative(root, path).replace(/\\/g, "/")).update("\0").update(readFileSync(path)).update("\0");
    }
  };
  for (const entry of CURATED) visit(join(root, entry));
  return hash.digest("hex");
}

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

export async function refresh(config: KnowledgeConfig, opts: RefreshOptions, deps: RefreshDeps = {}): Promise<RefreshOutcome> {
  const origin = requireOrigin(config);
  const paths = knowledgePaths(config.dir);
  if (!existsSync(paths.root)) throw new Error(`Knowledge directory ${paths.root} does not exist.`);
  const log = deps.log ?? (() => undefined);
  const before = curatedFingerprint(paths.root);
  const previous = loadRegistry(config.dir, origin);
  const manifest = loadManifest(config.dir, origin);

  let renderer: Renderer | undefined;
  let result: CrawlResult;
  try {
    renderer = await (deps.launch ?? (() => launchRenderer({ origin, userAgent: config.userAgent })))();
  } catch (err) {
    const at = new Date((deps.clock ?? realClock).now()).toISOString();
    result = {
      startedAt: at,
      finishedAt: at,
      robotsSha256: null,
      sitemapSha256: null,
      aborted: err instanceof Error ? err.message : String(err),
      complete: false,
      sitemapUrls: [],
      outcomes: [],
      skipped: [],
      warnings: [],
    };
  }
  try {
    if (renderer) {
      log(`browser: ${renderer.browserName}`);
      result = await crawl(
        {
          origin,
          userAgent: config.userAgent,
          minDelayMs: config.minDelayMs,
          maxPages: config.maxPages,
          limit: opts.limit,
          textResources: config.textResources,
          extraUrls: [
            ...previous.urls.filter((r) => !r.removed_at && r.kind === "page").map((r) => r.url),
            ...(opts.extraPaths ?? []).map((p) => `${origin}${p}`),
          ],
        },
        { fetchText: deps.fetchText ?? makeFetcher(config.userAgent), renderer, clock: deps.clock ?? realClock, log },
      );
    }
  } finally {
    await renderer?.close();
  }
  result = result!;

  // ---- merge, snapshots, report (computed even for --dry-run) ----------------
  const merge = result.aborted ? null : mergeCrawl(previous, result, origin);
  const pendingWrites: { file: string; content: string }[] = [];
  const sectionDiffs = new Map<string, SectionDiff[]>();
  const snapshots = new Map<string, ParsedSnapshot>();

  for (const change of merge?.changes ?? []) {
    const { record, outcome } = change;
    if (!outcome.ok || record.alias_of || !record.evidence_file || !record.content_sha256) continue;
    const file = join(paths.pages, record.evidence_file);
    const old = existsSync(file) ? parseSnapshot(readFileSync(file, "utf8")) : undefined;
    const needsWrite = change.kind !== "unchanged" || !old || old.meta.content_sha256 !== record.content_sha256;
    const capturedAt = needsWrite ? result.finishedAt : String(old?.meta.captured_at ?? result.finishedAt);
    const meta = {
      url: record.url,
      lang: record.lang,
      kind: record.kind,
      http_status: record.http_status,
      canonical: record.canonical,
      content_sha256: record.content_sha256,
      captured_at: capturedAt,
    };
    const content =
      outcome.kind === "text"
        ? renderSnapshot(meta, { title: record.url, description: "", sections: [], hreflang: {}, links: [], ctas: [], jsonLd: [], anchors: [] }, outcome.text)
        : renderSnapshot(meta, outcome.extract);
    const parsed = parseSnapshot(content);
    snapshots.set(record.url, parsed);
    if (needsWrite) {
      pendingWrites.push({ file, content });
      if (old) sectionDiffs.set(record.url, diffSections(old, parsed));
    }
  }

  const failed = result.outcomes.filter((o) => !o.ok).length;
  const report = buildReport({
    crawl: result,
    merge,
    mode: { dryRun: opts.dryRun, limit: opts.limit },
    browser: renderer?.browserName ?? null,
    sectionDiffs,
    extras: merge && deps.extras ? deps.extras({ merge, snapshots }) : undefined,
  });

  if (opts.dryRun) return { crawl: result, merge, report, reportFile: null, written: [], commit: null };

  // ---- write generated files only ---------------------------------------------
  const stamp = result.finishedAt.replace(/[:.]/g, "-");
  const reportFile = join(paths.reports, `${stamp}-refresh.md`);
  const run: CrawlRun = {
    started_at: result.startedAt,
    finished_at: result.finishedAt,
    origin,
    user_agent: config.userAgent,
    complete: result.complete && !failed && !result.aborted,
    limit: opts.limit ?? null,
    robots_sha256: result.robotsSha256,
    sitemap_sha256: result.sitemapSha256,
    pages_ok: result.outcomes.filter((o) => o.ok).length,
    pages_failed: failed,
    pages_skipped: result.skipped.length,
    report: relative(paths.root, reportFile).replace(/\\/g, "/"),
  };
  const nextManifest = {
    version: 1 as const,
    origin,
    last_complete_crawl_at: run.complete ? result.finishedAt : manifest.last_complete_crawl_at,
    runs: [...manifest.runs, run].slice(-MAX_RUNS),
  };
  const writes = [...pendingWrites];
  if (merge) writes.push({ file: paths.urls, content: stableJson(merge.registry) });
  writes.push({ file: paths.manifest, content: stableJson(nextManifest) });
  writes.push({ file: reportFile, content: report });
  for (const w of writes) writeGenerated(paths.root, w.file, w.content);

  // Defensive: curated knowledge must be byte-identical.
  if (curatedFingerprint(paths.root) !== before) {
    throw new Error("Curated knowledge changed during refresh. This must never happen; inspect the knowledge repository.");
  }

  let commit: string | null = null;
  if (opts.commit) {
    // Validate what was written before committing it.
    if (merge) readJsonFile(paths.urls, urlRegistry);
    readJsonFile(paths.manifest, manifestSchema);
    git(paths.root, ["add", "--", "evidence", "reports"]);
    const staged = git(paths.root, ["diff", "--cached", "--name-only"]);
    if (staged) {
      git(paths.root, ["commit", "-q", "-m", `knowledge refresh ${result.finishedAt}${run.complete ? "" : " (partial)"}`, "--", "evidence", "reports"]);
      commit = git(paths.root, ["rev-parse", "--short", "HEAD"]);
    }
  }
  return { crawl: result, merge, report, reportFile, written: writes.map((w) => relative(paths.root, w.file)), commit };
}
