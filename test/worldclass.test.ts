import { beforeAll, afterAll, it, expect, vi } from "vitest";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { compileTile, validateTile } from "../src/compiler/compile.ts";
import { finishResult } from "../src/compiler/result.ts";
import { model, conn, tile } from "./fixtures.ts";
import { parseDrafts, documentGrain } from "../src/app/document.ts";
import { applyBestLayout } from "../src/canvas/layouts.ts";
import { applyProposal } from "../src/canvas/proposals.ts";
import { DEFAULT_CANVAS } from "../src/canvas/presets.ts";
import { leasePool } from "../src/connectors/leases.ts";
import { visibleQuery } from "../src/app/query.ts";

let db: DuckDBConnection;
let instance: DuckDBInstance;
beforeAll(async () => {
  instance = await DuckDBInstance.create(":memory:"); db = await instance.connect();
  await db.run("CREATE TABLE fct_sales AS SELECT DATE '2024-01-01' + CAST(range AS INT) AS sold_on, CAST(range AS DOUBLE) AS amount, CAST(range AS VARCHAR) AS user_id FROM range(800)");
});
afterAll(() => { db.closeSync(); instance.closeSync(); });
it("keeps the latest period and its calendar comparison beyond the default row limit", async () => {
  const t = tile({ dimensions: ["day:sold_on"], compare: "prior" });
  const sql = compileTile(model, { ...conn, relation: t => t }, t, { probe: true });
  const reader = await db.runAndReadAll(sql);
  const result = finishResult({ sql, ms: 0, columns: reader.columnNames(), rows: reader.getRows().map(r => r.map(v => v && typeof v === "object" ? String(v) : v)) }, t);
  expect(result.truncated).toBe(true); expect(result.rows).toHaveLength(500);
  expect(result.rows.at(-1)?.[result.columns.indexOf("revenue")]).toBe(799);
  expect(result.rows.at(-1)?.[result.columns.indexOf("revenue__prev")]).toBe(798);
  expect(result.rows[0][result.columns.indexOf("revenue")]).toBe(300);
  expect(result.warnings[0]).toMatch(/latest 500/);
});
it("does not claim truncation when the full result fits exactly", () => {
  const result = finishResult({ columns: ["country", "revenue"], rows: [["GB", 1], ["US", 2]], sql: "", ms: 0 }, tile({ dimensions: ["country"], limit: 2 }));
  expect(result.truncated).toBe(false); expect(result.rows).toHaveLength(2);
});
it("rejects unsupported snapshot grains and all-time snapshot totals", () => {
  const snapshot = { ...model, metrics: { ...model.metrics, revenue: { ...model.metrics.revenue, timeGrains: ["month" as const], timeDimension: "fct_sales.sold_on" } } };
  for (const dimensions of [[], ["day:sold_on"], ["quarter:sold_on"], ["year:sold_on"]]) expect(validateTile(snapshot, tile({ dimensions }))[0].problem).toMatch(/requires month/);
  expect(validateTile(snapshot, tile({ dimensions: ["month:sold_on"] }))).toEqual([]);
});
it("detects mixed periods and rejects malformed recovery records", () => {
  expect(documentGrain({ title: "Mixed", tiles: [tile({ dimensions: ["day:sold_on"] }), tile({ id: "b", dimensions: ["month:sold_on"] })] })).toBe("mixed");
  expect(() => parseDrafts('{}')).toThrow(/unreadable/);
  expect(() => parseDrafts('[{"spec":{}}]')).toThrow(/unreadable/);
});
it("keeps section headings above readable KPI rows at compact widths", () => {
  const heading = tile({ id: "section", kind: "heading", metrics: [], text: "Revenue", layout: { x: 24, y: 24, w: 500, h: 48 } });
  const kpis = Array.from({ length: 6 }, (_, i) => tile({ id: `k${i}`, chart: "kpi", section: "section", dimensions: ["month:sold_on"], layout: { x: i * 160, y: 90, w: 144, h: 156 } }));
  const result = applyBestLayout([heading, ...kpis, tile({ id: "chart", chart: "line", dimensions: ["month:sold_on"], layout: { x: 24, y: 270, w: 500, h: 300 } })], 640).tiles;
  const h = result.find(t => t.id === "section")!;
  for (const k of result.filter(t => t.chart === "kpi")) { expect(k.layout.w).toBeGreaterThanOrEqual(180); expect(k.layout.y).toBeGreaterThanOrEqual(h.layout.y + h.layout.h); }
  expect(new Set(result.filter(t => t.chart === "kpi").map(t => t.layout.y)).size).toBe(2);
});
it("preserves a pinned section when arranging other content", () => {
  const pinned = tile({ id: "p", pinned: true, layout: { x: 24, y: 24, w: 500, h: 300 } });
  expect(applyBestLayout([pinned, tile({ id: "next", kind: "heading", metrics: [], text: "Next", layout: { x: 24, y: 400, w: 500, h: 48 } })], 640).tiles[0]).toEqual(pinned);
});
it("validates a whole proposal before applying it and rejects invented metrics", () => {
  const spec = { title: "Before", tiles: [tile()] };
  const bad = { title: "Bad", reason: "Bad", actions: [{ type: "rename", title: "Changed" }, { type: "add", tile: tile({ id: "new", metrics: ["invented"] }) }] };
  expect(() => applyProposal(spec, DEFAULT_CANVAS, bad, model)).toThrow(/unknown metric/);
  expect(spec.title).toBe("Before"); expect(spec.tiles).toHaveLength(1);
  const good = applyProposal(spec, DEFAULT_CANVAS, { title: "Good", reason: "Clearer", actions: [{ type: "rename", title: "Revenue" }] }, model);
  expect(good.spec.title).toBe("Revenue"); expect(spec.title).toBe("Before");
});
it("uses the same filtered and drilled request for charts and review", () => {
  const q = visibleQuery(model, tile({ dimensions: ["month:sold_on"], chart: "kpi" }), [{ id: "country", source: "dimension", mode: "discrete", field: "dim_users.country", values: ["GB"] }], [{ grain: "day", column: "sold_on", min: "2024-03-01", max: "2024-03-31", label: "March" } as any]);
  expect(q.dimensions).toEqual(["day:sold_on"]); expect(q.where).toHaveLength(2); expect(q.compare).toBe("prior");
});
it("drains leases and closes retired connections only after active work finishes", async () => {
  const destroy = vi.fn(); const leases = leasePool(["connection"], destroy);
  const c = await leases.acquire();
  const queued = expect(leases.acquire()).rejects.toThrow(/replaced/);
  const closed = leases.close(); await queued;
  expect(destroy).not.toHaveBeenCalled(); await expect(leases.acquire()).rejects.toThrow(/replaced/);
  leases.release(c); await closed; await leases.close(); expect(destroy).toHaveBeenCalledTimes(1);
});

it("keeps Snowflake's TOML connection-file interface on the patched parser", async () => {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const sdkRequire = createRequire(require.resolve("snowflake-sdk"));
  const parser = sdkRequire("toml");
  expect(sdkRequire("toml/package.json").version).toMatch(/^5\./);
  const config = parser.parse('[default]\naccount = "sample-account"\nuser = "sample-user"\nwarehouse = "COMPUTE_WH"\nclient_session_keep_alive = true\n');
  expect(config.default).toMatchObject({ account: "sample-account", user: "sample-user", warehouse: "COMPUTE_WH", client_session_keep_alive: true });
  expect(() => parser.parse('x = [[[[[[1]]]]]]', { maxDepth: 4 })).toThrow();
});
