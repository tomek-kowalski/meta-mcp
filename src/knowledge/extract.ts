import { createHash } from "node:crypto";
import { parseHTML } from "linkedom";
import { normalizeUrl } from "./urls.js";

/**
 * Turns an HTML document (the browser-rendered page, or a test fixture) into
 * structured evidence. Pure and browser-free. The input is untrusted website
 * content: it's only read as data, never executed or followed as instructions.
 */

export interface Section {
  /** Stable key: the section's anchor id, h-<slug> of its heading, or _top */
  key: string;
  heading: string | null;
  level: number;
  /** The id a #fragment link can target for this section, if any */
  anchor: string | null;
  blocks: string[];
}

export interface Link {
  href: string;
  text: string;
  internal: boolean;
  fragment: string | null;
  area: "header" | "nav" | "main" | "footer" | "other";
}

export interface Cta {
  text: string;
  href: string | null;
}

export interface PageExtract {
  lang: string | null;
  title: string;
  description: string;
  canonical: string | null;
  robots: string | null;
  hreflang: Record<string, string>;
  og: Record<string, string>;
  jsonLd: unknown[];
  sections: Section[];
  anchors: string[];
  links: Link[];
  ctas: Cta[];
}

/** Collapse whitespace (incl. no-break spaces), NFC: cosmetic changes don't change hashes. */
export const normalizeText = (text: string) => text.normalize("NFC").replace(/[\s ​]+/g, " ").trim();

export const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

export function sectionHash(section: Pick<Section, "heading" | "blocks">): string {
  return sha256(`${section.heading ?? ""}\n${section.blocks.join("\n")}`);
}

/** Hash of the page content only (no timestamps, links or markup). */
export function contentHash(extract: Pick<PageExtract, "title" | "description" | "sections">): string {
  return sha256(
    JSON.stringify({
      title: extract.title,
      description: extract.description,
      sections: extract.sections.map((s) => [s.key, s.heading, s.blocks]),
    }),
  );
}

export const slugify = (text: string) =>
  normalizeText(text)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ł/g, "l")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "section";

// Elements whose text flows inline inside their parent block.
const INLINE = new Set(
  "a abbr b bdi bdo br cite code data dfn em i img kbd label mark q s samp small span strong sub sup time u var wbr".split(" "),
);
const SKIP = new Set("script style noscript template svg iframe canvas object video audio picture source head".split(" "));
const HEADING = /^h([1-6])$/;
const IGNORED_IDS = new Set(["root", "modal"]);

const tag = (el: Element) => el.tagName.toLowerCase();

function hidden(el: Element): boolean {
  return (
    el.hasAttribute("hidden") ||
    el.getAttribute("aria-hidden") === "true" ||
    el.getAttribute("role") === "dialog" ||
    el.getAttribute("aria-modal") === "true"
  );
}

/** Text of `el` that isn't inside a nested block element (blocks are emitted separately). */
function ownText(el: Element): string {
  let out = "";
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === 3) out += node.textContent ?? "";
    else if (node.nodeType === 1) {
      const child = node as Element;
      const name = tag(child);
      if (SKIP.has(name) || hidden(child)) continue;
      if (name === "br") out += " ";
      else if (INLINE.has(name)) out += ownText(child);
    }
  }
  return normalizeText(out);
}

function areaOf(el: Element): Link["area"] {
  for (let node: Element | null = el; node; node = node.parentElement) {
    const name = tag(node);
    if (name === "nav") return "nav";
    if (name === "header") return "header";
    if (name === "footer") return "footer";
    if (name === "main") return "main";
  }
  return "other";
}

function anchorFor(heading: Element, used: Set<string>): string | null {
  if (heading.id && !IGNORED_IDS.has(heading.id)) return heading.id;
  // The nearest ancestor with an id names the section, but only for its first heading.
  for (let node = heading.parentElement; node && tag(node) !== "main" && tag(node) !== "body"; node = node.parentElement) {
    if (node.id && !IGNORED_IDS.has(node.id)) {
      const firstHeading = node.querySelector("h1, h2, h3");
      return firstHeading === heading && !used.has(node.id) ? node.id : null;
    }
  }
  return null;
}

