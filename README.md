# meta-mcp

A local, **read-only** [MCP](https://modelcontextprotocol.io) server that gives Claude Code access to the
ForeachURL Meta Business assets (the configured ad account and Facebook Page)
through the Meta Graph / Marketing API.

- Runtime: Node.js ≥ 20.12, TypeScript, `@modelcontextprotocol/sdk` (stdio transport)
- Graph API: `https://graph.facebook.com/v26.0`
- No HTTP server; Claude Code launches it as a child process.

## Installation and build

```sh
cd E:\react\campaign\meta-mcp
npm install
cp .env.example .env     # then fill in values locally; never commit .env
npm run build            # outputs dist/
```

## Environment variables

Read from `E:\react\campaign\meta-mcp\.env`. The server finds this file from its own location, so it works whatever
directory Claude Code is started from. Variables already set in the process environment take precedence.

| Variable                 | Required | Description                                                         |
| ------------------------ | -------- | ------------------------------------------------------------------- |
| `META_ACCESS_TOKEN`      | yes      | System User access token ("Foreach MCP"). Secret.                   |
| `META_AD_ACCOUNT_ID`     | yes      | Ad account, in the form `act_<digits>`.                             |
| `META_GRAPH_API_VERSION` | no       | Defaults to `v26.0`.                                                |
| `META_PAGE_ID`           | no       | Facebook Page ID. Leave unset until it is verified (see below).    |

If a variable is missing, the server still starts and the affected tools return a clear configuration error.

## Tools

| Tool                   | Description                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| `meta_get_ad_account`  | The configured ad account: name, status, currency, timezone, business.                           |
| `meta_list_campaigns`  | Campaigns (`limit` 1–100, `after` cursor). An empty list is a valid result.                       |
| `meta_get_campaign`    | One campaign by numeric `campaign_id`. It must belong to the configured account.                  |
| `meta_get_insights`    | Metrics at `level` account/campaign/adset/ad, with `date_preset` **or** `time_range` (default `last_30d`), plus optional `time_increment` and `campaign_id`. |
| `meta_list_adsets`     | Ad sets, optionally filtered by `campaign_id`.                                                   |
| `meta_list_ads`        | Ads, optionally filtered by `campaign_id` / `adset_id`. Creatives are not downloaded.            |
| `meta_get_page`        | Basic info for `META_PAGE_ID`.                                                                   |
| `meta_list_page_posts` | Posts of `META_PAGE_ID` (read only).                                                             |

Pagination happens one page at a time. A response includes `paging.after` and `paging.has_next_page`. To get the
next page, pass `after` back. Raw `paging.next` URLs are never returned.

## Read-only security model

- The Graph client (`src/meta-client.ts`) only has GET methods. There is no code path for POST, PUT or DELETE,
  and every tool carries the `readOnlyHint` annotation.
- No tool accepts an arbitrary endpoint. Request paths are fixed in code and limited to
  `act_<id>`, `<numeric id>` or `me`, optionally followed by one edge. The `access_token`, `method` and `batch`
  query parameters are rejected.
- All inputs are validated with schemas: numeric IDs, `limit` from 1 to 100, known date presets and levels, and
  real calendar dates with `since ≤ until`.
- The token is sent in the `Authorization` header and never appears in a URL. All responses and errors go through
  `src/sanitize.ts`, which redacts the token, any derived Page token, `access_token=` values, `Bearer` values and
  `access_token` keys. Nothing logs `process.env`. Logs go to stderr only, because stdout carries the MCP protocol.
- `.env` and `token.txt` are git-ignored.

The System User token currently has write scopes (e.g. `ads_management`, `pages_manage_posts`). This server does not use
them. A token with only read scopes (`ads_read`, `read_insights`, `pages_read_engagement`, `pages_show_list`)
would add another layer of protection.

## Tests

```sh
npm test         # unit tests with a mocked fetch and a fake token, no network
npm run smoke    # real READ-ONLY calls: launches the server over stdio, calls the tools, probes Page access
```

The smoke test fails if the access token appears anywhere in its output.

## Claude Code registration

The server is registered at user scope, so it is available in every project, including
`E:\react\campaign\facebook` and `E:\react\campaign\portfolio`:

```sh
claude mcp add --scope user --transport stdio meta -- node "E:/react/campaign/meta-mcp/dist/src/index.js"
claude mcp get meta      # should show: ✔ Connected
```

The Claude configuration contains no secrets, because the server loads its own `.env`. Run `npm run build`
after changing the source.

## Testing connectivity

From any directory, in Claude Code: *"Call meta_get_ad_account"*. The expected result is the ad account set in
`META_AD_ACCOUNT_ID` (the smoke test checks the ID against `.env`). `meta_list_campaigns` returns `data: []` while the
account has no campaigns.

## Enabling Facebook Page support

1. In Meta Business Settings (Foreachurl), make sure the Foreachurl Page is in the business portfolio.
2. Assign the Page to the **Foreach MCP** System User (Users → System users → Assign assets → Pages), with at
   least read/content permissions.
3. Run `npm run smoke`. The *Page discovery* section should list the Page under `/me/accounts`.
4. Put that verified ID into `.env` as `META_PAGE_ID=<id>` and restart Claude Code. Never guess the ID.

`meta_list_page_posts` gets a Page access token in memory through a GET request when needed. That token is never
returned or logged.
