/**
 * Public Sandbox Guard (SC_SANDBOX_MODE=true).
 *
 * Allows public visitors (e.g. try.semanticcanvas.ai) to explore the bundled
 * sample warehouse, build/arrange/export dashboards, run Semantic Coach, and
 * upload ephemeral Excel/CSV spreadsheets—while hard-blocking arbitrary local
 * filesystem paths, .env credential writes, AI key mutations, and external
 * warehouse connections.
 */

export const SANDBOX_MAX_SPREADSHEET_SOURCES = 10;

export function isSandboxMode(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = String(env.SC_SANDBOX_MODE ?? "").trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}

const SANDBOX_BLOCK_MESSAGE =
  "This action is disabled in the public sandbox. Self-host Semantic Canvas in 60 seconds to connect private warehouses or save API keys.";

/**
 * Returns a human-readable block message if `method + path` must be refused in
 * public sandbox mode, or `null` if permitted.
 */
export function sandboxBlockReason(method: string, path: string): string | null {
  const upper = method.toUpperCase();
  if (upper === "GET" || upper === "HEAD" || upper === "OPTIONS") return null;

  const normalized = path.toLowerCase().replace(/^\/api/, "");

  // Allow ephemeral spreadsheet preview, import, and refresh in sandbox mode.
  if (/^\/modeler\/spreadsheet(\/|$)/.test(normalized)) return null;

  // Hard-block warehouse/source config edits, .env credential writes, and AI keys.
  if (
    /^\/sources(\/|$)/.test(normalized) ||
    /^\/agent\/key(\/|$)/.test(normalized) ||
    /^\/setup\/model(\/|$)/.test(normalized) ||
    /^\/modeler\/drafts(\/|$)/.test(normalized) ||
    /^\/scim(\/|$)/.test(normalized)
  ) {
    return SANDBOX_BLOCK_MESSAGE;
  }

  return null;
}

/**
 * Validates Host / Origin headers when running in Public Sandbox mode
 * (`SC_SANDBOX_MODE=true`) without OIDC login.
 *
 * - Always rejects cross-origin browser requests (`Origin` host !== `Host`).
 * - When `SC_SANDBOX_ORIGINS` is set (comma-separated URLs or hostnames),
 *   only those origins (plus localhost for health/dev checks) are allowed.
 */
export function isSandboxOriginAllowed(
  host: string,
  origin: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const cleanHost = host.trim().toLowerCase();
  if (!cleanHost) return false;

  const isLocalHost = (h: string) => {
    try {
      return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(`http://${h}`).hostname);
    } catch {
      return false;
    }
  };

  let originHost: string | null = null;
  if (origin) {
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      return false;
    }
    if (originHost !== cleanHost) return false;
  }

  const configured = String(env.SC_SANDBOX_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (configured.length === 0) return true;
  if (isLocalHost(cleanHost)) return true;

  const allowedHosts = new Set(
    configured
      .map((entry) => {
        try {
          return new URL(entry.includes("://") ? entry : `https://${entry}`).host.toLowerCase();
        } catch {
          return "";
        }
      })
      .filter(Boolean),
  );
  return allowedHosts.has(cleanHost);
}
