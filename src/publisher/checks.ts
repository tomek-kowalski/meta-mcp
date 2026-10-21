import { svgElementCount, svgErrors, svgText } from "../content/post.js";
import { normalizeUrl } from "../knowledge/urls.js";
import type { UrlRegistry } from "../knowledge/schema.js";
import { LANGUAGES, type Draft, type DraftMeta, type Language } from "./draft.js";

/**
 * Checks on an article draft before it is shown for approval (and again
 * before publishing). Errors block publishing; warnings are shown to the
 * owner. A heuristic safety net, not proof: the owner's approval decides.
 */

export interface Finding {
  level: "error" | "warning";
  code: string;
  message: string;
  where?: string;
}

/** A published article as listed in the website's articles.json. */
export interface PublishedArticle {
  slug: string;
  translations?: Partial<Record<"en" | "de", { slug: string }>>;
}

export interface CheckContext {
  origin: string | null;
  /** language -> News path, e.g. pl -> /news, en -> /en/news */
  newsPaths: Record<Language, string>;
  published: PublishedArticle[];
  categories: string[];
  otherDrafts: DraftMeta[];
  registry: UrlRegistry | null;
  registryAgeDays: number | null;
  staleDays: number;
  /** Terms that must never appear in published content (editorial/anonymization.json). */
  denylist: string[];
}

// ---- Markdown structure -----------------------------------------------------------

interface Structure {
  code: { lang: string; code: string }[];
  headings: string[];
  tableRows: number;
  listItems: number;
  /** text outside code blocks */
  prose: string;
}

export function structureOf(markdown: string): Structure {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const s: Structure = { code: [], headings: [], tableRows: 0, listItems: 0, prose: "" };
  const prose: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const open = /^ {0,3}(`{3,}|~{3,})[ \t]*([^`\s]*)/.exec(lines[i]);
    if (open) {
      const fence = open[1];
      const close = new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}[ \\t]*$`);
      const code: string[] = [];
      for (i += 1; i < lines.length && !close.test(lines[i]); i += 1) code.push(lines[i]);
      s.code.push({ lang: open[2].toLowerCase(), code: code.join("\n") });
      continue;
    }
    const line = lines[i];
    prose.push(line);
    const h = /^(#{1,6}) /.exec(line);
    if (h) s.headings.push(`h${h[1].length}`);
    else if (line.trim().startsWith("|") && !/^\|[\s|:-]+\|$/.test(line.trim())) s.tableRows += 1;
    else if (/^\s*(?:-|\*|\d+\.) /.test(line)) s.listItems += 1;
  }
  s.prose = prose.join("\n");
  return s;
}

// ---- patterns ---------------------------------------------------------------------

const SECRET_PATTERNS: [string, RegExp][] = [
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{20,})\b/],
  ["API secret key", /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/],
  ["Stripe live key", /\b(?:sk|rk|pk)_live_[A-Za-z0-9]{10,}\b/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ["Meta access token", /\bEAA[A-Za-z0-9]{30,}\b/],
  ["JWT", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["credentials in a URL", /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]+@/i],
  // (?<![a-z]) rather than \b, so DB_PASSWORD or WP_AUTH_TOKEN match too
  ["password or secret value", /(?<![a-z])(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)["']?\s*(?:[:=]>?|,)\s*["']([^"'\s]{6,})["']/i],
];
// Values that are clearly placeholders in example code.
const PLACEHOLDER = /^(?:\*+|x+|\.+|<[^>]+>|\$\{?[A-Za-z_]+\}?|%[A-Za-z_]+%|your[-_a-z]*|example[-_a-z]*|changeme|secret|password|placeholder|dummy|test|xxx.*)$/i;

/** Names of the secret kinds found in a text (e.g. in source material, to warn before drafting). */
export function secretsIn(text: string): string[] {
  return SECRET_PATTERNS.filter(([, re]) => {
    const m = re.exec(text);
    return m !== null && !(m[1] !== undefined && PLACEHOLDER.test(m[1]));
  }).map(([name]) => name);
}

const NUMBER_CLAIMS: [string, RegExp][] = [
  ["percentage", /\d+(?:[.,]\d+)?\s?%/g],
  ["count with a plus", /\b\d+\s?\+(?=\s|$|[.,;:)])/g],
  ["amount of money", /(?:\d[\d\s.,]*\s?(?:zł|PLN|EUR|€|USD|\$)|[$€]\s?\d[\d.,]*)/g],
  ["multiplier", /\b\d+(?:[.,]\d+)?\s?(?:x|×|razy|times|mal)\b/gi],
];
// whole words only: "panelu klienta" is not "u klienta"
const CASE_STUDY = /(?<!\p{L})(?:case stud|dla klient[ae]|u klienta|nasz(?:ego|ym|emu|ych)? klient|for (?:our|a) client|our clients?(?!\p{L})|für unseren? Kunden|unsere Kunden|testimonial|referencj)/iu;
const BRAND = /\bfor\s?each\s?url\b/gi;
const BASE_COM = /base\.com|base\s?linker/i;
const URL_RE = /https?:\/\/[^\s)\]>"'`]+/g;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const excerpt = (text: string, index: number, length: number) =>
  text.slice(Math.max(0, index - 40), index + length + 40).replace(/\s+/g, " ").trim();

