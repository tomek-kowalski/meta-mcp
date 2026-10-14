import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmdirSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, PROJECT_ROOT } from "../src/config.js";
import { resolveContentDir } from "../src/publisher-config.js";

const outside = mkdtempSync(join(tmpdir(), "editorial-"));

test("default content dir is the sibling 'editorial' folder, outside the repository", () => {
  assert.equal(resolveContentDir({}, PROJECT_ROOT), join(PROJECT_ROOT, "..", "editorial"));
});

test("an absolute content dir outside the repository is accepted", () => {
  assert.equal(resolveContentDir({ PUBLISHER_CONTENT_DIR: outside }), outside);
});

test("content dir inside the repository is rejected (root, subfolder, dot segments, case)", () => {
  const inside = [
    PROJECT_ROOT,
    join(PROJECT_ROOT, "content"),
    join(PROJECT_ROOT, "src", "..", "editorial"),
    join(PROJECT_ROOT, "not", "created", "yet"),
  ];
  if (process.platform === "win32") inside.push(join(PROJECT_ROOT.toUpperCase(), "content"));
  for (const dir of inside) {
    assert.throws(() => resolveContentDir({ PUBLISHER_CONTENT_DIR: dir }), ConfigError, dir);
  }
});

test("a relative content dir is rejected", () => {
  assert.throws(() => resolveContentDir({ PUBLISHER_CONTENT_DIR: "content" }), ConfigError);
  assert.throws(() => resolveContentDir({ PUBLISHER_CONTENT_DIR: "../editorial" }), ConfigError);
});

test("a link outside the repository that points into it is rejected", (t) => {
  const target = join(PROJECT_ROOT, "dist", "link-target-test");
  const link = join(outside, "link");
  mkdirSync(target, { recursive: true });
  try {
    try {
      symlinkSync(target, link, "junction");
    } catch {
      t.skip("cannot create a junction/symlink here");
      return;
    }
    assert.throws(() => resolveContentDir({ PUBLISHER_CONTENT_DIR: link }), ConfigError);
    assert.throws(() => resolveContentDir({ PUBLISHER_CONTENT_DIR: join(link, "sub") }), ConfigError);
  } finally {
    // remove only the link itself, never what it points to
    try {
      unlinkSync(link);
    } catch {
      try {
        rmdirSync(link);
      } catch {
        /* not created */
      }
    }
    rmSync(target, { force: true, recursive: true });
  }
});