export function extractPage(html: string, pageUrl: string, origin: string): PageExtract {
  const { document } = parseHTML(html);
  const meta = (selector: string) => normalizeText(document.querySelector(selector)?.getAttribute("content") ?? "");

  // JSON-LD before scripts are skipped. Invalid JSON is kept out, not fatal.
  const jsonLd: unknown[] = [];
  for (const script of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
    try {
      jsonLd.push(JSON.parse(script.textContent ?? ""));
    } catch {
      /* ignore malformed structured data */
    }
  }

  const hreflang: Record<string, string> = {};
  for (const link of Array.from(document.querySelectorAll('link[rel="alternate"][hreflang]'))) {
    const lang = link.getAttribute("hreflang");
    const href = link.getAttribute("href");
    if (lang && href) hreflang[lang] = normalizeUrl(href, pageUrl, origin)?.url ?? href;
  }
  const og: Record<string, string> = {};
  for (const m of Array.from(document.querySelectorAll('meta[property^="og:"]'))) {
    const key = m.getAttribute("property");
    if (key) og[key] = normalizeText(m.getAttribute("content") ?? "");
  }
  const canonicalHref = document.querySelector('link[rel="canonical"]')?.getAttribute("href");

  // ---- anchors and links: the whole document, before any element is removed ---
  const anchors = Array.from(document.querySelectorAll("[id]"))
    .map((el) => el.id)
    .filter((id) => id && !IGNORED_IDS.has(id));

  const links: Link[] = [];
  const seenLinks = new Set<string>();
  for (const a of Array.from(document.querySelectorAll("a[href]"))) {
    if (hidden(a)) continue;
    const raw = a.getAttribute("href") ?? "";
    const n = normalizeUrl(raw, pageUrl, origin);
    if (!n) continue;
    const text = normalizeText(a.textContent ?? "") || normalizeText(a.getAttribute("aria-label") ?? "");
    const href = n.fragment ? `${n.url}#${n.fragment}` : n.url;
    const key = `${href}\u0000${text}`;
    if (seenLinks.has(key)) continue;
    seenLinks.add(key);
    links.push({ href, text, internal: n.sameOrigin, fragment: n.fragment, area: areaOf(a) });
  }

  // ---- sections: document order over the main content -----------------------
  const main =
    document.querySelector("main") ??
    (() => {
      const body = document.body;
      for (const el of Array.from(body.querySelectorAll("header, nav, footer"))) el.remove();
      return body;
    })();
  const sections: Section[] = [];
  const usedKeys = new Set<string>();
  const usedAnchors = new Set<string>();
  let current: Section = { key: "_top", heading: null, level: 0, anchor: null, blocks: [] };
  const push = (section: Section) => {
    if (section.heading !== null || section.blocks.length) sections.push(section);
  };
  const uniqueKey = (base: string) => {
    let key = base;
    for (let n = 2; usedKeys.has(key); n += 1) key = `${base}-${n}`;
    usedKeys.add(key);
    return key;
  };

  const emit = (raw: string) => {
    const text = normalizeText(raw);
    // Responsive layouts render some texts twice in a row; keep one.
    if (text && current.blocks[current.blocks.length - 1] !== text) current.blocks.push(text);
  };
  const BLOCK_INSIDE = "p, div, li, ul, ol, h1, h2, h3, h4, h5, h6, section, article, table";

  // Walks child nodes in document order. A run of text and inline elements is
  // one block, emitted where it occurs; block elements are walked recursively.
  const walk = (el: Element) => {
    let run = "";
    const flush = () => {
      emit(run);
      run = "";
    };
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === 3) {
        run += node.textContent ?? "";
        continue;
      }
      if (node.nodeType !== 1) continue;
      const child = node as Element;
      const name = tag(child);
      if (SKIP.has(name) || hidden(child)) continue;
      if (INLINE.has(name) && !child.querySelector(BLOCK_INSIDE)) {
        run += name === "br" ? " " : ownText(child);
        continue;
      }
      flush();
      const level = HEADING.exec(name);
      if (level && Number(level[1]) <= 3) {
        push(current);
        const heading = normalizeText(child.textContent ?? "");
        const anchor = anchorFor(child, usedAnchors);
        if (anchor) usedAnchors.add(anchor);
        current = { key: uniqueKey(anchor ?? `h-${slugify(heading)}`), heading, level: Number(level[1]), anchor, blocks: [] };
      } else if (level) {
        emit(child.textContent ?? "");
      } else {
        walk(child);
      }
    }
    flush();
  };
  walk(main);
  push(current);

  // ---- CTAs: buttons and button-styled links in the main content -----------
  const ctas: Cta[] = [];
  const seenCtas = new Set<string>();
  for (const el of Array.from(main.querySelectorAll("a, button, [role=button]"))) {
    const cls = (el.getAttribute("class") ?? "").toLowerCase();
    const isCta = tag(el) === "button" || el.getAttribute("role") === "button" || /\b(btn|button|cta)\b|btn-|cta-|_btn|_cta|button_/.test(cls);
    if (!isCta || hidden(el) || el.getAttribute("aria-expanded") !== null) continue;
    const text = normalizeText(el.textContent ?? "") || normalizeText(el.getAttribute("aria-label") ?? "");
    if (!text) continue;
    const raw = el.getAttribute("href");
    const n = raw ? normalizeUrl(raw, pageUrl, origin) : null;
    const href = n ? (n.fragment ? `${n.url}#${n.fragment}` : n.url) : null;
    const key = `${text}\u0000${href}`;
    if (seenCtas.has(key)) continue;
    seenCtas.add(key);
    ctas.push({ text, href });
  }

  return {
    lang: document.documentElement.getAttribute("lang")?.trim().toLowerCase().split("-")[0] || null,
    title: normalizeText(document.querySelector("title")?.textContent ?? ""),
    description: meta('meta[name="description"]'),
    canonical: canonicalHref ? normalizeUrl(canonicalHref, pageUrl, origin)?.url ?? canonicalHref : null,
    robots: meta('meta[name="robots"]') || null,
    hreflang,
    og,
    jsonLd,
    sections,
    anchors: [...new Set(anchors)],
    links,
    ctas,
  };
}
