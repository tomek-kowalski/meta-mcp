import { z } from "zod";
import {
  ConfigError,
  type MetaConfig,
  requireAdAccountId,
  requirePageId,
  requireToken,
} from "./config.js";
import { MetaApiError, MetaClient, type Query } from "./meta-client.js";
import { sanitize } from "./sanitize.js";

// ---------------------------------------------------------------------------
// Shared input schemas
// ---------------------------------------------------------------------------

export const numericId = (label: string) =>
  z.string().regex(/^\d{1,32}$/, `${label} must be a numeric Meta object ID (digits only)`);

export const limitSchema = z
  .number()
  .int("limit must be an integer")
  .min(1, "limit must be at least 1")
  .max(100, "limit must be at most 100")
  .optional()
  .describe("Records per page (1-100, default 25).");

export const afterSchema = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[A-Za-z0-9_\-=+/%.]+$/, "after must be a pagination cursor returned by a previous call")
  .optional()
  .describe("Pagination cursor: pass paging.after from a previous response to get the next page.");

export const DATE_PRESETS = [
  "today",
  "yesterday",
  "this_week_mon_today",
  "this_week_sun_today",
  "last_week_mon_sun",
  "last_week_sun_sat",
  "last_3d",
  "last_7d",
  "last_14d",
  "last_28d",
  "last_30d",
  "last_90d",
  "this_month",
  "last_month",
  "this_quarter",
  "last_quarter",
  "this_year",
  "last_year",
  "maximum",
] as const;

export const LEVELS = ["account", "campaign", "adset", "ad"] as const;

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "dates must be YYYY-MM-DD")
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, "not a valid calendar date");

export const timeRangeSchema = z
  .object({ since: isoDate, until: isoDate })
  .strict()
  .refine((r) => r.since <= r.until, "time_range.since must be on or before time_range.until")
  .describe("Custom date range (inclusive), in the ad account's timezone.");

export const DEFAULT_LIMIT = 25;
export const DEFAULT_DATE_PRESET = "last_30d";

// ---------------------------------------------------------------------------
// Field lists
// ---------------------------------------------------------------------------

const AD_ACCOUNT_FIELDS =
  "id,account_id,name,account_status,currency,timezone_name,timezone_offset_hours_utc,business,amount_spent,spend_cap,disable_reason,created_time";
const CAMPAIGN_LIST_FIELDS = "id,name,status,effective_status,objective,created_time,updated_time";
const CAMPAIGN_DETAIL_FIELDS =
  "id,account_id,name,status,configured_status,effective_status,objective,buying_type,bid_strategy," +
  "daily_budget,lifetime_budget,budget_remaining,spend_cap,special_ad_categories,start_time,stop_time," +
  "created_time,updated_time";
const ADSET_FIELDS =
  "id,name,campaign_id,status,effective_status,daily_budget,lifetime_budget,optimization_goal,billing_event," +
  "start_time,end_time,created_time,updated_time";
const AD_FIELDS = "id,name,adset_id,campaign_id,status,effective_status,created_time,updated_time";
const PAGE_FIELDS = "id,name,username,link,category,about,website,fan_count,followers_count";
const PAGE_POST_FIELDS = "id,message,story,created_time,updated_time,permalink_url,status_type";

const INSIGHT_METRICS = [
  "impressions",
  "reach",
  "frequency",
  "clicks",
  "inline_link_clicks",
  "spend",
  "cpc",
  "cpm",
  "ctr",
  "actions",
  "cost_per_action_type",
];

export function insightFields(level: (typeof LEVELS)[number]): string {
  const dims = ["account_currency", "date_start", "date_stop"];
  if (level === "campaign" || level === "adset" || level === "ad") dims.push("campaign_id", "campaign_name");
  if (level === "adset" || level === "ad") dims.push("adset_id", "adset_name");
  if (level === "ad") dims.push("ad_id", "ad_name");
  return [...dims, ...INSIGHT_METRICS].join(",");
}

