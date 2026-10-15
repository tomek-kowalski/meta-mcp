import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { ConfigError } from "../config.js";
import { isInside } from "../publisher-config.js";
import { LANGUAGES } from "../publisher/draft.js";

/**
 * Source material in the editorial inbox: plain .txt files the owner drops
 * into <editorial>/inbox/. A file is untrusted data: it is read, parsed and
 * shown to the writer, never executed, and nothing in it can change the rules.
 *
 * Optional format (every part may be missing; plain text works too):
 *
 *   TITLE: WooCommerce Action Scheduler optimization
 *   LANGUAGE: pl
 *   CHANNELS: website, facebook
 *
 *   PROBLEM:
 *   …
 *   IMPLEMENTATION:
 *   …
 *   CODE:
 *   …
 *   RESULT:
 *   …
 *   NOTES:
 *   …
 */

export const MAX_SOURCE_BYTES = 200 * 1024;
export const SECTIONS = ["PROBLEM", "IMPLEMENTATION", "CODE", "RESULT", "NOTES"] as const;
export type SectionName = (typeof SECTIONS)[number];
export const CHANNELS = ["website", "facebook"] as const;
export type Channel = (typeof CHANNELS)[number];

export const language = z.enum(LANGUAGES);
export const channels = z
  .array(z.enum(CHANNELS))
  .min(1, "at least one channel")
  .transform((list) => CHANNELS.filter((c) => list.includes(c)));

export interface ParsedSource {
  title: string | null;
  language: (typeof LANGUAGES)[number] | null;
  channels: Channel[] | null;
  sections: Partial<Record<SectionName, string>>;
  /** Text outside the named sections (a plain-text file is all body) */
  body: string;
  /** Header-looking lines that aren't TITLE/LANGUAGE/CHANNELS, reported back */
  ignoredHeaders: string[];
}

export interface SourceFile {
  /** The draft name: the file name without .txt, as lowercase words joined by hyphens */
  name: string;
  /** The file name as given in the inbox */
  fileName: string;
  path: string;
  bytes: number;
  sha256: string;
  text: string;
}

/** woo Action-Scheduler.txt -> woo-action-scheduler */
export function draftName(fileName: string): string {
  const stem = basename(fileName).replace(/\.txt$/i, "");
  const name = stem
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[łŁ]/g, "l")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  if (!name) throw new ConfigError(`"${fileName}" gives no usable draft name; use letters or digits in the file name`);
  return name;
}

/**
 * Resolves what the owner typed (a file name, with or without .txt, or a
 * path) to a regular .txt file directly inside the inbox. Refuses anything
 * else: other folders, ../ traversal, symlinks (even pointing back inside).
 */
export function resolveInboxFile(inboxDir: string, input: string, cwd = process.cwd()): string {
  const typed = input.trim();
  if (!typed) throw new ConfigError("No file given.");
  const hasDir = /[\\/]/.test(typed);
  const withExt = extname(typed).toLowerCase() === ".txt" ? typed : `${typed}.txt`;
  const candidate = hasDir ? resolve(isAbsolute(withExt) ? withExt : resolve(cwd, withExt)) : join(inboxDir, withExt);
  if (extname(candidate).toLowerCase() !== ".txt") throw new ConfigError("Only .txt files can be ingested.");
  if (!existsSync(inboxDir)) throw new ConfigError(`The inbox ${inboxDir} doesn't exist.`);
  const inbox = realpathSync.native(inboxDir);
  if (!isInside(resolve(dirname(candidate)), inboxDir) && !isInside(resolve(dirname(candidate)), inbox)) {
    throw new ConfigError(`"${input}" is not in the editorial inbox (${inboxDir}).`);
  }
  if (!existsSync(candidate)) throw new ConfigError(`"${basename(candidate)}" is not in the inbox.`);
  const stat = lstatSync(candidate);
  if (stat.isSymbolicLink()) throw new ConfigError(`"${basename(candidate)}" is a link; put the file itself into the inbox.`);
  if (!stat.isFile()) throw new ConfigError(`"${basename(candidate)}" is not a regular file.`);
  // the file must really live directly in the inbox (no junction or link in the path)
  const real = realpathSync.native(candidate);
  if (realpathSync.native(dirname(real)).toLowerCase() !== inbox.toLowerCase()) {
    throw new ConfigError(`"${input}" resolves outside the editorial inbox.`);
  }
  return real;
}

