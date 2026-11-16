import { describe, expect, it } from "vitest";
import { DuckDBInstance } from "@duckdb/node-api";
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

  it("executes an empty or unknown allow-list as no rows while authorized scopes return their own totals", async () => {
    const instance = await DuckDBInstance.create(":memory:"), db = await instance.connect();
    const connector = { ...conn, relation: (table: string) => conn.quote(table) };
    try {
      await db.run(`CREATE TABLE fct_sales (user_id VARCHAR, amount DOUBLE, sold_on DATE);
        CREATE TABLE dim_users (user_id VARCHAR, country VARCHAR);
        INSERT INTO dim_users VALUES ('one','GB'),('two','US'),('three','DE');
        INSERT INTO fct_sales VALUES ('one',10,'2026-01-02'),('two',20,'2026-01-02'),('three',30,'2026-01-02');`);
      for (const [principal, expected] of [[cfg.principals.admin, [60]], [cfg.principals.emea, [40]], [cfg.principals.empty, []], [null, []]] as const) {
        const scope = scopeFor(model, "fct_sales", cfg, principal);
        const query = compileTile(model, connector, tile({ dimensions: ["month:sold_on"], where: scope.filters }));
        const result = await db.runAndReadAll(query), column = result.columnNames().indexOf("revenue");
        expect(column).toBeGreaterThanOrEqual(0);
        expect(result.getRows().map(row => row[column]), principal?.id ?? "unknown principal").toEqual(expected);
      }
    } finally { db.closeSync(); instance.closeSync(); }
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
