import { afterAll, beforeAll, expect, it } from "vitest";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { bucketRange, drillInto, type DrillGrain } from "../src/app/drill.ts";
import { visibleQuery } from "../src/app/query.ts";
import { futureFilter } from "../src/suggest/dataHonesty.ts";
import { compileTile, truncOnCalendar } from "../src/compiler/compile.ts";
import type { Calendar, Model } from "../src/semantic/model.ts";
import { model as base, conn, tile } from "./fixtures.ts";

const connector = { ...conn, relation: (table: string) => conn.quote(table),
  dateTrunc: (grain: string, expr: string) => `CAST(date_trunc('${grain}', ${expr}) AS DATE)`,
  toTimezone: (expr: string, timezone: string) => `timezone('${timezone}', timezone('UTC', CAST(${expr} AS TIMESTAMP)))` };
let db: DuckDBConnection;
beforeAll(async () => {
  db = await (await DuckDBInstance.create(":memory:")).connect();
  // Every day contributes exactly one, so drill totals can be checked against
  // the independently counted calendar days in the requested half-open range.
  await db.run(`CREATE TABLE fct_sales AS SELECT CAST(day AS DATE) AS sold_on, 1.0::DOUBLE AS amount
    FROM generate_series(DATE '2024-01-01', DATE '2027-12-31', INTERVAL '1 day') AS dates(day)`);
});
afterAll(() => db.closeSync());
const date = (s: string) => new Date(`${s}T00:00:00Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const sunday: Calendar = { weekStart: "sunday", fiscalYearStartMonth: 2 };

it("uses the clicked Sunday week and February fiscal periods, including year rollover", () => {
  expect(bucketRange("week", date("2026-09-06"), sunday))
    .toEqual({ min: "2026-09-06", max: "2026-09-13", label: "Week of 2026-09-06" });
  expect(bucketRange("quarter", date("2026-08-01"), sunday))
    .toEqual({ min: "2026-08-01", max: "2026-11-01", label: "Fiscal quarter from Aug 2026" });
  expect(bucketRange("quarter", date("2026-01-15"), sunday))
    .toEqual({ min: "2025-11-01", max: "2026-02-01", label: "Fiscal quarter from Nov 2025" });
  expect(bucketRange("year", date("2026-01-15"), sunday))
    .toEqual({ min: "2025-02-01", max: "2026-02-01", label: "Fiscal year from Feb 2025" });
});

it("matches the actual SQL bucket for every fiscal start month and both week starts", async () => {
  for (const weekStart of ["monday", "sunday"] as const) for (let month = 1; month <= 12; month++) {
    const calendar: Calendar = { weekStart, fiscalYearStartMonth: month };
    const model = { ...base, calendar };
    for (const grain of ["week", "quarter", "year"] as const) {
      for (const input of ["2026-01-15", "2026-09-06", "2024-02-29"]) {
        const sql = `SELECT ${truncOnCalendar(model, connector, grain, `DATE '${input}'`)} AS bucket`;
        const row = (await db.runAndReadAll(sql)).getRows()[0];
        const start = String(row[0]).slice(0, 10);
        const range = bucketRange(grain, date(input), calendar);
        expect(range.min, `${weekStart}, fiscal ${month}, ${grain}, ${input}`).toBe(start);
        expect(range.max > input && range.min <= input).toBe(true);
        expect(bucketRange(grain, date(start), calendar)).toEqual(range);
      }
    }
  }
});

it.each([
  ["week", "2026-09-06", "2026-09-13"],
  ["quarter", "2026-08-01", "2026-11-01"],
  ["quarter", "2025-11-01", "2026-02-01"],
  ["year", "2025-02-01", "2026-02-01"],
] as [DrillGrain, string, string][])("keeps the %s chart's value when drilling %s into smaller buckets", async (grain, start, end) => {
  const model: Model = { ...base, calendar: sunday };
  const spec = tile({ dimensions: [`${grain}:fct_sales.sold_on`], limit: 5000 });
  const original = await db.runAndReadAll(compileTile(model, connector, spec));
  const originalRow = original.getRows().find(row => String(row[0]).slice(0, 10) === start)!;
  const entry = drillInto(grain, "fct_sales.sold_on", date(start), sunday)!;
  expect(entry).toMatchObject({ min: start, max: end });
  const query = visibleQuery(model, spec, [], [entry]);
  const result = await db.runAndReadAll(compileTile(model, connector, { ...spec, ...query }));
  const rows = result.getRows();
  expect(rows.length).toBeGreaterThan(1);
  expect(rows.every(row => String(row[0]).slice(0, 10) >= start && String(row[0]).slice(0, 10) < end)).toBe(true);
  const expectedDays = (+date(end) - +date(start)) / 86400000;
  expect(Number(originalRow[1])).toBe(expectedDays);
  expect(rows.reduce((sum, row) => sum + Number(row[1]), 0)).toBe(expectedDays);
});

it("treats timestamp-derived bucket labels as dates without shifting them again at DST", () => {
  const calendar = { ...sunday, timezone: "America/New_York" };
  for (const start of ["2026-03-08", "2026-11-01"]) {
    const clicked = date(start), before = clicked.getTime();
    expect(drillInto("week", "events.at", clicked, calendar)).toMatchObject({ min: start, max: iso(new Date(+clicked + 7 * 86400000)) });
    expect(clicked.getTime()).toBe(before);
  }
});

it("the future-date fix keeps the whole reporting day rather than just midnight", async () => {
  const model: Model = { ...base, calendar: { ...sunday, timezone: "America/New_York" }, tables: { ...base.tables,
    fct_sales: { ...base.tables.fct_sales, columns: [{ name: "sold_on", type: "timestamp" }, { name: "amount", type: "double" }] },
  } };
  const events = { ...connector, relation: () => `(SELECT event_time::TIMESTAMP AS sold_on, 1.0::DOUBLE AS amount FROM
    (VALUES ('2026-02-01 04:59:59'),('2026-02-01 05:00:00'),('2026-02-02 04:59:59'),('2026-02-02 05:00:00')) AS v(event_time))` };
  const spec = tile({ dimensions: ["day:fct_sales.sold_on"], where: [futureFilter("t", { kind: "exclude-future", field: "fct_sales.sold_on", through: "2026-02-01" })] });
  const result = await db.runAndReadAll(compileTile(model, events, spec));
  expect(result.getRows().map(r => [String(r[0]).slice(0, 10), Number(r[1])]))
    .toEqual([["2026-01-31", 1], ["2026-02-01", 2]]);
});

it.each([
  ["2026-03-08", "2026-03-08 04:59:59", "2026-03-08 05:00:00", "2026-03-15 03:59:59", "2026-03-15 04:00:00"],
  ["2026-11-01", "2026-11-01 03:59:59", "2026-11-01 04:00:00", "2026-11-08 04:59:59", "2026-11-08 05:00:00"],
])("drills timestamp events in the reporting zone across the %s DST boundary", async (start, before, first, last, after) => {
  const model: Model = { ...base, calendar: { ...sunday, timezone: "America/New_York" }, tables: { ...base.tables,
    fct_sales: { ...base.tables.fct_sales, columns: [{ name: "sold_on", type: "timestamp" }, { name: "amount", type: "double" }] },
  } };
  // The first and last events belong to adjacent weeks. Their UTC dates
  // alone cannot determine which reporting-calendar week they belong to.
  const events = { ...connector, relation: () => `(SELECT event_time::TIMESTAMP AS sold_on, 1.0::DOUBLE AS amount FROM (VALUES ('${before}'),('${first}'),('${last}'),('${after}')) AS v(event_time))` };
  const spec = tile({ dimensions: ["week:fct_sales.sold_on"] });
  const original = await db.runAndReadAll(compileTile(model, events, spec));
  expect(Number(original.getRows().find(r => String(r[0]).slice(0, 10) === start)![1])).toBe(2);
  const entry = drillInto("week", "fct_sales.sold_on", date(start), model.calendar)!;
  const query = visibleQuery(model, spec, [], [entry]);
  const result = await db.runAndReadAll(compileTile(model, events, { ...spec, ...query }));
  expect(result.getRows().reduce((sum, r) => sum + Number(r[1]), 0)).toBe(2);
  expect(result.getRows().every(r => String(r[0]).slice(0, 10) >= entry.min && String(r[0]).slice(0, 10) < entry.max)).toBe(true);
  const scoped = { ...spec, ...query, where: [...query.where,
    { id: "rls:timestamp", field: "fct_sales.sold_on", source: "dimension" as const, mode: "discrete" as const, values: [first] }] };
  const restricted = await db.runAndReadAll(compileTile(model, events, scoped));
  expect(restricted.getRows().reduce((sum, r) => sum + Number(r[1]), 0)).toBe(1);
});
