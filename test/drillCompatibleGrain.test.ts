import { beforeAll, describe, expect, it } from "vitest";
import { duckglueAdapter } from "../src/semantic/duckglue.ts";
import { compileTile, validateTile } from "../src/compiler/compile.ts";
import { issuesText, joinProblems } from "../src/compiler/issueText.ts";
import { compatibleDrill, drillGrain, drillGrainAllowed, drillInto, drillQueryKey, retainDrillSessions, type DrillEntry } from "../src/app/drill.ts";
import { visibleQuery } from "../src/app/query.ts";
import { calendarOf, type Model } from "../src/semantic/model.ts";
import type { TileSpec } from "../src/compiler/spec.ts";
import type { Connector } from "../src/connectors/types.ts";

// "Recurring revenue · monthly closing balance" in the showcase library:
// Ending MRR is month-only and fct_saas_monthly.month holds whole months.
let model: Model;
beforeAll(async () => { model = (await duckglueAdapter.load("sample-data/warehouse.yaml"))!; });
const M = "fct_saas_monthly.month";
const revenue = (dimensions = [`month:${M}`]): TileSpec => ({ id: "revenue-trend", kind: "metric", title: "Recurring revenue · monthly closing balance",
  metrics: ["ending_mrr"], dimensions, chart: "area", layout: { x: 0, y: 0, w: 640, h: 350 } });
const sessions = (): TileSpec => ({ id: "web", kind: "metric", metrics: [Object.values(model.metrics).find(m => m.baseTable === "fct_web_sessions" && !m.timeGrains)!.name],
  dimensions: [`month:fct_web_sessions.session_date`], layout: { x: 0, y: 0, w: 1, h: 1 } });
const june = new Date("2026-06-01T00:00:00Z");
const staleDay: DrillEntry = { grain: "day", column: M, min: "2026-06-01", max: "2026-07-01", label: "Jun 2026" };

describe("drilling into Jun 2026 on a month-only closing balance", () => {
  it("the backend still rejects an explicit day request, so the drill must never send one", () => {
    const problems = validateTile(model, revenue([`day:${M}`])).map(i => i.problem);
    expect(problems.some(p => p.includes("requires month reporting"))).toBe(true);
    expect(problems.some(p => p.includes("represents whole month periods"))).toBe(true);
  });

  it("offers no finer grain than month and builds no drill entry for the Jun 2026 click", () => {
    const tile = revenue();
    expect(drillGrainAllowed(model, tile, "day")).toBe(false);
    expect(drillGrainAllowed(model, tile, "week")).toBe(false);
    expect(drillGrain(model, tile)).toBeNull();
    expect(drillInto("month", M, june, calendarOf(model), drillGrain(model, tile))).toBeNull();
  });

  it("year and quarter buckets drill down to month, never past it", () => {
    expect(drillGrain(model, revenue([`year:${M}`]))).toBe("quarter");
    expect(drillGrain(model, revenue([`quarter:${M}`]))).toBe("month");
    const entry = drillInto("quarter", M, june, calendarOf(model), drillGrain(model, revenue([`quarter:${M}`])))!;
    expect(entry).toMatchObject({ grain: "month", min: "2026-04-01", max: "2026-07-01", label: "Q2 2026" });
    expect(validateTile(model, { ...revenue([`quarter:${M}`]), ...visibleQuery(model, revenue([`quarter:${M}`]), [], [entry]) } as TileSpec)).toEqual([]);
  });

  it("skips a disallowed intermediate grain instead of stopping (year -> month when quarter is not reportable)", () => {
    const restricted: Model = { ...model, metrics: { ...model.metrics, ending_mrr: { ...model.metrics.ending_mrr, timeGrains: ["month", "year"] } } };
    expect(drillGrain(restricted, revenue([`year:${M}`]))).toBe("month");
    expect(drillGrain(restricted, revenue([`month:${M}`]))).toBeNull();
  });

  it("an unrestricted metric on a daily table still drills month -> day", () => {
    const tile = sessions();
    expect(drillGrain(model, tile)).toBe("day");
    expect(drillInto("month", "fct_web_sessions.session_date", june, calendarOf(model), drillGrain(model, tile))).toMatchObject({ grain: "day", label: "Jun 2026" });
    expect(drillGrain(model, { ...tile, dimensions: ["day:fct_web_sessions.session_date"] })).toBeNull();
    expect(drillGrain(model, { ...tile, dimensions: ["fct_web_sessions.device"] } as TileSpec)).toBeNull();
    expect(drillGrainAllowed(model, { ...tile, dimensions: [] }, "day")).toBe(false);
  });

  it("recovers a stale Jun 2026 day drill: the visible query is valid and compiles", () => {
    const tile = revenue();
    expect(compatibleDrill(model, tile, [staleDay])).toEqual([]);
    const query = visibleQuery(model, tile, [], [staleDay]);
    expect(query.dimensions).toEqual([`month:${M}`]);
    expect(query.where.some(f => f.id === "drill:revenue-trend")).toBe(false);
    expect(validateTile(model, { ...tile, ...query } as TileSpec)).toEqual([]);
    const conn = { dateTrunc: (g: string, e: string) => `date_trunc('${g}', ${e})`, dateAdd: (u: string, e: string, n: number) => `${e} + ${n} ${u}`, quote: (s: string) => `"${s}"` } as unknown as Connector;
    expect(() => compileTile(model, conn, revenue([`day:${M}`]))).toThrow(/requires month reporting/);
  });

  it("prunes a stale invalid drill session and keeps the valid levels of a mixed stack", () => {
    const tile = revenue([`year:${M}`]);
    const quarter = drillInto("year", M, june, calendarOf(model), "quarter")!;
    const month = drillInto("quarter", M, june, calendarOf(model), "month")!;
    const stuck = { [tile.id]: { query: drillQueryKey(tile), entries: [quarter, month, staleDay] } };
    expect(retainDrillSessions([tile], stuck, model)).toEqual({ [tile.id]: { query: drillQueryKey(tile), entries: [quarter, month] } });
    const monthly = revenue();
    expect(retainDrillSessions([monthly], { [monthly.id]: { query: drillQueryKey(monthly), entries: [staleDay] } }, model)).toEqual({});
    const valid = { [tile.id]: { query: drillQueryKey(tile), entries: [quarter, month] } };
    expect(retainDrillSessions([tile], valid, model)).toBe(valid);
    expect(retainDrillSessions([tile], stuck)).toBe(stuck);
  });
});

describe("validation messages read cleanly", () => {
  it("never shows a '.;' seam between grain problems (the Jun 2026 banner)", () => {
    const message = issuesText(validateTile(model, revenue([`day:${M}`])));
    expect(message).not.toMatch(/\.;|\.\./);
    expect(message).toBe("Ending MRR (USD) requires month reporting on fct_saas_monthly.month. Other grains would change the metric's meaning. "
      + "fct_saas_monthly.month represents whole month periods; day reporting would split those periods. Use a compatible grain or a metric based on finer data.");
  });

  it("joins fragments with '; ' after dropping trailing periods, and drops repeats", () => {
    expect(joinProblems(["no metrics", "A requires month reporting.", "A requires month reporting.", "", null, undefined])).toBe("no metrics; A requires month reporting");
    expect(joinProblems(["First.", "Second!"])).toBe("First. Second!");
    expect(issuesText([{ message: "bad field." }, { problem: "unknown metric \"x\"" }])).toBe("bad field; unknown metric \"x\"");
    expect(issuesText([])).toBe("");
  });
});
