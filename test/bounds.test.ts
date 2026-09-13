import { describe, expect, it } from "vitest";
import { LIMITS, joinCandidates, probeJoins, profileTables } from "../src/modeler/introspect.ts";
import type { Connector, QueryResult } from "../src/connectors/types.ts";
import type { TableProfile } from "../src/modeler/propose.ts";

// The Modeler's bounds (docs/modeler.md): a warehouse larger than the limits is read up to them, in order, never all of it.
const fake = (): Connector & { calls: string[] } => {
  const calls: string[] = [];
  return {
    id: "fake", label: "fake", calls,
    quote: (i) => `"${i}"`, dateTrunc: (g, e) => e, dateAdd: (_u, e) => e, relation: (t) => t,
    async execute(sql: string): Promise<QueryResult> {
      calls.push(sql);
      // A profile query: one row of counts; a probe: n and matched.
      if (sql.startsWith("SELECT COUNT(")) {
        const cols = [...sql.matchAll(/AS "([^"]+)"/g)].map((m) => m[1]);
        return { columns: ["n", ...cols], rows: [[10, ...cols.map((c) => (c.startsWith("d") ? 10 : c.startsWith("nn") ? 10 : null))]], sql, ms: 0 };
      }
      return { columns: ["n", "matched"], rows: [[10, 10]], sql, ms: 0 };
    },
    async close() {},
  };
};

describe("modeler bounds", () => {
  it("profiles at most LIMITS.tables tables and LIMITS.columns columns each, one query per table", async () => {
    const c = fake();
    const catalog = Array.from({ length: LIMITS.tables + 50 }, (_, i) => ({ name: `t${i}`, columns: Array.from({ length: LIMITS.columns + 20 }, (_, j) => ({ name: `c${j}`, type: "VARCHAR" })) }));
    const profiles = await profileTables(c, catalog);
    expect(profiles).toHaveLength(LIMITS.tables);
    expect(profiles[0].columns).toHaveLength(LIMITS.columns);
    expect(c.calls).toHaveLength(LIMITS.tables);
    expect(c.calls[0].match(/COUNT\(DISTINCT/g)?.length).toBe(LIMITS.columns);
  });
  it("probes at most LIMITS.probes candidate joins", async () => {
    const c = fake();
    // Each fact points at every dim by an id-like column named after the dim's key.
    const dims: TableProfile[] = Array.from({ length: 30 }, (_, i) => ({ name: `dim_${i}`, rows: 10, columns: [{ name: `k${i}_id`, type: "string", rawType: "VARCHAR", nonNull: 10, distinct: 10 }] }));
    const facts: TableProfile[] = Array.from({ length: 4 }, (_, f) => ({ name: `fct_${f}`, rows: 100, columns: [{ name: "row_id", type: "string", rawType: "VARCHAR", nonNull: 100, distinct: 100 }, ...dims.map((d) => ({ name: d.columns[0].name, type: "string", rawType: "VARCHAR", nonNull: 100, distinct: 10 }))] }));
    const candidates = joinCandidates([...facts, ...dims]);
    expect(candidates).toHaveLength(LIMITS.probes);
    const probes = await probeJoins(c, [...facts, ...dims], candidates);
    expect(probes).toHaveLength(LIMITS.probes);
    expect(c.calls).toHaveLength(LIMITS.probes);
  });
});
