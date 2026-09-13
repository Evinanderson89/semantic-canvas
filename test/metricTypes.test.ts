import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileTile, validateTile } from "../src/compiler/compile.ts";
import { computedMetricIssue, derivedReferences, metricComponents } from "../src/semantic/model.ts";
import { duckglueAdapter } from "../src/semantic/duckglue.ts";
import { duckdbConnector } from "../src/connectors/duckdb.ts";
import type { Connector } from "../src/connectors/types.ts";
import type { Model } from "../src/semantic/model.ts";
import { conn, model as base, tile } from "./fixtures.ts";

// Ratio, derived and cumulative metrics (docs/metric-types.md): defined from
// governed simple metrics, compiled through the same grouped query.
const model: Model = { ...base, metrics: { ...base.metrics,
  cost: { name: "cost", label: "Cost", baseTable: "fct_sales", expression: "SUM(fct_sales.amount) * 0.6", filter: null, synonyms: [] },
  margin: { name: "margin", label: "Margin", baseTable: "fct_sales", expression: "revenue - cost", type: "derived", filter: null, synonyms: [] },
  revenue_per_user: { name: "revenue_per_user", label: "Revenue per user", baseTable: "fct_sales", expression: "", type: "ratio", numerator: "revenue", denominator: "users_on_sales", filter: null, synonyms: [] },
  users_on_sales: { name: "users_on_sales", label: "Buyers", baseTable: "fct_sales", expression: "COUNT(DISTINCT fct_sales.user_id)", filter: null, synonyms: [] },
  running_revenue: { name: "running_revenue", label: "Running revenue", baseTable: "fct_sales", expression: "", type: "cumulative", metric: "revenue", filter: null, synonyms: [] },
  trailing_revenue: { name: "trailing_revenue", label: "Trailing 3", baseTable: "fct_sales", expression: "", type: "cumulative", metric: "revenue", window: 3, filter: null, synonyms: [] },
  sales_per_user: { name: "sales_per_user", label: "Sales per user", baseTable: "fct_sales", expression: "", type: "ratio", numerator: "revenue", denominator: "users", filter: null, synonyms: [] },
} };

describe("metric types: definitions", () => {
  it("knows what each metric is made of and refuses a definition that does not hold", () => {
    expect(metricComponents(model, model.metrics.margin).map((m) => m.name)).toEqual(["revenue", "cost"]);
    expect(metricComponents(model, model.metrics.revenue_per_user).map((m) => m.name)).toEqual(["revenue", "users_on_sales"]);
    expect(metricComponents(model, model.metrics.running_revenue).map((m) => m.name)).toEqual(["revenue"]);
    expect(derivedReferences(model, "revenue - cost * 'revenue'")).toEqual(["revenue", "cost"]);
    expect(computedMetricIssue(model, model.metrics.margin)).toBeNull();
    expect(computedMetricIssue(model, { ...model.metrics.margin, expression: "revenue - nope" })).toBeNull(); // an unknown name is left to SQL; the known ones are checked
    expect(computedMetricIssue(model, { ...model.metrics.margin, expression: "42" })).toContain("names other metrics");
    expect(computedMetricIssue(model, { ...model.metrics.margin, expression: "revenue - users" })).toContain('"users" is on dim_users, not fct_sales');
    expect(computedMetricIssue(model, { ...model.metrics.revenue_per_user, denominator: "margin" })).toContain('denominator must be a simple metric; "margin" is derived');
    expect(computedMetricIssue(model, { ...model.metrics.running_revenue, window: 0 })).toContain("window is a whole number");
    expect(computedMetricIssue(model, { ...model.metrics.revenue_per_user, numerator: undefined })).toContain("numerator is required");
  });
  it("validates tiles: cumulative needs time, a cross-table ratio stands alone with qualified dimensions", () => {
    expect(validateTile(model, tile({ metrics: ["running_revenue"] }) as any).map((i) => i.problem)).toEqual(["Running revenue is cumulative: it needs a time dimension to run along"]);
    expect(validateTile(model, tile({ metrics: ["running_revenue"], dimensions: ["month:sold_on"] }) as any)).toEqual([]);
    expect(validateTile(model, tile({ metrics: ["sales_per_user", "revenue"], dimensions: ["dim_users.country"] }) as any).map((i) => i.problem)[0]).toContain("charted on its own tile");
    expect(validateTile(model, tile({ metrics: ["sales_per_user"], dimensions: ["plan_id"] }) as any).map((i) => i.problem)[0]).toContain("name the dimension's table");
    expect(validateTile(model, tile({ metrics: ["sales_per_user"], dimensions: ["dim_users.country"] }) as any)).toEqual([]);
    expect(validateTile(model, tile({ metrics: ["margin", "revenue_per_user", "revenue"] }) as any)).toEqual([]);
  });
});

