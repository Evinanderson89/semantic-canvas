import { describe, expect, it } from "vitest";
import {
  createSandboxRateLimiter,
  generateSandboxSessionId,
  isRefreshableSpreadsheetSource,
  isSandboxMode,
  isSandboxOriginAllowed,
  isValidSandboxSessionId,
  redactSandboxError,
  resolveSandboxSession,
  SANDBOX_MAX_SPREADSHEET_SOURCES,
  SANDBOX_SESSION_COOKIE,
  SANDBOX_SESSION_HEADER,
  sandboxBlockReason,
  sandboxClientKey,
} from "../src/security/sandbox.ts";

describe("Public Sandbox guard (SC_SANDBOX_MODE)", () => {
  it("parses SC_SANDBOX_MODE safely and generates/validates 128-bit hex visitor session tokens", () => {
    expect(isSandboxMode({ SC_SANDBOX_MODE: "true" })).toBe(true);
    expect(isSandboxMode({ SC_SANDBOX_MODE: "1" })).toBe(true);
    expect(isSandboxMode({ SC_SANDBOX_MODE: "YES" })).toBe(true);
    expect(isSandboxMode({ SC_SANDBOX_MODE: "false" })).toBe(false);
    expect(isSandboxMode({})).toBe(false);
    expect(SANDBOX_MAX_SPREADSHEET_SOURCES).toBeGreaterThanOrEqual(5);

    const sid = generateSandboxSessionId();
    expect(sid).toMatch(/^[0-9a-f]{32}$/);
    expect(isValidSandboxSessionId(sid)).toBe(true);
    expect(isValidSandboxSessionId("not-hex-token")).toBe(false);
    expect(isValidSandboxSessionId("deadbeef")).toBe(false);

    const fresh = resolveSandboxSession({});
    expect(isValidSandboxSessionId(fresh.sessionId)).toBe(true);
    expect(fresh.shouldSetCookie).toBe(true);

    const fromCookie = resolveSandboxSession({ cookie: `other=1; ${SANDBOX_SESSION_COOKIE}=${sid}` });
    expect(fromCookie).toEqual({ sessionId: sid, shouldSetCookie: false });

    const headerToken = "ABCDEF0123456789ABCDEF0123456789";
    const fromHeader = resolveSandboxSession({ [SANDBOX_SESSION_HEADER]: headerToken });
    expect(fromHeader).toEqual({ sessionId: headerToken.toLowerCase(), shouldSetCookie: true });

    expect(redactSandboxError("Failed reading /Users/alice/.semantic-canvas/spreadsheets/secret/part-0.parquet"))
      .toBe("Failed reading [redacted-path]");
  });

  it("allows read endpoints, analytics queries, read-only digests, and ephemeral spreadsheet uploads/refreshes", () => {
    expect(sandboxBlockReason("GET", "/api/sources")).toBeNull();
    expect(sandboxBlockReason("GET", "/api/model")).toBeNull();
    expect(sandboxBlockReason("GET", "/api/operations/status")).toBeNull();
    expect(sandboxBlockReason("GET", "/api/dashboards")).toBeNull();
    expect(sandboxBlockReason("GET", "/api/library")).toBeNull();
    expect(sandboxBlockReason("POST", "/api/query")).toBeNull();
    expect(sandboxBlockReason("POST", "/api/dashboards/saas-overview/digest")).toBeNull();
    expect(sandboxBlockReason("POST", "/api/modeler/spreadsheet/preview")).toBeNull();
    expect(sandboxBlockReason("POST", "/api/modeler/spreadsheet/import")).toBeNull();
    expect(sandboxBlockReason("POST", "/api/modeler/spreadsheet/refresh/q3-sales")).toBeNull();
    expect(sandboxBlockReason("POST", "/api/modeler/spreadsheet/refresh/coffee-roastery-2tab")).toMatch(/public sandbox/i);
    expect(sandboxBlockReason("POST", "/api/modeler/spreadsheet/refresh/duckglue-local")).toMatch(/public sandbox/i);
    expect(sandboxBlockReason("POST", "/api/modeler/spreadsheet/refresh/us-grid-renewables/")).toMatch(/public sandbox/i);
  });

  it("hard-blocks modal spoofing (/agent/questions), shared dashboard/library/activity mutations, warehouse/AI writes, MCP, and SCIM", () => {
    // Modal hijack & polling blocked on ALL methods
    expect(sandboxBlockReason("GET", "/api/agent/questions")).toMatch(/public sandbox/i);
    expect(sandboxBlockReason("POST", "/api/agent/questions")).toMatch(/public sandbox/i);
    expect(sandboxBlockReason("POST", "/api/agent/questions/q1/answer/")).toMatch(/public sandbox/i);

    // Shared dashboard, library, and chart-activity vandalism blocked on POST/PUT/PATCH/DELETE
    expect(sandboxBlockReason("POST", "/api/dashboards")).toMatch(/public sandbox/i);
    expect(sandboxBlockReason("POST", "/api/dashboards/")).toMatch(/public sandbox/i);
    expect(sandboxBlockReason("POST", "/api/dashboards/import-yaml")).toMatch(/public sandbox/i);
    expect(sandboxBlockReason("POST", "/api/dashboards/d1/arrange")).toMatch(/public sandbox/i);
    expect(sandboxBlockReason("PUT", "/api/dashboards/d1")).toMatch(/public sandbox/i);
    expect(sandboxBlockReason("PATCH", "/api/dashboards/d1")).toMatch(/public sandbox/i);
    expect(sandboxBlockReason("DELETE", "/api/dashboards/dash-1")).toMatch(/public sandbox/i);

    expect(sandboxBlockReason("POST", "/api/library/folders")).toMatch(/public sandbox/i);
    expect(sandboxBlockReason("POST", "/api/library/views")).toMatch(/public sandbox/i);
    expect(sandboxBlockReason("PUT", "/api/library/views/v-1")).toMatch(/public sandbox/i);
    expect(sandboxBlockReason("PATCH", "/api/library/items/dashboard/d-1")).toMatch(/public sandbox/i);
    expect(sandboxBlockReason("DELETE", "/api/library/folders/f-1")).toMatch(/public sandbox/i);

    expect(sandboxBlockReason("POST", "/api/chart-activity/d-1/t-1/comments")).toMatch(/public sandbox/i);
    expect(sandboxBlockReason("PUT", "/api/chart-activity/d-1/t-1/alert")).toMatch(/public sandbox/i);
    expect(sandboxBlockReason("PATCH", "/api/chart-activity/d-1/t-1/alert")).toMatch(/public sandbox/i);

    // Warehouse & AI credential mutations
    expect(sandboxBlockReason("POST", "/api/sources")).toMatch(/public sandbox/i);
    expect(sandboxBlockReason("PUT", "/api/sources/sample-saas")).toMatch(/public sandbox/i);
    expect(sandboxBlockReason("DELETE", "/api/sources/sample-saas")).toMatch(/public sandbox/i);
    expect(sandboxBlockReason("POST", "/api/agent/key")).toMatch(/public sandbox/i);
    expect(sandboxBlockReason("DELETE", "/api/agent/key")).toMatch(/public sandbox/i);
    expect(sandboxBlockReason("POST", "/api/setup/model")).toMatch(/public sandbox/i);
    expect(sandboxBlockReason("POST", "/api/modeler/drafts")).toMatch(/public sandbox/i);
    expect(sandboxBlockReason("POST", "/api/scim/v2/Users")).toMatch(/public sandbox/i);

    // Sensitive reads & local tunnel/MCP endpoints (blocked on ALL methods)
    expect(sandboxBlockReason("GET", "/api/sources/duckglue-local/config")).toMatch(/public sandbox/i);
    expect(sandboxBlockReason("GET", "/api/operations/backup")).toMatch(/public sandbox/i);
    expect(sandboxBlockReason("GET", "/api/operations/audit")).toMatch(/public sandbox/i);
    expect(sandboxBlockReason("POST", "/api/operations/access/reload")).toMatch(/public sandbox/i);
    expect(sandboxBlockReason("GET", "/api/setup/chatgpt")).toMatch(/public sandbox/i);
    expect(sandboxBlockReason("POST", "/api/setup/chatgpt/check")).toMatch(/public sandbox/i);
    expect(sandboxBlockReason("POST", "/api/setup/claude/check")).toMatch(/public sandbox/i);
    expect(sandboxBlockReason("POST", "/api/mcp")).toMatch(/public sandbox/i);
    expect(sandboxBlockReason("GET", "/api/modeler/drafts")).toMatch(/public sandbox/i);
  });

  it("enforces same-origin CSRF checks and optional SC_SANDBOX_ORIGINS allowlist in sandbox mode", () => {
    expect(isSandboxOriginAllowed("try.semanticcanvas.ai", undefined, {})).toBe(true);
    expect(isSandboxOriginAllowed("try.semanticcanvas.ai", "https://try.semanticcanvas.ai", {})).toBe(true);
    expect(isSandboxOriginAllowed("try.semanticcanvas.ai", "https://evil.example.com", {})).toBe(false);
    expect(isSandboxOriginAllowed("", undefined, {})).toBe(false);

    const env = { SC_SANDBOX_ORIGINS: "https://try.semanticcanvas.ai, sandbox.up.railway.app" };
    expect(isSandboxOriginAllowed("try.semanticcanvas.ai", "https://try.semanticcanvas.ai", env)).toBe(true);
    expect(isSandboxOriginAllowed("sandbox.up.railway.app", undefined, env)).toBe(true);
    expect(isSandboxOriginAllowed("localhost:5174", "http://localhost:5174", env)).toBe(true);
    expect(isSandboxOriginAllowed("other.example.com", "https://other.example.com", env)).toBe(false);
  });

  it("extracts spoof-resistant rightmost proxy client keys and rate-limits general API (600/min default), previews, and uploads", () => {
    // Behind local/private reverse proxy: uses rightmost proxy-appended hop, defeating client XFF spoofing
    expect(sandboxClientKey({ "x-forwarded-for": "1.1.1.1, 203.0.113.5" }, "10.0.0.1")).toBe("203.0.113.5");
    expect(sandboxClientKey({ "x-forwarded-for": ["9.9.9.9", "203.0.113.7"] }, "::ffff:127.0.0.1")).toBe("203.0.113.7");
    // Direct external peer: ignores spoofed X-Forwarded-For header completely
    expect(sandboxClientKey({ "x-forwarded-for": "1.1.1.1" }, "198.51.100.9")).toBe("198.51.100.9");
    expect(sandboxClientKey({}, "198.51.100.9")).toBe("198.51.100.9");
    expect(sandboxClientKey({}, undefined)).toBe("unknown");

    // Default limiter allows 600 req/min so shared office NATs never 429 on boot
    const defaultCheck = createSandboxRateLimiter();
    for (let i = 0; i < 300; i++) {
      expect(defaultCheck("203.0.113.42", "GET", "/api/sources").allowed).toBe(true);
    }

    let clock = 1_000_000;
    const check = createSandboxRateLimiter({
      apiPerMinute: 4,
      uploadsPerTenMinutes: 2,
      previewsPerMinute: 2,
      maxKeys: 4,
      now: () => clock,
    });

    // General API bucket allows 4/min then returns 429 metadata until the window expires.
    expect(check("1.2.3.4", "POST", "/api/query").allowed).toBe(true);
    expect(check("1.2.3.4", "POST", "/api/query").allowed).toBe(true);
    expect(check("1.2.3.4", "POST", "/api/query").allowed).toBe(true);
    expect(check("1.2.3.4", "POST", "/api/query").allowed).toBe(true);
    const blockedApi = check("1.2.3.4", "POST", "/api/query");
    expect(blockedApi.allowed).toBe(false);
    expect(blockedApi.bucket).toBe("api");
    expect(blockedApi.retryAfterSeconds).toBeGreaterThan(0);

    // Different IP is unaffected; preview has its own fair upload-protected cap.
    expect(check("5.6.7.8", "POST", "/api/modeler/spreadsheet/preview").allowed).toBe(true);
    expect(check("5.6.7.8", "POST", "/api/modeler/spreadsheet/preview").allowed).toBe(true);
    const blockedPreview = check("5.6.7.8", "POST", "/api/modeler/spreadsheet/preview");
    expect(blockedPreview.allowed).toBe(false);
    expect(blockedPreview.bucket).toBe("upload");

    // Upload bucket enforces stricter 10-minute cap independently.
    expect(check("9.9.9.9", "POST", "/api/modeler/spreadsheet/import").allowed).toBe(true);
    expect(check("9.9.9.9", "POST", "/api/modeler/spreadsheet/refresh/sales").allowed).toBe(true);
    const blockedUpload = check("9.9.9.9", "POST", "/api/modeler/spreadsheet/import");
    expect(blockedUpload.allowed).toBe(false);
    expect(blockedUpload.bucket).toBe("upload");

    // Window resets cleanly once elapsed.
    clock += 10 * 60_000 + 1;
    expect(check("9.9.9.9", "POST", "/api/modeler/spreadsheet/import").allowed).toBe(true);
    expect(check("1.2.3.4", "POST", "/api/query").allowed).toBe(true);
  });

  it("marks only uploaded DuckDB spreadsheet sources as refreshable by file upload", () => {
    expect(isRefreshableSpreadsheetSource({ id: "duckglue-local", connector: "duckdb" })).toBe(false);
    expect(isRefreshableSpreadsheetSource({ id: "sample-warehouse", connector: "duckdb" })).toBe(false);
    expect(isRefreshableSpreadsheetSource({ id: "coffee-roastery-2tab", connector: "duckdb" })).toBe(false);
    expect(isRefreshableSpreadsheetSource({ id: "coffee-roastery-pnl", connector: "duckdb" })).toBe(false);
    expect(isRefreshableSpreadsheetSource({ id: "us-grid-renewables", connector: "duckdb" })).toBe(false);
    expect(isRefreshableSpreadsheetSource("coffee-roastery-2tab")).toBe(false);
    expect(isRefreshableSpreadsheetSource("q3-sales")).toBe(true);
    expect(isRefreshableSpreadsheetSource({ id: "q3-sales", connector: "duckdb" })).toBe(true);
    expect(isRefreshableSpreadsheetSource({ id: "q3-sales", connector: "DuckDB" })).toBe(true);
    expect(isRefreshableSpreadsheetSource({ id: "prod-pg", connector: "postgres" })).toBe(false);
    expect(isRefreshableSpreadsheetSource({ id: "bq-prod", connector: "bigquery" })).toBe(false);
    expect(isRefreshableSpreadsheetSource({ id: "sf-prod", connector: "snowflake" })).toBe(false);
    expect(isRefreshableSpreadsheetSource({ id: "no-conn", connector: null })).toBe(false);
  });
});
