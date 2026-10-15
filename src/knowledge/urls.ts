/**
 * URL normalization for the published-URL registry. A page is identified by
 * origin + path: the #fragment is a section of it, and a ?query view is never
 * a separate publishable page.
 */

export interface NormalizedUrl {
  /** origin + path, no query, no fragment, no trailing slash (except "/") */
  url: string;
  path: string;
  fragment: string | null;
  hadQuery: boolean;
  sameOrigin: boolean;
}

const ASSET = /\.(?:png|jpe?g|gif|webp|avif|svg|ico|css|js|mjs|map|json|xml|pdf|zip|woff2?|ttf|otf|mp4|webm|mp3|txt|webmanifest)$/i;

export function normalizeUrl(href: string, base: string, origin: string): NormalizedUrl | null {
  let url: URL;
  try {
    url = new URL(href.trim(), base);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null; // mailto:, tel:, javascript:, data:
  const fragment = url.hash ? decodeURIComponent(url.hash.slice(1)) || null : null;
  const hadQuery = url.search.length > 1;
  let path = url.pathname.replace(/\/{2,}/g, "/");
  if (path.length > 1) path = path.replace(/\/+$/, "");
  return { url: `${url.origin}${path}`, path, fragment, hadQuery, sameOrigin: url.origin === origin };
}

/** True for internal URLs that may be HTML pages (not assets or API endpoints). */
export function isPageCandidate(n: NormalizedUrl): boolean {
  return n.sameOrigin && !ASSET.test(n.path) && !n.path.startsWith("/api/") && n.path !== "/api";
}
