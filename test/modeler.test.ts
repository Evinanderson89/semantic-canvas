import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pooledDuckdb } from "../src/connectors/pool.ts";
import { joinCandidates, probeJoins, profileTables } from "../src/modeler/introspect.ts";
import { findKey, normalizeType, prettyName, propose, type TableProfile } from "../src/modeler/propose.ts";
import { proposalIssues, proposalToYaml } from "../src/modeler/yaml.ts";
import { duckglueAdapter } from "../src/semantic/duckglue.ts";
import { compileTile, validateTile } from "../src/compiler/compile.ts";
import type { Connector } from "../src/connectors/types.ts";

// The proposal rules on synthetic profiles: what is asserted must be what
// the numbers support.
const col = (name: string, type: string, rows: number, o: Partial<{ nonNull: number; distinct: number }> = {}) =>
  ({ name, type, rawType: type, nonNull: o.nonNull ?? rows, distinct: o.distinct ?? Math.min(rows, 5) });
const orders: TableProfile = { name: "fct_orders", rows: 1000, columns: [
  col("order_id", "string", 1000, { distinct: 1000 }), col("customer_id", "string", 1000, { distinct: 120 }), col("ordered_on", "date", 1000, { distinct: 300 }),
  col("amount", "double", 1000, { distinct: 900 }), col("status", "string", 1000, { distinct: 4 }) ] };
const customers: TableProfile = { name: "dim_customers", rows: 120, columns: [ col("customer_id", "string", 120, { distinct: 120 }), col("country", "string", 120, { distinct: 12 }), col("signed_up_on", "date", 120, { distinct: 100 }) ] };
const log: TableProfile = { name: "raw_clicks", rows: 500, columns: [ col("clicked_at", "timestamp", 500, { distinct: 480 }), col("page", "string", 500, { distinct: 30 }) ] };

describe("propose", () => {
  it("finds keys, grains, joins with evidence, kinds and metrics from the profile alone", () => {
    const p = propose({ id: "shop", label: "Shop", tables: [orders, customers, log], probes: [{ left: "fct_orders", leftOn: "customer_id", right: "dim_customers", rightOn: "customer_id", leftRows: 1000, matched: 998 }] });
    const o = p.tables.find((t) => t.name === "fct_orders")!, c = p.tables.find((t) => t.name === "dim_customers")!, l = p.tables.find((t) => t.name === "raw_clicks")!;
    expect(o).toMatchObject({ kind: "fact", grain: "one row per order_id", primaryKey: "order_id", timeColumn: "ordered_on", include: true });
    expect(o.evidence).toContain("order_id is unique across 1,000 rows");
    expect(c).toMatchObject({ kind: "dimension", primaryKey: "customer_id" });
    expect(l).toMatchObject({ kind: "fact", primaryKey: null, grain: "one row per event on clicked_at" });
    expect(p.warnings).toContain("raw_clicks: no unique column; write its grain before publishing.");
    expect(p.joins).toEqual([expect.objectContaining({ left: "fct_orders", leftOn: "customer_id", right: "dim_customers", rightOn: "customer_id", include: true, resolution: 0.998 })]);
    expect(p.joins[0].evidence).toBe("customer_id is dim_customers's key; 99.8% of fct_orders.customer_id values resolve.");
    const names = p.metrics.filter((m) => m.include).map((m) => m.name);
    expect(names).toEqual(expect.arrayContaining(["orders_count", "total_amount", "distinct_customers", "clicks_count"]));
    expect(p.metrics.find((m) => m.name === "total_amount")).toMatchObject({ baseTable: "fct_orders", expression: "SUM(fct_orders.amount)", label: "Total amount" });
    expect(p.metrics.find((m) => m.name === "customers_count")!.include).toBe(false);
  });
  it("leaves out a join that barely resolves and says so; an empty table is excluded", () => {
    const p = propose({ id: "s", label: "S", tables: [orders, customers, { name: "dim_empty", rows: 0, columns: [col("empty_id", "string", 0)] }],
      probes: [{ left: "fct_orders", leftOn: "customer_id", right: "dim_customers", rightOn: "customer_id", leftRows: 1000, matched: 200 }] });
    expect(p.joins[0]).toMatchObject({ include: false, resolution: 0.2 });
    expect(p.warnings).toContain("fct_orders.customer_id → dim_customers: only 20% of fct_orders.customer_id values resolve; left out.");
    expect(p.tables.find((t) => t.name === "dim_empty")!.include).toBe(false);
  });
  it("helpers: key preference, type vocabulary, names", () => {
    expect(findKey(orders)!.name).toBe("order_id");
    expect(findKey({ name: "t", rows: 3, columns: [col("amount", "double", 3, { distinct: 3 }), col("code", "string", 3, { distinct: 3 })] })!.name).toBe("code");
    for (const [raw, t] of [["VARCHAR", "string"], ["BIGINT", "integer"], ["NUMBER(38,0)", "integer"], ["NUMBER(10,2)", "double"], ["DOUBLE", "double"], ["TIMESTAMP_NTZ", "timestamp"], ["DATE", "date"], ["BOOLEAN", "boolean"], ["BLOB", "other"]]) expect(normalizeType(raw)).toBe(t);
    expect(prettyName("fct_web_sessions")).toBe("Web sessions");
    expect(prettyName("dim_users")).toBe("Users");
  });
});

