import { describe, expect, it } from "vitest";
import { detectNoisy, noiseScores } from "../src/suggest/recommend.ts";
import { noiseSeriesReady, worthwhileCoarsening } from "../src/suggest/reviewChecks.ts";
import { checkResultQuality } from "../src/suggest/resultQuality.ts";

const columns = ["date_day", "value"];
const rowsFor = (values: unknown[]) => values.map((v, i) => [new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10), v]);
const query = { metrics: ["value"], dimensions: ["day:events.date"] };

describe("noise suggestions use observed values", () => {
  it.each([null, undefined, "", "  ", false, NaN, Infinity, "not a number"])("does not turn %s into a measured zero", missing => {
    const rows = rowsFor(Array.from({ length: 40 }, (_, i) => i % 2 ? missing : 100));
    expect(detectNoisy(rows, columns, ["value"])).toEqual([]);
    expect(noiseScores(rows, columns, ["value"])).toEqual([]);
  });

  it("preserves missing-value gaps instead of connecting the observations on either side", () => {
    const rows = rowsFor([...Array(10).fill(100), null, ...Array(10).fill(200)]);
    expect(noiseScores(rows, columns, ["value"])).toEqual([{ measure: "value", score: 0 }]);
    expect(checkResultQuality(query.metrics, query.dimensions, { columns, rows }).map(f => f.id)).toContain("null:value");
  });

  it("still flags observed zigzags and accepts numeric strings from a connector", () => {
    const rows = rowsFor(Array.from({ length: 30 }, (_, i) => String(i % 2 ? 100 : 0)));
    expect(detectNoisy(rows, columns, ["value"])).toEqual([{ measure: "value", score: 1 }]);
    expect(detectNoisy(rowsFor([...rows.map(r => r[1]), null]), columns, ["value"]))
      .toEqual([{ measure: "value", score: 1 }]);
  });

  it("does not recommend a coarser result just because its values are missing", () => {
    const before = detectNoisy(rowsFor(Array.from({ length: 30 }, (_, i) => i % 2 ? 100 : 0)), columns, ["value"]);
    const missing = noiseScores(rowsFor(Array(20).fill(null)), columns, ["value"]);
    expect(worthwhileCoarsening(before, missing, 20)).toBe(false);
    const flat = noiseScores(rowsFor(Array(20).fill(50)), columns, ["value"]);
    expect(worthwhileCoarsening(before, flat, 20)).toBe(true);
    expect(worthwhileCoarsening([...before, { measure: "other", score: 1 }], flat, 20)).toBe(false);
  });

  it("does not compare gaps, repeated dates, or interleaved categories as neighboring periods", () => {
    const rows = rowsFor(Array.from({ length: 24 }, (_, i) => i % 2 ? 100 : 0));
    expect(noiseSeriesReady(query, { columns, rows })).toBe(true);
    expect(noiseSeriesReady(query, { columns, rows: rows.filter((_, i) => i !== 10) })).toBe(false);
    expect(noiseSeriesReady(query, { columns, rows: [...rows, rows[0]] })).toBe(false);
    expect(noiseSeriesReady(query, { columns, rows: [[null, 1], ...rows] })).toBe(false);
    expect(noiseSeriesReady({ ...query, dimensions: [...query.dimensions, "country"] }, { columns, rows })).toBe(false);
    expect(noiseSeriesReady(query, { columns, rows, truncated: true })).toBe(false);
  });
});
