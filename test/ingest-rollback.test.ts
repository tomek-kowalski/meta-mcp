import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "../src/config.js";
import { readState } from "../src/content/lifecycle.js";
import * as service from "../src/content/service.js";
import type { PublisherPaths } from "../src/publisher/draft.js";

/**
 * Ingest is all or nothing: every failure after the checks leaves the source either back in the
 * inbox, byte for byte, or kept in the draft folder at a path the error names. Never lost.
 */

const SOURCE = "TITLE: Rollback\nLANGUAGE: pl\n\nPROBLEM:\nZadania kończyły się błędem.\n\nRESULT:\nSpadek o 40%.\n";
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

function sandbox() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ingest-"))); // the long path, as ingest resolves the inbox file
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
  const inboxFile = join(paths.inboxDir, "case.txt");
  writeFileSync(inboxFile, SOURCE);
  return { paths, inboxFile, draftDir: join(paths.draftsDir, "case"), moved: join(paths.draftsDir, "case", "source.txt") };
}

let clock = Date.parse("2026-10-21T10:00:00Z");
const deps = (fs: Partial<service.IngestFs> = {}): service.ContentDeps => ({ now: () => new Date((clock += 1000)), pageId: null, fs });

const failing = (code: string, message = "simulated") => () => {
  throw Object.assign(new Error(`${code}: ${message}`), { code });
};

/** The source content exists exactly where expected, and nowhere is it lost. */
function assertInInbox(s: ReturnType<typeof sandbox>, content = SOURCE) {
  assert.ok(existsSync(s.inboxFile), "the source is back in the inbox");
  assert.equal(readFileSync(s.inboxFile, "utf8"), content);
}

function events(paths: PublisherPaths): Record<string, unknown>[] {
  const file = join(paths.logsDir, "publications.jsonl");
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
}

test("success: the moved file is verified against the parsed hash, state.json written", () => {
  const s = sandbox();
  const reads: string[] = [];
  const r = service.ingest(s.paths, "case.txt", {}, deps({ readFile: (f) => (reads.push(f), readFileSync(f)) }));
  assert.equal(r.state.source.sha256, sha(SOURCE));
  assert.deepEqual(reads, [s.moved]);
  assert.equal(existsSync(s.inboxFile), false);
  assert.equal(readFileSync(s.moved, "utf8"), SOURCE);
  assert.equal(readState(s.draftDir).status, "VALIDATED");
  assert.equal(events(s.paths).at(-1)?.event, "ingested");
});

test("the draft folder can't be created: nothing moved, nothing created", () => {
  const s = sandbox();
  assert.throws(() => service.ingest(s.paths, "case.txt", {}, deps({ mkdir: failing("EACCES") })), (e: unknown) => e instanceof ConfigError && /still in the inbox/.test(e.message));
  assertInInbox(s);
  assert.equal(existsSync(s.draftDir), false);
});

test("move fails: the source stays in the inbox, only the empty folder of this attempt is removed, a retry works", () => {
  const s = sandbox();
  assert.throws(
    () => service.ingest(s.paths, "case.txt", {}, deps({ rename: failing("EBUSY", "resource busy or locked") })),
    (e: unknown) => e instanceof ConfigError && /Couldn't move "case.txt"/.test(e.message) && e.message.includes(s.inboxFile) && !/Remove the empty folder/.test(e.message),
  );
  assertInInbox(s);
  assert.equal(existsSync(s.draftDir), false);
  assert.deepEqual(events(s.paths).map((e) => e.event), ["ingest_failed"]);
  // the same file ingests normally afterwards ("already ingested" isn't triggered by a leftover)
  service.ingest(s.paths, "case.txt", {}, deps());
  assert.equal(readFileSync(s.moved, "utf8"), SOURCE);
});

test("move fails and the folder can't be removed: the error names the leftover folder", () => {
  const s = sandbox();
  assert.throws(
    () => service.ingest(s.paths, "case.txt", {}, deps({ rename: failing("EXDEV"), rmdir: failing("EPERM") })),
    (e: unknown) => e instanceof ConfigError && e.message.includes(`Remove the empty folder ${s.draftDir}`),
  );
  assertInInbox(s);
});

test("state.json can't be written: the source is restored byte for byte, the draft folder removed, a retry works", () => {
  const s = sandbox();
  assert.throws(
    () => service.ingest(s.paths, "case.txt", {}, deps({ writeState: failing("ENOSPC", "no space left on device") })),
    (e: unknown) => e instanceof ConfigError && /state\.json couldn't be written/.test(e.message) && /Nothing was ingested/.test(e.message),
  );
  assertInInbox(s);
  assert.equal(existsSync(s.draftDir), false);
  const last = events(s.paths).at(-1)!;
  assert.equal(last.event, "ingest_failed");
  assert.equal(last.source_at, s.inboxFile);
  service.ingest(s.paths, "case.txt", {}, deps());
  assert.equal(readState(s.draftDir).status, "VALIDATED");
});

test("an interrupted state.json write leaves a temporary file: it's cleaned up with the folder", () => {
  const s = sandbox();
  const writeState: service.IngestFs["writeState"] = (dir) => {
    writeFileSync(join(dir, `state.json.tmp-${process.pid}`), "{partial");
    throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
  };
  assert.throws(() => service.ingest(s.paths, "case.txt", {}, deps({ writeState })), ConfigError);
  assertInInbox(s);
  assert.equal(existsSync(s.draftDir), false);
});

