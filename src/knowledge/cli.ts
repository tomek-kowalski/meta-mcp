import { existsSync } from "node:fs";
import { logError, redactString } from "../sanitize.js";
import { readKnowledgeConfig } from "./config.js";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeText } from "./extract.js";
import { claimEvidence, factCitations, findRecord, freshness, loadKnowledge } from "./knowledge.js";
import { refresh } from "./refresh.js";
import { parseSnapshot } from "./snapshot.js";
import { knowledgePaths, loadAnonymization, loadClaims, loadManifest, loadRegistry } from "./store.js";

/**
 * Knowledge CLI:  npm run knowledge -- <command> [options]
 *
 *   status                        configuration and repository health
 *   refresh [--dry-run] [--limit N] [--commit]
 *   cite <url>#<section> [--excerpt "<verbatim text>"]   evidence reference for claims.json
 *   check                         validate curated knowledge (claims, evidence states, fact citations)
 *   validate <file> --lang <pl|en|de> [--channel facebook|website|editorial] [--link <url>]... [--live] [--final]
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

const BOOLEAN_FLAGS = new Set(["dry-run", "commit", "live", "final", "json"]);

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

export async function status(out: Out = stdout): Promise<number> {
  const config = readKnowledgeConfig();
  const paths = knowledgePaths(config.dir);
  out.log(`knowledge dir:   ${config.dir}${existsSync(config.dir) ? "" : "  (MISSING)"}`);
  out.log(`site origin:     ${config.origin ?? "(KNOWLEDGE_SITE_ORIGIN not set)"}`);
  out.log(`editorial dir:   ${config.editorialDir} (read-only)`);
  let problems = 0;
  const check = (label: string, fn: () => string) => {
    try {
      out.log(`${label.padEnd(16)} ${fn()}`);
    } catch (err) {
      problems += 1;
      out.log(`${label.padEnd(16)} ERROR ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  check("claims.json:", () => `${loadClaims(config.dir).claims.length} claims`);
  check("urls.json:", () => `${loadRegistry(config.dir).urls.length} URLs`);
  check("manifest.json:", () => {
    const m = loadManifest(config.dir);
    return `last complete crawl: ${m.last_complete_crawl_at ?? "never"}`;
  });
  check("anonymization:", () => {
    const { rules, found } = loadAnonymization(config.editorialDir);
    return found ? `${rules.clients.length} clients, ${rules.domains.length} domains, ${rules.identifiers.length} identifiers` : "not found";
  });
  if (!existsSync(paths.facts)) {
    problems += 1;
    out.log("facts/:          MISSING");
  }
  return problems ? 1 : 0;
}

const flag = (args: ParsedArgs, name: string) => args.flags.get(name)?.at(-1);

export async function runRefresh(args: ParsedArgs, out: Out = stdout): Promise<number> {
  const config = readKnowledgeConfig();
  const limitRaw = flag(args, "limit");
  const limit = limitRaw === undefined ? undefined : Number(limitRaw);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new Error("--limit must be a positive integer");
  const dryRun = flag(args, "dry-run") === "true";
  const commit = flag(args, "commit") === "true";
  if (dryRun && commit) throw new Error("--dry-run and --commit can't be combined");
  const result = await refresh(
    config,
    { dryRun, limit, commit, extraPaths: config.extraPaths },
    { log: (line) => out.error(line) },
  );
  if (dryRun) out.log(result.report);
  const ok = result.crawl.outcomes.filter((o) => o.ok).length;
  const failed = result.crawl.outcomes.length - ok;
  out.log(`refresh: ${ok} ok, ${failed} failed, ${result.crawl.skipped.length} skipped${result.crawl.aborted ? `, ABORTED: ${result.crawl.aborted}` : ""}`);
  if (result.reportFile) out.log(`report: ${result.reportFile}`);
  if (result.written.length) out.log(`written: ${result.written.length} generated file(s)`);
  if (dryRun) out.log("dry run: nothing was written");
  if (commit) out.log(result.commit ? `committed ${result.commit} in the knowledge repository (local only)` : "nothing to commit");
  return result.crawl.aborted ? 1 : 0;
}

/** Prints an evidence reference (with the section's current hash) for curating claims.json. */
export async function cite(args: ParsedArgs, out: Out = stdout): Promise<number> {
  const target = args.positional[0];
  if (!target || !target.includes("#")) throw new Error("usage: cite <url>#<section> [--excerpt \"text\"]");
  const [url, section] = [target.slice(0, target.lastIndexOf("#")), target.slice(target.lastIndexOf("#") + 1)];
  const kb = loadKnowledge(readKnowledgeConfig());
  const record = findRecord(kb.registry, url);
  if (!record || record.removed_at || record.alias_of) throw new Error(`${url} is not a published page in evidence/urls.json`);
  const sha256 = record.sections[section];
  if (!sha256) throw new Error(`${record.url} has no section "${section}". Sections: ${Object.keys(record.sections).join(", ")}`);
  const ref: Record<string, string> = { url: record.url, section, sha256 };
  const excerpt = flag(args, "excerpt");
  if (excerpt) {
    const snapshot = parseSnapshot(readFileSync(join(knowledgePaths(kb.config.dir).pages, record.evidence_file!), "utf8"));
    const text = normalizeText(snapshot.sections.find((s) => s.key === section)?.lines.join(" ") ?? "");
    if (!text.includes(normalizeText(excerpt))) throw new Error(`The excerpt is not verbatim in ${record.url}#${section}`);
    ref.excerpt = normalizeText(excerpt);
  }
  out.log(JSON.stringify(ref, null, 2));
  return 0;
}