describe("yaml", () => {
  it("writes a duckglue file the adapter loads, leaving out excluded tables and what names them", async () => {
    const p = propose({ id: "shop", label: "Shop", tables: [orders, customers, log] });
    p.tables.find((t) => t.name === "raw_clicks")!.include = false;
    p.tables.find((t) => t.name === "fct_orders")!.reportingLag = 2;
    const yaml = proposalToYaml(p);
    expect(yaml).not.toContain("raw_clicks");
    expect(yaml).toContain("reporting_lag: 2");
    const dir = mkdtempSync(join(tmpdir(), "sc-modeler-")); writeFileSync(join(dir, "m.yaml"), yaml);
    const model = (await duckglueAdapter.load(join(dir, "m.yaml")))!;
    expect(Object.keys(model.tables)).toEqual(["dim_customers", "fct_orders"]);
    expect(model.joins).toHaveLength(1);
    expect(model.metrics.total_amount.baseTable).toBe("fct_orders");
    expect(model.tables.fct_orders.reportingLagDays).toBe(2);
    expect(proposalIssues(p)).toEqual([]);
  });
  it("refuses to publish without a grain, a metric, or with an unsafe expression", () => {
    const p = propose({ id: "s", label: "S", tables: [log] });
    p.tables[0].grain = "";
    expect(proposalIssues(p)).toContain("raw_clicks: say what one row is (its grain).");
    p.tables[0].grain = "one row per click"; p.metrics.forEach((m) => (m.include = false));
    expect(proposalIssues(p)).toContain("Include at least one metric.");
    p.metrics[0].include = true; p.metrics[0].expression = "COUNT(*); DROP TABLE x";
    expect(proposalIssues(p)[0]).toMatch(/may not contain/);
  });
});

// End to end on the sample lake: the warehouse's own catalogue in, a model
// Canvas can query out.
describe("modeler on the sample lake", () => {
  let conn: Connector;
  beforeAll(async () => { conn = await pooledDuckdb("sample-data/lake", { size: 1 }); });
  afterAll(async () => { await conn.close(); });
  it("lists the lake, profiles it, probes joins, and publishes a model a tile compiles against", async () => {
    const catalog = await conn.catalog!();
    expect(catalog.map((t) => t.name)).toEqual(expect.arrayContaining(["dim_users", "dim_plans", "fct_events", "fct_web_sessions"]));
    expect(catalog.find((t) => t.name === "dim_users")!.columns.map((c) => c.name)).toContain("user_id");
    const profiles = await profileTables(conn, catalog);
    const users = profiles.find((p) => p.name === "dim_users")!;
    expect(users.rows).toBeGreaterThan(0);
    expect(findKey(users)!.name).toBe("user_id");
    const probes = await probeJoins(conn, profiles, joinCandidates(profiles));
    const eventsToUsers = probes.find((p) => p.left === "fct_events" && p.right === "dim_users")!;
    expect(eventsToUsers.matched / eventsToUsers.leftRows).toBeGreaterThan(0.99);
    const proposal = propose({ id: "lake", label: "Sample lake", tables: profiles, probes });
    expect(proposal.tables.find((t) => t.name === "dim_users")).toMatchObject({ kind: "dimension", grain: "one row per user_id" });
    expect(proposal.joins.some((j) => j.left === "fct_web_sessions" && j.right === "dim_users" && j.include)).toBe(true);
    for (const t of proposal.tables) if (!t.grain) t.grain = "one row per event";
    expect(proposalIssues(proposal)).toEqual([]);
    const dir = mkdtempSync(join(tmpdir(), "sc-modeler-lake-")); writeFileSync(join(dir, "lake.yaml"), proposalToYaml(proposal));
    const model = (await duckglueAdapter.load(join(dir, "lake.yaml")))!;
    const metric = Object.values(model.metrics).find((m) => m.baseTable === "fct_web_sessions" && m.expression === "COUNT(*)")!;
    const tile = { id: "t", kind: "metric", metrics: [metric.name], dimensions: ["month:session_date", "dim_users.country"], layout: { x: 0, y: 0, w: 1, h: 1 } } as any;
    expect(validateTile(model, tile)).toEqual([]);
    const r = await conn.execute(compileTile(model, conn, tile), 50);
    expect(r.rows.length).toBeGreaterThan(0);
  });
});
