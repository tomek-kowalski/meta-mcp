import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { readConfig, type MetaConfig } from "../src/config.js";
import { MetaClient } from "../src/meta-client.js";
import { clearSecrets, REDACTED, redactString, registerSecret, sanitize } from "../src/sanitize.js";
import {
  createContext,
  getCampaignInput,
  handlers,
  insightsInput,
  listCampaignsInput,
  run,
} from "../src/tools.js";

const FAKE_TOKEN = "EAAFakeTokenForUnitTests1234567890abcdef";
const baseConfig: MetaConfig = {
  accessToken: FAKE_TOKEN,
  adAccountId: "act_111",
  apiVersion: "v26.0",
  pageId: undefined,
};

interface Call {
  url: string;
  init: RequestInit;
}

function mockFetch(responder: (url: string) => { status?: number; body: string }) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    const r = responder(url);
    return new Response(r.body, { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { impl, calls };
}

const text = (r: { content: { text: string }[] }) => r.content[0].text;

beforeEach(() => {
  clearSecrets();
  registerSecret(FAKE_TOKEN);
});

test("missing token: tools return a configuration error, no request made", async () => {
  const { impl, calls } = mockFetch(() => ({ body: "{}" }));
  const ctx = createContext({ ...baseConfig, accessToken: undefined }, impl);
  const res = await run(() => handlers.meta_get_ad_account(ctx));
  assert.equal(res.isError, true);
  assert.match(text(res), /ConfigurationError/);
  assert.match(text(res), /META_ACCESS_TOKEN is not set/);
  assert.equal(calls.length, 0);
});

test("readConfig treats blank token as missing", () => {
  const cfg = readConfig({ META_ACCESS_TOKEN: "   ", META_AD_ACCOUNT_ID: "act_1" });
  assert.equal(cfg.accessToken, undefined);
  assert.equal(cfg.apiVersion, "v26.0");
});

test("token redaction: raw token, access_token= params, Bearer headers, secret keys", () => {
  assert.equal(redactString(`x ${FAKE_TOKEN} y`), `x ${REDACTED} y`);
  assert.equal(
    redactString("https://graph.facebook.com/v26.0/1/posts?access_token=OTHERSECRET&after=abc"),
    `https://graph.facebook.com/v26.0/1/posts?access_token=${REDACTED}&after=abc`,
  );
  assert.equal(redactString("access_token%3DABC123"), `access_token%3D${REDACTED}`);
  assert.equal(redactString("Authorization: Bearer abc.def"), `Authorization: Bearer ${REDACTED}`);
  const out = sanitize({ access_token: "zzz", nested: [{ note: FAKE_TOKEN }], paging: { next: `u?access_token=${FAKE_TOKEN}` } });
  assert.equal(out.access_token, REDACTED);
  assert.equal(out.nested[0].note, REDACTED);
  assert.ok(!JSON.stringify(out).includes(FAKE_TOKEN));
});

test("token goes in Authorization header, never in the URL; only GET is used", async () => {
  const { impl, calls } = mockFetch(() => ({ body: JSON.stringify({ id: "act_111", name: "Acc" }) }));
  const ctx = createContext(baseConfig, impl);
  const res = await run(() => handlers.meta_get_ad_account(ctx));
  assert.equal(res.isError, undefined);
  assert.equal(calls.length, 1);
  assert.ok(!calls[0].url.includes(FAKE_TOKEN));
  assert.ok(!calls[0].url.includes("access_token"));
  assert.equal(calls[0].init.method, "GET");
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, `Bearer ${FAKE_TOKEN}`);
  assert.ok(calls[0].url.startsWith("https://graph.facebook.com/v26.0/act_111?"));
});

test("invalid campaign ID is rejected by the input schema", () => {
  const schema = z.object(getCampaignInput);
  for (const bad of ["abc", "123; DROP", "../me", "act_123", "", "1".repeat(40)]) {
    assert.equal(schema.safeParse({ campaign_id: bad }).success, false, bad);
  }
  assert.equal(schema.safeParse({ campaign_id: "120200000000000001" }).success, true);
});

test("invalid limit is rejected by the input schema", () => {
  const schema = z.object(listCampaignsInput);
  for (const bad of [0, -1, 101, 1.5, "10"]) {
    assert.equal(schema.safeParse({ limit: bad }).success, false, String(bad));
  }
  assert.equal(schema.safeParse({ limit: 100 }).success, true);
  assert.equal(schema.safeParse({}).success, true);
});

test("insights input: date presets, levels and date ranges are validated", () => {
  const schema = z.object(insightsInput);
  assert.equal(schema.safeParse({ date_preset: "last_7d", level: "campaign" }).success, true);
  assert.equal(schema.safeParse({ date_preset: "last_1000d" }).success, false);
  assert.equal(schema.safeParse({ level: "business" }).success, false);
  assert.equal(schema.safeParse({ time_range: { since: "2026-01-01", until: "2026-01-31" } }).success, true);
  assert.equal(schema.safeParse({ time_range: { since: "2026-02-01", until: "2026-01-01" } }).success, false);
  assert.equal(schema.safeParse({ time_range: { since: "2026-02-30", until: "2026-03-01" } }).success, false);
  assert.equal(schema.safeParse({ time_range: { since: "2026/01/01", until: "2026-01-02" } }).success, false);
});

