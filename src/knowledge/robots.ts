/**
 * robots.txt (RFC 9309): user-agent groups, Allow/Disallow with `*` and `$`,
 * longest match wins (Allow on ties), plus the non-standard Crawl-delay.
 */

interface Rule {
  allow: boolean;
  pattern: string;
}

interface Group {
  agents: string[];
  rules: Rule[];
  crawlDelay?: number;
}

export interface RobotsPolicy {
  isAllowed(path: string): boolean;
  /** Seconds, if the matching group sets Crawl-delay. */
  crawlDelay: number | undefined;
  sitemaps: string[];
  /** The group that applies (its user-agent tokens), for reporting. */
  agents: string[];
}

export function parseRobots(text: string): { groups: Group[]; sitemaps: string[] } {
  const groups: Group[] = [];
  const sitemaps: string[] = [];
  let current: Group | undefined;
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    const match = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2].trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (key === "sitemap") {
      if (value) sitemaps.push(value);
    } else if (current && (key === "allow" || key === "disallow")) {
      // An empty Disallow means "allow everything"; it adds no rule.
      if (value) current.rules.push({ allow: key === "allow", pattern: value });
    } else if (current && key === "crawl-delay") {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0) current.crawlDelay = seconds;
    }
  }
  return { groups, sitemaps };
}

/** Converts a robots pattern to a RegExp anchored at the path start. */
function patternToRegExp(pattern: string): RegExp {
  const anchoredEnd = pattern.endsWith("$");
  const body = (anchoredEnd ? pattern.slice(0, -1) : pattern)
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}${anchoredEnd ? "$" : ""}`);
}

/** The policy for `userAgent` (its product token, e.g. "meta-mcp-knowledge" from "meta-mcp-knowledge/0.3"). */
export function robotsPolicy(text: string | null, userAgent: string): RobotsPolicy {
  const { groups, sitemaps } = text === null ? { groups: [], sitemaps: [] } : parseRobots(text);
  const token = userAgent.split("/")[0].trim().toLowerCase();
  const specific = groups
    .flatMap((group) => group.agents.filter((agent) => agent !== "*" && token.includes(agent)).map((agent) => ({ group, agent })))
    .sort((a, b) => b.agent.length - a.agent.length)[0]?.group;
  const merged = specific ? [specific] : groups.filter((group) => group.agents.includes("*"));
  const rules = merged.flatMap((group) => group.rules).map((rule) => ({ ...rule, re: patternToRegExp(rule.pattern) }));
  const delays = merged.map((group) => group.crawlDelay).filter((d): d is number => d !== undefined);
  return {
    sitemaps,
    agents: merged.flatMap((group) => group.agents),
    crawlDelay: delays.length ? Math.max(...delays) : undefined,
    isAllowed(path: string) {
      let best: { allow: boolean; length: number } | undefined;
      for (const rule of rules) {
        if (!rule.re.test(path)) continue;
        const length = rule.pattern.length;
        if (!best || length > best.length || (length === best.length && rule.allow)) best = { allow: rule.allow, length };
      }
      return best ? best.allow : true;
    },
  };
}