// ---- the checks -------------------------------------------------------------------

export function checkDraft(draft: Draft, ctx: CheckContext): Finding[] {
  const findings: Finding[] = [];
  const error = (code: string, message: string, where?: string) => findings.push({ level: "error", code, message, where });
  const warn = (code: string, message: string, where?: string) => findings.push({ level: "warning", code, message, where });
  const { meta } = draft;

  // identity, category, slugs
  if (meta.id !== draft.id) error("meta.id", `meta.json id "${meta.id}" doesn't match the folder "${draft.id}"`);
  if (!ctx.categories.includes(meta.category)) error("meta.category", `unknown category "${meta.category}"; use one of: ${ctx.categories.join(", ")}`);
  const existing = ctx.published.find((a) => a.slug === meta.pl.slug);
  if (existing) warn("published", `an article with the Polish slug "${meta.pl.slug}" is already published: publishing this would update it`);
  for (const l of LANGUAGES) {
    const { slug, excerpt: ex } = meta[l];
    const taken = ctx.published.some((a) => a !== existing && (l === "pl" ? a.slug : a.translations?.[l]?.slug) === slug);
    if (taken) error("slug.taken", `${l} slug "${slug}" is already used by another published article`, `meta.json ${l}`);
    if (ctx.otherDrafts.some((d) => d[l].slug === slug)) error("slug.draft", `${l} slug "${slug}" is also used by another draft`, `meta.json ${l}`);
    if (ex.length > 220) warn("excerpt.length", `${l} excerpt is ${ex.length} characters; keep it under about 200`, `meta.json ${l}`);
  }

  // bodies in all three languages, same structure, identical code
  const structures: Partial<Record<Language, Structure>> = {};
  for (const l of LANGUAGES) {
    const body = draft.bodies[l];
    if (body === null || !body.trim()) {
      error("body.missing", `article.${l}.md is missing or empty: every article is published in pl, en and de`);
      continue;
    }
    structures[l] = structureOf(body);
  }
  const pl = structures.pl;
  if (pl) {
    for (const l of ["en", "de"] as const) {
      const t = structures[l];
      if (!t) continue;
      if (t.code.length !== pl.code.length) error("code.parity", `article.${l}.md has ${t.code.length} code blocks, Polish has ${pl.code.length}`);
      else t.code.forEach((block, i) => {
        if (block.code !== pl.code[i].code) error("code.parity", `code block ${i + 1} in article.${l}.md differs from the Polish one; code must be identical in every language`);
      });
      if (t.headings.join() !== pl.headings.join()) warn("structure", `article.${l}.md headings (${t.headings.length}) don't match the Polish ones (${pl.headings.length})`);
      if (t.tableRows !== pl.tableRows) warn("structure", `article.${l}.md has ${t.tableRows} table rows, Polish has ${pl.tableRows}`);
      if (t.listItems !== pl.listItems) warn("structure", `article.${l}.md has ${t.listItems} list items, Polish has ${pl.listItems}`);
    }
  }

  // The Facebook post: exactly one language, chosen by the owner (Polish by default)
  const fbLanguages = meta.facebook.languages;
  if (fbLanguages.length !== 1) error("facebook.language", `a Facebook post has exactly one language; meta.json lists ${fbLanguages.join(", ")}`);
  else if (fbLanguages[0] !== "pl") warn("facebook.language", `the Facebook post is in ${fbLanguages[0]}: Polish is the default, confirm this choice`);
  for (const l of fbLanguages) {
    const post = draft.facebook[l];
    if (post === undefined || !post.trim()) {
      error("facebook.missing", `facebook.${l}.txt is missing or empty (meta.json facebook.languages lists ${l})`);
      continue;
    }
    if (post.length > 1500) warn("facebook.length", `facebook.${l}.txt is ${post.length} characters; about 500–1300 reads best`);
    if (post.length > 60000) error("facebook.length", `facebook.${l}.txt is longer than Facebook allows`);
    const hashtags = post.match(/(^|\s)#[\p{L}\p{N}_]+/gu)?.length ?? 0;
    if (hashtags > 3) warn("facebook.hashtags", `facebook.${l}.txt has ${hashtags} hashtags; use at most 3`);
    if (post.match(URL_RE)) warn("facebook.link", `facebook.${l}.txt contains a URL; the article link is added at the bottom automatically, keep links out of the text`);
  }
  // its one image
  const posted = fbLanguages.some((l) => draft.facebook[l]?.trim());
  if (posted && draft.image === null) error("image.missing", "image.svg is missing: every Facebook post has one image (1080×1080 SVG in the website's style)");
  if (draft.image !== null) {
    for (const problem of svgErrors(draft.image)) error("image.svg", problem, "image.svg");
    const elements = svgElementCount(draft.image);
    if (elements > 40) warn("image.busy", `image.svg draws ${elements} elements; keep only what the post needs`, "image.svg");
    const words = svgText(draft.image).split(/\s+/).filter(Boolean).length;
    if (words > 12) warn("image.text", `image.svg has ${words} words of text; a few words read best`, "image.svg");
  }
  for (const l of LANGUAGES) {
    if (draft.facebook[l] !== undefined && !fbLanguages.includes(l)) warn("facebook.unused", `facebook.${l}.txt exists but ${l} isn't in meta.json facebook.languages: it won't be posted`);
  }

  // texts that get published, with where they come from
  const texts: { where: string; lang: Language; text: string; prose: string; facebook: boolean }[] = [];
  for (const l of LANGUAGES) {
    texts.push({ where: `meta.json ${l}`, lang: l, text: `${meta[l].title}\n${meta[l].excerpt}`, prose: `${meta[l].title}\n${meta[l].excerpt}`, facebook: false });
    const body = draft.bodies[l];
    if (body) texts.push({ where: `article.${l}.md`, lang: l, text: body, prose: structures[l]?.prose ?? body, facebook: false });
  }
  for (const l of fbLanguages) {
    const post = draft.facebook[l];
    if (post) texts.push({ where: `facebook.${l}.txt`, lang: l, text: post, prose: post, facebook: true });
  }
  if (draft.image !== null && fbLanguages.length) {
    const words = svgText(draft.image);
    if (words) texts.push({ where: "image.svg", lang: fbLanguages[0], text: words, prose: words, facebook: true });
  }

  for (const t of texts) {
    // secrets: everywhere, code included
    for (const [name, re] of SECRET_PATTERNS) {
      const m = re.exec(t.text);
      if (m && !(m[1] !== undefined && PLACEHOLDER.test(m[1]))) error("secret", `possible ${name}: "${excerpt(t.text, m.index, m[0].length)}"`, t.where);
    }
    for (const m of t.text.matchAll(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g)) {
      if (!/@(?:example\.(?:com|org|net)|foreachurl\.app)$/i.test(m[0])) warn("private.email", `e-mail address "${m[0]}": make sure it may be published`, t.where);
    }
    for (const m of t.text.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b|\b[\w-]+\.(?:local|internal|lan|corp)\b/g)) {
      warn("private.host", `"${m[0]}" looks like an internal address or host`, t.where);
    }
    // never-publish terms
    for (const term of ctx.denylist) {
      const m = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(term)}(?![\\p{L}\\p{N}])`, "iu").exec(t.text);
      if (m) error("denylist", `"${m[0]}" is on the never-publish list (editorial/anonymization.json)`, t.where);
    }
    // brand spelling (domain names are lowercase and fine)
    for (const m of t.prose.replace(URL_RE, " ").replace(/\bforeachurl\.app\b/gi, " ").matchAll(BRAND)) {
      if (m[0] !== "ForeachURL") error("brand", `brand written as "${m[0]}": always ForeachURL`, t.where);
    }
    // Base.com: never on Facebook; needs the owner's authorization elsewhere
    const base = BASE_COM.exec(t.text);
    if (base) {
      if (t.facebook) error("base-com", "Base.com must never be mentioned on Facebook", t.where);
      else warn("base-com", "Base.com is mentioned: public use needs the owner's explicit authorization", t.where);
    }
    // numbers and case-study claims: must come from the case. With the
    // source material at hand, a number that isn't in it is an error.
    for (const [name, re] of NUMBER_CLAIMS) {
      for (const m of t.prose.matchAll(re)) {
        const context = excerpt(t.prose, m.index ?? 0, m[0].length);
        if (draft.source === null) warn("claim.number", `${name} "${m[0].trim()}": confirm it comes from the real case: "${context}"`, t.where);
        else if (!inSource(m[0], draft.source)) error("claim.source", `${name} "${m[0].trim()}" doesn't appear in the source material: "${context}"`, t.where);
      }
    }
    const cs = CASE_STUDY.exec(t.prose);
    if (cs) warn("claim.client", `client or case-study wording "${cs[0]}": no client names or invented results`, t.where);

    // links to the website: published, in the same language, valid anchor
    if (!t.facebook) checkLinks(t, draft, ctx, error);
  }

  if (ctx.registry === null) warn("links.registry", "no website link registry found: links to the site weren't checked (run npm run knowledge -- refresh)");
  else if (ctx.registryAgeDays === null || ctx.registryAgeDays > ctx.staleDays) {
    warn("links.stale", `the website link registry is ${ctx.registryAgeDays ?? "never"} days old: refresh recommended (npm run knowledge -- refresh)`);
  }
  return findings;
}

