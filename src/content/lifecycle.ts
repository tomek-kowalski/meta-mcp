import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ConfigError } from "../config.js";
import { LANGUAGES } from "../publisher/draft.js";
import { redactString } from "../sanitize.js";
import { CHANNELS } from "./intake.js";

/**
 * A draft's lifecycle, kept in drafts/<name>/state.json:
 *
 *   VALIDATED → DRAFT → REVIEW → APPROVED → WEBSITE_PUBLISHED → FACEBOOK_PUBLISHED
 *   plus REJECTED, FAILED, PARTIALLY_PUBLISHED (website live, Facebook not yet)
 *
 * The approval is bound to a hash of the exact content (all three article
 * versions and the Facebook post), the Facebook language, the channels and
 * the Page: any change voids it. Only the owner approves, interactively.
 */

export const STATUSES = [
  "VALIDATED",
  "DRAFT",
  "REVIEW",
  "APPROVED",
  "WEBSITE_PUBLISHED",
  "FACEBOOK_PUBLISHED",
  "PARTIALLY_PUBLISHED",
  "REJECTED",
  "FAILED",
] as const;
export type Status = (typeof STATUSES)[number];

const timestamp = z.iso.datetime();

export const draftState = z
  .object({
    version: z.literal(1),
    name: z.string(),
    status: z.enum(STATUSES),
    source: z.object({ file: z.string(), sha256: z.string(), bytes: z.number().int(), ingested_at: timestamp }).strict(),
    /** language of the source and the first draft; the website always gets pl, en and de */
    lang: z.enum(LANGUAGES),
    /** the one language of the Facebook post */
    facebook_lang: z.enum(LANGUAGES),
    channels: z.array(z.enum(CHANNELS)).min(1),
    approval: z
      .object({
        content_sha256: z.string(),
        facebook_lang: z.enum(LANGUAGES),
        channels: z.array(z.enum(CHANNELS)),
        page_id: z.string().nullable(),
        approved_at: timestamp,
      })
      .strict()
      .nullable(),
    website: z
      .object({
        content_sha256: z.string(),
        urls: z.record(z.string(), z.string()),
        commit: z.string().nullable(),
        published_at: timestamp,
      })
      .strict()
      .nullable(),
    facebook: z
      .object({
        status: z.enum(["pending", "published", "unknown", "failed"]),
        lang: z.enum(LANGUAGES),
        link: z.string(),
        post_id: z.string().nullable(),
        attempted_at: timestamp,
        published_at: timestamp.nullable(),
        last_error: z.string().nullable(),
      })
      .strict()
      .nullable(),
    last_error: z.string().nullable(),
    history: z.array(z.object({ at: timestamp, status: z.enum(STATUSES), note: z.string().optional() }).strict()),
  })
  .strict();
export type DraftState = z.infer<typeof draftState>;

/** Allowed moves. Editing (save) from REVIEW or APPROVED goes back to DRAFT. */
const NEXT: Record<Status, readonly Status[]> = {
  VALIDATED: ["DRAFT", "REJECTED", "FAILED"],
  DRAFT: ["DRAFT", "REVIEW", "REJECTED", "FAILED"],
  REVIEW: ["DRAFT", "APPROVED", "REJECTED"],
  APPROVED: ["DRAFT", "WEBSITE_PUBLISHED", "REJECTED", "FAILED"],
  WEBSITE_PUBLISHED: ["FACEBOOK_PUBLISHED", "PARTIALLY_PUBLISHED"],
  PARTIALLY_PUBLISHED: ["FACEBOOK_PUBLISHED", "PARTIALLY_PUBLISHED"],
  FACEBOOK_PUBLISHED: [],
  REJECTED: [],
  FAILED: ["DRAFT", "REJECTED"],
};

export function canMove(from: Status, to: Status): boolean {
  return NEXT[from].includes(to);
}

export function move(state: DraftState, to: Status, now: Date, note?: string): DraftState {
  if (!canMove(state.status, to)) {
    throw new ConfigError(`"${state.name}" is ${state.status}; it can't become ${to}.`);
  }
  return { ...state, status: to, history: [...state.history, { at: now.toISOString(), status: to, ...(note ? { note } : {}) }] };
}

export const stateFile = (draftDir: string) => join(draftDir, "state.json");

export function readState(draftDir: string): DraftState {
  const file = stateFile(draftDir);
  if (!existsSync(file)) throw new ConfigError(`No state for this draft (${file}).`);
  const parsed = draftState.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) throw new ConfigError(`${file}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return parsed.data;
}

export function writeState(draftDir: string, state: DraftState): void {
  const file = stateFile(draftDir);
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(draftState.parse(state), null, 2)}\n`);
  renameSync(tmp, file);
}

/** What the owner approves: one hash over content, Facebook language, channels and Page. */
export function approvalHash(contentSha256: string, facebookLang: string, channels: readonly string[], pageId: string | null): string {
  return createHash("sha256").update(JSON.stringify([contentSha256, facebookLang, [...channels].sort(), pageId])).digest("hex");
}

/** The code the owner types to approve: short, derived from the approval hash. */
export const approvalCode = (hash: string) => hash.slice(0, 6).toUpperCase();

/** Is the stored approval still valid for this exact content? */
export function approvalValid(state: DraftState, contentSha256: string, pageId: string | null): boolean {
  const a = state.approval;
  return (
    a !== null &&
    a.content_sha256 === contentSha256 &&
    a.facebook_lang === state.facebook_lang &&
    a.page_id === pageId &&
    [...a.channels].sort().join() === [...state.channels].sort().join()
  );
}

/**
 * Append-only publication log (logs/publications.jsonl): names, hashes,
 * languages, URLs, post ids, statuses and errors. Never source or draft text.
 */
export function logEvent(logsDir: string, event: Record<string, unknown>, now: Date): void {
  mkdirSync(logsDir, { recursive: true });
  const safe = JSON.parse(redactString(JSON.stringify({ at: now.toISOString(), ...event })));
  appendFileSync(join(logsDir, "publications.jsonl"), `${JSON.stringify(safe)}\n`);
}
