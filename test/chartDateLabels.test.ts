import { expect, it } from "vitest";
import { dateLabeler, spacedBandTicks } from "../src/charts/Chart.tsx";

it("thins band labels by screen position while retaining observed endpoints", () => {
  const dates = Array.from({ length: 24 }, (_, i) => new Date(Date.UTC(2024, i, 1)).toISOString());
  const original = [...dates];
  for (const width of [180, 320, 700]) {
    const ticks = spacedBandTicks(dates, width, 52);
    expect(ticks[0]).toBe(dates[0]);
    expect(ticks.at(-1)).toBe(dates.at(-1));
    expect(ticks.length).toBeLessThan(dates.length);
    ticks.slice(1).forEach((v, i) => expect((dates.indexOf(v) - dates.indexOf(ticks[i])) * width / dates.length).toBeGreaterThanOrEqual(52));
  }
  expect(dates).toEqual(original);
  expect(spacedBandTicks(dates, 20, 52)).toEqual([dates.at(-1)]);
  expect(spacedBandTicks([], 320, 52)).toEqual([]);
  expect(spacedBandTicks(["only"], 320, 52)).toEqual(["only"]);
});

it("keeps repeated monthly series in distinct year-aware UTC buckets", () => {
  const dates = ["2024-10-01", "2024-11-01", "2025-10-01", "2025-11-01"].map(s => new Date(`${s}T00:00:00Z`));
  const label = dateLabeler(dates.flatMap(d => [d, d, d]));
  expect(new Set(dates.map(label)).size).toBe(4);
  expect(label(dates[0])).toBe(dates[0].toLocaleDateString(undefined, { month: "short", year: "2-digit", timeZone: "UTC" }));
});

it("does not collapse daily buckets from different years or shift a single UTC date", () => {
  const dates = ["2024-01-01", "2024-01-02", "2025-01-01"].map(s => new Date(`${s}T00:00:00Z`));
  expect(new Set(dates.map(dateLabeler(dates))).size).toBe(3);
  expect(dateLabeler([dates[0]])(dates[0])).toBe(dates[0].toLocaleDateString(undefined, { month: "short", day: "numeric", year: "2-digit", timeZone: "UTC" }));
});

it("keeps intraday, subsecond and century-spanning dates distinguishable", () => {
  for (const values of [
    ["2026-07-01T09:00:00Z", "2026-07-01T10:00:00Z"],
    ["2026-07-01T09:00:00.001Z", "2026-07-01T09:00:00.002Z"],
    ["1926-07-01", "1926-08-01", "2026-07-01", "2026-08-01"],
  ]) {
    const dates = values.map(v => new Date(v)), label = dateLabeler(dates.flatMap(v => [v, v]));
    expect(new Set(dates.map(label)).size).toBe(dates.length);
    expect(label("A category")).toBe("A category");
  }
});
