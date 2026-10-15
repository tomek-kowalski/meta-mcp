import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { z } from "zod";
import { ConfigError } from "../config.js";
import { emptyManifest, emptyRegistry, manifest, urlRegistry, type Manifest, type UrlRegistry } from "./schema.js";

/** Layout of the knowledge repository. The crawler writes only below evidence/. */
export const GENERATED = ["evidence"] as const;

export const knowledgePaths = (dir: string) => ({
  root: dir,
  evidence: join(dir, "evidence"),
  manifest: join(dir, "evidence", "manifest.json"),
  urls: join(dir, "evidence", "urls.json"),
});

/** JSON with a stable layout (2-space indent, trailing newline) so git diffs stay small. */
export const stableJson = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

export function readJsonFile<S extends z.ZodType>(file: string, schema: S, fallback?: () => z.infer<S>): z.infer<S> {
  if (!existsSync(file)) {
    if (fallback) return fallback();
    throw new ConfigError(`Missing knowledge file: ${file}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new ConfigError(`${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new ConfigError(`${file} does not match its schema: ${issues}`);
  }
  return parsed.data;
}

/**
 * Writes a generated file atomically (temp file + rename). Refuses any path
 * outside evidence/, so a bug can't touch anything else in the repository.
 */
export function writeGenerated(root: string, file: string, content: string): void {
  const rel = relative(root, file);
  const top = rel.split(sep)[0];
  if (rel.startsWith("..") || !(GENERATED as readonly string[]).includes(top)) {
    throw new Error(`Refusing to write outside the generated knowledge area: ${rel}`);
  }
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, file);
}

export const loadRegistry = (dir: string, origin: string | null = null): UrlRegistry =>
  readJsonFile(knowledgePaths(dir).urls, urlRegistry, () => emptyRegistry(origin));
export const loadManifest = (dir: string, origin: string | null = null): Manifest =>
  readJsonFile(knowledgePaths(dir).manifest, manifest, () => emptyManifest(origin));
