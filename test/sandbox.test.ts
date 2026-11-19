import { describe, expect, it } from "vitest";
import {
  createSandboxRateLimiter,
  isSandboxMode,
  isSandboxOriginAllowed,
  SANDBOX_MAX_SPREADSHEET_SOURCES,
  sandboxBlockReason,
  sandboxClientKey,
} from "../src/security/sandbox.ts";

describe("Public Sandbox guard (SC_SANDBOX_MODE)", () => {
  it("parses SC_SANDBOX_MODE safely", () => {
    expect(isSandboxMode({ SC_SANDBOX_MODE: "true" })).toBe(true);
    expect(isSandboxMode({ SC_SANDBOX_MODE: "1" })).toBe(true);
    expect(isSandboxMode({ SC_SANDBOX_MODE: "YES" })).toBe(true);
    expect(isSandboxMode({ SC_SANDBOX_MODE: "false" })).toBe(false);
    expect(isSandboxMode({})).toBe(false);
    expect(SANDBOX_MAX_SPREADSHEET_SOURCES).toBeGreaterThanOrEqual(5);
  });

  it("allows read endpoints, analytics queries, dashboards, and ephemeral spreadsheet uploads/refreshes", () => {
    expect(sandboxBlockReason("GET", "/api/sources")).toBeNull();
    expect(sandboxBlockReason("GET", "/api/model")).toBeNull();
    expect(sandboxBlockReason("GET", "/api/operations/status")).toBeNull();
    expect(sandboxBlockReason("POST", "/api/query")).toBeNull();
    expect(sandboxBlockReason("POST", "/api/dashboards")).toBeNull();
    expect(sandboxBlockReason("POST", "/api/modeler/spreadsheet/preview")).toBeNull();
    expect(sandboxBlockReason("POST", "/api/modeler/spreadsheet/import")).toBeNull();
    expect(sandboxBlockReason("POST", "/api/modeler/spreadsheet/refresh/q3-sales")).toBeNull();
  });

  it("hard-blocks warehouse mutations, .env credential writes, AI key saves, sensitive GETs, local setup checks, MCP, and shared deletions", () => {
    // Mutations
    expect(sandboxBlockReason("POST", "/api/sources")).toMatch(/public sandbox/i);
    expect(sandboxBlockReason("PUT", "/api/sources/sample-saas")).toMatch(/public sandbox/i);
    expect(sandboxBlockReason("DELETE", "/api/sources/sample-saas")).toMatch(/public sandbox/i);
    expect(sandboxBlockReason("POST", "/api/agent/key")).toMatch(/public sandbox/i);
    expect(sandboxBlockReason("DELETE", "/api/agent/key")).toMatch(/public sandbox/i);
    expect(sandboxBlockReason("POST", "/api/setup/model")).toMatch(/public sandbox/i);
    expect(sandboxBlockReason("POST", "/api/modeler/drafts")).toMatch(/public sandbox/i);
    expect(sandboxBlockReason("POST", "/api/scim/v2/Users")).toMatch(/public sandbox/i);
    expect(sandboxBlockReason("DELETE", "/api/dashboards/dash-1")).toMatch(/public sandbox/i);
    expect(sandboxBlockReason("DELETE", "/api/library/folders/f-1")).toMatch(/public sandbox/i);

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

  it("extracts bounded client keys and rate-limits general API and spreadsheet uploads per IP", () => {
    expect(sandboxClientKey({ "x-forwarded-for": "203.0.113.5, 10.0.0.1" }, "127.0.0.1")).toBe("203.0.113.5");
    expect(sandboxClientKey({}, "198.51.100.9")).toBe("198.51.100.9");
    expect(sandboxClientKey({}, undefined)).toBe("unknown");

    let clock = 1_000_000;
    const check = createSandboxRateLimiter({
      apiPerMinute: 3,
      uploadsPerTenMinutes: 2,
      maxKeys: 3,
      now: () => clock,
    });

    // General API bucket allows 3/min then returns 429 metadata until the window expires.
    expect(check("1.2.3.4", "POST", "/api/query").allowed).toBe(true);
    expect(check("1.2.3.4", "POST", "/api/query").allowed).toBe(true);
    expect(check("1.2.3.4", "POST", "/api/query").allowed).toBe(true);
    const blockedApi = check("1.2.3.4", "POST", "/api/query");
    expect(blockedApi.allowed).toBe(false);
    expect(blockedApi.bucket).toBe("api");
    expect(blockedApi.retryAfterSeconds).toBeGreaterThan(0);

    // Different IP is unaffected.
    expect(check("5.6.7.8", "POST", "/api/query").allowed).toBe(true);

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
});
