#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadDotEnv, readConfig } from "./config.js";
import { logError } from "./sanitize.js";
import {
  createContext,
  getCampaignInput,
  handlers,
  insightsInput,
  listAdsetsInput,
  listAdsInput,
  listCampaignsInput,
  listPagePostsInput,
  run,
  type ToolContext,
} from "./tools.js";

/** Every tool is read-only: Graph API GET requests only. */
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

export function createServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: "meta", version: "0.1.0" });

  server.registerTool(
    "meta_get_ad_account",
    {
      title: "Get Meta ad account",
      description:
        "Read the configured Meta ad account (META_AD_ACCOUNT_ID): name, status, currency, timezone, business. Read-only.",
      annotations: READ_ONLY,
    },
    () => run(() => handlers.meta_get_ad_account(ctx)),
  );

  server.registerTool(
    "meta_list_campaigns",
    {
      title: "List campaigns",
      description:
        "List campaigns of the configured ad account (one page; use paging.after to continue). An empty list is valid. Read-only.",
      inputSchema: listCampaignsInput,
      annotations: READ_ONLY,
    },
    (args) => run(() => handlers.meta_list_campaigns(ctx, args)),
  );

  server.registerTool(
    "meta_get_campaign",
    {
      title: "Get campaign",
      description: "Get details of one campaign that belongs to the configured ad account. Read-only.",
      inputSchema: getCampaignInput,
      annotations: READ_ONLY,
    },
    (args) => run(() => handlers.meta_get_campaign(ctx, args)),
  );

  server.registerTool(
    "meta_get_insights",
    {
      title: "Get insights",
      description:
        "Performance insights (impressions, reach, frequency, clicks, link clicks, spend, CPC, CPM, CTR, actions, cost per action) " +
        "for the configured ad account at account/campaign/adset/ad level. Defaults to last_30d. Metrics may be absent when there is no delivery. Read-only.",
      inputSchema: insightsInput,
      annotations: READ_ONLY,
    },
    (args) => run(() => handlers.meta_get_insights(ctx, args)),
  );

  server.registerTool(
    "meta_list_adsets",
    {
      title: "List ad sets",
      description: "List ad sets of the configured ad account, optionally for one campaign. Read-only.",
      inputSchema: listAdsetsInput,
      annotations: READ_ONLY,
    },
    (args) => run(() => handlers.meta_list_adsets(ctx, args)),
  );

  server.registerTool(
    "meta_list_ads",
    {
      title: "List ads",
      description:
        "List ads of the configured ad account, optionally filtered by campaign or ad set. Does not download creatives. Read-only.",
      inputSchema: listAdsInput,
      annotations: READ_ONLY,
    },
    (args) => run(() => handlers.meta_list_ads(ctx, args)),
  );

  server.registerTool(
    "meta_get_page",
    {
      title: "Get Facebook Page",
      description:
        "Read basic info for the configured Facebook Page (META_PAGE_ID). Returns a configuration error if the Page is not set up yet. Read-only.",
      annotations: READ_ONLY,
    },
    () => run(() => handlers.meta_get_page(ctx)),
  );

  server.registerTool(
    "meta_list_page_posts",
    {
      title: "List Facebook Page posts",
      description:
        "List posts of the configured Facebook Page (META_PAGE_ID). Read-only: no publishing, editing or deleting.",
      inputSchema: listPagePostsInput,
      annotations: READ_ONLY,
    },
    (args) => run(() => handlers.meta_list_page_posts(ctx, args)),
  );

  return server;
}

async function main(): Promise<void> {
  loadDotEnv();
  const config = readConfig();
  if (!config.accessToken) logError("META_ACCESS_TOKEN is not set; tools will return configuration errors.");
  const server = createServer(createContext(config));
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  logError(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