/** Is a number claim (e.g. "40%", "3 000 zł", "2x") backed by the same number in the source? */
export function inSource(claim: string, source: string): boolean {
  // "3 000" and "3000" are the same number; "1,5" and "1.5" too
  const normalize = (text: string) => text.replace(/(\d)[  ](?=\d{3}(?!\d))/g, "$1").replace(/(\d),(\d)/g, "$1.$2");
  const numbers = normalize(claim).match(/\d+(?:\.\d+)?/g);
  if (!numbers) return true;
  const haystack = normalize(source);
  return numbers.every((n) => new RegExp("(?<![\\d.])" + n.replace(".", "\\.") + "(?![\\d])").test(haystack));
}

/** The draft's own article URL in a language (not published yet, so not in the registry). */
export const ownUrl = (ctx: CheckContext, meta: DraftMeta, l: Language) => `${ctx.origin}${ctx.newsPaths[l]}/${meta[l].slug}`;

function checkLinks(
  t: { where: string; lang: Language; text: string },
  draft: Draft,
  ctx: CheckContext,
  error: (code: string, message: string, where?: string) => void,
) {
  if (!ctx.origin || !ctx.registry) return;
  for (const m of t.text.matchAll(URL_RE)) {
    const raw = m[0].replace(/[.,;:!?]+$/, "");
    const n = normalizeUrl(raw, ctx.origin, ctx.origin);
    if (!n?.sameOrigin) continue;
    const own = LANGUAGES.find((l) => n.url === ownUrl(ctx, draft.meta, l));
    if (own) {
      if (own !== t.lang) error("link.language", `${raw} is the ${own} version of this article; link the ${t.lang} one`, t.where);
      continue;
    }
    const record = ctx.registry.urls.find((r) => r.url === n.url);
    if (!record || record.removed_at) error("link.unknown", `${raw} is not a published page of the website`, t.where);
    else if (record.alias_of) error("link.alias", `${raw} is an alias of ${record.alias_of}; link that page instead`, t.where);
    else if (record.lang !== t.lang) error("link.language", `${raw} is a ${record.lang} page, linked from ${t.lang} content`, t.where);
    else if (n.fragment && !record.anchors.includes(n.fragment)) error("link.anchor", `${raw}: #${n.fragment} doesn't exist on that page`, t.where);
  }
}