describe("metric types: SQL", () => {
  it("computes derived and ratio metrics in a select over the grouped rows, hiding components the tile did not ask for", () => {
    const sql = compileTile(model, conn, tile({ metrics: ["margin", "revenue_per_user"], dimensions: ["dim_users.country"] }) as any);
    expect(sql).toContain('SUM(fct_sales.amount) AS "__m_revenue"');
    expect(sql).toContain('SUM(fct_sales.amount) * 0.6 AS "__m_cost"');
    expect(sql).toContain('COUNT(DISTINCT fct_sales.user_id) AS "__m_users_on_sales"');
    expect(sql).toContain('"__m_revenue" - "__m_cost" AS "margin"');
    expect(sql).toContain('CAST("__m_revenue" AS DOUBLE) / NULLIF("__m_users_on_sales", 0) AS "revenue_per_user"');
    expect(sql.match(/SUM\(fct_sales\.amount\) AS/g)?.length).toBe(1); // the shared component is computed once
    // Asked for by name, the component keeps its own name.
    expect(compileTile(model, conn, tile({ metrics: ["margin", "revenue"] }) as any)).toContain('"revenue" - "__m_cost" AS "margin"');
    expect(sql.match(/FROM \(/g)?.length).toBe(1);
  });
  it("runs a cumulative metric as a window along the time axis, partitioned by the other dimensions, before the limit", () => {
    const sql = compileTile(model, conn, tile({ metrics: ["running_revenue", "trailing_revenue"], dimensions: ["month:sold_on", "dim_users.country"] }) as any);
    expect(sql).toContain('SUM("__m_revenue") OVER (PARTITION BY "country" ORDER BY "sold_on_month" ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS "running_revenue"');
    expect(sql).toContain('ROWS BETWEEN 2 PRECEDING AND CURRENT ROW) AS "trailing_revenue"');
    expect(sql.indexOf("OVER (")).toBeLessThan(sql.indexOf("LIMIT"));
    expect(sql).toContain('"__partial_start"');
  });
  it("joins the two sides of a cross-table ratio on the dimensions, each aligned on its own date, and refuses a filter one side cannot apply", () => {
    const sql = compileTile(model, conn, tile({ metrics: ["sales_per_user"], dimensions: ["dim_users.country"] }) as any);
    expect(sql).toContain("WITH __n AS (");
    expect(sql).toContain('SUM(fct_sales.amount) AS "__num"');
    expect(sql).toContain('COUNT(*) AS "__den"');
    expect(sql).toContain('COALESCE(__n."country", __d."country") AS "country"');
    expect(sql).toContain('CAST(__n."__num" AS DOUBLE) / NULLIF(__d."__den", 0) AS "sales_per_user"');
    expect(sql).toContain("FULL OUTER JOIN __d ON __n.\"country\" IS NOT DISTINCT FROM __d.\"country\"");
    expect(() => compileTile(model, conn, tile({ metrics: ["sales_per_user"], dimensions: ["dim_users.country"], where: [{ id: "f", field: "plan_id", source: "dimension", mode: "discrete", values: ["pro"] }] }) as any)).toThrow(/cannot be applied to both fct_sales and dim_users/);
  });
  it("keeps period-over-period columns for computed metrics", () => {
    const sql = compileTile(model, conn, tile({ metrics: ["margin"], dimensions: ["month:sold_on"], compare: "prior" }) as any);
    expect(sql).toContain('AS "margin__prev"');
    expect(sql).toContain('AS "margin__pct"');
  });
});

// On the sample lake: every computed metric in sample-data/warehouse.yaml returns rows that agree with its parts.
describe("metric types on the sample lake", () => {
  let lake: Model, c: Connector;
  beforeAll(async () => { lake = (await duckglueAdapter.load("sample-data/warehouse.yaml"))!; c = await duckdbConnector("sample-data/lake"); });
  afterAll(async () => { await c.close(); });
  const run = async (t: object) => c.execute(compileTile(lake, c, { id: "t", kind: "metric", layout: { x: 0, y: 0, w: 1, h: 1 }, ...t } as any), 5000);
  const col = (r: { columns: string[]; rows: unknown[][] }, name: string) => r.rows.map((row) => Number(row[r.columns.indexOf(name)]));
  it("a same-table ratio equals its parts divided; a derived metric equals its arithmetic", async () => {
    const r = await run({ metrics: ["mrr_per_subscriber", "mrr", "paying_subscribers"], dimensions: [] });
    expect(col(r, "mrr_per_subscriber")[0]).toBeCloseTo(col(r, "mrr")[0] / col(r, "paying_subscribers")[0], 6);
    const d = await run({ metrics: ["lost_mrr", "gross_new_mrr", "net_new_mrr"], dimensions: ["month:movement_date"] });
    expect(d.rows.length).toBeGreaterThan(3);
    for (let i = 0; i < d.rows.length; i++) expect(col(d, "lost_mrr")[i]).toBeCloseTo(col(d, "gross_new_mrr")[i] - col(d, "net_new_mrr")[i], 4);
  });
  it("a cumulative metric runs along the months; a trailing window sums the last three", async () => {
    const r = await run({ metrics: ["cumulative_net_new_mrr", "trailing_3_period_net_new_mrr", "net_new_mrr"], dimensions: ["month:movement_date"] });
    const net = col(r, "net_new_mrr"), cum = col(r, "cumulative_net_new_mrr"), tr = col(r, "trailing_3_period_net_new_mrr");
    let sum = 0;
    for (let i = 0; i < net.length; i++) { sum += net[i]; expect(cum[i]).toBeCloseTo(sum, 4); expect(tr[i]).toBeCloseTo(net.slice(Math.max(0, i - 2), i + 1).reduce((a, b) => a + b, 0), 4); }
  });
  it("a ratio across two fact tables aligns each side on its own month and divides", async () => {
    const r = await run({ metrics: ["new_customers_per_session"], dimensions: ["month:movement_date"] });
    expect(r.columns).toEqual(["movement_date_month", "new_customers_per_session"]);
    expect(r.rows.length).toBeGreaterThan(3);
    const n = await run({ metrics: ["new_paying_customers"], dimensions: ["month:movement_date"] }), s = await run({ metrics: ["web_sessions"], dimensions: ["month:session_date"] });
    const month = (row: unknown[]) => String(row[0]).slice(0, 7);
    const sessions = new Map(s.rows.map((row) => [month(row), Number(row[1])])), customers = new Map(n.rows.map((row) => [month(row), Number(row[1])]));
    for (const row of r.rows) { const m = month(row); if (customers.has(m) && sessions.has(m)) expect(Number(row[1])).toBeCloseTo(customers.get(m)! / sessions.get(m)!, 8); }
    const byCountry = await run({ metrics: ["new_customers_per_session"], dimensions: ["dim_users.country"] });
    expect(byCountry.columns).toEqual(["country", "new_customers_per_session"]);
    expect(byCountry.rows.length).toBeGreaterThan(1);
  });
});