// ---------------------------------------------------------------------------
// Tool context
// ---------------------------------------------------------------------------

export interface ToolContext {
  config: MetaConfig;
  /** Lazily creates the client so a missing token surfaces as a tool error, not a startup crash. */
  client(): MetaClient;
}

export function createContext(config: MetaConfig, fetchImpl?: typeof fetch): ToolContext {
  let cached: MetaClient | undefined;
  return {
    config,
    client() {
      if (!cached) {
        cached = new MetaClient({ token: requireToken(config), apiVersion: config.apiVersion, fetchImpl });
      }
      return cached;
    },
  };
}

function filterParam(field: string, value: string): string {
  return JSON.stringify([{ field, operator: "EQUAL", value }]);
}

async function assertCampaignInAccount(ctx: ToolContext, campaignId: string): Promise<Record<string, unknown>> {
  const accountId = requireAdAccountId(ctx.config);
  const campaign = await ctx.client().get(campaignId, { fields: CAMPAIGN_DETAIL_FIELDS });
  if (String(campaign.account_id ?? "") !== accountId.replace(/^act_/, "")) {
    throw new ConfigError(`Campaign ${campaignId} does not belong to the configured ad account ${accountId}.`);
  }
  return campaign;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const listCampaignsInput = { limit: limitSchema, after: afterSchema };
export const getCampaignInput = { campaign_id: numericId("campaign_id").describe("Numeric campaign ID.") };
export const listAdsetsInput = {
  limit: limitSchema,
  after: afterSchema,
  campaign_id: numericId("campaign_id").optional().describe("Only ad sets of this campaign."),
};
export const listAdsInput = {
  limit: limitSchema,
  after: afterSchema,
  campaign_id: numericId("campaign_id").optional().describe("Only ads of this campaign."),
  adset_id: numericId("adset_id").optional().describe("Only ads of this ad set."),
};
export const insightsInput = {
  level: z.enum(LEVELS).optional().describe("Aggregation level (default: account)."),
  date_preset: z
    .enum(DATE_PRESETS)
    .optional()
    .describe(`Relative period. Defaults to ${DEFAULT_DATE_PRESET} when neither date_preset nor time_range is given.`),
  time_range: timeRangeSchema.optional(),
  time_increment: z
    .union([z.enum(["monthly", "all_days"]), z.number().int().min(1).max(90)])
    .optional()
    .describe("Split results by N days (1-90), 'monthly', or 'all_days' (default)."),
  campaign_id: numericId("campaign_id").optional().describe("Restrict insights to one campaign of the ad account."),
  limit: limitSchema,
  after: afterSchema,
};
export const listPagePostsInput = { limit: limitSchema, after: afterSchema };

type Args<S extends z.ZodRawShape> = z.infer<z.ZodObject<S>>;

export const handlers = {
  async meta_get_ad_account(ctx: ToolContext) {
    const accountId = requireAdAccountId(ctx.config);
    return ctx.client().get(accountId, { fields: AD_ACCOUNT_FIELDS });
  },

  async meta_list_campaigns(ctx: ToolContext, args: Args<typeof listCampaignsInput>) {
    const accountId = requireAdAccountId(ctx.config);
    return ctx.client().list(`${accountId}/campaigns`, {
      fields: CAMPAIGN_LIST_FIELDS,
      limit: args.limit ?? DEFAULT_LIMIT,
      after: args.after,
    });
  },

  async meta_get_campaign(ctx: ToolContext, args: Args<typeof getCampaignInput>) {
    return assertCampaignInAccount(ctx, args.campaign_id);
  },

  async meta_list_adsets(ctx: ToolContext, args: Args<typeof listAdsetsInput>) {
    const accountId = requireAdAccountId(ctx.config);
    return ctx.client().list(`${accountId}/adsets`, {
      fields: ADSET_FIELDS,
      limit: args.limit ?? DEFAULT_LIMIT,
      after: args.after,
      filtering: args.campaign_id ? filterParam("campaign.id", args.campaign_id) : undefined,
    });
  },

  async meta_list_ads(ctx: ToolContext, args: Args<typeof listAdsInput>) {
    const accountId = requireAdAccountId(ctx.config);
    const filters: { field: string; operator: string; value: string }[] = [];
    if (args.campaign_id) filters.push({ field: "campaign.id", operator: "EQUAL", value: args.campaign_id });
    if (args.adset_id) filters.push({ field: "adset.id", operator: "EQUAL", value: args.adset_id });
    return ctx.client().list(`${accountId}/ads`, {
      fields: AD_FIELDS,
      limit: args.limit ?? DEFAULT_LIMIT,
      after: args.after,
      filtering: filters.length ? JSON.stringify(filters) : undefined,
    });
  },

  async meta_get_insights(ctx: ToolContext, args: Args<typeof insightsInput>) {
    const accountId = requireAdAccountId(ctx.config);
    if (args.date_preset && args.time_range) {
      throw new ConfigError("Provide either date_preset or time_range, not both.");
    }
    const level = args.level ?? "account";
    let path = `${accountId}/insights`;
    if (args.campaign_id) {
      if (level === "account") throw new ConfigError("level 'account' cannot be combined with campaign_id.");
      await assertCampaignInAccount(ctx, args.campaign_id);
      path = `${args.campaign_id}/insights`;
    }
    const query: Query = {
      level,
      fields: insightFields(level),
      limit: args.limit ?? DEFAULT_LIMIT,
      after: args.after,
      time_increment: args.time_increment,
    };
    if (args.time_range) query.time_range = JSON.stringify(args.time_range);
    else query.date_preset = args.date_preset ?? DEFAULT_DATE_PRESET;
    const result = await ctx.client().list(path, query);
    return {
      level,
      period: args.time_range ?? { date_preset: query.date_preset },
      note: result.data.length === 0 ? "No delivery data for this period (an empty result is normal for inactive accounts)." : undefined,
      ...result,
    };
  },

  async meta_get_page(ctx: ToolContext) {
    const pageId = requirePageId(ctx.config);
    return ctx.client().get(pageId, { fields: PAGE_FIELDS });
  },

  async meta_list_page_posts(ctx: ToolContext, args: Args<typeof listPagePostsInput>) {
    const pageId = requirePageId(ctx.config);
    const query: Query = { fields: PAGE_POST_FIELDS, limit: args.limit ?? DEFAULT_LIMIT, after: args.after };
    try {
      return await ctx.client().list(`${pageId}/posts`, query);
    } catch (err) {
      if (!(err instanceof MetaApiError)) throw err;
      // Reading Page posts usually requires a Page access token. Derive it with a GET
      // (never returned to the client; registered for redaction) and retry once.
      const pageToken = await getPageToken(ctx, pageId);
      return ctx.client().list(`${pageId}/posts`, query, pageToken);
    }
  },
};

const pageTokenCache = new Map<string, string>();

async function getPageToken(ctx: ToolContext, pageId: string): Promise<string> {
  const cached = pageTokenCache.get(pageId);
  if (cached) return cached;
  const token = await ctx.client().getPageAccessToken(pageId);
  pageTokenCache.set(pageId, token);
  return token;
}

// ---------------------------------------------------------------------------
// Result formatting
// ---------------------------------------------------------------------------

export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(sanitize(data), null, 2) }] };
}

export function fail(err: unknown): ToolResult {
  let payload: unknown;
  if (err instanceof MetaApiError) payload = err.toJSON();
  else if (err instanceof ConfigError) payload = { error: "ConfigurationError", message: err.message };
  else payload = { error: "Error", message: err instanceof Error ? err.message : String(err) };
  return { content: [{ type: "text", text: JSON.stringify(sanitize(payload), null, 2) }], isError: true };
}

export async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    return fail(err);
  }
}