test("the file changed between reading and moving: hash mismatch, the changed file goes back to the inbox", () => {
  const s = sandbox();
  const rename: service.IngestFs["rename"] = (from, to) => {
    appendFileSync(from, "\nSaved again by the editor.\n"); // the owner saved the file in between
    renameSync(from, to);
  };
  assert.throws(
    () => service.ingest(s.paths, "case.txt", {}, deps({ rename })),
    (e: unknown) => e instanceof ConfigError && /changed while it was being ingested/.test(e.message) && /Ingest it again/.test(e.message),
  );
  assertInInbox(s, `${SOURCE}\nSaved again by the editor.\n`);
  assert.equal(existsSync(s.draftDir), false);
});

test("the moved file can't be read back: restored", () => {
  const s = sandbox();
  let calls = 0;
  const readFile: service.IngestFs["readFile"] = (f) => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
    return readFileSync(f);
  };
  assert.throws(() => service.ingest(s.paths, "case.txt", {}, deps({ readFile })), /couldn't be read back/);
  assertInInbox(s);
  assert.equal(existsSync(s.draftDir), false);
});

test("rollback never overwrites: a new file with the same name in the inbox is kept, the source stays in the draft folder", () => {
  const s = sandbox();
  const writeState: service.IngestFs["writeState"] = () => {
    writeFileSync(s.inboxFile, "a different, newer file"); // dropped into the inbox meanwhile
    throw new Error("EIO");
  };
  assert.throws(
    () => service.ingest(s.paths, "case.txt", {}, deps({ writeState })),
    (e: unknown) =>
      e instanceof ConfigError && /wasn't overwritten/.test(e.message) && e.message.includes(`kept at ${s.moved}`) && e.message.includes(`remove the folder ${s.draftDir}`),
  );
  assert.equal(readFileSync(s.inboxFile, "utf8"), "a different, newer file");
  assert.equal(readFileSync(s.moved, "utf8"), SOURCE);
  assert.equal(events(s.paths).at(-1)?.source_at, s.moved);
});

test("restoring fails: the draft folder and source are preserved, the exact recovery path reported", () => {
  const s = sandbox();
  assert.throws(
    () => service.ingest(s.paths, "case.txt", {}, deps({ writeState: failing("EIO"), copyExclusive: failing("EACCES", "permission denied") })),
    (e: unknown) => e instanceof ConfigError && /Restoring it failed too/.test(e.message) && e.message.includes(`kept at ${s.moved}`) && e.message.includes(`move it back to ${s.inboxFile}`),
  );
  assert.equal(existsSync(s.inboxFile), false);
  assert.equal(readFileSync(s.moved, "utf8"), SOURCE);
});

test("the restored copy differs: it's removed, the moved source is kept", () => {
  const s = sandbox();
  const copyExclusive: service.IngestFs["copyExclusive"] = (_from, to) => writeFileSync(to, "truncated", { flag: "wx" });
  assert.throws(() => service.ingest(s.paths, "case.txt", {}, deps({ writeState: failing("EIO"), copyExclusive })), /couldn't be verified/);
  assert.equal(existsSync(s.inboxFile), false);
  assert.equal(readFileSync(s.moved, "utf8"), SOURCE);
});

test("the restored copy differs and can't be removed either: both copies stay, the source isn't lost", () => {
  const s = sandbox();
  const copyExclusive: service.IngestFs["copyExclusive"] = (_from, to) => writeFileSync(to, "truncated", { flag: "wx" });
  assert.throws(() => service.ingest(s.paths, "case.txt", {}, deps({ writeState: failing("EIO"), copyExclusive, unlink: failing("EPERM") })), /kept at/);
  assert.equal(readFileSync(s.moved, "utf8"), SOURCE);
});

test("restored, but the moved copy can't be removed: both exist, the error says what to remove", () => {
  const s = sandbox();
  assert.throws(
    () => service.ingest(s.paths, "case.txt", {}, deps({ writeState: failing("EIO"), unlink: failing("EPERM") })),
    (e: unknown) => e instanceof ConfigError && /back in the inbox/.test(e.message) && e.message.includes(`a copy remains at ${s.moved}`),
  );
  assertInInbox(s);
  assert.equal(readFileSync(s.moved, "utf8"), SOURCE);
});

test("restored, but the folder can't be removed: the error names the leftover folder", () => {
  const s = sandbox();
  assert.throws(
    () => service.ingest(s.paths, "case.txt", {}, deps({ writeState: failing("EIO"), rmdir: failing("EPERM") })),
    (e: unknown) => e instanceof ConfigError && e.message.includes(`Remove the leftover folder ${s.draftDir}`),
  );
  assertInInbox(s);
});

test("a failed ingest never touches other drafts or the publication history", () => {
  const s = sandbox();
  writeFileSync(join(s.paths.inboxDir, "first.txt"), SOURCE.replace("Rollback", "First"));
  service.ingest(s.paths, "first.txt", {}, deps());
  const firstDir = join(s.paths.draftsDir, "first");
  const before = { state: readFileSync(join(firstDir, "state.json"), "utf8"), source: readFileSync(join(firstDir, "source.txt"), "utf8"), log: events(s.paths).length };

  assert.throws(() => service.ingest(s.paths, "case.txt", {}, deps({ writeState: failing("EIO"), rmdir: failing("EPERM") })), ConfigError);

  assert.equal(readFileSync(join(firstDir, "state.json"), "utf8"), before.state);
  assert.equal(readFileSync(join(firstDir, "source.txt"), "utf8"), before.source);
  const log = events(s.paths);
  assert.equal(log.length, before.log + 1); // appended, nothing rewritten
  assert.equal(log[0].event, "ingested");
});
