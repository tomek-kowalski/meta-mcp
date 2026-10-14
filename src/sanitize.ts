/**
 * Credential redaction. Everything returned to the MCP client or written to
 * stderr passes through here first.
 */

export const REDACTED = "[REDACTED]";

/** Keys whose values are always secrets, regardless of content. */
const SECRET_KEYS = new Set(["access_token", "appsecret_proof", "client_secret", "authorization"]);

/** Secrets registered at runtime (system user token, derived page tokens). */
const knownSecrets = new Set<string>();

export function registerSecret(secret: string | undefined): void {
  // Very short values would cause pathological over-redaction; real tokens are long.
  if (secret && secret.length >= 8) knownSecrets.add(secret);
}

/** For tests only. */
export function clearSecrets(): void {
  knownSecrets.clear();
}

export function redactString(input: string): string {
  let out = input;
  for (const secret of knownSecrets) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  return out
    // access_token=..., appsecret_proof=... in URLs / query strings (raw or URL-encoded '=')
    .replace(/((?:access_token|appsecret_proof|client_secret)(?:=|%3D))[^&\s"'#]+/gi, `$1${REDACTED}`)
    // "Authorization: Bearer xxx" / "Bearer xxx"
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/g, `$1${REDACTED}`);
}

/** Deep-redacts any JSON-like value. Returns a new value; input is not mutated. */
export function sanitize<T>(value: T): T {
  return sanitizeInner(value, 0) as T;
}

function sanitizeInner(value: unknown, depth: number): unknown {
  if (depth > 50) return "[TRUNCATED]";
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((v) => sanitizeInner(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.has(k.toLowerCase()) ? REDACTED : sanitizeInner(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** Safe stderr logging (stdout is reserved for the MCP stdio protocol). */
export function logError(message: string): void {
  process.stderr.write(`[meta-mcp] ${redactString(message)}\n`);
}
