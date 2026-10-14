/**
 * Read-only smoke test against the real Meta Graph API.
 *
 * 1. Launches the built MCP server over stdio (exactly as Claude Code does) and calls
 *    tools through the MCP protocol.
 * 2. Runs read-only Page discovery (GET only) to see whether a Page is reachable.
 *
 * Never prints credentials: all output is passed through the sanitizer, and the run
 * fails if the token appears anywhere in the collected output.
 */
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadDotEnv, PROJECT_ROOT, readConfig, requireToken } from "../src/config.js";
import { MetaApiError, MetaClient } from "../src/meta-client.js";
import { redactString } from "../src/sanitize.js";

const out: string[] = [];
const log = (s: string) => {
  const safe = redactString(s);
  out.push(safe);
  console.log(safe);
};
let failed = false;

loadDotEnv();
const config = readConfig();
const token = requireToken(config);

// --- 1. Through MCP over stdio ------------------------------------------------
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(PROJECT_ROOT, "dist", "src", "index.js")],
  cwd: PROJECT_ROOT,
  // Do not pass secrets via env: the server must load its own .env.
  env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "" },
  stderr: "pipe",
});
transport.stderr?.on("data", (d) => log(`[server stderr] ${String(d).trim()}`));
const client = new Client({ name: "meta-mcp-smoke", version: "0.1.0" });
await client.connect(transport);

const { tools } = await client.listTools();
log(`tools: ${tools.map((t) => t.name).join(", ")}`);
const notReadOnly = tools.filter((t) => t.annotations?.readOnlyHint !== true);
if (notReadOnly.length) {
  failed = true;
  log(`FAIL: tools without readOnlyHint: ${notReadOnly.map((t) => t.name).join(", ")}`);
}

async function call(name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  const text = res.content?.[0]?.text ?? "";
  log(`\n=== ${name} ${JSON.stringify(args)} ${res.isError ? "(isError)" : ""}\n${text}`);
  return { text, isError: !!res.isError, json: (() => { try { return JSON.parse(text); } catch { return undefined; } })() };
}

// The expected account comes from the local .env (META_AD_ACCOUNT_ID), never from the source.
const expectedAccountId = config.adAccountId;
const acct = await call("meta_get_ad_account");
if (acct.isError || !expectedAccountId || acct.json?.id !== expectedAccountId || typeof acct.json?.name !== "string") {
  failed = true;
  log("FAIL: meta_get_ad_account did not return the ad account configured in META_AD_ACCOUNT_ID");
}
const camps = await call("meta_list_campaigns", { limit: 10 });
if (camps.isError || !Array.isArray(camps.json?.data)) {
  failed = true;
  log("FAIL: meta_list_campaigns");
}
await call("meta_list_adsets", { limit: 5 });
await call("meta_list_ads", { limit: 5 });
await call("meta_get_insights", { level: "campaign" });
await call("meta_get_page");
const badId = await call("meta_get_campaign", { campaign_id: "not-a-number" });
if (!badId.isError) {
  failed = true;
  log("FAIL: invalid campaign_id accepted");
}
await client.close();

// --- 2. Read-only Page discovery -------------------------------------------------
log("\n=== Page discovery (GET only)");
const meta = new MetaClient({ token, apiVersion: config.apiVersion });
async function probe(label: string, fn: () => Promise<unknown>) {
  try {
    log(`${label}: ${JSON.stringify(await fn())}`);
  } catch (e) {
    log(`${label}: ERROR ${e instanceof MetaApiError ? JSON.stringify(e.toJSON()) : String(e)}`);
  }
}
await probe("GET /me", () => meta.get("me", { fields: "id,name" }));
await probe("GET /me/accounts", () => meta.list("me/accounts", { fields: "id,name,category,tasks", limit: 25 }));
await probe("GET /me/assigned_pages", () => meta.list("me/assigned_pages", { fields: "id,name", limit: 25 }));
await probe("GET /me/permissions", () => meta.list("me/permissions", { limit: 50 }));
const business = acct.json?.business as { id?: string } | undefined;
if (business?.id && /^\d+$/.test(business.id)) {
  await probe(`GET /<business>/owned_pages`, () => meta.list(`${business.id}/owned_pages`, { fields: "id,name", limit: 25 }));
  await probe(`GET /<business>/client_pages`, () => meta.list(`${business.id}/client_pages`, { fields: "id,name", limit: 25 }));
}

// --- Leak check ---------------------------------------------------------------
if (out.join("\n").includes(token)) {
  failed = true;
  console.log("FAIL: token appeared in output");
}
console.log(failed ? "\nSMOKE: FAILED" : "\nSMOKE: OK (token not present in any output)");
process.exit(failed ? 1 : 0);