/** Reads a source file: size limit, strict UTF-8 (BOM removed), no binary content, LF line endings. */
export function readSourceFile(path: string, maxBytes = MAX_SOURCE_BYTES): Omit<SourceFile, "name" | "fileName"> {
  const bytes = lstatSync(path).size;
  if (bytes > maxBytes) throw new ConfigError(`The file is ${bytes} bytes; the limit is ${maxBytes} bytes.`);
  if (bytes === 0) throw new ConfigError("The file is empty.");
  const buffer = readFileSync(path);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new ConfigError("The file is not valid UTF-8 text. Save it as UTF-8.");
  }
  if (text.includes("\u0000")) throw new ConfigError("The file contains binary data (NUL bytes); only plain text is accepted.");
  text = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  if (!text.trim()) throw new ConfigError("The file contains no text.");
  return { path, bytes, sha256: createHash("sha256").update(buffer).digest("hex"), text };
}

const HEADER = /^([A-Z][A-Z _-]{1,30}):[ \t]*(.*)$/;

export function parseSource(text: string): ParsedSource {
  const lines = text.split("\n");
  const parsed: ParsedSource = { title: null, language: null, channels: null, sections: {}, body: "", ignoredHeaders: [] };
  let i = 0;
  // header block: KEY: value lines at the top (blank lines allowed between them)
  for (; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    const m = HEADER.exec(line);
    if (!m || (SECTIONS as readonly string[]).includes(m[1].trim())) break;
    const key = m[1].trim();
    const value = m[2].trim();
    if (key === "TITLE") parsed.title = value || null;
    else if (key === "LANGUAGE") {
      const lang = language.safeParse(value.toLowerCase());
      if (!lang.success) throw new ConfigError(`LANGUAGE: "${value}" is not one of ${LANGUAGES.join(", ")}`);
      parsed.language = lang.data;
    } else if (key === "CHANNELS") {
      const list = channels.safeParse(value.toLowerCase().split(/[\s,;]+/).filter(Boolean));
      if (!list.success) throw new ConfigError(`CHANNELS: "${value}" must list website and/or facebook`);
      parsed.channels = list.data;
    } else parsed.ignoredHeaders.push(key);
  }
  // sections: a line "PROBLEM:" (optionally with text after the colon) starts one
  let current: SectionName | null = null;
  const body: string[] = [];
  const buffers: Partial<Record<SectionName, string[]>> = {};
  for (; i < lines.length; i += 1) {
    const m = /^(PROBLEM|IMPLEMENTATION|CODE|RESULT|NOTES):[ \t]*(.*)$/.exec(lines[i]);
    if (m) {
      current = m[1] as SectionName;
      buffers[current] = buffers[current] ?? [];
      if (m[2].trim()) buffers[current]!.push(m[2]);
      continue;
    }
    (current ? buffers[current]! : body).push(lines[i]);
  }
  for (const name of SECTIONS) {
    const value = buffers[name]?.join("\n").replace(/^\n+|\s+$/g, "");
    if (value) parsed.sections[name] = value;
  }
  parsed.body = body.join("\n").trim();
  return parsed;
}

/** .txt files waiting in the inbox (regular files only). */
export function listInbox(inboxDir: string): { fileName: string; name: string; bytes: number }[] {
  if (!existsSync(inboxDir)) return [];
  return readdirSync(inboxDir, { withFileTypes: true })
    .filter((d) => d.isFile() && /\.txt$/i.test(d.name))
    .map((d) => {
      let name = "";
      try {
        name = draftName(d.name);
      } catch {
        name = "(unusable name)";
      }
      return { fileName: d.name, name, bytes: lstatSync(join(inboxDir, d.name)).size };
    })
    .sort((a, b) => a.fileName.localeCompare(b.fileName));
}
