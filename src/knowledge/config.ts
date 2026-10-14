import { join } from "node:path";
import { ConfigError, PROJECT_ROOT } from "../config.js";
import { resolveContentDir, resolveGuardedDir } from "../publisher-config.js";

/**
 * Configuration of the business knowledge tooling. Everything site- or
 * business-specific comes from the environment (.env); this repository is
 * public and holds no business content.
 *
 *   KNOWLEDGE_DIR              knowledge repository (default: sibling ../knowledge)
 *   KNOWLEDGE_SITE_ORIGIN      website origin to crawl, e.g. https://example.com (required to crawl/validate URLs)
 *   KNOWLEDGE_TEXT_RESOURCES   plain-text resources to keep as evidence, "path=lang" comma-separated (e.g. /llms.txt=en)
 *   KNOWLEDGE_USER_AGENT       crawler User-Agent (default: meta-mcp-knowledge/<version> (+<origin>))
 *   KNOWLEDGE_MIN_DELAY_MS     delay between page requests, at least 2000 (default 2000)
 *   KNOWLEDGE_MAX_PAGES        crawl cap (default 100)
 *   KNOWLEDGE_STALE_DAYS       evidence age that triggers a freshness warning (default 14)
 *   PORTFOLIO_DIR              the website repository, which the knowledge dir must not be inside (default: sibling ../portfolio)
 *   PUBLISHER_CONTENT_DIR      the editorial store (read-only here: anonymization rules)
 */

export const KNOWLEDGE_TOOL_VERSION = "0.3.0";
export const MIN_DELAY_MS = 2000;

export interface KnowledgeConfig {
  dir: string;
  origin: string | undefined;
  textResources: { path: string; lang: string }[];
  userAgent: string;
  minDelayMs: number;
  maxPages: number;
  staleDays: number;
  editorialDir: string;
}

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number, min = 1): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) throw new ConfigError(`${name} must be an integer >= ${min}.`);
  return value;
}

export function parseOrigin(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError("KNOWLEDGE_SITE_ORIGIN must be an absolute URL such as https://example.com.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConfigError("KNOWLEDGE_SITE_ORIGIN must use http or https.");
  }
  return url.origin;
}

export function parseTextResources(raw: string | undefined): { path: string; lang: string }[] {
  if (!raw?.trim()) return [];
  return raw.split(",").map((entry) => {
    const match = /^\s*(\/[A-Za-z0-9._\-/]*)\s*=\s*([a-z]{2,3})\s*$/.exec(entry);
    if (!match) throw new ConfigError(`KNOWLEDGE_TEXT_RESOURCES entry "${entry}" must look like /llms.txt=en.`);
    return { path: match[1], lang: match[2] };
  });
}

export function resolveKnowledgeDir(env: NodeJS.ProcessEnv = process.env, projectRoot: string = PROJECT_ROOT): string {
  const portfolio = resolveGuardedDir({
    envVar: "PORTFOLIO_DIR",
    value: env.PORTFOLIO_DIR,
    defaultDir: join(projectRoot, "..", "portfolio"),
    forbidden: [],
  });
  return resolveGuardedDir({
    envVar: "KNOWLEDGE_DIR",
    value: env.KNOWLEDGE_DIR,
    defaultDir: join(projectRoot, "..", "knowledge"),
    forbidden: [
      {
        path: projectRoot,
        reason: "points inside the meta-mcp repository, which is public. Keep the knowledge repository outside it.",
      },
      {
        path: portfolio,
        reason: "points inside the website repository (PORTFOLIO_DIR); it could end up in a public build or deployment.",
      },
      {
        path: resolveContentDir(env, projectRoot),
        reason: "points inside the editorial store; the knowledge system must never write there.",
      },
    ],
  });
}

export function readKnowledgeConfig(env: NodeJS.ProcessEnv = process.env, projectRoot: string = PROJECT_ROOT): KnowledgeConfig {
  const origin = parseOrigin(env.KNOWLEDGE_SITE_ORIGIN);
  return {
    dir: resolveKnowledgeDir(env, projectRoot),
    origin,
    textResources: parseTextResources(env.KNOWLEDGE_TEXT_RESOURCES),
    userAgent:
      env.KNOWLEDGE_USER_AGENT?.trim() ||
      `meta-mcp-knowledge/${KNOWLEDGE_TOOL_VERSION} (+${origin ?? "unconfigured"})`,
    minDelayMs: positiveInt(env, "KNOWLEDGE_MIN_DELAY_MS", MIN_DELAY_MS, MIN_DELAY_MS),
    maxPages: positiveInt(env, "KNOWLEDGE_MAX_PAGES", 100),
    staleDays: positiveInt(env, "KNOWLEDGE_STALE_DAYS", 14),
    editorialDir: resolveContentDir(env, projectRoot),
  };
}

export function requireOrigin(config: KnowledgeConfig): string {
  if (!config.origin) {
    throw new ConfigError("KNOWLEDGE_SITE_ORIGIN is not set. Add the website origin to .env (see .env.example).");
  }
  return config.origin;
}
