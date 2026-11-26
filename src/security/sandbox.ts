/**
 * Public Sandbox Guard (SC_SANDBOX_MODE=true).
 *
 * Allows public visitors (e.g. try.semanticcanvas.ai) to explore the bundled
 * sample warehouse, build/arrange/export dashboards locally, run Semantic Coach,
 * and upload session-isolated ephemeral Excel/CSV spreadsheets—while hard-blocking
 * arbitrary local filesystem paths, .env credential writes, AI key mutations,
 * external warehouse connections, shared dashboard/library vandalism, modal
 * spoofing, local setup probes, audit/backup dumps, and DoS floods.
 */

import { randomBytes } from "node:crypto";

export const SANDBOX_MAX_SPREADSHEET_SOURCES = 10;
export const SANDBOX_SESSION_COOKIE = "sc_sandbox_sid";
export const SANDBOX_SESSION_HEADER = "x-sc-sandbox-session";

export const BUILTIN_SAMPLE_SOURCE_IDS = new Set([
  "sample-warehouse",
  "duckglue-local",
  "coffee-roastery-pnl",
  "coffee-roastery-2tab",
  "us-grid-renewables",
]);

/** Validates an opaque 128-to-256-bit hex sandbox visitor session token. */
export function isValidSandboxSessionId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{32,64}$/i.test(value.trim());
}

/** Generates a random 128-bit hex token for per-visitor sandbox isolation. */
export function generateSandboxSessionId(): string {
  return randomBytes(16).toString("hex");
}

