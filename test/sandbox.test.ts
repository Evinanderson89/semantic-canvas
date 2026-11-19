import { describe, expect, it } from "vitest";
import { isSandboxMode, isSandboxOriginAllowed, SANDBOX_MAX_SPREADSHEET_SOURCES, sandboxBlockReason } from "../src/security/sandbox.ts";

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
    expect(sandboxBlockReason("POST", "/api/query")).toBeNull();
    expect(sandboxBlockReason("POST", "/api/dashboards")).toBeNull();
    expect(sandboxBlockReason("POST", "/api/modeler/spreadsheet/preview")).toBeNull();
    expect(sandboxBlockReason("POST", "/api/modeler/spreadsheet/import")).toBeNull();
    expect(sandboxBlockReason("POST", "/api/modeler/spreadsheet/refresh/q3-sales")).toBeNull();
  });

  it("hard-blocks warehouse mutations, .env credential writes, AI key saves, raw modeler drafts, and SCIM", () => {
    expect(sandboxBlockReason("POST", "/api/sources")).toMatch(/public sandbox/i);
    expect(sandboxBlockReason("PUT", "/api/sources/sample-saas")).toMatch(/public sandbox/i);
    expect(sandboxBlockReason("DELETE", "/api/sources/sample-saas")).toMatch(/public sandbox/i);
    expect(sandboxBlockReason("POST", "/api/agent/key")).toMatch(/public sandbox/i);
    expect(sandboxBlockReason("DELETE", "/api/agent/key")).toMatch(/public sandbox/i);
    expect(sandboxBlockReason("POST", "/api/setup/model")).toMatch(/public sandbox/i);
    expect(sandboxBlockReason("POST", "/api/modeler/drafts")).toMatch(/public sandbox/i);
    expect(sandboxBlockReason("POST", "/api/scim/v2/Users")).toMatch(/public sandbox/i);
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
});
