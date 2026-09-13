import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileTile, splitPartialPeriods, truncOnCalendar } from "../src/compiler/compile.ts";
import { PRESETS, resolvePreset } from "../src/app/datePresets.ts";
import { duckglueAdapter } from "../src/semantic/duckglue.ts";
import { duckdbConnector } from "../src/connectors/duckdb.ts";
import { bucketEnd } from "../src/suggest/dataHonesty.ts";
import type { Connector } from "../src/connectors/types.ts";
import type { Model } from "../src/semantic/model.ts";
import { conn, model as base, tile } from "./fixtures.ts";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The model's calendar (docs/calendar.md): weeks, fiscal periods and time zones cut the same way everywhere.
const sunday: Model = { ...base, calendar: { weekStart: "sunday", fiscalYearStartMonth: 1 } };
const fiscalFeb: Model = { ...base, calendar: { weekStart: "monday", fiscalYearStartMonth: 2 } };
const at = (iso: string) => new Date(`${iso}T12:00:00`);

describe("calendar in the compiler", () => {
  it("cuts weeks on the declared start day and fiscal periods on the declared month; default is unchanged", () => {
    expect(truncOnCalendar(base, conn, "week", "x")).toBe("date_trunc('week', x)");
    expect(truncOnCalendar(sunday, conn, "week", "x")).toBe("date_trunc('day', (date_trunc('week', (x + INTERVAL '1 day')) + INTERVAL '-1 day'))");
    expect(truncOnCalendar(fiscalFeb, conn, "quarter", "x")).toBe("date_trunc('day', (date_trunc('quarter', (x + INTERVAL '-1 month')) + INTERVAL '1 month'))");
    expect(truncOnCalendar(fiscalFeb, conn, "year", "x")).toBe("date_trunc('day', (date_trunc('year', (x + INTERVAL '-1 month')) + INTERVAL '1 month'))");
    expect(truncOnCalendar(fiscalFeb, conn, "month", "x")).toBe("date_trunc('month', x)");
    const sql = compileTile(fiscalFeb, conn, tile({ dimensions: ["quarter:sold_on"] }) as any);
    expect(sql).toContain(`date_trunc('day', (date_trunc('quarter', (fct_sales."sold_on" + INTERVAL '-1 month')) + INTERVAL '1 month')) AS "sold_on_quarter"`);
  });
  it("reads a timestamp in the calendar's time zone before cutting; a date column is left alone", () => {
    const tz: Model = { ...base, calendar: { weekStart: "monday", fiscalYearStartMonth: 1, timezone: "America/New_York" },
      tables: { ...base.tables, fct_sales: { ...base.tables.fct_sales, columns: [...base.tables.fct_sales.columns, { name: "sold_at", type: "timestamp" }] } } };
    const dialect = { ...conn, toTimezone: (e: string, z: string) => `tz(${e}, '${z}')` };
    expect(compileTile(tz, dialect, tile({ dimensions: ["day:sold_at"] }) as any)).toContain(`date_trunc('day', tz(fct_sales."sold_at", 'America/New_York')) AS "sold_at_day"`);
    expect(compileTile(tz, dialect, tile({ dimensions: ["day:sold_on"] }) as any)).toContain(`date_trunc('day', fct_sales."sold_on") AS "sold_on_day"`);
  });
});

describe("calendar in presets and honesty", () => {
  it("this quarter and year to date follow the fiscal year", () => {
    expect(PRESETS["year-to-date"].resolve(at("2026-09-12"), { weekStart: "monday", fiscalYearStartMonth: 2 })).toEqual({ min: "2026-02-01", max: "2026-09-12" });
    expect(PRESETS["year-to-date"].resolve(at("2026-01-15"), { weekStart: "monday", fiscalYearStartMonth: 2 })).toEqual({ min: "2025-02-01", max: "2026-01-15" });
    expect(PRESETS["this-quarter"].resolve(at("2026-09-12"), { weekStart: "monday", fiscalYearStartMonth: 2 })).toEqual({ min: "2026-08-01", max: "2026-09-12" });
    expect(PRESETS["this-quarter"].resolve(at("2026-01-15"), { weekStart: "monday", fiscalYearStartMonth: 2 })).toEqual({ min: "2025-11-01", max: "2026-01-15" });
    expect(PRESETS["this-quarter"].resolve(at("2026-09-12"))).toEqual({ min: "2026-07-01", max: "2026-09-12" });
    expect(resolvePreset({ preset: "year-to-date" }, at("2026-03-15"), { weekStart: "sunday", fiscalYearStartMonth: 7 })).toEqual({ min: "2025-07-01", max: "2026-03-15" });
  });
  it("a fiscal year bucket ends twelve months after it starts", () => {
    expect(bucketEnd(new Date("2026-02-01T00:00:00Z"), "year").toISOString().slice(0, 10)).toBe("2027-02-01");
    expect(bucketEnd(new Date("2026-01-01T00:00:00Z"), "year").toISOString().slice(0, 10)).toBe("2027-01-01");
  });
});

// On the sample lake: sessions run Sunday 2024-09-01 to Monday 2026-08-31. Monday weeks are partial at both ends; Sunday weeks start whole.
describe("calendar on the sample lake", () => {
  let c: Connector, mondays: Model, sundays: Model;
  beforeAll(async () => {
    c = await duckdbConnector("sample-data/lake");
    mondays = (await duckglueAdapter.load("sample-data/warehouse.yaml"))!;
    const dir = mkdtempSync(join(tmpdir(), "sc-cal-"));
    writeFileSync(join(dir, "w.yaml"), readFileSync("sample-data/warehouse.yaml", "utf8").replace("model:\n", "model:\n  calendar: { week_start: sunday }\n"));
    sundays = (await duckglueAdapter.load(join(dir, "w.yaml")))!;
    expect(sundays.calendar).toEqual({ weekStart: "sunday", fiscalYearStartMonth: 1 });
  });
  afterAll(async () => { await c.close(); });
  it("moves the week boundary and the partial-edge judgement with it", async () => {
    const metric = Object.values(mondays.metrics).find((m) => m.baseTable === "fct_web_sessions" && m.expression === "COUNT(*)")!.name;
    const t = { id: "t", kind: "metric", metrics: [metric], dimensions: ["week:session_date"], layout: { x: 0, y: 0, w: 1, h: 1 } } as any;
    const mon = splitPartialPeriods(await c.execute(compileTile(mondays, c, t), 5000));
    const sun = splitPartialPeriods(await c.execute(compileTile(sundays, c, t), 5000));
    expect(mon.partial).toEqual({ start: true, end: true });
    expect(String(mon.rows[0][0])).toBe("2024-09-02");
    expect(sun.partial).toEqual({ start: false, end: true });
    expect(String(sun.rows[0][0])).toBe("2024-09-01");
    expect(new Date(String(sun.rows[5][0])).getUTCDay()).toBe(0);
  });
  it("refuses a time zone that is not one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sc-cal-bad-"));
    writeFileSync(join(dir, "w.yaml"), readFileSync("sample-data/warehouse.yaml", "utf8").replace("model:\n", "model:\n  calendar: { timezone: Mars/Olympus }\n"));
    await expect(duckglueAdapter.load(join(dir, "w.yaml"))).rejects.toThrow(/not an IANA time zone/);
  });
});
