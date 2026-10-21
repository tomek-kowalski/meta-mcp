import { createHash } from "node:crypto";
import { constants as fsConstants, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { ConfigError } from "../config.js";
import { checkDraft, ownUrl, secretsIn, type CheckContext, type Finding } from "../publisher/checks.js";
import { loadContext } from "../publisher/cli.js";
import { LANGUAGES, contentHash, draftMeta, loadDraft, type Draft, type Language, type PublisherPaths } from "../publisher/draft.js";
import { CHANNELS, channels as channelsSchema, draftName, language, listInbox, parseSource, readSourceFile, resolveInboxFile, type Channel, type ParsedSource } from "./intake.js";
import { approvalCode, approvalHash, approvalValid, logEvent, move, readState, writeState, type DraftState } from "./lifecycle.js";
import { IMAGE_FILE, postMessage } from "./post.js";

/**
 * The content workflow, shared by the CLI (npm run content) and the MCP
 * tools. Drafts are addressed by name: the source file's name without .txt.
 * Nothing here publishes; publishing is in site-publisher.ts / facebook.ts
 * and needs an approval only the owner can give (approve(), CLI only).
 */

export interface ContentDeps {
  now: () => Date;
  /** The Facebook Page posts go to (META_PAGE_ID) */
  pageId: string | null;
  /** Loads the check context; tests replace it */
  context?: (paths: PublisherPaths, name: string) => CheckContext;
  /** File operations of ingest; tests replace some to simulate failures */
  fs?: Partial<IngestFs>;
}

export const ingestOptions = z
  .object({
    lang: language.optional(),
    facebookLang: language.optional(),
    channels: channelsSchema.optional(),
  })
  .strict();
export type IngestOptions = z.input<typeof ingestOptions>;

/** The draft files Claude (or the owner) may write. */
export const DRAFT_FILES = ["meta.json", "case.md", ...LANGUAGES.map((l) => `article.${l}.md`), ...LANGUAGES.map((l) => `facebook.${l}.txt`), IMAGE_FILE];

const draftDir = (paths: PublisherPaths, name: string) => join(paths.draftsDir, name);

/** Accepts "file.txt", "file" or a draft name; returns the draft name. */
export function nameOf(input: string): string {
  return draftName(basename(input.trim()));
}

// ---- list -------------------------------------------------------------------

export function list(paths: PublisherPaths) {
  const drafts = existsSync(paths.draftsDir)
    ? readdirSync(paths.draftsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && existsSync(join(paths.draftsDir, d.name, "state.json")))
        .map((d) => {
          const state = readState(join(paths.draftsDir, d.name));
          return { name: d.name, file: state.source.file, status: state.status, lang: state.lang, facebook_lang: state.facebook_lang };
        })
    : [];
  return { inbox: listInbox(paths.inboxDir), drafts };
}

// ---- ingest -----------------------------------------------------------------

export interface IngestResult {
  name: string;
  file: string;
  state: DraftState;
  parsed: ParsedSource;
  /** secret-like values found in the source: they must not reach the draft */
  sourceSecrets: string[];
}

export function ingest(paths: PublisherPaths, input: string, options: IngestOptions, deps: ContentDeps): IngestResult {
  const opts = ingestOptions.parse(options);
  const file = resolveInboxFile(paths.inboxDir, input);
  const source = readSourceFile(file);
  const parsed = parseSource(source.text);
  const fileName = basename(file);
  const name = draftName(fileName);

  const existing = draftDir(paths, name);
  if (existsSync(existing)) {
    const status = existsSync(join(existing, "state.json")) ? readState(existing).status : "unknown";
    throw new ConfigError(`"${fileName}" was already ingested: drafts/${name} (${status}). Rename the file to ingest it as a new draft.`);
  }
  if (existsSync(join(paths.rejectedDir, name))) {
    throw new ConfigError(`A draft "${name}" was rejected before (rejected/${name}). Rename the file to start a new one.`);
  }
  for (const other of list(paths).drafts) {
    if (readState(draftDir(paths, other.name)).source.sha256 === source.sha256) {
      throw new ConfigError(`The same content was already ingested as drafts/${other.name} (${other.status}).`);
    }
  }

  const now = deps.now();
  const lang: Language = opts.lang ?? parsed.language ?? "pl";
  const facebookLang: Language = opts.facebookLang ?? "pl";
  const channelList: Channel[] = opts.channels ?? parsed.channels ?? [...CHANNELS];
  const state: DraftState = {
    version: 1,
    name,
    status: "VALIDATED",
    source: { file: fileName, sha256: source.sha256, bytes: source.bytes, ingested_at: now.toISOString() },
    lang,
    facebook_lang: facebookLang,
    channels: channelList,
    approval: null,
    website: null,
    facebook: null,
    last_error: null,
    history: [{ at: now.toISOString(), status: "VALIDATED", note: `ingested ${fileName}` }],
  };
  moveIntoDraft(paths, { file, fileName, name, dir: existing, sha256: source.sha256 }, state, { ...REAL_FS, ...deps.fs }, deps);
  logEvent(paths.logsDir, { event: "ingested", name, file: fileName, sha256: source.sha256, bytes: source.bytes, lang, facebook_lang: facebookLang, channels: channelList }, now);
  return { name, file: fileName, state, parsed, sourceSecrets: secretsIn(source.text) };
}

/** The file operations ingest uses; tests replace them to simulate failures. */
export interface IngestFs {
  /** creates one directory; fails if it exists */
  mkdir: (dir: string) => void;
  /** removes a directory only if it's empty */
  rmdir: (dir: string) => void;
  rename: (from: string, to: string) => void;
  /** copies; fails if the target exists (never overwrites) */
  copyExclusive: (from: string, to: string) => void;
  unlink: (file: string) => void;
  readFile: (file: string) => Buffer;
  readdir: (dir: string) => string[];
  writeState: (dir: string, state: DraftState) => void;
}

const REAL_FS: IngestFs = {
  mkdir: (dir) => mkdirSync(dir),
  rmdir: (dir) => rmdirSync(dir),
  rename: (from, to) => renameSync(from, to),
  copyExclusive: (from, to) => copyFileSync(from, to, fsConstants.COPYFILE_EXCL),
  unlink: (file) => unlinkSync(file),
  readFile: (file) => readFileSync(file),
  readdir: (dir) => readdirSync(dir),
  writeState,
};

const sha256Of = (buffer: Buffer) => createHash("sha256").update(buffer).digest("hex");
const reason = (err: unknown) => (err instanceof Error ? err.message : String(err));

interface Ingesting {
  /** where the source is now (the inbox) */
  file: string;
  fileName: string;
  name: string;
  /** drafts/<name>, not yet existing */
  dir: string;
  /** hash of the bytes that were read and parsed */
  sha256: string;
}

/**
 * Moves the source into its new draft folder and writes state.json, all or nothing:
 *
 * - the folder is created by this attempt (it must not exist), so only it is ever removed;
 * - a failed move leaves the source in the inbox (rename is all or nothing) and removes the
 *   folder if it's still empty;
 * - after the move, the file is hashed again: it must be exactly the content that was parsed;
 * - if that check or state.json fails, the source goes back to the inbox with an exclusive copy
 *   (never over an existing file), verified byte for byte before the moved file is removed;
 * - when restoring isn't possible, the draft folder is kept and the error names the exact
 *   path of the source. The only copy of the source is never deleted.
 */
function moveIntoDraft(paths: PublisherPaths, src: Ingesting, state: DraftState, fs: IngestFs, deps: ContentDeps): void {
  mkdirSync(paths.draftsDir, { recursive: true });
  try {
    fs.mkdir(src.dir);
  } catch (err) {
    throw new ConfigError(`Couldn't create drafts/${src.name} (${reason(err)}). Nothing was moved: "${src.fileName}" is still in the inbox.`);
  }

  const moved = join(src.dir, "source.txt");
  try {
    fs.rename(src.file, moved);
  } catch (err) {
    const leftover = removeIfEmpty(src.dir, fs) ? "" : ` Remove the empty folder ${src.dir} before trying again.`;
    failed(paths, src, `the move failed: ${reason(err)}`, src.file, deps);
    throw new ConfigError(`Couldn't move "${src.fileName}" into drafts/${src.name} (${reason(err)}). It is still in the inbox: ${src.file}.${leftover}`);
  }

  let failure: string | null = null;
  try {
    if (sha256Of(fs.readFile(moved)) !== src.sha256) failure = "the file changed while it was being ingested";
  } catch (err) {
    failure = `the moved file couldn't be read back (${reason(err)})`;
  }
  if (failure === null) {
    try {
      fs.writeState(src.dir, state);
      return;
    } catch (err) {
      failure = `state.json couldn't be written (${reason(err)})`;
    }
  }
  throw restore(paths, src, moved, failure, fs, deps);
}

/** Puts the source back in the inbox after a failure past the move. Returns the error to throw. */
function restore(paths: PublisherPaths, src: Ingesting, moved: string, failure: string, fs: IngestFs, deps: ContentDeps): ConfigError {
  const keep = (why: string) => {
    failed(paths, src, `${failure}; ${why}`, moved, deps);
    return new ConfigError(
      `Ingesting "${src.fileName}" failed: ${failure}. ${why} The source is kept at ${moved}. ` +
        `To recover, move it back to ${src.file} yourself, then remove the folder ${src.dir}.`,
    );
  };

  // never over an existing file: an exclusive copy fails if one appeared meanwhile
  try {
    fs.copyExclusive(moved, src.file);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return keep(code === "EEXIST" ? `A new "${src.fileName}" is in the inbox, so it wasn't overwritten.` : `Restoring it failed too (${reason(err)}).`);
  }

  // the restored copy must be byte for byte the moved file before the moved one goes
  let identical = false;
  try {
    identical = sha256Of(fs.readFile(src.file)) === sha256Of(fs.readFile(moved));
  } catch {
    identical = false;
  }
  if (!identical) {
    try {
      fs.unlink(src.file); // only the faulty copy; the moved file stays
    } catch {
      // both stay: nothing is lost
    }
    return keep("The copy back to the inbox couldn't be verified.");
  }

  try {
    fs.unlink(moved);
  } catch (err) {
    failed(paths, src, `${failure}; restored, but the moved copy couldn't be removed`, src.file, deps);
    return new ConfigError(
      `Ingesting "${src.fileName}" failed: ${failure}. It is back in the inbox (${src.file}), but a copy remains at ${moved} (${reason(err)}): ` +
        `remove the folder ${src.dir} before trying again.`,
    );
  }

  // leftovers of this attempt only: an interrupted state.json write, then the folder if it's empty
  try {
    for (const f of fs.readdir(src.dir)) if (/^state\.json\.tmp-\d+$/.test(f)) fs.unlink(join(src.dir, f));
  } catch {
    // the folder check below reports what's left
  }
  const leftover = removeIfEmpty(src.dir, fs) ? "" : ` Remove the leftover folder ${src.dir} before trying again.`;
  failed(paths, src, failure, src.file, deps);
  const again = failure.startsWith("the file changed") ? " Ingest it again." : "";
  return new ConfigError(`Ingesting "${src.fileName}" failed: ${failure}. Nothing was ingested: it is back in the inbox (${src.file}).${again}${leftover}`);
}

function removeIfEmpty(dir: string, fs: IngestFs): boolean {
  if (!existsSync(dir)) return true;
  try {
    fs.rmdir(dir);
    return true;
  } catch {
    return false;
  }
}

/** Logs the failed attempt and where the source is; never fails the ingest itself. */
function failed(paths: PublisherPaths, src: Ingesting, why: string, sourceAt: string, deps: ContentDeps): void {
  try {
    logEvent(paths.logsDir, { event: "ingest_failed", name: src.name, file: src.fileName, sha256: src.sha256, reason: why, source_at: sourceAt }, deps.now());
  } catch {
    // the thrown error carries the same information
  }
}

// ---- status -----------------------------------------------------------------

export function status(paths: PublisherPaths, input: string, deps: ContentDeps) {
  const name = nameOf(input);
  const dir = draftDir(paths, name);
  const state = readState(dir);
  const files = DRAFT_FILES.filter((f) => existsSync(join(dir, f)));
  let contentSha256: string | null = null;
  try {
    contentSha256 = contentHash(loadDraft(paths, name));
  } catch {
    /* no meta.json yet */
  }
  const checkFile = join(dir, "check.json");
  const check = existsSync(checkFile) ? (JSON.parse(readFileSync(checkFile, "utf8")) as CheckOutcome) : null;
  return {
    name,
    state,
    files,
    content_sha256: contentSha256,
    check: check && { errors: check.errors, warnings: check.warnings, current: check.content_sha256 === contentSha256, checked_at: check.checked_at },
    approval_valid: contentSha256 !== null && approvalValid(state, contentSha256, deps.pageId),
  };
}

// ---- save (write or revise draft files) ---------------------------------------

export function save(paths: PublisherPaths, input: string, files: Record<string, string>, deps: ContentDeps) {
  const name = nameOf(input);
  const dir = draftDir(paths, name);
  let state = readState(dir);
  if (["WEBSITE_PUBLISHED", "PARTIALLY_PUBLISHED", "FACEBOOK_PUBLISHED", "REJECTED"].includes(state.status)) {
    throw new ConfigError(`"${name}" is ${state.status}; it can't be edited.`);
  }
  for (const [file, content] of Object.entries(files)) {
    if (!DRAFT_FILES.includes(file)) throw new ConfigError(`"${file}" is not a draft file (${DRAFT_FILES.join(", ")}).`);
    if (typeof content !== "string") throw new ConfigError(`${file}: content must be text.`);
    if (file === "meta.json") {
      const meta = draftMeta.safeParse(JSON.parse(content));
      if (!meta.success) throw new ConfigError(`meta.json: ${meta.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
      if (meta.data.id !== name) throw new ConfigError(`meta.json id must be "${name}" (the draft name).`);
      if (meta.data.facebook.languages.join() !== state.facebook_lang) {
        throw new ConfigError(`meta.json facebook.languages must be ["${state.facebook_lang}"], the language chosen for the post.`);
      }
    }
  }
  for (const [file, content] of Object.entries(files)) writeFileSync(join(dir, file), content.endsWith("\n") ? content : `${content}\n`);
  const now = deps.now();
  if (state.status !== "DRAFT") state = move(state, "DRAFT", now, "draft edited");
  state = { ...state, approval: null }; // any edit voids the approval
  writeState(dir, state);
  return { name, status: state.status, written: Object.keys(files) };
}

// ---- check ------------------------------------------------------------------

export interface CheckOutcome {
  name: string;
  checked_at: string;
  content_sha256: string;
  errors: number;
  warnings: number;
  findings: Finding[];
}

export function check(paths: PublisherPaths, input: string, deps: ContentDeps): CheckOutcome {
  const name = nameOf(input);
  const dir = draftDir(paths, name);
  const state = readState(dir);
  const draft = loadDraft(paths, name);
  const ctx = (deps.context ?? ((p, n) => loadContext(p, n)))(paths, name);
  let findings = checkDraft(draft, ctx);
  if (!state.channels.includes("facebook")) findings = findings.filter((f) => !f.code.startsWith("facebook."));
  else if (draft.meta.facebook.languages.join() !== state.facebook_lang) {
    findings.push({ level: "error", code: "facebook.language", message: `the post's language is ${state.facebook_lang}; meta.json facebook.languages must be ["${state.facebook_lang}"]` });
  }
  const now = deps.now();
  const outcome: CheckOutcome = {
    name,
    checked_at: now.toISOString(),
    content_sha256: contentHash(draft),
    errors: findings.filter((f) => f.level === "error").length,
    warnings: findings.filter((f) => f.level === "warning").length,
    findings,
  };
  writeFileSync(join(dir, "check.json"), `${JSON.stringify(outcome, null, 2)}\n`);
  if (state.status === "VALIDATED") writeState(dir, move(state, "DRAFT", now, "draft written"));
  return outcome;
}

// ---- submit, approve, reject ----------------------------------------------------

export interface ApprovalSummary {
  name: string;
  content_sha256: string;
  channels: Channel[];
  article: Record<Language, { title: string; excerpt: string; url: string }>;
  /** text: exactly what is posted (the post, then its article link); image: image.svg, posted as PNG */
  facebook: { lang: Language; page_id: string | null; text: string; link: string; image: string | null } | null;
  warnings: Finding[];
}

export function summary(paths: PublisherPaths, draft: Draft, state: DraftState, ctx: CheckContext, deps: ContentDeps, warnings: Finding[]): ApprovalSummary {
  const article = Object.fromEntries(
    LANGUAGES.map((l) => [l, { title: draft.meta[l].title, excerpt: draft.meta[l].excerpt, url: ownUrl(ctx, draft.meta, l) }]),
  ) as ApprovalSummary["article"];
  return {
    name: state.name,
    content_sha256: contentHash(draft),
    channels: state.channels,
    article,
    facebook: state.channels.includes("facebook")
      ? {
          lang: state.facebook_lang,
          page_id: deps.pageId,
          text: postMessage(draft.facebook[state.facebook_lang] ?? "", article[state.facebook_lang].url),
          link: article[state.facebook_lang].url,
          image: draft.image === null ? null : join(draft.dir, IMAGE_FILE),
        }
      : null,
    warnings,
  };
}

export function submit(paths: PublisherPaths, input: string, deps: ContentDeps): ApprovalSummary {
  const name = nameOf(input);
  const dir = draftDir(paths, name);
  const outcome = check(paths, input, deps);
  if (outcome.errors) throw new ConfigError(`"${name}" has ${outcome.errors} error(s); fix them before submitting (npm run content -- check ${name}).`);
  let state = readState(dir);
  const ctx = (deps.context ?? ((p, n) => loadContext(p, n)))(paths, name);
  if (state.status !== "REVIEW") state = move(state, "REVIEW", deps.now(), "submitted for approval");
  writeState(dir, state);
  logEvent(paths.logsDir, { event: "submitted", name, content_sha256: outcome.content_sha256 }, deps.now());
  return summary(paths, loadDraft(paths, name), state, ctx, deps, outcome.findings.filter((f) => f.level === "warning"));
}

/** The code the owner must type to approve this exact submission. */
export function pendingApprovalCode(paths: PublisherPaths, input: string, deps: ContentDeps): string {
  const name = nameOf(input);
  const state = readState(draftDir(paths, name));
  if (state.status !== "REVIEW") throw new ConfigError(`"${name}" is ${state.status}; submit it for review first.`);
  const sha = contentHash(loadDraft(paths, name));
  return approvalCode(approvalHash(sha, state.facebook_lang, state.channels, deps.pageId));
}

/** Records the owner's approval. Called only by the interactive CLI, never by an MCP tool. */
export function approve(paths: PublisherPaths, input: string, typedCode: string, deps: ContentDeps): DraftState {
  const name = nameOf(input);
  const dir = draftDir(paths, name);
  const outcome = check(paths, input, deps); // revalidated right before the approval
  if (outcome.errors) throw new ConfigError(`"${name}" has ${outcome.errors} error(s); it can't be approved.`);
  let state = readState(dir);
  if (state.status !== "REVIEW") throw new ConfigError(`"${name}" is ${state.status}; only a submitted draft (REVIEW) can be approved.`);
  const expected = approvalCode(approvalHash(outcome.content_sha256, state.facebook_lang, state.channels, deps.pageId));
  if (typedCode.trim().toUpperCase() !== expected) throw new ConfigError("The code doesn't match: nothing was approved.");
  const now = deps.now();
  state = move(state, "APPROVED", now, "approved by the owner");
  state = {
    ...state,
    approval: {
      content_sha256: outcome.content_sha256,
      facebook_lang: state.facebook_lang,
      channels: state.channels,
      page_id: deps.pageId,
      approved_at: now.toISOString(),
    },
  };
  writeState(dir, state);
  logEvent(paths.logsDir, { event: "approved", name, content_sha256: outcome.content_sha256, facebook_lang: state.facebook_lang, channels: state.channels, page_id: deps.pageId }, now);
  return state;
}

export function reject(paths: PublisherPaths, input: string, reason: string, deps: ContentDeps) {
  const name = nameOf(input);
  const dir = draftDir(paths, name);
  let state = readState(dir);
  const now = deps.now();
  state = move(state, "REJECTED", now, reason || "rejected");
  writeState(dir, state);
  mkdirSync(paths.rejectedDir, { recursive: true });
  renameSync(dir, join(paths.rejectedDir, name)); // kept, with its source, under rejected/
  logEvent(paths.logsDir, { event: "rejected", name }, now);
  return { name, status: state.status };
}
