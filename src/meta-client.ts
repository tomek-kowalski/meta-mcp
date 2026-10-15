import { redactString, registerSecret, sanitize } from "./sanitize.js";
import { validateApiVersion } from "./config.js";

/**
 * Minimal, GET-only Meta Graph API client.
 *
 * - The access token is sent in the Authorization header, never in the URL.
 * - There is deliberately no method for POST/PUT/DELETE.
 * - Paths are restricted to simple node/edge segments; callers are the
 *   individual MCP tools, never arbitrary user input.
 */

export type QueryValue = string | number | boolean | undefined;
export type Query = Record<string, QueryValue>;

export class MetaApiError extends Error {
  readonly status?: number;
  readonly code?: number;
  readonly subcode?: number;
  readonly type?: string;
  readonly fbtraceId?: string;
  /** The request may not have reached Meta, or its answer was lost: for a write, the outcome is unknown. */
  readonly network?: boolean;

  constructor(
    message: string,
    details: { status?: number; code?: number; subcode?: number; type?: string; fbtraceId?: string; network?: boolean } = {},
  ) {
    super(redactString(message));
    this.name = "MetaApiError";
    Object.assign(this, details);
  }

  toJSON() {
    return sanitize({
      error: "MetaApiError",
      message: this.message,
      http_status: this.status,
      code: this.code,
      error_subcode: this.subcode,
      type: this.type,
      fbtrace_id: this.fbtraceId,
    });
  }
}

export interface PageInfo {
  /** Cursor to pass back as `after` to fetch the next page. */
  after?: string;
  before?: string;
  has_next_page: boolean;
}

export interface ListResult<T = Record<string, unknown>> {
  data: T[];
  paging: PageInfo;
}

const PATH_RE = /^(?:act_\d{1,32}|\d{1,32}|me)(?:\/[a-z_]{1,64})?$/;
const FORBIDDEN_PARAMS = new Set(["access_token", "appsecret_proof", "method", "batch"]);

export interface MetaClientOptions {
  token: string;
  apiVersion: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class MetaClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: MetaClientOptions) {
    this.token = opts.token;
    registerSecret(opts.token);
    this.baseUrl = `https://graph.facebook.com/${validateApiVersion(opts.apiVersion)}`;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Builds the request URL (no credentials in it). Exposed for tests. */
  buildUrl(path: string, query: Query = {}): string {
    if (!PATH_RE.test(path)) throw new Error(`Refusing to request disallowed Graph API path: ${path}`);
    const url = new URL(`${this.baseUrl}/${path}`);
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      if (FORBIDDEN_PARAMS.has(k.toLowerCase())) throw new Error(`Query parameter not allowed: ${k}`);
      url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  /** Performs a GET request; the response is sanitized. Uses `tokenOverride` (e.g. a Page token) when given. */
  async get<T = Record<string, unknown>>(path: string, query: Query = {}, tokenOverride?: string): Promise<T> {
    return sanitize((await this.request(path, query, tokenOverride)) as T);
  }

  /**
   * Internal: reads a Page access token for `pageId` (GET /{page-id}?fields=access_token).
   * The value is registered for redaction and must never be returned to the MCP client.
   */
  async getPageAccessToken(pageId: string): Promise<string> {
    if (!/^\d{1,32}$/.test(pageId)) throw new Error("Invalid Page ID");
    const body = (await this.request(pageId, { fields: "access_token" })) as { access_token?: unknown };
    if (typeof body.access_token !== "string" || !body.access_token) {
      throw new MetaApiError("No Page access token available: the Page is not assigned to this System User.");
    }
    registerSecret(body.access_token);
    return body.access_token;
  }

  /**
   * The only write this client can make: a text/link post on a Page's feed
   * (POST /{page-id}/feed with message and link), with the Page's own token.
   * Returns the new post id. A network failure is thrown with `network: true`
   * (the post may exist: check before retrying).
   */
  async postPageFeed(pageId: string, post: { message: string; link: string }, pageToken: string): Promise<{ id: string }> {
    if (!/^\d{1,32}$/.test(pageId)) throw new Error("Invalid Page ID");
    if (!post.message.trim()) throw new Error("A post needs a message");
    if (!/^https:\/\//.test(post.link)) throw new Error("A post link must be an https URL");
    const form = new URLSearchParams({ message: post.message, link: post.link });
    const result = (await this.request(`${pageId}/feed`, {}, pageToken, form)) as { id?: unknown };
    if (typeof result.id !== "string" || !result.id) {
      throw new MetaApiError("Meta answered without a post id: the outcome is unknown", { network: true });
    }
    return { id: result.id };
  }

  private async request(path: string, query: Query, tokenOverride?: string, form?: URLSearchParams): Promise<unknown> {
    const url = this.buildUrl(path, query);
    // the only write allowed is a Page feed post
    if (form && !/^\d{1,32}\/feed$/.test(path)) throw new Error(`Refusing to write to ${path}`);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: form ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${tokenOverride ?? this.token}`,
          Accept: "application/json",
          ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        },
        ...(form ? { body: form.toString() } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      throw new MetaApiError(`Network error calling Meta Graph API (${path}): ${msg}`, { network: true });
    }

    const text = await res.text();
    let body: unknown;
    try {
      body = text.length ? JSON.parse(text) : {};
    } catch {
      throw new MetaApiError(
        `Meta Graph API returned invalid JSON (HTTP ${res.status}) for ${path}: ${text.slice(0, 200)}`,
        { status: res.status },
      );
    }

    const errObj = (body as { error?: Record<string, unknown> } | null)?.error;
    if (!res.ok || errObj) {
      if (errObj && typeof errObj === "object") {
        const userMsg = typeof errObj.error_user_msg === "string" ? ` (${errObj.error_user_msg})` : "";
        throw new MetaApiError(`${String(errObj.message ?? "Unknown Meta API error")}${userMsg}`, {
          status: res.status,
          code: typeof errObj.code === "number" ? errObj.code : undefined,
          subcode: typeof errObj.error_subcode === "number" ? errObj.error_subcode : undefined,
          type: typeof errObj.type === "string" ? errObj.type : undefined,
          fbtraceId: typeof errObj.fbtrace_id === "string" ? errObj.fbtrace_id : undefined,
        });
      }
      throw new MetaApiError(`Meta Graph API request failed with HTTP ${res.status} for ${path}`, {
        status: res.status,
      });
    }
    return body;
  }

  /**
   * Fetches a single page of an edge. Pagination is cursor-based and caller-driven:
   * the raw `paging.next`/`previous` URLs are never returned (they may contain tokens).
   */
  async list<T = Record<string, unknown>>(path: string, query: Query = {}, tokenOverride?: string): Promise<ListResult<T>> {
    const body = await this.get<{ data?: T[]; paging?: { cursors?: { after?: string; before?: string }; next?: string } }>(
      path,
      query,
      tokenOverride,
    );
    const data = Array.isArray(body.data) ? body.data : [];
    const cursors = body.paging?.cursors ?? {};
    return {
      data,
      paging: {
        after: typeof cursors.after === "string" ? cursors.after : undefined,
        before: typeof cursors.before === "string" ? cursors.before : undefined,
        has_next_page: typeof body.paging?.next === "string",
      },
    };
  }
}
