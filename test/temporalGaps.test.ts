import { expect, it } from "vitest";
import { breakTemporalGaps } from "../src/charts/series.ts";
import { chartResult } from "../src/app/chartResult.ts";
import { tile } from "./fixtures.ts";

const row = (date:string, value:number|null, group:unknown = "US") => ({date:new Date(date),value,group});
it("breaks an absent month without changing raw rows or creating zero values", () => {
  const data = [row("2026-04-01",40),row("2026-01-01",10),row("2026-03-01",30)];
  const before = structuredClone(data);
  const result = breakTemporalGaps(data,"date",["value"],"month");
  expect(result.map(r => r.value)).toEqual([10,null,30,40]);
  expect((result[1].date as Date).toISOString()).toBe("2026-02-01T00:00:00.000Z");
  expect(data).toEqual(before);
  expect(result.filter(r => r.value !== null)).toEqual([data[1],data[2],data[0]]);
});
it("assesses gaps within each typed breakdown and never extends its observed window", () => {
  const data = [row("2026-01-01",10,null),row("2026-03-01",30,null),row("2026-01-01",5,"null"),row("2026-02-01",6,"null"),row("2026-03-01",7,"null")];
  const result = breakTemporalGaps(data,"date",["value"],"month",["group"]);
  expect(result.filter(r => r.value === null)).toEqual([row("2026-02-01",null,null)]);
  expect(result.filter(r => r.group === "null")).toHaveLength(3);
});
it.each([
  ["day","2024-02-28","2024-03-01","2024-02-29"],
  ["week","2026-03-01","2026-03-15","2026-03-08"],
  ["month","2025-12-01","2026-02-01","2026-01-01"],
  ["quarter","2026-02-01","2026-08-01","2026-05-01"],
  ["year","2024-04-01","2026-04-01","2025-04-01"],
] as const)("respects %s reporting buckets, including fiscal offsets", (grain,a,b,missing) => {
  const result = breakTemporalGaps([row(a,1),row(b,2)],"date",["value"],grain);
  expect(result).toHaveLength(3);
  expect((result[1].date as Date).toISOString().slice(0,10)).toBe(missing);
});
it("does not guess a grain, expand a long gap, or impute absent metric values", () => {
  const data = [row("1900-01-01",1),row("2100-01-01",2)];
  expect(breakTemporalGaps(data,"date",["value"])).toBe(data);
  expect(breakTemporalGaps(data,"date",["value"],"day")).toHaveLength(3);
  const missing = [row("2026-01-01",1),row("2026-02-01",null),row("2026-03-01",0)];
  expect(breakTemporalGaps(missing,"date",["value"],"month")).toBe(missing);
  const invalid = [{date:"bad",value:1},row("2026-03-01",2)];
  expect(breakTemporalGaps(invalid,"date",["value"],"month")).toBe(invalid);
});
it("passes the active drill grain separately without changing query rows or comparison values", () => {
  const raw = {columns:["sold_on_day","revenue","revenue__pct"],rows:[["2026-01-01",10,.1],["2026-01-03",20,.2]]};
  const before = structuredClone(raw);
  const result = chartResult(tile({dimensions:["month:sold_on"],compare:"prior",compareShow:"percent"}),raw,["day:sold_on"]);
  expect(result.timeGrains).toEqual({sold_on_day:"day"});
  expect(result.rows).toEqual([["2026-01-01",.1],["2026-01-03",.2]]);
  expect(raw).toEqual(before);
  expect(chartResult(tile({dimensions:["sold_on"]}),{columns:["sold_on","revenue"],rows:[]}).timeGrains).toEqual({});
});
