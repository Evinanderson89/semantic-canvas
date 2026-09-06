import { describe, expect, it } from "vitest";
import { bucketRange, drillInto, NEXT_GRAIN } from "../src/app/drill.ts";

const d = (s: string) => new Date(`${s}T00:00:00Z`);

describe("bucketRange", () => {
  it("years", () => {
    expect(bucketRange("year", d("2026-05-17"))).toEqual({ min: "2026-01-01", max: "2027-01-01", label: "2026" });
  });

  it("quarters, including the December-crossing Q4", () => {
    expect(bucketRange("quarter", d("2026-02-01"))).toMatchObject({ min: "2026-01-01", max: "2026-04-01" });
    expect(bucketRange("quarter", d("2026-11-15"))).toMatchObject({ min: "2026-10-01", max: "2027-01-01" });
  });

  it("months, including December -> January year rollover", () => {
    expect(bucketRange("month", d("2026-03-17"))).toMatchObject({ min: "2026-03-01", max: "2026-04-01" });
    expect(bucketRange("month", d("2026-12-25"))).toMatchObject({ min: "2026-12-01", max: "2027-01-01" });
  });

  it("weeks start Monday, matching DuckDB's date_trunc('week', ...)", () => {
    // 2026-03-17 is a Tuesday.
    expect(bucketRange("week", d("2026-03-17"))).toMatchObject({ min: "2026-03-16", max: "2026-03-23" });
    // A Monday should map to itself, not the prior week.
    expect(bucketRange("week", d("2026-03-16"))).toMatchObject({ min: "2026-03-16", max: "2026-03-23" });
  });

  it("days are a single-day half-open range", () => {
    expect(bucketRange("day", d("2026-03-17"))).toEqual({ min: "2026-03-17", max: "2026-03-18", label: "2026-03-17" });
  });
});

describe("NEXT_GRAIN / drillInto", () => {
  it("has no further grain past day", () => {
    expect(NEXT_GRAIN.day).toBeNull();
    expect(drillInto("day", "event_date", d("2026-03-17"))).toBeNull();
  });

  it("skips week in the chain -- month drills straight to day", () => {
    expect(NEXT_GRAIN.month).toBe("day");
  });

  it("week (as a starting grain) also drills to day", () => {
    expect(NEXT_GRAIN.week).toBe("day");
  });

  it("builds a scoped entry at the next grain, covering the clicked bucket", () => {
    const entry = drillInto("month", "event_date", d("2026-03-17"));
    expect(entry).toEqual({
      grain: "day", column: "event_date", min: "2026-03-01", max: "2026-04-01", label: "Mar 2026",
    });
  });
});
