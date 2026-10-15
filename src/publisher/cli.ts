import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError } from "../config.js";
import { readKnowledgeConfig } from "../knowledge/config.js";
import { freshness } from "../knowledge/registry.js";
import { knowledgePaths, loadManifest, loadRegistry } from "../knowledge/store.js";
import { logError, redactString } from "../sanitize.js";
import { checkDraft, type CheckContext, type Finding, type PublishedArticle } from "./checks.js";
import { LANGUAGES, contentHash, listDrafts, loadDraft, publisherPaths, type Language, type PublisherPaths } from "./draft.js";

/**
 * Publisher CLI:  npm run publisher -- <command>
 *
 *   list          drafts in the editorial store, with their last check
 *   check <id>    run the checks on a draft; writes <id>/check.json (exit 1 on errors)
 *
 * Nothing here publishes anything.
 */

type Out = { log: (line: string) => void; error: (line: string) => void };
const stdout: Out = { log: (line) => process.stdout.write(`${redactString(line)}\n`), error: (line) => logError(line) };

export function parseNewsPaths(raw: string | undefined): Record<Language, string> {
  const paths: Record<Language, string> = { pl: "/news", en: "/en/news", de: "/de/news" };
  if (!raw?.trim()) return paths;
  for (const entry of raw.split(",")) {
    const m = /^\s*(pl|en|de)\s*=\s*(\/[a-z0-9/_-]*)\s*$/.exec(entry);
    if (!m) throw new ConfigError(`PUBLISHER_NEWS_PATHS entry "${entry}" must look like en=/en/news`);
    paths[m[1] as Language] = m[2].replace(/\/+$/, "");
  }
  return paths;
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** Terms from editorial/anonymization.json: clients (names and aliases), domains, identifiers, excluded topics. */
export function denylistFrom(anonymization: unknown): string[] {
  const a = (anonymization ?? {}) as Record<string, unknown>;
  const terms: string[] = [];
  const add = (v: unknown) => {
    if (typeof v === "string" && v.trim()) terms.push(v.trim());
  };
  for (const c of (a.clients as unknown[]) ?? []) {
    if (typeof c === "string") add(c);
    else if (c && typeof c === "object") {
      add((c as { name?: unknown }).name);
      for (const alias of ((c as { aliases?: unknown[] }).aliases ?? [])) add(alias);
    }
  }
  for (const d of (a.domains as unknown[]) ?? []) add(d);
  for (const i of (a.identifiers as unknown[]) ?? []) add(i);
  for (const e of (a.exclude as unknown[]) ?? []) add(typeof e === "object" && e ? (e as { term?: unknown }).term : e);
  return terms;
}

export function loadContext(paths: PublisherPaths, currentId: string, env: NodeJS.ProcessEnv = process.env): CheckContext {
  const articlesJson = join(paths.portfolioDir, "src", "components", "News", "articles.json");
  const categoriesJs = join(paths.portfolioDir, "src", "components", "News", "categories.js");
  if (!existsSync(articlesJson) || !existsSync(categoriesJs)) {
    throw new ConfigError(`Website repository not found at ${paths.portfolioDir} (set PORTFOLIO_DIR)`);
  }
  const published = readJson(articlesJson) as PublishedArticle[];
  const categories = [...readFileSync(categoriesJs, "utf8").matchAll(/slug:\s*"([^"]+)"/g)].map((m) => m[1]);

  const knowledge = readKnowledgeConfig(env);
  const registryFile = knowledgePaths(knowledge.dir).urls;
  const registry = existsSync(registryFile) ? loadRegistry(knowledge.dir) : null;
  const age = registry ? freshness(loadManifest(knowledge.dir).last_complete_crawl_at, new Date(), knowledge.staleDays).ageDays : null;

  const anonymizationFile = join(paths.editorialDir, "anonymization.json");
  const otherDrafts = listDrafts(paths)
    .filter((id) => id !== currentId)
    .flatMap((id) => {
      try {
        return [loadDraft(paths, id).meta];
      } catch {
        return [];
      }
    });

  return {
    origin: knowledge.origin ?? null,
    newsPaths: parseNewsPaths(env.PUBLISHER_NEWS_PATHS),
    published,
    categories,
    otherDrafts,
    registry,
    registryAgeDays: age,
    staleDays: knowledge.staleDays,
    denylist: existsSync(anonymizationFile) ? denylistFrom(readJson(anonymizationFile)) : [],
  };
}

export interface CheckResult {
  id: string;
  checked_at: string;
  content_sha256: string;
  errors: number;
  warnings: number;
  findings: Finding[];
}

export function runCheck(paths: PublisherPaths, id: string, env: NodeJS.ProcessEnv = process.env, now = new Date()): CheckResult {
  const draft = loadDraft(paths, id);
  const findings = checkDraft(draft, loadContext(paths, id, env));
  const result: CheckResult = {
    id,
    checked_at: now.toISOString(),
    content_sha256: contentHash(draft),
    errors: findings.filter((f) => f.level === "error").length,
    warnings: findings.filter((f) => f.level === "warning").length,
    findings,
  };
  writeFileSync(join(draft.dir, "check.json"), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

export async function main(argv: string[], out: Out = stdout, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const [command, id] = argv;
  const paths = publisherPaths(env);
  if (command === "list") {
    const ids = listDrafts(paths);
    if (!ids.length) out.log(`no drafts in ${paths.draftsDir}`);
    for (const draftId of ids) {
      const checkFile = join(paths.draftsDir, draftId, "check.json");
      let state = "not checked";
      if (existsSync(checkFile)) {
        const check = readJson(checkFile) as CheckResult;
        const current = (() => {
          try {
            return contentHash(loadDraft(paths, draftId)) === check.content_sha256;
          } catch {
            return false;
          }
        })();
        state = `${check.errors} error(s), ${check.warnings} warning(s)${current ? "" : " (changed since the last check)"}`;
      }
      out.log(`${draftId}  ${state}`);
    }
    return 0;
  }
  if (command === "check") {
    if (!id) throw new Error("usage: check <id>");
    const result = runCheck(paths, id, env);
    for (const level of ["error", "warning"] as const) {
      for (const f of result.findings.filter((x) => x.level === level)) {
        out.log(`${level === "error" ? "ERROR  " : "warning"} [${f.code}]${f.where ? ` ${f.where}:` : ""} ${f.message}`);
      }
    }
    out.log(`check ${id}: ${result.errors} error(s), ${result.warnings} warning(s); content ${result.content_sha256.slice(0, 12)}`);
    out.log(result.errors ? "Not ready: fix the errors before preview." : "No blocking errors. Review the warnings with the owner.");
    return result.errors ? 1 : 0;
  }
  out.error(`Unknown command "${command ?? ""}". Use: list | check <id>`);
  return 2;
}

