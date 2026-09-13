import { describe, expect, it } from "vitest";
import { scopeFor } from "../src/security/rls.ts";
import { requireScope } from "../src/security/queryScope.ts";
import { readGatewayPolicy } from "../src/security/auth.ts";
import { scopedBy } from "../src/app/Tile.tsx";
import { createHmac } from "node:crypto";
import { model } from "./fixtures.ts";

// Gateway policies (gateway-platform/docs/policy.md) arrive as rules; here they become the same filters our own policies become.
const cfg = { policies: [], principals: {} };
describe("gateway data policy in the query scope", () => {
  it("turns only/not rules into filters on the base table or through a declared join, and refuses what it cannot reach", () => {
    const s = scopeFor(model, "fct_sales", cfg, null, [{ field: "dim_users.country", mode: "only", values: ["GB", "DE"] }, { field: "fct_sales.plan_id", mode: "not", values: ["internal"] }]);
    expect(s.filters).toEqual([
      { id: "gateway:dim_users.country:only", field: "dim_users.country", source: "dimension", mode: "discrete", values: ["GB", "DE"] },
      { id: "gateway:fct_sales.plan_id:not", field: "plan_id", source: "dimension", mode: "discrete", values: ["internal"], exclude: true },
    ]);
    expect(s.unenforceable).toEqual([]);
    // dim_users cannot be reached from dim_plans: the query is refused rather than run unscoped.
    expect(() => requireScope(model, "dim_plans", cfg, null, [{ field: "dim_users.country", mode: "only", values: ["GB"] }])).toThrow(/cannot enforce gateway:dim_users.country/);
    // A table this model does not have is not this model's concern.
    expect(scopeFor(model, "fct_sales", cfg, null, [{ field: "other_app_table.col", mode: "only", values: ["x"] }]).filters).toEqual([]);
  });
  it("verifies the header exactly as the gateway signs it", () => {
    const secret = "s", now = Math.floor(Date.now() / 1000);
    const body = Buffer.from(JSON.stringify({ v: 1, sub: "u1", app: "canvas", iat: now, exp: now + 120, rules: [{ field: "dim_users.country", mode: "only", values: ["GB"] }] })).toString("base64url");
    const sig = createHmac("sha256", secret).update(body).digest("base64url");
    expect(readGatewayPolicy(body, sig, secret, "u1")).toEqual([{ field: "dim_users.country", mode: "only", values: ["GB"] }]);
    expect(readGatewayPolicy(body, sig, "other", "u1")).toBeNull();
    expect(readGatewayPolicy(body, sig, secret, "u2")).toBeNull();
    // Signed for this app, the rules apply; signed for another app, they are that app's, not ours.
    expect(readGatewayPolicy(body, sig, secret, "u1", Date.now(), "canvas")).toHaveLength(1);
    expect(readGatewayPolicy(body, sig, secret, "u1", Date.now(), "ingest")).toBeNull();
    const bad = Buffer.from(JSON.stringify({ v: 1, sub: "u1", app: "canvas", iat: now, exp: now + 120, rules: [{ field: "country", mode: "only", values: ["GB"] }] })).toString("base64url");
    expect(readGatewayPolicy(bad, createHmac("sha256", secret).update(bad).digest("base64url"), secret, "u1")).toBeNull();
    expect(readGatewayPolicy(undefined, undefined, secret, "u1")).toBeNull();
  });
});

describe("the tile chip", () => {
  it("says which gateway rules a query applied, in the session's own words, and nothing when none did", () => {
    const policy = [{ field: "dim_users.country", mode: "only" as const, values: ["GB", "DE"] }, { field: "fct_orders.status", mode: "not" as const, values: ["internal"] }];
    expect(scopedBy(["rls:region", "gateway:dim_users.country:only"], policy)).toEqual({ short: "country only GB, DE", full: "dim_users.country only GB, DE" });
    expect(scopedBy(["gateway:dim_users.country:only", "gateway:fct_orders.status:not"], policy)!.short).toBe("country only GB, DE; status not internal");
    expect(scopedBy(["rls:region"], policy)).toBeNull();
    expect(scopedBy(undefined, policy)).toBeNull();
    // A rule the session does not list (it changed since the page loaded) is still named by field.
    expect(scopedBy(["gateway:dim_users.plan:only"], policy)!.short).toBe("plan only");
  });
});
