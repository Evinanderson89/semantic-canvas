/**
 * Public Sandbox Guard (SC_SANDBOX_MODE=true).
 *
 * Allows public visitors (e.g. try.semanticcanvas.ai) to explore the bundled
 * sample warehouse, build/arrange/export dashboards, run Semantic Coach, and
 * upload ephemeral Excel/CSV spreadsheets—while hard-blocking arbitrary local
 * filesystem paths, .env credential writes, AI key mutations, external
 * warehouse connections, local setup probes, audit/backup dumps, and DoS floods.
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
  const normalized = path.toLowerCase().replace(/^\/api(?=\/|$)/, "");

  // Hard-block sensitive read AND write endpoints in public sandbox mode:
  // - source configs (expose server lakeRoot paths)
  // - operations backups, audit logs, and access reloads
  // - local ChatGPT/Claude setup/tunnel probes
  // - unauthenticated remote MCP endpoint
  // - raw warehouse modeler drafts & SCIM provisioning
  if (
    /^\/sources\/[^/]+\/config(\/|$)/.test(normalized) ||
    /^\/operations\/(backup|audit|access)(\/|$)/.test(normalized) ||
    /^\/setup\/(chatgpt|claude)(\/|$)/.test(normalized) ||
    /^\/mcp(\/|$)/.test(normalized) ||
    /^\/modeler\/drafts(\/|$)/.test(normalized) ||
    /^\/scim(\/|$)/.test(normalized)
  ) {
    return SANDBOX_BLOCK_MESSAGE;
  }

  if (upper === "GET" || upper === "HEAD" || upper === "OPTIONS") return null;

  // Allow ephemeral spreadsheet preview, import, and refresh in sandbox mode.
  if (/^\/modeler\/spreadsheet(\/|$)/.test(normalized)) return null;

  // Prevent visitors from deleting shared dashboards or library items.
  if (upper === "DELETE" && (/^\/dashboards(\/|$)/.test(normalized) || /^\/library(\/|$)/.test(normalized))) {
    return SANDBOX_BLOCK_MESSAGE;
  }

  // Hard-block warehouse/source config edits, .env credential writes, and AI keys.
  if (
    /^\/sources(\/|$)/.test(normalized) ||
    /^\/agent\/key(\/|$)/.test(normalized) ||
    /^\/setup\/model(\/|$)/.test(normalized)
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

/** Extracts a bounded client IP key for per-IP rate limiting behind Railway/Cloudflare proxies. */
export function sandboxClientKey(headers: Record<string, string | string[] | undefined>, remoteAddress?: string): string {
  const xff = headers["x-forwarded-for"];
  const rawXff = Array.isArray(xff) ? xff[0] : xff;
  const firstHop = rawXff?.split(",")[0]?.trim();
  const candidate = firstHop || remoteAddress?.trim() || "unknown";
  return candidate.slice(0, 128);
}

export interface SandboxRateLimiterOptions {
  /** General API requests per minute per IP (default: 180). */
  apiPerMinute?: number;
  /** Spreadsheet import/refresh requests per 10 minutes per IP (default: 10). */
  uploadsPerTenMinutes?: number;
  /** Maximum tracked client keys in memory (default: 10,000). */
  maxKeys?: number;
  now?: () => number;
}

export interface SandboxRateResult {
  allowed: boolean;
  retryAfterSeconds: number;
  bucket: "upload" | "api";
}

/**
 * Bounded in-memory per-IP rate limiter for Public Sandbox mode.
 * Protects Railway CPU/RAM/disk against query floods and repeated large uploads.
 */
export function createSandboxRateLimiter(opts: SandboxRateLimiterOptions = {}) {
  const apiLimit = opts.apiPerMinute ?? 180;
  const uploadLimit = opts.uploadsPerTenMinutes ?? 10;
  const maxKeys = opts.maxKeys ?? 10_000;
  const now = opts.now ?? Date.now;
  const windows = new Map<string, { start: number; used: number; windowMs: number }>();

  const take = (key: string, limit: number, windowMs: number): { allowed: boolean; retryAfterSeconds: number } => {
    const t = now();
    let entry = windows.get(key);
    if (!entry || t - entry.start >= windowMs) {
      if (!entry && windows.size >= maxKeys) {
        for (const [k, v] of windows) {
          if (t - v.start >= v.windowMs) windows.delete(k);
        }
        if (windows.size >= maxKeys) {
          const oldest = windows.keys().next().value;
          if (oldest !== undefined) windows.delete(oldest);
        }
      }
      windows.delete(key);
      entry = { start: t, used: 0, windowMs };
      windows.set(key, entry);
    }
    if (entry.used >= limit) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((entry.start + windowMs - t) / 1000)),
      };
    }
    entry.used++;
    return { allowed: true, retryAfterSeconds: 0 };
  };

  return function check(clientKey: string, method: string, path: string): SandboxRateResult {
    const normalized = path.toLowerCase().replace(/^\/api(?=\/|$)/, "");
    const isHeavyUpload =
      method.toUpperCase() === "POST" &&
      /^\/modeler\/spreadsheet\/(import|refresh)(\/|$)/.test(normalized);

    if (isHeavyUpload) {
      const res = take(`upload\0${clientKey}`, uploadLimit, 10 * 60_000);
      if (!res.allowed) return { ...res, bucket: "upload" };
    }
    const apiRes = take(`api\0${clientKey}`, apiLimit, 60_000);
    return { ...apiRes, bucket: "api" };
  };
}
