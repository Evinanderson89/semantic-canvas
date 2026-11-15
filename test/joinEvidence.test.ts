import { expect, it } from "vitest";
import { DuckDBInstance } from "@duckdb/node-api";
import { probeJoins } from "../src/modeler/introspect.ts";
import { formatJoinResolution, propose, type TableProfile } from "../src/modeler/propose.ts";
import { conn } from "./fixtures.ts";

const column = (name: string, n: number, distinct: number) => ({ name, type: "string", rawType: "VARCHAR", nonNull: n, distinct });
const tables: TableProfile[] = [
  { name: "fct_orders", rows: 10_000, columns: [column("order_id", 10_000, 10_000), column("customer_id", 10_000, 10)] },
  { name: "dim_customers", rows: 10, columns: [column("customer_id", 10, 10)] },
];
const candidate = { left: "fct_orders", leftOn: "customer_id", right: "dim_customers", rightOn: "customer_id" };

it("does not call a nearly complete join 100%, and retains exact counts and their scope", () => {
  const proposal = propose({ id: "near", label: "Near match", tables, probes: [{ ...candidate, leftRows: 10_000, matched: 9999 }] });
  expect(proposal.joins[0].evidence).not.toContain("100%");
  expect(proposal.joins[0].evidence).toContain("9,999 matched; 1 unmatched");
  expect(proposal.joins[0].evidence).toContain("non-null");
  expect(proposal.warnings.some(w => w.includes("1 unmatched"))).toBe(true);
});

it("keeps a failed query unmeasured and leaves its join out until the reviewer opts in", async () => {
  const probes = await probeJoins({ ...conn, execute: async () => { throw new Error("Warehouse connection failed"); } }, tables);
  expect(probes).toEqual([{ ...candidate, leftRows: null, matched: null, failure: "query-failed" }]);
  const proposal = propose({ id: "failed", label: "Failed check", tables, probes });
  expect(proposal.joins[0]).toMatchObject({ resolution: null, include: false });
  expect(proposal.joins[0].evidence).toContain("check failed");
  expect(proposal.joins[0].evidence).not.toContain("0%");
  expect(proposal.warnings.some(w => w.includes("check failed"))).toBe(true);
});

it.each([
  { columns: ["n", "matched"], rows: [] },
  { columns: ["n", "matched"], rows: [[10, 5], [10, 5]] },
  { columns: ["n", "n", "matched"], rows: [[10, 10, 5]] },
  { columns: ["matched"], rows: [[0]] },
  { columns: ["n", "matched"], rows: [[null, null]] },
  { columns: ["n", "matched"], rows: [[true, 0]] },
  { columns: ["n", "matched"], rows: [["", 0]] },
  { columns: ["n", "matched"], rows: [[10, 11]] },
  { columns: ["n", "matched"], rows: [[10, -1]] },
  { columns: ["n", "matched"], rows: [[10, 1.5]] },
  { columns: ["n", "matched"], rows: [[Number.MAX_SAFE_INTEGER + 1, 10]] },
])("does not turn invalid aggregate results into zero-match evidence: %j", async result => {
  const probes = await probeJoins({ ...conn, execute: async () => ({ ...result, sql: "", ms: 0 }) }, tables);
  expect(probes[0]).toMatchObject({ leftRows: null, matched: null, failure: "invalid-result" });
  const proposal = propose({ id: "invalid", label: "Invalid check", tables, probes });
  expect(proposal.joins[0]).toMatchObject({ resolution: null, include: false });
});

it("measures key rows with actual SQL, excludes nulls, and does not multiply matches from repeated right keys", async () => {
  const db = await (await DuckDBInstance.create(":memory:")).connect();
  try {
    await db.run(`CREATE TABLE fct_orders(customer_id VARCHAR);
      INSERT INTO fct_orders VALUES ('a'),('a'),('missing'),(NULL);
      CREATE TABLE dim_customers(customer_id VARCHAR);
      INSERT INTO dim_customers VALUES ('a'),('a'),(NULL);`);
    const probes = await probeJoins({ ...conn, relation: name => conn.quote(name), execute: async sql => {
      const result = await db.runAndReadAll(sql);
      return { columns: result.columnNames(), rows: result.getRows(), sql, ms: 0 };
    } }, tables);
    expect(probes).toEqual([{ ...candidate, leftRows: 3, matched: 2 }]);
    const proposal = propose({ id: "actual", label: "Actual SQL", tables, probes });
    expect(proposal.joins[0].evidence).toContain("2 matched; 1 unmatched");
    expect(proposal.joins[0].evidence).toContain("3 non-null");
  } finally { db.closeSync(); }
});

it("accepts exact numeric count strings without confusing complete matches with rounded percentages", async () => {
  const probes = await probeJoins({ ...conn, execute: async () => ({ columns: ["n", "matched"], rows: [["10000", "10000"]], sql: "", ms: 0 }) }, tables);
  expect(probes[0]).toMatchObject({ leftRows: 10_000, matched: 10_000 });
  expect(propose({ id: "complete", label: "Complete", tables, probes }).joins[0].evidence).toContain("100%");
  for (const [value, label] of [[1, "100%"], [0, "0%"], [0.999999, "<100%"], [0.000001, ">0%"], [0.998, "99.8%"], [0.9999, "99.99%"], [null, "not measured"], [NaN, "not measured"]] as const) {
    expect(formatJoinResolution(value)).toBe(label);
  }
});

it("distinguishes an empty denominator from a measured zero-match result", async () => {
  const empty = await probeJoins({ ...conn, execute: async () => ({ columns: ["n", "matched"], rows: [[0, 0]], sql: "", ms: 0 }) }, tables);
  const emptyProposal = propose({ id: "empty", label: "Empty keys", tables, probes: empty });
  expect(emptyProposal.joins[0]).toMatchObject({ resolution: null, include: false });
  expect(emptyProposal.joins[0].evidence).toContain("No non-null");
  const zero = await probeJoins({ ...conn, execute: async () => ({ columns: ["n", "matched"], rows: [[10, 0]], sql: "", ms: 0 }) }, tables);
  const zeroProposal = propose({ id: "zero", label: "No matches", tables, probes: zero });
  expect(zeroProposal.joins[0]).toMatchObject({ resolution: 0, include: false });
  expect(zeroProposal.joins[0].evidence).toContain("0 matched; 10 unmatched");
});
