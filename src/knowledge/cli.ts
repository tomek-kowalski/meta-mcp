import { existsSync } from "node:fs";
import { logError, redactString } from "../sanitize.js";
import { readKnowledgeConfig } from "./config.js";
import { knowledgePaths, loadAnonymization, loadClaims, loadManifest, loadRegistry } from "./store.js";

/**
 * Knowledge CLI:  npm run knowledge -- <command> [options]
 *
 *   status                        configuration and repository health
 *   refresh [--dry-run] [--limit N] [--commit]
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

export async function main(argv: string[], out: Out = stdout): Promise<number> {
  const args = parseArgs(argv);
  switch (args.command) {
    case "status":
      return status(out);
    default:
      out.error(`Unknown command "${args.command ?? ""}". Use: status | refresh | validate`);
      return 2;
  }
}