test("insights default to last_30d and reject preset+range together", async () => {
  const { impl, calls } = mockFetch(() => ({ body: JSON.stringify({ data: [] }) }));
  const ctx = createContext(baseConfig, impl);
  const res = await run(() => handlers.meta_get_insights(ctx, {}));
  assert.equal(res.isError, undefined);
  const u = new URL(calls[0].url);
  assert.equal(u.pathname, "/v26.0/act_111/insights");
  assert.equal(u.searchParams.get("date_preset"), "last_30d");
  assert.equal(u.searchParams.get("level"), "account");

  const both = await run(() =>
    handlers.meta_get_insights(ctx, { date_preset: "last_7d", time_range: { since: "2026-01-01", until: "2026-01-02" } }),
  );
  assert.equal(both.isError, true);
});

test("Meta error responses are surfaced but sanitized", async () => {
  const { impl } = mockFetch(() => ({
    status: 400,
    body: JSON.stringify({
      error: {
        message: `Invalid OAuth access token - Cannot parse access token ${FAKE_TOKEN}; url ?access_token=LEAKED123`,
        type: "OAuthException",
        code: 190,
        fbtrace_id: "Atrace",
      },
    }),
  }));
  const ctx = createContext(baseConfig, impl);
  const res = await run(() => handlers.meta_get_ad_account(ctx));
  assert.equal(res.isError, true);
  const body = JSON.parse(text(res));
  assert.equal(body.code, 190);
  assert.equal(body.type, "OAuthException");
  assert.equal(body.http_status, 400);
  assert.ok(!text(res).includes(FAKE_TOKEN));
  assert.ok(!text(res).includes("LEAKED123"));
});

test("invalid JSON and network failures produce clean errors", async () => {
  const bad = createContext(baseConfig, mockFetch(() => ({ status: 502, body: "<html>Bad gateway</html>" })).impl);
  const r1 = await run(() => handlers.meta_get_ad_account(bad));
  assert.equal(r1.isError, true);
  assert.match(text(r1), /invalid JSON/);

  const net = createContext(baseConfig, (async () => {
    throw new TypeError(`fetch failed for token ${FAKE_TOKEN}`);
  }) as typeof fetch);
  const r2 = await run(() => handlers.meta_get_ad_account(net));
  assert.equal(r2.isError, true);
  assert.ok(!text(r2).includes(FAKE_TOKEN));
});

test("pagination: returns cursors only, never raw paging URLs; empty list is success", async () => {
  const { impl, calls } = mockFetch(() => ({
    body: JSON.stringify({
      data: [],
      paging: {
        cursors: { before: "QVFIb", after: "QVFIa" },
        next: `https://graph.facebook.com/v26.0/act_111/campaigns?access_token=${FAKE_TOKEN}&after=QVFIa`,
      },
    }),
  }));
  const ctx = createContext(baseConfig, impl);
  const res = await run(() => handlers.meta_list_campaigns(ctx, { limit: 5 }));
  assert.equal(res.isError, undefined);
  const body = JSON.parse(text(res));
  assert.deepEqual(body.data, []);
  assert.deepEqual(body.paging, { after: "QVFIa", before: "QVFIb", has_next_page: true });
  assert.ok(!text(res).includes("graph.facebook.com"));
  assert.equal(new URL(calls[0].url).searchParams.get("limit"), "5");
});

test("page tools return a configuration error when META_PAGE_ID is absent", async () => {
  const { impl, calls } = mockFetch(() => ({ body: "{}" }));
  const ctx = createContext(baseConfig, impl);
  for (const r of [
    await run(() => handlers.meta_get_page(ctx)),
    await run(() => handlers.meta_list_page_posts(ctx, {})),
  ]) {
    assert.equal(r.isError, true);
    assert.match(text(r), /META_PAGE_ID is not configured/);
    assert.match(text(r), /Foreach MCP/);
  }
  assert.equal(calls.length, 0);
});

test("campaign from another ad account is refused", async () => {
  const { impl } = mockFetch(() => ({ body: JSON.stringify({ id: "5", account_id: "999" }) }));
  const ctx = createContext(baseConfig, impl);
  const res = await run(() => handlers.meta_get_campaign(ctx, { campaign_id: "5" }));
  assert.equal(res.isError, true);
  assert.match(text(res), /does not belong/);
});

test("client refuses arbitrary paths and credential query params", () => {
  const client = new MetaClient({ token: FAKE_TOKEN, apiVersion: "v26.0" });
  assert.throws(() => client.buildUrl("https://evil.example/x"));
  assert.throws(() => client.buildUrl("act_1/../../me"));
  assert.throws(() => client.buildUrl("123/posts/extra"));
  assert.throws(() => client.buildUrl("act_1", { access_token: "x" }));
  assert.throws(() => client.buildUrl("act_1", { method: "POST" }));
  assert.throws(() => new MetaClient({ token: FAKE_TOKEN, apiVersion: "v26.0/../x" }));
});

test("MetaClient's only write method is postPageFeed", () => {
  const writes = Object.getOwnPropertyNames(MetaClient.prototype).filter((m) => /post|put|delete|patch|create|update|send|publish/i.test(m));
  assert.deepEqual(writes, ["postPageFeed"]);
});
