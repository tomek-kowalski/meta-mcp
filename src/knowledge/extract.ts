import { parseHTML } from "linkedom";
import { normalizeUrl } from "./urls.js";

/**
 * Reads what link checking needs from an HTML document (the browser-rendered
 * page, or a test fixture): language, title, canonical, hreflang alternates,
 * element ids (valid #anchors) and links (to discover further pages). Pure and
 * browser-free. The input is untrusted website content, only read as data.
 */

export interface PageExtract {
  lang: string | null;
  title: string;
  canonical: string | null;
  hreflang: Record<string, string>;
  anchors: string[];
  /** Normalized internal page links (no fragment) found anywhere on the page */
  links: string[];
}

const IGNORED_IDS = new Set(["root", "modal"]);
const clean = (text: string) => text.normalize("NFC").replace(/[\s ]+/g, " ").trim();

export function extractPage(html: string, pageUrl: string, origin: string): PageExtract {
  const { document } = parseHTML(html);

  const hreflang: Record<string, string> = {};
  for (const link of Array.from(document.querySelectorAll('link[rel="alternate"][hreflang]'))) {
    const lang = link.getAttribute("hreflang");
    const href = link.getAttribute("href");
    if (lang && href) hreflang[lang] = normalizeUrl(href, pageUrl, origin)?.url ?? href;
  }
  const canonicalHref = document.querySelector('link[rel="canonical"]')?.getAttribute("href");

  const links = new Set<string>();
  for (const a of Array.from(document.querySelectorAll("a[href]"))) {
    const n = normalizeUrl(a.getAttribute("href") ?? "", pageUrl, origin);
    if (n?.sameOrigin) links.add(n.url);
  }

  const anchors = Array.from(document.querySelectorAll("[id]"))
    .map((el) => el.id)
    .filter((id) => id && !IGNORED_IDS.has(id));

  return {
    lang: document.documentElement.getAttribute("lang")?.trim().toLowerCase().split("-")[0] || null,
    title: clean(document.querySelector("title")?.textContent ?? ""),
    canonical: canonicalHref ? (normalizeUrl(canonicalHref, pageUrl, origin)?.url ?? canonicalHref) : null,
    hreflang,
    anchors: [...new Set(anchors)],
    links: [...links],
  };
}
