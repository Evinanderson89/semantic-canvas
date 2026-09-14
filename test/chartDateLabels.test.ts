import { expect, it } from "vitest";
import { dateLabeler } from "../src/charts/Chart.tsx";

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
