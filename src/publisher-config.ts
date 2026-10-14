import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { ConfigError, PROJECT_ROOT } from "./config.js";

/**
 * Location of the editorial store (evidence, drafts, publication history,
 * source allowlist, anonymization rules). It is confidential, while this
 * repository is public, so it must never resolve inside the project root.
 *
 * PUBLISHER_CONTENT_DIR overrides the default, which is the sibling folder
 * `<parent of project root>/editorial`.
 */
export function resolveContentDir(env: NodeJS.ProcessEnv = process.env, projectRoot: string = PROJECT_ROOT): string {
  const configured = env.PUBLISHER_CONTENT_DIR?.trim();
  if (configured !== undefined && configured !== "" && !isAbsolute(configured)) {
    throw new ConfigError("PUBLISHER_CONTENT_DIR must be an absolute path.");
  }
  const dir = resolve(configured || join(projectRoot, "..", "editorial"));
  if (isInside(realish(dir), realish(projectRoot))) {
    throw new ConfigError(
      "PUBLISHER_CONTENT_DIR points inside the meta-mcp repository. Editorial content is confidential and this " +
        "repository is public: use a directory outside it (e.g. the sibling 'editorial' folder).",
    );
  }
  return dir;
}

/** True when `child` is `parent` itself or below it (case-insensitive on Windows, via path.relative). */
export function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Resolves symlinks/junctions through the deepest existing ancestor, so a link
 * that points into the repository can't bypass the check. Non-existing tail
 * segments are appended unchanged.
 */
function realish(path: string): string {
  let head = resolve(path);
  const tail: string[] = [];
  while (!existsSync(head)) {
    const parent = dirname(head);
    if (parent === head) return resolve(path);
    tail.unshift(basename(head));
    head = parent;
  }
  return join(realpathSync.native(head), ...tail);
}
