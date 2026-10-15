# meta-mcp

A local [MCP](https://modelcontextprotocol.io) server that gives Claude Code **read-only** access to the
ForeachURL Meta Business assets (the configured ad account and Facebook Page) through the Meta Graph / Marketing API,
plus an approval-gated content workflow that publishes News articles to the website and their posts to the Page
(see [Content workflow](#content-workflow-txt-intake-approval-publishing)).

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

The `content_*` tools are described under [Content workflow](#content-workflow-txt-intake-approval-publishing).

Pagination happens one page at a time. A response includes `paging.after` and `paging.has_next_page`. To get the
next page, pass `after` back. Raw `paging.next` URLs are never returned.

## Security model

- The `meta_*` tools are read-only and carry the `readOnlyHint` annotation. The Graph client (`src/meta-client.ts`)
  has exactly one write: `postPageFeed`, a text/link post on `<numeric page id>/feed` with the Page token. Any other
  write path is refused in code. Only `content_publish_facebook` uses it, and only for an approved draft.
- No tool accepts an arbitrary endpoint. Request paths are fixed in code and limited to
  `act_<id>`, `<numeric id>` or `me`, optionally followed by one edge. The `access_token`, `method` and `batch`
  query parameters are rejected.
- All inputs are validated with schemas: numeric IDs, `limit` from 1 to 100, known date presets and levels, and
  real calendar dates with `since ≤ until`.
- The token is sent in the `Authorization` header and never appears in a URL. All responses and errors go through
  `src/sanitize.ts`, which redacts the token, any derived Page token, `access_token=` values, `Bearer` values and
  `access_token` keys. Nothing logs `process.env`. Logs go to stderr only, because stdout carries the MCP protocol.
- `.env` and `token.txt` are git-ignored.

The System User token has write scopes (e.g. `ads_management`, `pages_manage_posts`). The server uses only
`pages_manage_posts`, through the single Page feed write above; it never uses `ads_management`.

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

## Website link registry

`src/knowledge/` crawls the website (robots.txt respected, ≥2 s between requests, installed Chrome via
`playwright-core`, other-origin requests blocked) and keeps a registry of its published URLs. The registry lives in a
separate, private repository. Content is checked against it before publishing: the page exists, it's in the
content's language, the #anchor exists, the URL isn't an alias. **No content lives in this repository.**
Configuration comes from `.env` (see `.env.example`):

- `KNOWLEDGE_DIR`: the registry repository. It's refused if it resolves inside this repository, the website
  repository (`PORTFOLIO_DIR`) or the editorial store (`PUBLISHER_CONTENT_DIR`), symlinks included.
- `KNOWLEDGE_SITE_ORIGIN`: the website to crawl.

```sh
npm run knowledge -- status
npm run knowledge -- refresh [--dry-run] [--limit N] [--commit]
```

`refresh` writes only `evidence/` in that repository. A failed or partial crawl never removes a URL, and `--commit`
makes a local commit (never a push).

## Publisher: article drafts and checks

`src/publisher/` reads article drafts from the private editorial store (`PUBLISHER_CONTENT_DIR`). Each draft is one
article in Polish, English and German plus its Facebook post, stored under `drafts/<name>/`. The publisher checks it
before it's shown for approval. **No content lives in this repository.** Publishing is in `src/content/` (below).

```sh
npm run publisher -- list
npm run publisher -- check <name>   # writes <name>/check.json; exit 1 when there are errors
```

The checks are a heuristic safety net, not proof; the owner's approval of the preview decides.

- **Errors** block publishing:
  - secrets, including inside code;
  - terms from the editorial never-publish list (`anonymization.json`);
  - brand spelling;
  - a missing language, or code that differs between languages;
  - links to unpublished, alias or wrong-language pages, or invalid anchors;
  - Base.com in a Facebook post;
  - a slug that's already taken.
  - for drafts made from a TXT source: a number in the text that isn't in `source.txt`;
  - a Facebook post with more than one language, or not in the language chosen at ingest.
- **Warnings** go to the owner: numbers (when there's no source), client wording, structure differences, post length
  and hashtags.

## Content workflow: TXT intake, approval, publishing

`src/content/` turns a `.txt` file the owner drops into the editorial inbox into an article and a Facebook post, and
publishes them only after the owner approves the exact content. The CLI and the MCP tools share one service.

```
<editorial>/
  inbox/                 .txt source files waiting to be ingested
  drafts/<name>/         source.txt (moved here unchanged), meta.json, article.{pl,en,de}.md,
                         facebook.<lang>.txt, case.md, check.json, state.json
  rejected/<name>/       rejected drafts, with their source
  logs/publications.jsonl  append-only log: names, hashes, languages, URLs, post ids, errors (never source text)
```

`<name>` is the file name without `.txt` (lowercase, hyphens). Lifecycle (`state.json`):

```
VALIDATED → DRAFT → REVIEW → APPROVED → WEBSITE_PUBLISHED → FACEBOOK_PUBLISHED
plus REJECTED, FAILED, PARTIALLY_PUBLISHED (article live, Facebook post not yet)
```

```sh
npm run content -- list
npm run content -- ingest <file> [--lang pl|en|de] [--facebook-lang pl|en|de] [--channels website,facebook]
npm run content:ingest -- --file <file> ...        # same as ingest
npm run content -- status <file>
npm run content -- check <file>
npm run content -- submit <file>                    # prints exactly what would be published
npm run content -- approve <file>                   # owner only: interactive terminal, type the code shown
npm run content -- reject <file> --reason "..."
npm run content -- publish <file> --channel website|facebook [--dry-run]
```

- `--lang` is the language of the source and first draft (default: the file's `LANGUAGE:` header, else `pl`). The
  website always gets the article in `pl`, `en` and `de`.
- `--facebook-lang` is the one language of the Facebook post (default `pl`). The post links the article in that
  same language, which must be live when it's posted.

MCP tools: `content_list`, `content_ingest` (`lang`, `facebook_lang`, `channels`), `content_get_draft`,
`content_save_draft`, `content_check`, `content_submit`, `content_publish_website`, `content_publish_facebook`
(both `dry_run`, default `true`).

Safety rules:

- A source file is untrusted data: it must be a regular UTF-8 `.txt` file directly in the inbox (no links, no
  traversal), at most 200 KB. It is never executed and can't change the rules.
- **There is no approve tool.** The approval is a code typed in the owner's terminal, tied to a hash of the exact
  content, the Facebook language, the channels and the Page. Any edit voids it; the checks run again before
  approving and before each publish.
- Website first: a detached worktree of the website repository's `origin/main` gets the `articles.json` entry and
  the three bodies, the site's unit checks run, one commit is pushed fast-forward to `main`, and the step waits
  until every language URL is live. A rerun never commits the same content again.
- Facebook second, only once the article is live: the post's state is saved as pending before posting; an
  unconfirmed post is looked up on the Page before any retry, so it isn't posted twice. A failure leaves the website
  published (`PARTIALLY_PUBLISHED`) and can be retried.
- List `content_publish_website` and `content_publish_facebook` under `permissions.ask` in Claude Code, so every
  call asks first.
