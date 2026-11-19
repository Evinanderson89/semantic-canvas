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
