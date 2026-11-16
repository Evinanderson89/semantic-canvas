import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { compileTile } from "../src/compiler/compile.ts";
import type { TileSpec } from "../src/compiler/spec.ts";
import type { Model } from "../src/semantic/model.ts";
import { conn, model as base, tile } from "./fixtures.ts";

const model: Model = { ...base, metrics: { ...base.metrics,
  running: { ...base.metrics.revenue, name: "running", type: "cumulative", metric: "revenue", expression: "" },
  trailing: { ...base.metrics.revenue, name: "trailing", type: "cumulative", metric: "revenue", window: 3, expression: "" },
  current: { ...base.metrics.revenue, name: "current", type: "cumulative", metric: "revenue", window: 1, expression: "" },
} };
let db: DuckDBConnection;
beforeAll(async () => { db = await (await DuckDBInstance.create(":memory:")).connect(); });
afterAll(() => db.closeSync());

// Inline synthetic records keep each calendar case independent. Dates are
// literal fixtures, not user input. Each series skips its second period.
async function run(dates: string[], grain: string, over: Partial<TileSpec> = {}, calendar?: Model["calendar"]) {
  const records = dates.flatMap((date, i) => [`('a', ${[10, 20, 30][i]}, DATE '${date}')`, `('b', ${[100, 200, 300][i]}, DATE '${date}')`]);
  const connector = { ...conn,
    relation: () => `(SELECT * FROM (VALUES ${records.join(",")}) AS records(user_id, amount, sold_on))`,
    dateTrunc: (g: string, e: string) => `CAST(date_trunc('${g}', ${e}) AS DATE)`,
  };
  const result = await db.runAndReadAll(compileTile({ ...model, calendar }, connector, tile({
    metrics: ["revenue", "trailing", "running", "current"], dimensions: [`${grain}:sold_on`, "user_id"], ...over,
  })));
  return result.getRows().map(row => Object.fromEntries(result.columnNames().map((c, i) => [c,
    row[i] !== null && typeof row[i] === "object" ? String(row[i]) : typeof row[i] === "bigint" ? Number(row[i]) : row[i],
  ])));
}

describe("trailing sums follow calendar periods, not available rows", () => {
  it.each([
    ["day", ["2024-02-27", "2024-02-29", "2024-03-01"]],
    ["week", ["2026-01-05", "2026-01-19", "2026-01-26"]],
    ["month", ["2026-01-01", "2026-03-01", "2026-04-01"]],
    ["quarter", ["2025-07-01", "2026-01-01", "2026-04-01"]],
    ["year", ["2023-01-01", "2025-01-01", "2026-01-01"]],
  ])("does not reach past a missing %s and keeps each segment separate", async (grain, dates) => {
    const rows = await run(dates as string[], grain as string);
    for (const [segment, scale] of [["a", 1], ["b", 10]] as const) {
      const series = rows.filter(r => r.user_id === segment);
      expect(series.map(r => r.trailing)).toEqual([10, 30, 50].map(n => n * scale));
      expect(series.map(r => r.running)).toEqual([10, 30, 60].map(n => n * scale));
      expect(series.map(r => r.current)).toEqual([10, 20, 30].map(n => n * scale));
      expect(series.map(r => r[`sold_on_${grain}`])).toEqual(dates);
    }
    // A missing period stays missing; the window does not insert a measured zero.
    expect(rows).toHaveLength(6);
  });

  it.each([
    ["week", ["2026-01-04", "2026-01-18", "2026-01-25"], { weekStart: "sunday", fiscalYearStartMonth: 1 }],
    ["quarter", ["2025-11-01", "2026-05-01", "2026-08-01"], { weekStart: "monday", fiscalYearStartMonth: 2 }],
    ["year", ["2023-02-01", "2025-02-01", "2026-02-01"], { weekStart: "monday", fiscalYearStartMonth: 2 }],
  ])("uses the model's %s boundaries", async (grain, dates, calendar) => {
    const rows = (await run(dates as string[], grain as string, {}, calendar as Model["calendar"])).filter(r => r.user_id === "a");
    expect(rows.map(r => r.trailing)).toEqual([10, 30, 50]);
    expect(rows.map(r => r[`sold_on_${grain}`])).toEqual(dates);
  });

  it("keeps calendar history and the actual prior value before result filters and the latest-row limit", async () => {
    const rows = await run(["2026-01-01", "2026-03-01", "2026-04-01"], "month", {
      compare: "prior", limit: 1,
      where: [
        { id: "segment", source: "dimension", field: "user_id", mode: "discrete", values: ["a"] },
        { id: "display", source: "metric", field: "trailing", mode: "range", min: 40 },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sold_on_month: "2026-04-01", trailing: 50, trailing__prev: 30, running: 60 });
  });

  it("restricts the input history with date filters, without borrowing outside the selected scope", async () => {
    const rows = await run(["2026-01-01", "2026-03-01", "2026-04-01"], "month", {
      where: [
        { id: "segment", source: "dimension", field: "user_id", mode: "discrete", values: ["a"] },
        { id: "dates", source: "dimension", field: "sold_on", mode: "range", min: "2026-03-01", max: "2026-04-30" },
      ],
    });
    expect(rows.map(r => [r.trailing, r.running])).toEqual([[20, 20], [50, 50]]);
  });
});
