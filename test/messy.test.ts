import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeMessyLake, MESSY_TODAY } from "../src/testing/messyLake.ts";
import { pooledDuckdb } from "../src/connectors/pool.ts";
import { joinCandidates, probeJoins, profileTables } from "../src/modeler/introspect.ts";
import { propose } from "../src/modeler/propose.ts";
import { driftOf, extendProposal } from "../src/modeler/extend.ts";
import { compileTile, splitPartialPeriods } from "../src/compiler/compile.ts";
import { reviewDataHonesty } from "../src/suggest/dataHonesty.ts";
import { proposalProblems } from "../src/modeler/proposals.ts";
import { duckglueAdapter } from "../src/semantic/duckglue.ts";
import type { Connector } from "../src/connectors/types.ts";
import type { Model } from "../src/semantic/model.ts";

// The messy lake (docs/messy-lake.md): every tool names the mess it was built to name.
let dir: string, conn: Connector, model: Model, counts: Record<string, number>;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "sc-messy-"));
  ({ tables: counts } = await writeMessyLake(dir));
  conn = await pooledDuckdb(join(dir, "lake"), { size: 1 });
  model = (await duckglueAdapter.load("sample-data/messy/warehouse.yaml"))!;
}, 120_000);
afterAll(async () => { await conn.close(); rmSync(dir, { recursive: true, force: true }); });