function readCookieValue(cookieHeader: string | string[] | undefined, name: string): string | undefined {
  const raw = Array.isArray(cookieHeader) ? cookieHeader.join("; ") : cookieHeader;
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${name}=`)) {
      return trimmed.slice(name.length + 1).trim();
    }
  }
  return undefined;
}

/**
 * Resolves the visitor's sandbox session ID from `x-sc-sandbox-session` (for
 * non-cookie test clients) or the `sc_sandbox_sid` cookie, generating a fresh
 * 128-bit hex token when absent or malformed.
 */
export function resolveSandboxSession(headers: Record<string, string | string[] | undefined>): {
  sessionId: string;
  shouldSetCookie: boolean;
} {
  const rawHeader = headers[SANDBOX_SESSION_HEADER];
  const headerVal = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  const cookieVal = readCookieValue(headers.cookie, SANDBOX_SESSION_COOKIE);

  if (isValidSandboxSessionId(headerVal)) {
    const normalized = headerVal.trim().toLowerCase();
    const cookieNormalized = isValidSandboxSessionId(cookieVal) ? cookieVal.trim().toLowerCase() : undefined;
    return { sessionId: normalized, shouldSetCookie: cookieNormalized !== normalized };
  }

  if (isValidSandboxSessionId(cookieVal)) {
    return { sessionId: cookieVal.trim().toLowerCase(), shouldSetCookie: false };
  }

  return { sessionId: generateSandboxSessionId(), shouldSetCookie: true };
}

/** Redacts filesystem paths from error strings in public sandbox responses. */
export function redactSandboxError(error: string | undefined): string | undefined {
  if (!error) return undefined;
  const scrubbed = error
    .replace(/(?:\/[\w.-]+){2,}/g, "[redacted-path]")
    .replace(/~\/[\w./-]+/g, "[redacted-path]")
    .replace(/[A-Za-z]:\\(?:[\w.-]+\\)+[\w.-]*/g, "[redacted-path]");
  return scrubbed || "Source unavailable in public sandbox.";
}

/**
 * Returns true when a listed source is eligible for an in-place spreadsheet
 * upload refresh in the Connections UI (DuckDB-backed uploaded sheets, never
 * the bundled sample warehouse or shared built-in sample worlds).
 */
export function isRefreshableSpreadsheetSource(
  source: string | { id: string; connector?: string | null },
): boolean {
  if (typeof source === "string") {
    return Boolean(source) && !BUILTIN_SAMPLE_SOURCE_IDS.has(source);
  }
  return Boolean(source.connector?.toLowerCase().includes("duckdb")) && !BUILTIN_SAMPLE_SOURCE_IDS.has(source.id);
}

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
  const normalized = path.toLowerCase().replace(/^\/api(?=\/|$)/, "").replace(/\/+$/, "") || "/";

  // Hard-block sensitive read AND write endpoints in public sandbox mode:
  // - source configs (expose server lakeRoot paths)
  // - operations backups, audit logs, and access reloads
  // - local ChatGPT/Claude setup/tunnel probes
  // - unauthenticated remote MCP endpoint
  // - raw warehouse modeler drafts & SCIM provisioning
  // - in-app MCP agent question polling/posting (cross-visitor modal spoofing)
  if (
    /^\/sources\/[^/]+\/config(\/|$)/.test(normalized) ||
    /^\/operations\/(backup|audit|access)(\/|$)/.test(normalized) ||
    /^\/setup\/(chatgpt|claude)(\/|$)/.test(normalized) ||
    /^\/mcp(\/|$)/.test(normalized) ||
    /^\/modeler\/drafts(\/|$)/.test(normalized) ||
    /^\/scim(\/|$)/.test(normalized) ||
    /^\/agent\/questions(\/|$)/.test(normalized)
  ) {
    return SANDBOX_BLOCK_MESSAGE;
  }

  if (upper === "GET" || upper === "HEAD" || upper === "OPTIONS") return null;

  // Allow ephemeral spreadsheet preview, import, and refresh in sandbox mode,
  // while protecting built-in shared sample worlds from anonymous refresh mutation.
  const refreshMatch = /^\/modeler\/spreadsheet\/refresh\/([^/]+)$/.exec(normalized);
  if (refreshMatch && BUILTIN_SAMPLE_SOURCE_IDS.has(decodeURIComponent(refreshMatch[1]))) {
    return SANDBOX_BLOCK_MESSAGE;
  }
  if (/^\/modeler\/spreadsheet(\/|$)/.test(normalized)) return null;

  // Allow read-only Executive Digest SHA-256 verification on existing dashboards.
  if (upper === "POST" && /^\/dashboards\/[^/]+\/digest$/.test(normalized)) {
    return null;
  }

  // Prevent visitors from creating, overwriting, renaming, or deleting shared
  // dashboards, Workspace Library items/folders/views, or chart comments/alerts.
  if (
    /^\/dashboards(\/|$)/.test(normalized) ||
    /^\/library(\/|$)/.test(normalized) ||
    /^\/chart-activity(\/|$)/.test(normalized)
  ) {
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

function normalizeIp(raw: string | undefined): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  return trimmed.toLowerCase().startsWith("::ffff:") ? trimmed.slice(7) : trimmed;
}

function isLocalOrPrivateProxyIp(ip: string): boolean {
  if (!ip) return true;
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "localhost" || lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) {
    return true;
  }
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(lower);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return (
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254)
  );
}

/**
 * Extracts a bounded client IP key for per-IP rate limiting behind Railway/Cloudflare proxies.
 * Uses the rightmost proxy-appended X-Forwarded-For hop when the immediate peer is a local/private
 * reverse proxy, preventing client-controlled leftmost X-Forwarded-For spoofing.
 */
export function sandboxClientKey(
  headers: Record<string, string | string[] | undefined>,
  remoteAddress?: string,
  expressIp?: string,
): string {
  const peer = normalizeIp(remoteAddress);
  if (isLocalOrPrivateProxyIp(peer)) {
    const xff = headers["x-forwarded-for"];
    const rawXff = Array.isArray(xff) ? xff.join(",") : xff;
    const hops = rawXff
      ?.split(",")
      .map((h) => normalizeIp(h))
      .filter(Boolean);
    const rightmostHop = hops && hops.length > 0 ? hops[hops.length - 1] : undefined;
    const candidate = rightmostHop || normalizeIp(expressIp) || peer || "unknown";
    return candidate.slice(0, 128);
  }
  return (peer || normalizeIp(expressIp) || "unknown").slice(0, 128);
}

export interface SandboxRateLimiterOptions {
  /** General API requests per minute per IP (default: 600). */
  apiPerMinute?: number;
  /** Spreadsheet import/refresh requests per 10 minutes per IP (default: 10). */
  uploadsPerTenMinutes?: number;
  /** Read-only spreadsheet preview requests per minute per IP (default: 30). */
  previewsPerMinute?: number;
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
 * Protects Railway CPU/RAM/disk against query floods and repeated large uploads,
 * while giving shared office/conference NAT IPs comfortable headroom on boot.
 */
export function createSandboxRateLimiter(opts: SandboxRateLimiterOptions = {}) {
  const apiLimit = opts.apiPerMinute ?? 600;
  const uploadLimit = opts.uploadsPerTenMinutes ?? 10;
  const previewLimit = opts.previewsPerMinute ?? 30;
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
    const upper = method.toUpperCase();
    const normalized = path.toLowerCase().replace(/^\/api(?=\/|$)/, "").replace(/\/+$/, "") || "/";
    const isHeavyUpload =
      upper === "POST" &&
      /^\/modeler\/spreadsheet\/(import|refresh)(\/|$)/.test(normalized);
    const isPreviewUpload =
      upper === "POST" &&
      normalized === "/modeler/spreadsheet/preview";

    if (isHeavyUpload) {
      const res = take(`upload\0${clientKey}`, uploadLimit, 10 * 60_000);
      if (!res.allowed) return { ...res, bucket: "upload" };
    } else if (isPreviewUpload) {
      const res = take(`preview\0${clientKey}`, previewLimit, 60_000);
      if (!res.allowed) return { ...res, bucket: "upload" };
    }
    const apiRes = take(`api\0${clientKey}`, apiLimit, 60_000);
    return { ...apiRes, bucket: "api" };
  };
}
