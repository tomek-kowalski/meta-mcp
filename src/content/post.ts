import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { ConfigError } from "../config.js";

/**
 * What a Facebook post is made of besides its text:
 *
 * - the message: the post text, then the article link on its own line at the bottom;
 * - one image: draft file image.svg (1080×1080, in the website's style), rendered to PNG offline
 *   with the website's own fonts. The SVG is untrusted text: no scripts, no external references.
 */

export const IMAGE_FILE = "image.svg";
export const IMAGE_SIZE = 1080;

/** The text that is posted: the post, then its article link. */
export const postMessage = (text: string, link: string) => `${text.trim()}\n\n${link}`;

const FORBIDDEN: [string, RegExp][] = [
  ["a script", /<script\b/i],
  ["foreignObject", /<foreignObject\b/i],
  ["an event handler attribute", /\son[a-z]+\s*=/i],
  ["an embedded or linked image", /<image\b/i],
  ["a link to another document", /\b(?:xlink:)?href\s*=\s*["']\s*(?!#)/i],
  ["an external url()", /url\(\s*["']?\s*(?!#)/i],
  ["an @import", /@import\b/i],
  ["a DOCTYPE or entity", /<!(?:DOCTYPE|ENTITY)\b/i],
  ["a javascript: URL", /javascript:/i],
];

/** Problems that keep image.svg from being rendered or posted. */
export function svgErrors(svg: string): string[] {
  const s = svg.trim();
  const errors: string[] = [];
  if (!/^<svg\b[^>]*>/i.test(s) || !/<\/svg>$/i.test(s)) errors.push("image.svg must be a single <svg>…</svg> element");
  if (s.length > 200_000) errors.push(`image.svg is ${s.length} characters; keep it under 200 000`);
  const open = s.match(/^<svg\b[^>]*>/i)?.[0] ?? "";
  if (!/\bxmlns\s*=\s*["']http:\/\/www\.w3\.org\/2000\/svg["']/.test(open)) errors.push('the <svg> element needs xmlns="http://www.w3.org/2000/svg"');
  if (!/\bviewBox\s*=\s*["']0 0 1080 1080["']/.test(open)) errors.push('the <svg> element needs viewBox="0 0 1080 1080"');
  const body = s.replace(/\bxmlns(?::\w+)?\s*=\s*["'][^"']*["']/g, ""); // namespace URIs aren't references
  for (const [what, re] of FORBIDDEN) if (re.test(body)) errors.push(`image.svg contains ${what}; draw everything with shapes and text`);
  return errors;
}

/** The words shown in the image (checked like the post: brand, Base.com, secrets, client names). */
export function svgText(svg: string): string {
  return [...svg.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/gi)]
    .map((m) => m[1].replace(/<[^>]+>/g, " "))
    .join("\n")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/** Elements drawn (a rough measure of how busy the image is). */
export const svgElementCount = (svg: string) => (svg.match(/<(?!\/|svg\b|defs\b|\/?g\b|stop\b|linearGradient\b|radialGradient\b|filter\b|fe\w+|tspan\b|title\b|desc\b)\w+/g) ?? []).length;

/** The website's @font-face rules (src/index.css) with the font files inlined, so rendering needs no network. */
export function siteFontFaces(portfolioDir: string): string {
  const cssFile = join(portfolioDir, "src", "index.css");
  if (!existsSync(cssFile)) return "";
  const css = readFileSync(cssFile, "utf8");
  return [...css.matchAll(/@font-face\s*\{[^}]*\}/g)]
    .map((m) =>
      m[0].replace(/url\(["']?([^"')]+\.woff2)["']?\)/g, (_all, rel: string) => {
        const file = resolve(dirname(cssFile), rel);
        return existsSync(file) ? `url(data:font/woff2;base64,${readFileSync(file).toString("base64")})` : "url()";
      }),
    )
    .join("\n");
}

async function launch(): Promise<Browser> {
  try {
    return await chromium.launch({ channel: "chrome", headless: true });
  } catch {
    return chromium.launch({ headless: true });
  }
}

/** Renders image.svg to a 1080×1080 PNG. Offline: every request from the page is refused. */
export async function renderSvg(svg: string, portfolioDir: string): Promise<Buffer> {
  const errors = svgErrors(svg);
  if (errors.length) throw new ConfigError(`image.svg can't be rendered: ${errors.join("; ")}`);
  const browser = await launch().catch((err) => {
    throw new ConfigError(`No browser to render the image (install Chrome): ${err instanceof Error ? err.message : String(err)}`);
  });
  try {
    const context = await browser.newContext({ viewport: { width: IMAGE_SIZE, height: IMAGE_SIZE }, serviceWorkers: "block" });
    await context.route("**/*", (route) => route.abort());
    const page = await context.newPage();
    const html =
      `<!doctype html><html><head><meta charset="utf-8"><style>${siteFontFaces(portfolioDir)}\n` +
      `html,body{margin:0;background:#0a0416}svg{display:block;width:${IMAGE_SIZE}px;height:${IMAGE_SIZE}px}</style></head>` +
      `<body>${svg.trim()}</body></html>`;
    await page.setContent(html, { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    return await page.locator("svg").first().screenshot({ type: "png" });
  } finally {
    await browser.close();
  }
}