/** Validates the curated layer against the current evidence. */
export async function check(out: Out = stdout): Promise<number> {
  const kb = loadKnowledge(readKnowledgeConfig());
  const paths = knowledgePaths(kb.config.dir);
  const ids = new Set(kb.claims.map((c) => c.id));
  let errors = 0;
  let warnings = 0;
  const fresh = freshness(kb.manifest, new Date(), kb.config.staleDays);
  out.log(`evidence: last complete crawl ${fresh.lastCompleteCrawl ?? "never"}${fresh.ageDays !== null ? ` (${fresh.ageDays} days)` : ""}${fresh.stale ? "  WARNING: stale, run refresh" : ""}`);
  if (fresh.stale) warnings += 1;
  for (const claim of kb.claims) {
    const ev = claimEvidence(claim, kb.registry);
    for (const r of ev.invalid) {
      errors += 1;
      out.log(`ERROR claim ${claim.id}: evidence ${r.ref.url}#${r.ref.section} is ${r.state}`);
    }
    for (const r of ev.refs.filter((x) => x.state === "unverifiable")) {
      warnings += 1;
      out.log(`warning claim ${claim.id}: ${r.ref.url} could not be re-checked on the last crawl (evidence kept)`);
    }
  }
  for (const term of kb.terms) {
    if (term.claim && !ids.has(term.claim)) {
      errors += 1;
      out.log(`ERROR technologies.md: term "${term.term}" cites unknown claim ${term.claim}`);
    }
  }
  for (const name of readdirSync(paths.facts).filter((f) => f.endsWith(".md"))) {
    const cites = factCitations(readFileSync(join(paths.facts, name), "utf8"));
    for (const id of cites.claims) {
      if (!ids.has(id)) {
        errors += 1;
        out.log(`ERROR facts/${name}: cites unknown claim ${id}`);
      }
    }
    for (const ev of cites.evidence) {
      const record = findRecord(kb.registry, ev.url);
      if (!record || record.removed_at || record.alias_of || !record.sections[ev.section]) {
        errors += 1;
        out.log(`ERROR facts/${name}: evidence ${ev.url}#${ev.section} is not a current section`);
      }
    }
  }
  if (!kb.anonymization.found) {
    warnings += 1;
    out.log("warning: editorial anonymization.json not found: client-name checks are off");
  }
  out.log(`check: ${kb.claims.length} claims, ${kb.terms.length} terms, ${errors} error(s), ${warnings} warning(s)`);
  return errors ? 1 : 0;
}

export async function main(argv: string[], out: Out = stdout): Promise<number> {
  const args = parseArgs(argv);
  switch (args.command) {
    case "status":
      return status(out);
    case "refresh":
      return runRefresh(args, out);
    case "cite":
      return cite(args, out);
    case "check":
      return check(out);
    default:
      out.error(`Unknown command "${args.command ?? ""}". Use: status | refresh | cite | check | validate`);
      return 2;
  }
}
