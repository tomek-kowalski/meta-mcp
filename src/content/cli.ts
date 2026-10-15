import { createInterface } from "node:readline/promises";
import { z } from "zod";
import { readConfig } from "../config.js";
import { readKnowledgeConfig } from "../knowledge/config.js";
import { MetaClient } from "../meta-client.js";
import { parseNewsPaths } from "../publisher/cli.js";
import { publisherPaths, type PublisherPaths } from "../publisher/draft.js";
import { logError, redactString } from "../sanitize.js";
import { publishFacebook, type FacebookDeps } from "./facebook.js";
import { channels, language } from "./intake.js";
import * as service from "./service.js";
import { publishWebsite, realRunner, type SiteDeps } from "./site-publisher.js";

/**
 * npm run content -- <command> <file>      (the file name from the inbox, with or without .txt)
 *
 *   list
 *   ingest <file> [--lang pl|en|de] [--facebook-lang pl|en|de] [--channels website,facebook]
 *   status <file>
 *   check <file>
 *   submit <file>                              ready for approval: shows exactly what would be published
 *   approve <file>                             the owner only: interactive, type the code shown
 *   reject <file> --reason "…"
 *   publish <file> --channel website|facebook [--dry-run]
 *
 * npm run content:ingest -- --file <file> …  is the same as ingest.
 */

type Out = { log: (line: string) => void; error: (line: string) => void };
const stdout: Out = { log: (line) => process.stdout.write(`${redactString(line)}\n`), error: (line) => logError(line) };

const BOOLEAN = new Set(["dry-run"]);
export function parseArgs(argv: string[]) {
  const [command, ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const [key, inline] = arg.slice(2).split(/=(.*)/s, 2);
    const value = inline ?? (BOOLEAN.has(key) ? "true" : rest[++i]);
    if (value === undefined) throw new Error(`--${key} needs a value`);
    flags[key] = value;
  }
  return { command, file: flags.file ?? positional[0], flags };
}

export const cliOptions = z
  .object({
    lang: language.optional(),
    "facebook-lang": language.optional(),
    channels: z
      .string()
      .transform((v) => v.split(/[\s,;]+/).filter(Boolean))
      .pipe(channels)
      .optional(),
    channel: z.enum(["website", "facebook"]).optional(),
    reason: z.string().optional(),
    "dry-run": z.literal("true").optional(),
    file: z.string().optional(),
  })
  .strict();

export interface CliDeps {
  paths: PublisherPaths;
  content: service.ContentDeps;
  site: () => SiteDeps;
  facebook: () => FacebookDeps;
  /** The owner's terminal; undefined when there is none (then approve refuses) */
  ask?: (question: string) => Promise<string>;
}

export function defaultDeps(env: NodeJS.ProcessEnv = process.env): CliDeps {
  const config = readConfig(env);
  const content: service.ContentDeps = { now: () => new Date(), pageId: config.pageId ?? null };
  const fetchText = async (url: string) => {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
    return { status: res.status, text: await res.text() };
  };
  return {
    paths: publisherPaths(env),
    content,
    site: () => {
      const origin = readKnowledgeConfig(env).origin;
      if (!origin) throw new Error("KNOWLEDGE_SITE_ORIGIN is not set: no website to publish to.");
      return { run: realRunner, fetchText, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), origin, newsPaths: parseNewsPaths(env.PUBLISHER_NEWS_PATHS) };
    },
    facebook: () => ({
      fetchText,
      client: () => {
        if (!config.accessToken) throw new Error("META_ACCESS_TOKEN is not set.");
        return new MetaClient({ token: config.accessToken, apiVersion: config.apiVersion });
      },
    }),
    ask: process.stdin.isTTY
      ? async (question) => {
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          try {
            return await rl.question(question);
          } finally {
            rl.close();
          }
        }
      : undefined,
  };
}

function printSummary(out: Out, s: service.ApprovalSummary) {
  out.log(`\n=== ${s.name}: what would be published ===`);
  out.log(`Channels: ${s.channels.join(", ")}`);
  for (const [lang, a] of Object.entries(s.article)) {
    out.log(`\nArticle (${lang}): ${a.title}\n  ${a.url}\n  ${a.excerpt}`);
  }
  if (s.facebook) {
    out.log(`\nFacebook post (${s.facebook.lang}) on Page ${s.facebook.page_id ?? "(META_PAGE_ID not set)"}, linking ${s.facebook.link}:`);
    out.log(s.facebook.text.split("\n").map((l) => `  | ${l}`).join("\n"));
  }
  if (s.warnings.length) {
    out.log(`\nWarnings (${s.warnings.length}):`);
    for (const w of s.warnings) out.log(`  - [${w.code}]${w.where ? ` ${w.where}:` : ""} ${w.message}`);
  }
  out.log(`\nContent ${s.content_sha256.slice(0, 12)}`);
}