describe("the messy lake", () => {
  it("is generated the same every time", () => {
    expect(counts).toEqual({ dim_regions: 6, dim_customers: 1200, dim_products: 0, fct_orders: 20000, fct_refunds: 1500, fct_events: 50000, stg_orders_2024: expect.any(Number) });
    expect(counts.stg_orders_2024).toBeGreaterThan(1000);
  });

  it("the Modeler names the table with no key, leaves out the empty one, and flags the joins that do not resolve", async () => {
    const catalog = await conn.catalog!();
    const profiles = await profileTables(conn, catalog);
    const probes = await probeJoins(conn, profiles, joinCandidates(profiles));
    const p = propose({ id: "messy", label: "Messy", tables: profiles, probes });
    const t = Object.fromEntries(p.tables.map((x) => [x.name, x]));
    expect(t.fct_events).toMatchObject({ primaryKey: null, grain: "one row per event on occurred_at", kind: "fact" });
    expect(p.warnings).toContain("fct_events: no unique column; write its grain before publishing.");
    expect(t.dim_products).toMatchObject({ include: false, rows: 0 });
    expect(p.warnings).toContain("dim_products has no rows; it is left out.");
    expect(t.fct_orders).toMatchObject({ primaryKey: "order_id", kind: "fact", timeColumn: "ordered_at" });
    expect(t.dim_customers).toMatchObject({ primaryKey: "customer_id", kind: "dimension" });
    // Text that looks like a date is text; the time column is the real timestamp.
    expect(t.dim_customers.timeColumn).toBeNull();
    expect(t.dim_customers.columns.find((c) => c.name === "signup_date")!.type).toBe("string");
    const j = (l: string, r: string) => p.joins.find((x) => x.left === l && x.right === r)!;
    expect(j("fct_orders", "dim_customers").resolution).toBeGreaterThan(0.85);
    expect(j("fct_orders", "dim_customers").resolution).toBeLessThan(0.95);
    expect(j("fct_orders", "dim_customers").include).toBe(true);
    expect(p.warnings.some((w) => w.startsWith("fct_orders.customer_id → dim_customers: only") && w.includes("included, check it"))).toBe(true);
    expect(j("dim_customers", "dim_regions").resolution).toBeLessThan(0.95);
    expect(j("fct_refunds", "fct_orders").resolution).toBe(1);
    // Refunds fan out from orders; the Modeler proposes the join from the many side only.
    expect(p.joins.some((x) => x.left === "fct_orders" && x.right === "fct_refunds")).toBe(false);
    // amount is a measure; amount_text is not.
    expect(p.metrics.some((m) => m.name === "total_amount" && m.baseTable === "fct_orders")).toBe(true);
    expect(p.metrics.some((m) => m.expression.includes("amount_text"))).toBe(false);
  });

  it("drift names the renamed column and the metric it breaks; extend finds the tables the model never had", async () => {
    const catalog = await conn.catalog!();
    const drift = driftOf(model, catalog);
    expect(drift).toEqual([expect.objectContaining({ table: "fct_orders", column: "order_total", kind: "column_missing", metrics: ["revenue"], text: "fct_orders.order_total is gone from the warehouse; revenue breaks." })]);
    const profiles = await profileTables(conn, catalog);
    const p = extendProposal(propose({ id: "more", label: "More", tables: profiles, probes: await probeJoins(conn, profiles, joinCandidates(profiles)) }), model, "messy");
    expect(p.tables.filter((t) => t.status === "new").map((t) => t.name).sort()).toEqual(["dim_products", "dim_regions", "fct_events", "fct_refunds", "stg_orders_2024"]);
    expect(p.tables.filter((t) => t.status === "existing").map((t) => t.name).sort()).toEqual(["dim_customers", "fct_orders"]);
    expect(p.model.description).toContain("5 tables not in the model");
    expect(p.joins.find((j) => j.left === "fct_orders" && j.right === "dim_customers")!.status).toBe("existing");
    expect(p.joins.find((j) => j.left === "dim_customers" && j.right === "dim_regions")!.status).toBe("new");
    // A metric over the renamed column would be a gap suggestion for a modelled table.
    expect(p.metrics.find((m) => m.name === "total_amount")).toMatchObject({ status: "gap", baseTable: "fct_orders" });
  });

  it("the honesty rules see the incomplete newest week and say so on a comparison", async () => {
    const tile = { id: "t", kind: "metric", metrics: ["orders"], dimensions: ["week:ordered_at"], compare: "prior", layout: { x: 0, y: 0, w: 1, h: 1 } } as any;
    const r = splitPartialPeriods(await conn.execute(compileTile(model, conn, tile), 5000));
    // Rows dated in the future hide the true edge: the newest week looks complete, and the honesty rules say why.
    const today = new Date(`${MESSY_TODAY}T12:00:00Z`);
    const findings = reviewDataHonesty({ tile, model, columns: r.columns, rows: r.rows, partial: r.partial, timeDimension: "week:ordered_at", today });
    expect(findings.map((f) => f.rule)).toEqual(["future"]);
    expect(findings[0].text).toContain("after today: some rows are dated in the future");
    expect(findings[0].fixes).toEqual([{ kind: "exclude-future", field: "fct_orders.ordered_at", through: MESSY_TODAY }]);
    // With the fix applied, the real edge shows: the newest week is incomplete, and the comparison says so.
    const fixed = { ...tile, where: [{ id: "honesty:t:through-today", field: "fct_orders.ordered_at", source: "dimension", mode: "range", max: MESSY_TODAY }] };
    const r2 = splitPartialPeriods(await conn.execute(compileTile(model, conn, fixed), 5000));
    expect(r2.partial.end).toBe(true);
    const again = reviewDataHonesty({ tile: fixed, model, columns: r2.columns, rows: r2.rows, partial: r2.partial, timeDimension: "week:ordered_at", where: fixed.where as any, today });
    expect(again.map((f) => f.rule)).toEqual(["lagging"]);
    expect(again[0].text).toContain("The newest week is not finished and is left out");
  });

  it("a proposed metric over the text amount passes the vocabulary and is refused by the warehouse at the probe", async () => {
    const live: Model = { ...model, tables: { ...model.tables, fct_orders: { ...model.tables.fct_orders, columns: [...model.tables.fct_orders.columns, { name: "amount_text", type: "string" }] } } };
    expect(proposalProblems(live, { name: "text_total", label: "Text total", baseTable: "fct_orders", expression: "SUM(amount_text)" })).toEqual([]);
    const candidate: Model = { ...live, metrics: { ...live.metrics, text_total: { name: "text_total", label: "Text total", baseTable: "fct_orders", expression: "SUM(fct_orders.amount_text)", filter: null, synonyms: [] } } };
    await expect(conn.execute(compileTile(candidate, conn, { id: "p", kind: "metric", metrics: ["text_total"], dimensions: [], layout: { x: 0, y: 0, w: 1, h: 1 } } as any), 1)).rejects.toThrow();
  });
});
