import { chromium, type Browser, type BrowserContext } from "playwright-core";

/**
 * Headless renderer for a client-rendered site. Only this module touches the
 * browser; extraction runs on the returned HTML (extract.ts).
 *
 * - Uses the installed Chrome, else the Chromium already in the Playwright
 *   cache. Never downloads a browser.
 * - Every request to another origin is aborted (analytics, tag managers,
 *   widgets, fonts), so a crawl never counts as a visit anywhere. Images and
 *   media are skipped too.
 */

/**
 * Text that changes between samples (typewriters, rotating quotes) isn't
 * stable evidence. Three samples 1.2 s apart also catch an animation that
 * pauses on a complete word.
 */
const STABILITY_SAMPLES = 3;
const STABILITY_INTERVAL_MS = 1200;

/**
 * Samples the text of every element several times and marks the innermost
 * elements whose text changed with data-knowledge-unstable; extract.ts skips
 * them. Without this, animated text would produce a "change" on every crawl.
 */
async function markUnstableText(page: import("playwright-core").Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __knowledgeText?: Map<Element, string>; __knowledgeChanged?: Set<Element> };
    w.__knowledgeText = new Map(Array.from(document.body.querySelectorAll("*")).map((el) => [el, el.textContent ?? ""]));
    w.__knowledgeChanged = new Set();
  });
  for (let i = 1; i < STABILITY_SAMPLES; i += 1) {
    await page.waitForTimeout(STABILITY_INTERVAL_MS);
    await page.evaluate(() => {
      const w = window as unknown as { __knowledgeText?: Map<Element, string>; __knowledgeChanged?: Set<Element> };
      for (const [el, text] of w.__knowledgeText ?? []) {
        if (el.isConnected && (el.textContent ?? "") !== text) w.__knowledgeChanged?.add(el);
      }
    });
  }
  await page.evaluate(() => {
    const w = window as unknown as { __knowledgeText?: Map<Element, string>; __knowledgeChanged?: Set<Element> };
    const changed = w.__knowledgeChanged ?? new Set<Element>();
    for (const el of changed) {
      const innermost = !Array.from(el.querySelectorAll("*")).some((child) => changed.has(child));
      if (innermost) el.setAttribute("data-knowledge-unstable", "");
    }
    delete w.__knowledgeText;
    delete w.__knowledgeChanged;
  });
}

export interface RenderResult {
  status: number | null;
  finalUrl: string;
  html: string;
}

export interface Renderer {
  render(url: string): Promise<RenderResult>;
  readonly browserName: string;
  close(): Promise<void>;
}

export async function launchRenderer(opts: { origin: string; userAgent: string; timeoutMs?: number }): Promise<Renderer> {
  const timeout = opts.timeoutMs ?? 45_000;
  let browser: Browser;
  let browserName = "chrome";
  try {
    browser = await chromium.launch({ channel: "chrome", headless: true });
  } catch (chromeError) {
    try {
      browser = await chromium.launch({ headless: true });
      browserName = "chromium (Playwright cache)";
    } catch (chromiumError) {
      const msg = (e: unknown) => (e instanceof Error ? e.message.split("\n")[0] : String(e));
      throw new Error(
        `No browser available: installed Chrome failed (${msg(chromeError)}) and the cached Chromium failed (${msg(chromiumError)}). ` +
          "Install Google Chrome; no browser is downloaded automatically.",
      );
    }
  }
  const context: BrowserContext = await browser.newContext({
    userAgent: opts.userAgent,
    serviceWorkers: "block",
    viewport: { width: 1280, height: 900 },
  });
  await context.route("**/*", (route) => {
    const request = route.request();
    let sameOrigin = false;
    try {
      sameOrigin = new URL(request.url()).origin === opts.origin;
    } catch {
      sameOrigin = false;
    }
    const type = request.resourceType();
    if (!sameOrigin || type === "image" || type === "media" || type === "font") return route.abort();
    return route.continue();
  });

  return {
    browserName,
    async render(url: string): Promise<RenderResult> {
      const page = await context.newPage();
      try {
        const response = await page.goto(url, { waitUntil: "networkidle", timeout });
        // Client-rendered content: wait until the main content has text.
        await page
          .waitForFunction(() => (document.querySelector("main")?.textContent?.trim().length ?? 0) > 0, undefined, { timeout: 10_000 })
          .catch(() => undefined);
        await page.waitForTimeout(300);
        await markUnstableText(page);
        return { status: response?.status() ?? null, finalUrl: page.url(), html: await page.content() };
      } finally {
        await page.close();
      }
    },
    async close() {
      await context.close();
      await browser.close();
    },
  };
}
