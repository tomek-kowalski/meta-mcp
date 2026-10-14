import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmdirSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, PROJECT_ROOT } from "../src/config.js";
import { parseOrigin, parseTextResources, readKnowledgeConfig, resolveKnowledgeDir } from "../src/knowledge/config.js";
import { writeGenerated } from "../src/knowledge/store.js";

const sandbox = mkdtempSync(join(tmpdir(), "knowledge-cfg-"));
const portfolio = join(sandbox, "portfolio");
const editorial = join(sandbox, "editorial");
mkdirSync(portfolio, { recursive: true });
mkdirSync(editorial, { recursive: true });
const env = (extra: Record<string, string> = {}) => ({ PORTFOLIO_DIR: portfolio, PUBLISHER_CONTENT_DIR: editorial, ...extra });

function removeLink(link: string) {
  try {
    unlinkSync(link);
  } catch {
    try {
      rmdirSync(link);
    } catch {
      /* not created */
    }
  }
}

test("default knowledge dir is the sibling 'knowledge' folder", () => {
  assert.equal(resolveKnowledgeDir(env()), join(PROJECT_ROOT, "..", "knowledge"));
});

test("an absolute knowledge dir outside every forbidden root is accepted", () => {
  const dir = join(sandbox, "knowledge");
  assert.equal(resolveKnowledgeDir(env({ KNOWLEDGE_DIR: dir })), dir);
});

test("knowledge dir inside meta-mcp, the website repo or the editorial store is rejected", () => {
  const inside = [
    PROJECT_ROOT,
    join(PROJECT_ROOT, "knowledge"),
    join(PROJECT_ROOT, "src", "..", "data"),
    portfolio,
    join(portfolio, "public", "knowledge"),
    join(portfolio, "dist"),
    editorial,
    join(editorial, "knowledge"),
  ];
  for (const dir of inside) {
    assert.throws(() => resolveKnowledgeDir(env({ KNOWLEDGE_DIR: dir })), ConfigError, dir);
  }
});

test("a relative knowledge dir is rejected", () => {
  assert.throws(() => resolveKnowledgeDir(env({ KNOWLEDGE_DIR: "knowledge" })), ConfigError);
});

test("a link that points into the website repo or meta-mcp is rejected (symlink/junction escape)", (t) => {
  const targets = [join(portfolio, "public"), join(PROJECT_ROOT, "dist", "knowledge-link-target")];
  for (const target of targets) {
    mkdirSync(target, { recursive: true });
    const link = join(sandbox, `link-${targets.indexOf(target)}`);
    try {
      try {
        symlinkSync(target, link, "junction");
      } catch {
        t.skip("cannot create a junction/symlink here");
        return;
      }
      assert.throws(() => resolveKnowledgeDir(env({ KNOWLEDGE_DIR: link })), ConfigError);
      assert.throws(() => resolveKnowledgeDir(env({ KNOWLEDGE_DIR: join(link, "deeper", "dir") })), ConfigError);
    } finally {
      removeLink(link);
    }
  }
  rmSync(join(PROJECT_ROOT, "dist", "knowledge-link-target"), { recursive: true, force: true });
});

test("site origin: normalized to the origin; invalid values rejected", () => {
  assert.equal(parseOrigin("https://example.com/some/path?q=1"), "https://example.com");
  assert.equal(parseOrigin(undefined), undefined);
  assert.throws(() => parseOrigin("example.com"), ConfigError);
  assert.throws(() => parseOrigin("ftp://example.com"), ConfigError);
});

test("text resources parse as path=lang; malformed entries are rejected", () => {
  assert.deepEqual(parseTextResources("/llms.txt=en, /humans.txt=pl"), [
    { path: "/llms.txt", lang: "en" },
    { path: "/humans.txt", lang: "pl" },
  ]);
  assert.throws(() => parseTextResources("llms.txt"), ConfigError);
});

test("the crawl delay can't go below two seconds", () => {
  assert.equal(readKnowledgeConfig(env()).minDelayMs, 2000);
  assert.equal(readKnowledgeConfig(env({ KNOWLEDGE_MIN_DELAY_MS: "5000" })).minDelayMs, 5000);
  assert.throws(() => readKnowledgeConfig(env({ KNOWLEDGE_MIN_DELAY_MS: "500" })), ConfigError);
});

test("generated writes are confined to evidence/ and reports/", () => {
  const root = join(sandbox, "kb");
  writeGenerated(root, join(root, "evidence", "urls.json"), "{}\n");
  writeGenerated(root, join(root, "reports", "r.md"), "x\n");
  for (const target of ["claims.json", join("facts", "services.md"), join("recommendations", "x.md"), join("..", "elsewhere.md")]) {
    assert.throws(() => writeGenerated(root, join(root, target), "x"), /Refusing to write/, target);
  }
});
