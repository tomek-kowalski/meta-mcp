import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ConfigError, PROJECT_ROOT } from "../config.js";
import { resolveContentDir, resolveGuardedDir } from "../publisher-config.js";

/**
 * An article draft in the private editorial store:
 *
 *   <editorial>/drafts/<name>/       <name> = the source file's name (inbox/<name>.txt)
 *     source.txt           the original source material, unchanged (never published)
 *     case.md              private notes on the real case (never published)
 *     meta.json            date, category, slug/title/excerpt per language, Facebook languages
 *     article.pl.md        body, Polish (primary)
 *     article.en.md        body, English
 *     article.de.md        body, German
 *     facebook.pl.txt      Facebook post (Polish by default; en/de only when the owner chooses)
 *     check.json           written by the checks
 *     state.json           lifecycle, approval and publication state (src/content/lifecycle.ts)
 *
 * Every article is published in all three languages; the Facebook post is in
 * exactly one language, chosen by the owner (Polish by default).
 */

export const LANGUAGES = ["pl", "en", "de"] as const;
export type Language = (typeof LANGUAGES)[number];

const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "slug: lowercase words joined by hyphens");
const localized = z
  .object({ slug, title: z.string().trim().min(1), excerpt: z.string().trim().min(1) })
  .strict();

export const draftMeta = z
  .object({
    /** The draft's name: its folder, taken from the source file name */
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "id: the draft name (lowercase words joined by hyphens)"),
    date: z.iso.date(),
    category: z.string().min(1),
    pl: localized,
    en: localized,
    de: localized,
    facebook: z
      .object({ languages: z.array(z.enum(LANGUAGES)).min(1) })
      .strict()
      .default({ languages: ["pl"] }),
  })
  .strict();
export type DraftMeta = z.infer<typeof draftMeta>;

export interface Draft {
  id: string;
  dir: string;
  meta: DraftMeta;
  bodies: Record<Language, string | null>;
  facebook: Partial<Record<Language, string>>;
  /** source.txt, when the draft came from the inbox: claims are checked against it */
  source: string | null;
}

export interface PublisherPaths {
  editorialDir: string;
  inboxDir: string;
  draftsDir: string;
  rejectedDir: string;
  logsDir: string;
  portfolioDir: string;
}

export function publisherPaths(env: NodeJS.ProcessEnv = process.env, projectRoot: string = PROJECT_ROOT): PublisherPaths {
  const editorialDir = resolveContentDir(env, projectRoot);
  return {
    editorialDir,
    inboxDir: join(editorialDir, "inbox"),
    draftsDir: join(editorialDir, "drafts"),
    rejectedDir: join(editorialDir, "rejected"),
    logsDir: join(editorialDir, "logs"),
    portfolioDir: resolveGuardedDir({ envVar: "PORTFOLIO_DIR", value: env.PORTFOLIO_DIR, defaultDir: join(projectRoot, "..", "portfolio"), forbidden: [] }),
  };
}

const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : null);

/** Loads a draft; meta.json must exist and parse (anything else is reported by the checks). */
export function loadDraft(paths: PublisherPaths, id: string): Draft {
  if (!/^[a-z0-9-]+$/.test(id)) throw new ConfigError(`Invalid draft id "${id}"`);
  const dir = join(paths.draftsDir, id);
  const metaText = read(join(dir, "meta.json"));
  if (metaText === null) throw new ConfigError(`No draft ${id}: ${join(dir, "meta.json")} not found`);
  let raw: unknown;
  try {
    raw = JSON.parse(metaText);
  } catch (err) {
    throw new ConfigError(`${id}/meta.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = draftMeta.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(`${id}/meta.json: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
  }
  const bodies = Object.fromEntries(LANGUAGES.map((l) => [l, read(join(dir, `article.${l}.md`))])) as Record<Language, string | null>;
  const facebook: Partial<Record<Language, string>> = {};
  for (const l of LANGUAGES) {
    const text = read(join(dir, `facebook.${l}.txt`));
    if (text !== null) facebook[l] = text;
  }
  return { id, dir, meta: parsed.data, bodies, facebook, source: read(join(dir, "source.txt")) };
}

export function listDrafts(paths: PublisherPaths): string[] {
  if (!existsSync(paths.draftsDir)) return [];
  return readdirSync(paths.draftsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(paths.draftsDir, d.name, "meta.json")))
    .map((d) => d.name)
    .sort();
}

/** sha256 over everything that would be published (meta, bodies, posts): a check or approval is tied to it. */
export function contentHash(draft: Draft): string {
  const hash = createHash("sha256");
  hash.update(JSON.stringify(draft.meta));
  for (const l of LANGUAGES) hash.update(`\0article.${l}\0${draft.bodies[l] ?? ""}`);
  for (const l of LANGUAGES) hash.update(`\0facebook.${l}\0${draft.facebook[l] ?? ""}`);
  return hash.digest("hex");
}
