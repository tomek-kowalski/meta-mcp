import { join } from "node:path";
import { ConfigError } from "../config.js";
import { MetaApiError, type MetaClient } from "../meta-client.js";
import { contentHash, loadDraft, type PublisherPaths } from "../publisher/draft.js";
import { logEvent, move, readState, writeState, type DraftState } from "./lifecycle.js";
import { check, type ContentDeps } from "./service.js";

/**
 * Posting an approved draft's Facebook post, after its article is live:
 *
 * - only from WEBSITE_PUBLISHED (or PARTIALLY_PUBLISHED, to retry);
 * - the post is in the one language chosen for it and links the article in
 *   that same language, which must answer 200 with its canonical right now;
 * - the state is set to "pending" before the post: a lost answer becomes
 *   "unknown", and the next attempt first looks for the post on the Page
 *   instead of posting twice;
 * - a failure never touches the website (status PARTIALLY_PUBLISHED).
 */

export type PageClient = Pick<MetaClient, "getPageAccessToken" | "postPageFeed" | "list">;

export interface FacebookDeps {
  client: () => PageClient;
  fetchText: (url: string) => Promise<{ status: number; text: string }>;
}

export interface FacebookResult {
  name: string;
  dryRun: boolean;
  status: DraftState["status"];
  lang: string;
  link: string;
  message: string;
  page_id: string;
  post_id: string | null;
  note?: string;
}

const firstChars = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 80);

export async function publishFacebook(paths: PublisherPaths, name: string, options: { dryRun: boolean }, deps: ContentDeps & FacebookDeps): Promise<FacebookResult> {
  const dir = join(paths.draftsDir, name);
  let state = readState(dir);
  if (!state.channels.includes("facebook")) throw new ConfigError(`"${name}" isn't meant for Facebook (channels: ${state.channels.join(", ")}).`);
  const pageId = deps.pageId;
  if (!pageId) throw new ConfigError("META_PAGE_ID is not configured: no Page to post to.");
  const lang = state.facebook_lang;
  const draft = loadDraft(paths, name);
  const message = (draft.facebook[lang] ?? "").trim();
  const link = state.website?.urls[lang];

  if (state.status === "FACEBOOK_PUBLISHED" && state.facebook?.post_id) {
    return { name, dryRun: options.dryRun, status: state.status, lang, link: state.facebook.link, message, page_id: pageId, post_id: state.facebook.post_id, note: "already posted" };
  }
  if (!["WEBSITE_PUBLISHED", "PARTIALLY_PUBLISHED"].includes(state.status) || !link) {
    throw new ConfigError(`"${name}" is ${state.status}: the article must be live on the website before the Facebook post.`);
  }
  if (!state.approval || state.approval.content_sha256 !== contentHash(draft) || state.approval.facebook_lang !== lang || state.approval.page_id !== pageId) {
    throw new ConfigError(`"${name}" changed after it was approved (text, language or Page): nothing was posted.`);
  }
  const outcome = check(paths, name, deps);
  if (outcome.errors) throw new ConfigError(`"${name}" now has ${outcome.errors} error(s): nothing was posted.`);
  if (!message) throw new ConfigError(`facebook.${lang}.txt is empty.`);

  // the linked article, in the post's language, must be live right now
  const page = await deps.fetchText(link).catch(() => ({ status: 0, text: "" }));
  if (page.status !== 200 || !page.text.includes(`<link rel="canonical" href="${link}">`)) {
    throw new ConfigError(`The ${lang} article ${link} isn't live (HTTP ${page.status || "no answer"}): it must be published before the post.`);
  }
  if (options.dryRun) {
    return { name, dryRun: true, status: state.status, lang, link, message, page_id: pageId, post_id: null, note: "dry run: nothing was posted" };
  }

  const client = deps.client();
  const token = await client.getPageAccessToken(pageId);

  // an earlier attempt whose outcome we don't know: look for that post first
  if (state.facebook && ["pending", "unknown"].includes(state.facebook.status)) {
    const posts = await client.list<{ id: string; message?: string }>(`${pageId}/posts`, { fields: "id,message,created_time", limit: 25 }, token);
    const found = posts.data.find((p) => p.message && firstChars(p.message) === firstChars(message));
    if (found) return finish(paths, dir, state, found.id, link, message, pageId, deps, "found the post from the earlier attempt");
  }

  const now = deps.now();
  state = { ...state, facebook: { status: "pending", lang, link, post_id: null, attempted_at: now.toISOString(), published_at: null, last_error: null } };
  writeState(dir, state);
  try {
    const { id } = await client.postPageFeed(pageId, { message, link }, token);
    return finish(paths, dir, state, id, link, message, pageId, deps);
  } catch (err) {
    const unknown = err instanceof MetaApiError && err.network === true;
    const error = err instanceof Error ? err.message : String(err);
    let failed: DraftState = { ...state, facebook: { ...state.facebook!, status: unknown ? "unknown" : "failed", last_error: error }, last_error: error };
    if (failed.status !== "PARTIALLY_PUBLISHED") failed = move(failed, "PARTIALLY_PUBLISHED", deps.now(), unknown ? "Facebook: outcome unknown" : "Facebook post failed");
    writeState(dir, failed);
    logEvent(paths.logsDir, { event: unknown ? "facebook_unknown" : "facebook_failed", name, lang, link, error }, deps.now());
    throw new ConfigError(
      unknown
        ? `Facebook didn't confirm the post (${error}). It may exist: run publish again, it checks the Page before posting.`
        : `Facebook refused the post: ${error}. The article stays published; fix the cause and run publish again.`,
    );
  }
}

function finish(paths: PublisherPaths, dir: string, state: DraftState, postId: string, link: string, message: string, pageId: string, deps: ContentDeps, note?: string): FacebookResult {
  const now = deps.now();
  let done = move(state, "FACEBOOK_PUBLISHED", now, note ?? "posted on Facebook");
  done = {
    ...done,
    facebook: { status: "published", lang: state.facebook_lang, link, post_id: postId, attempted_at: state.facebook?.attempted_at ?? now.toISOString(), published_at: now.toISOString(), last_error: null },
    last_error: null,
  };
  writeState(dir, done);
  logEvent(paths.logsDir, { event: "facebook_published", name: state.name, lang: state.facebook_lang, link, post_id: postId, page_id: pageId }, now);
  return { name: state.name, dryRun: false, status: done.status, lang: state.facebook_lang, link, message, page_id: pageId, post_id: postId, note };
}