export async function main(argv: string[], out: Out = stdout, deps: CliDeps = defaultDeps()): Promise<number> {
  const { command, file, flags } = parseArgs(argv);
  const parsedOptions = cliOptions.safeParse(flags);
  if (!parsedOptions.success) {
    throw new Error(parsedOptions.error.issues.map((i) => (i.path.length ? `--${i.path.join(".")}: ${i.message}` : i.message)).join("; "));
  }
  const options = parsedOptions.data;
  const need = () => {
    if (!file) throw new Error(`usage: npm run content -- ${command} <file.txt>`);
    return file;
  };
  const { paths, content } = deps;
  switch (command) {
    case "list": {
      const { inbox, drafts } = service.list(paths);
      out.log(`Inbox (${paths.inboxDir}):${inbox.length ? "" : " empty"}`);
      for (const f of inbox) out.log(`  ${f.fileName}  (${f.bytes} bytes)`);
      out.log(`Drafts:${drafts.length ? "" : " none"}`);
      for (const d of drafts) out.log(`  ${d.file.padEnd(40)} ${d.status.padEnd(20)} article ${d.lang} → pl/en/de, Facebook ${d.facebook_lang}`);
      return 0;
    }
    case "ingest": {
      const result = service.ingest(paths, need(), { lang: options.lang, facebookLang: options["facebook-lang"], channels: options.channels }, content);
      const s = result.state;
      out.log(`Ingested ${result.file} → drafts/${result.name} (VALIDATED)`);
      out.log(`Language of the source: ${s.lang}; website: pl, en, de; Facebook post: ${s.facebook_lang}; channels: ${s.channels.join(", ")}`);
      out.log(`Sections found: ${Object.keys(result.parsed.sections).join(", ") || "none (plain text)"}${result.parsed.title ? `; title: ${result.parsed.title}` : ""}`);
      if (result.parsed.ignoredHeaders.length) out.log(`Ignored headers: ${result.parsed.ignoredHeaders.join(", ")}`);
      if (result.sourceSecrets.length) out.log(`WARNING: the source contains ${result.sourceSecrets.join(", ")}; it must not appear in the article or post.`);
      out.log(`Next: ask Claude to write the drafts for ${result.file} (/publish-article ${result.file}), then npm run content -- check ${result.file}`);
      return 0;
    }
    case "status": {
      const st = service.status(paths, need(), content);
      out.log(`${st.name} (${st.state.source.file}): ${st.state.status}`);
      out.log(`  website: pl, en, de; Facebook: ${st.state.facebook_lang}; channels: ${st.state.channels.join(", ")}`);
      out.log(`  files: ${st.files.join(", ") || "none yet"}`);
      if (st.check) out.log(`  last check: ${st.check.errors} error(s), ${st.check.warnings} warning(s)${st.check.current ? "" : " (content changed since)"}`);
      out.log(`  approval: ${st.state.approval ? (st.approval_valid ? "valid" : "VOID (content changed)") : "none"}`);
      if (st.state.website) out.log(`  website: ${Object.values(st.state.website.urls).join(", ")}`);
      if (st.state.facebook) out.log(`  facebook: ${st.state.facebook.status}${st.state.facebook.post_id ? ` (post ${st.state.facebook.post_id})` : ""}`);
      if (st.state.last_error) out.log(`  last error: ${st.state.last_error}`);
      return 0;
    }
    case "check": {
      const result = service.check(paths, need(), content);
      for (const f of result.findings) out.log(`${f.level === "error" ? "ERROR  " : "warning"} [${f.code}]${f.where ? ` ${f.where}:` : ""} ${f.message}`);
      out.log(`check ${result.name}: ${result.errors} error(s), ${result.warnings} warning(s)`);
      return result.errors ? 1 : 0;
    }
    case "submit": {
      printSummary(out, service.submit(paths, need(), content));
      out.log(`\nSubmitted for approval. To approve exactly this, run in your own terminal: npm run content -- approve ${file}`);
      return 0;
    }
    case "approve": {
      if (!deps.ask) {
        out.error("approve needs your own interactive terminal (not an automated shell). Run it yourself: ! npm run content -- approve <file>");
        return 1;
      }
      const s = service.submit(paths, need(), content); // fresh check and summary of the exact content
      printSummary(out, s);
      const code = service.pendingApprovalCode(paths, file!, content);
      const typed = await deps.ask(`\nApprove publishing exactly this? Type ${code} to approve, anything else to cancel: `);
      if (typed.trim().toUpperCase() !== code) {
        out.log("Not approved.");
        return 1;
      }
      service.approve(paths, file!, typed, content);
      out.log(`Approved. Publish with: npm run content -- publish ${file} --channel website${s.facebook ? `, then --channel facebook` : ""}`);
      return 0;
    }
    case "reject": {
      const r = service.reject(paths, need(), options.reason ?? "", content);
      out.log(`${r.name}: REJECTED (moved to rejected/${r.name})`);
      return 0;
    }
    case "publish": {
      const dryRun = options["dry-run"] === "true";
      const name = service.nameOf(need());
      if (options.channel === "website") {
        const r = await publishWebsite(paths, name, { dryRun }, { ...content, ...deps.site() });
        out.log(`${dryRun ? "Dry run: nothing pushed. " : ""}Website (${r.status}): ${r.changed ? `commit ${r.commit ?? "(none)"}` : "already up to date on main"}`);
        for (const [lang, url] of Object.entries(r.urls)) out.log(`  ${lang}: ${url}`);
        return 0;
      }
      if (options.channel === "facebook") {
        const r = await publishFacebook(paths, name, { dryRun }, { ...content, ...deps.facebook() });
        out.log(`${r.dryRun ? "Dry run: nothing posted." : `Facebook (${r.status}): post ${r.post_id}`}${r.note && !r.dryRun ? ` (${r.note})` : ""}`);
        out.log(`  Page ${r.page_id}, ${r.lang}, linking ${r.link}`);
        out.log(r.message.split("\n").map((l) => `  | ${l}`).join("\n"));
        return 0;
      }
      throw new Error("publish needs --channel website or --channel facebook");
    }
    default:
      out.error(`Unknown command "${command ?? ""}". Use: list | ingest | status | check | submit | approve | reject | publish`);
      return 2;
  }
}
