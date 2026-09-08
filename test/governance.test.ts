import { describe, expect, it } from "vitest";
import { compileTile } from "../src/compiler/compile.ts";
import { scopeFor, type RlsConfig } from "../src/security/rls.ts";
import type { TileSpec } from "../src/compiler/spec.ts";
import { conn, model, tile } from "./fixtures.ts";

const cfg: RlsConfig = {
  policies: [{ id: "region", table: "dim_users", column: "country", claim: "regions" }],
  principals: {
    admin: { id: "admin", name: "admin", regions: "*" },
    emea: { id: "emea", name: "emea", regions: ["GB", "DE"] },
    empty: { id: "empty", name: "empty", regions: [] },
  },
};

describe("row-level security", () => {
  it("injects a predicate for a restricted principal", () => {
    const s = scopeFor(model, "fct_sales", cfg, cfg.principals.emea);
    expect(s.filters).toHaveLength(1);
    expect(s.filters[0].values).toEqual(["GB", "DE"]);
  });

  it("exempts a principal with a wildcard claim", () => {
    expect(scopeFor(model, "fct_sales", cfg, cfg.principals.admin).filters).toEqual([]);
  });

  it("denies an unknown principal rather than failing open", () => {
    const s = scopeFor(model, "fct_sales", cfg, null);
    expect(s.filters).toHaveLength(1);
    expect(s.filters[0].values).toEqual([]);
  });

  it("compiles an empty allow-list to FALSE, not to a no-op", () => {
    // The single most dangerous bug an RLS layer can have is dropping its own
    // predicate when the allow-list is empty.
    const s = scopeFor(model, "fct_sales", cfg, cfg.principals.empty);
    const sql = compileTile(model, conn,
      { ...tile(), where: s.filters } as TileSpec);
    expect(sql).toContain("FALSE");
  });

  it("forces the join so a policy cannot be dodged by not joining", () => {
    const s = scopeFor(model, "fct_sales", cfg, cfg.principals.emea);
    const sql = compileTile(model, conn, { ...tile(), where: s.filters } as TileSpec);
    expect(sql).toContain("LEFT JOIN");
    expect(sql).toContain("dim_users");
    expect(sql).toContain(`dim_users."country" IN ('GB', 'DE')`);
  });

  it("reports a policy it cannot enforce instead of silently passing", () => {
    const orphan = { ...model, joins: [] };
    const s = scopeFor(orphan, "fct_sales", cfg, cfg.principals.emea);
    expect(s.filters).toEqual([]);
    expect(s.unenforceable.map((p) => p.id)).toEqual(["region"]);
  });
});

describe("period-over-period", () => {
  const t = (over: Partial<TileSpec>) =>
    ({ ...tile({ dimensions: ["month:sold_on"] }), ...over } as TileSpec);

  it("emits prior, delta and percent columns", () => {
    const sql = compileTile(model, conn, t({ compare: "prior" }));
    expect(sql).toContain(`AS "revenue__prev"`);
    expect(sql).toContain(`AS "revenue__delta"`);
    expect(sql).toContain(`AS "revenue__pct"`);
    expect(sql).toContain("LEFT JOIN __base prev");
  });

  it("looks up the previous calendar year", () => {
    expect(compileTile(model, conn, t({ compare: "yoy" }))).toContain("INTERVAL '-1 year'");
  });

  it("partitions by the non-time dimensions so regions do not bleed together", () => {
    const sql = compileTile(model, conn,
      t({ dimensions: ["month:sold_on", "dim_users.country"], compare: "prior" }));
    expect(sql).toContain(`cur."country" IS NOT DISTINCT FROM prev."country"`);
  });

  it("rejects comparison without a time dimension", () => {
    expect(() => compileTile(model, conn, t({ dimensions: [], compare: "prior" })))
      .toThrow(/requires a time dimension/);
  });
});
