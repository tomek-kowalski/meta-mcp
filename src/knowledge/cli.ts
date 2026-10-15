import { existsSync } from "node:fs";
import { logError, redactString } from "../sanitize.js";
import { readKnowledgeConfig } from "./config.js";
import { freshness } from "./registry.js";
import { refresh } from "./refresh.js";
import { loadManifest, loadRegistry } from "./store.js";

/**
 * Website link registry CLI:  npm run knowledge -- <command> [options]
 *
 *   status                                       configuration and registry state
 *   refresh [--dry-run] [--limit N] [--commit]   crawl the website, update evidence/urls.json
 */

export type Out = { log: (line: string) => void; error: (line: string) => void };
const stdout: Out = {
  log: (line) => process.stdout.write(`${redactString(line)}\n`),
  error: (line) => logError(line),
};

export interface ParsedArgs {
  command: string | undefined;
  positional: string[];
  flags: Map<string, string[]>;
}

const BOOLEAN_FLAGS = new Set(["dry-run", "commit"]);

export function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split(/=(.*)/s, 2);
    let value = inline;
    if (value === undefined) value = BOOLEAN_FLAGS.has(name) ? "true" : rest[++i];
    if (value === undefined) throw new Error(`--${name} needs a value`);
    flags.set(name, [...(flags.get(name) ?? []), value]);
  }
  return { command, positional, flags };
}

const flag = (args: ParsedArgs, name: string) => args.flags.get(name)?.at(-1);

export async function status(out: Out = stdout): Promise<number> {
  const config = readKnowledgeConfig();
  out.log(`knowledge dir:  ${config.dir}${existsSync(config.dir) ? "" : "  (MISSING)"}`);
  out.log(`site origin:    ${config.origin ?? "(KNOWLEDGE_SITE_ORIGIN not set)"}`);
  try {
    const live = loadRegistry(config.dir).urls.filter((r) => !r.removed_at && !r.alias_of);
    const counts = new Map<string, number>();
    for (const r of live) counts.set(r.lang, (counts.get(r.lang) ?? 0) + 1);
    out.log(`published URLs: ${live.length} (${[...counts].map(([lang, n]) => `${lang} ${n}`).join(", ") || "none"})`);
    const f = freshness(loadManifest(config.dir).last_complete_crawl_at, new Date(), config.staleDays);
    out.log(`last complete crawl: ${f.lastCompleteCrawl ?? "never"}${f.ageDays !== null ? ` (${f.ageDays} days)` : ""}${f.stale ? "  → refresh recommended" : ""}`);
    return 0;
  } catch (err) {
    out.log(`ERROR ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

export async function runRefresh(args: ParsedArgs, out: Out = stdout): Promise<number> {
  const config = readKnowledgeConfig();
  const limitRaw = flag(args, "limit");
  const limit = limitRaw === undefined ? undefined : Number(limitRaw);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new Error("--limit must be a positive integer");
  const dryRun = flag(args, "dry-run") === "true";
  const commit = flag(args, "commit") === "true";
  if (dryRun && commit) throw new Error("--dry-run and --commit can't be combined");
  const result = await refresh(config, { dryRun, limit, commit }, { log: (line) => out.error(line) });
  out.log(result.summary);
  if (dryRun) out.log("dry run: nothing was written");
  else if (result.written.length) out.log(`written: ${result.written.join(", ")}`);
  if (commit) out.log(result.commit ? `committed ${result.commit} in the knowledge repository (local only)` : "nothing to commit");
  return result.crawl.aborted ? 1 : 0;
}

export async function main(argv: string[], out: Out = stdout): Promise<number> {
  const args = parseArgs(argv);
  switch (args.command) {
    case "status":
      return status(out);
    case "refresh":
      return runRefresh(args, out);
    default:
      out.error(`Unknown command "${args.command ?? ""}". Use: status | refresh`);
      return 2;
  }
}
