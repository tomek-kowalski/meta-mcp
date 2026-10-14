import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { registerSecret } from "./sanitize.js";

/** Project root: dist/src/config.js -> ../.. */
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface MetaConfig {
  accessToken: string | undefined;
  adAccountId: string | undefined;
  apiVersion: string;
  pageId: string | undefined;
}

/**
 * Loads <project root>/.env into process.env without overriding values that are
 * already set. Never logs contents. Missing file is not an error (startup must
 * not fail); individual tools report missing configuration instead.
 */
export function loadDotEnv(file = resolve(PROJECT_ROOT, ".env")): void {
  if (!existsSync(file)) return;
  const parsed = parseEnv(readFileSync(file, "utf8"));
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined && value !== undefined) process.env[key] = value;
  }
}

function clean(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): MetaConfig {
  const accessToken = clean(env.META_ACCESS_TOKEN);
  registerSecret(accessToken);
  return {
    accessToken,
    adAccountId: clean(env.META_AD_ACCOUNT_ID),
    apiVersion: clean(env.META_GRAPH_API_VERSION) ?? "v26.0",
    pageId: clean(env.META_PAGE_ID),
  };
}

export function requireToken(cfg: MetaConfig): string {
  if (!cfg.accessToken) {
    throw new ConfigError(
      "META_ACCESS_TOKEN is not set. Add it to E:\\react\\campaign\\meta-mcp\\.env (see .env.example).",
    );
  }
  return cfg.accessToken;
}

export function requireAdAccountId(cfg: MetaConfig): string {
  const id = cfg.adAccountId;
  if (!id) {
    throw new ConfigError("META_AD_ACCOUNT_ID is not set. Add it to .env, e.g. META_AD_ACCOUNT_ID=act_123456789.");
  }
  if (!/^act_\d{1,32}$/.test(id)) {
    throw new ConfigError("META_AD_ACCOUNT_ID must have the form act_<digits>.");
  }
  return id;
}

export function requirePageId(cfg: MetaConfig): string {
  const id = cfg.pageId;
  if (!id) {
    throw new ConfigError(
      "META_PAGE_ID is not configured. The Foreachurl Facebook Page must first be assigned to the " +
        "'Foreach MCP' System User in Meta Business Settings; then set META_PAGE_ID in .env to the verified Page ID " +
        "and restart the MCP server.",
    );
  }
  if (!/^\d{1,32}$/.test(id)) throw new ConfigError("META_PAGE_ID must be a numeric Page ID.");
  return id;
}

export function validateApiVersion(version: string): string {
  if (!/^v\d{1,3}\.\d{1,2}$/.test(version)) {
    throw new ConfigError("META_GRAPH_API_VERSION must look like v26.0.");
  }
  return version;
}
