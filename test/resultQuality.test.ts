import { expect, it } from "vitest";
import { checkResultQuality, isScopeNote } from "../src/suggest/resultQuality.ts";
import { describeFilter } from "../src/app/MetricEvidence.tsx";
const check = (rows: unknown[][], extra = {}, dimensions = ["month:facts.date"]) => checkResultQuality(["revenue"], dimensions, { columns: ["date_month", "revenue"], rows, ...extra });
it("makes both ratio input windows inspectable without asserting a data defect", () => {
  const findings = check([["2026-08-01", 1]], { partial: { start: false, end: false, ratio: [{ period: "2026-08-01", numeratorStart: "2026-08-01", numeratorEnd: "2026-08-31", denominatorStart: "2026-08-01", denominatorEnd: "2026-08-15" }] } });
  const finding = findings.find(f => f.id === "ratio-coverage")!;
  expect(finding.evidence).toContain("numerator 2026-08-01 to 2026-08-31; denominator 2026-08-01 to 2026-08-15");
  expect(finding.nextStep).toContain("matching boundaries do not certify complete data");
  expect(isScopeNote(finding)).toBe(false);
});
it("labels retained partial selected periods as scope without claiming a source defect", () => {
  const rows = [["2026-01-01", 10], ["2026-02-01", 2]];
  const findings = check(rows, { partial: { start: false, end: false, selected: { start: false, end: true } } });
  expect(findings).toHaveLength(1);
  expect(isScopeNote(findings[0])).toBe(true);
  expect(findings[0].evidence).toContain("These rows remain visible");
  expect(findings[0].nextStep).toContain("does not prove missing source data");
});
it("distinguishes missing, invalid and measured zero without mutating returned data", () => {
  const rows = [["2026-01-01", 0], ["2026-02-01", null], ["2026-03-01", "0"], ["2026-04-01", ""], ["2026-05-01", false], ["2026-06-01", Infinity]];
  const before = structuredClone(rows), findings = check(rows);
  expect(findings.map(f => f.id)).toEqual(["null:revenue", "invalid:revenue"]);
  expect(findings[0].evidence).toContain("1 of 6"); expect(findings[1].evidence).toContain("3 of 6"); expect(rows).toEqual(before);
});
it("reports internal gaps with observed boundaries, not a claim of failed ingestion", () => {
  const findings = check([["2026-04-01", 4], ["2026-01-01", 1]]);
  expect(findings[0].id).toBe("gaps"); expect(findings[0].evidence).toContain("2 month periods"); expect(findings[0].nextStep).toContain("no activity");
});
it("does not infer gaps across a truncated result", () => {
  const rows = [["2026-01-01", 1], ["2026-04-01", 2]];
  expect(check(rows, { truncated: true }).map(f => f.id)).toEqual(["limited"]);
});
it("reports repeated periods in an unsegmented time dimension", () => {
  const rows = [["2026-01-01", 1], ["2026-01-01", 2], ["2026-04-01", 3]];
  expect(check(rows).map(f => f.id)).toEqual(["duplicate-periods"]);
});
it("rejects impossible dates and avoids a misleading gap conclusion", () => {
  expect(check([["2026-02-30", 1], [null, 2], ["2026-05-01", 3]]).map(f => f.id)).toEqual(["invalid-dates"]);
  expect(check([["2024-02-29", 1], ["2024-03-31", 2]])).toEqual([]);
});
for (const [grain, first, last] of [["day", "2024-02-28", "2024-03-01"], ["week", "2026-03-02", "2026-03-16"], ["quarter", "2025-10-01", "2026-04-01"], ["year", "2024-01-01", "2026-01-01"]]) it(`counts ${grain} gaps in UTC across calendar boundaries`, () => {
  const findings = checkResultQuality(["revenue"], [`${grain}:date`], { columns: [`date_${grain}`, "revenue"], rows: [[first, 1], [last, 2]] });
  expect(findings[0].evidence).toContain(`1 ${grain} period`);
});
it("does not treat absent comparison values as missing primary metrics", () => {
  expect(check([["2026-01-01", 1, null]], { columns: ["date_month", "revenue", "revenue__prev"] })).toEqual([]);
});
it("reports empty, missing-column and excluded-edge evidence separately", () => {
  expect(check([], { partial: { start: true, end: false } }).map(f => f.id)).toEqual(["partial", "empty"]);
  expect(check([[1]], { columns: ["other"] }).map(f => f.id)).toEqual(["missing:revenue", "time-column"]);
});
it("keeps exclusion and exclusive bounds visible in scope descriptions", () => {
  expect(describeFilter({ id: "x", source: "dimension", field: "country", mode: "discrete", values: ["US"], exclude: true })).toContain("excludes US");
  expect(describeFilter({ id: "y", source: "dimension", field: "amount", mode: "range", min: 0, max: 100, maxExclusive: true })).toContain("0 ≤ value < 100");
});

const segmented = (rows: unknown[][], extra = {}, dimensions = ["month:facts.date", "country"]) =>
  checkResultQuality(["revenue"], dimensions, { columns: ["date_month", "country", "revenue"], rows, ...extra });

it("finds gaps within a segment even when another segment fills the overall timeline", () => {
  const rows = [["2026-01-01", "US", 1], ["2026-03-01", "US", 3],
    ["2026-01-01", "DE", 1], ["2026-02-01", "DE", 2], ["2026-03-01", "DE", 3]];
  const before = structuredClone(rows), findings = segmented(rows);
  expect(findings).toHaveLength(1);
  expect(findings[0]).toMatchObject({ id: "gaps", impact: expect.stringContaining("segment") });
  expect(findings[0].evidence).toContain('country="US"');
  expect(findings[0].evidence).not.toContain('country="DE"');
  expect(findings[0].evidence).toContain("1 month period");
  expect(rows).toEqual(before);
});

it("does not infer gaps between segments with different observed windows or on a limited query", () => {
  expect(segmented([["2026-01-01", "US", 1], ["2026-04-01", "DE", 2]])).toEqual([]);
  expect(segmented([["2026-01-01", "US", 1], ["2026-04-01", "US", 2]], { truncated: true }).map(f => f.id)).toEqual(["limited"]);
});

it("distinguishes typed segment keys and finds duplicate dates only within the same full breakdown", () => {
  const rows = [["2026-01-01", null, 1], ["2026-01-01", "null", 2],
    ["2026-01-01", 1, 3], ["2026-01-01", "1", 4]];
  expect(segmented(rows).map(f => f.id)).toEqual(["category-values:country"]);
  const findings = segmented([...rows, ["2026-01-01", "null", 5]]);
  expect(findings.map(f => f.id)).toEqual(["category-values:country", "duplicate-periods"]);
  expect(findings[1].evidence).toContain('country="null"');
  expect(findings[1].evidence).toContain("1 extra row");
});

it("checks complete multi-field segment identity regardless of dimension order", () => {
  const findings = segmented([["2026-01-01", "US", 1, "new"], ["2026-01-01", "US", 2, "expansion"],
    ["2026-03-01", "US", 3, "new"]], { columns: ["date_month", "country", "revenue", "movement"] },
    ["country", "month:facts.date", "movement"]);
  expect(findings.map(f => f.id)).toEqual(["gaps"]);
  expect(findings[0].evidence).toContain('country="US", movement="new"');
});

it("does not certify continuity when a requested segment column is absent", () => {
  const findings = segmented([["2026-01-01", 10]], { columns: ["date_month", "revenue"] });
  expect(findings.map(f => f.id)).toEqual(["segment-columns"]);
});

it("suppresses gap inference only for ambiguous segments, while checking independent valid segments", () => {
  const findings = segmented([["2026-01-01", "US", 1], ["2026-03-01", "US", 3],
    ["2026-01-01", "DE", 1], ["2026-01-01", "DE", 2], ["2026-04-01", "DE", 3],
    ["2026-01-01", "GB", 1], [null, "GB", 2], ["2026-04-01", "GB", 3]]);
  expect(findings.map(f => f.id)).toEqual(["invalid-dates", "duplicate-periods", "gaps"]);
  const gaps = findings.find(f => f.id === "gaps")!;
  expect(gaps.evidence).toContain("1 month period across 1 segment");
  expect(gaps.evidence).not.toMatch(/DE|GB/);
});

it("bounds examples without losing the total affected-segment count", () => {
  const findings = segmented(Array.from({ length: 8 }, (_, i) => [["2026-01-01", `segment-${i}`, 1], ["2026-03-01", `segment-${i}`, 2]]).flat());
  expect(findings[0].evidence).toContain("8 month periods across 8 segments");
  expect(findings[0].evidence.match(/country=/g)).toHaveLength(3);
});

it("flags unassigned category labels without confusing valid falsy or sentinel-looking values", () => {
  const rows = [[null, 10], [undefined, 20], ["", 30], ["  \t", 40], [0, 0], [false, 50],
    ["null", 60], ["Unknown", 70], ["(missing)", 80], [" US ", 90]];
  const before = structuredClone(rows);
  const findings = checkResultQuality(["revenue"], ["customers.country"], { columns: ["country", "revenue"], rows });
  expect(findings).toHaveLength(1);
  expect(findings[0]).toMatchObject({ id: "category-values:customers.country",
    evidence: expect.stringContaining("4 of 10 returned rows"), impact: expect.stringContaining("Excluding the rows") });
  expect(findings[0].evidence).toContain("2 missing (null or absent); 2 blank text");
  expect(findings[0].evidence).toContain("not counts of customers or source records");
  expect(findings[0].nextStep).toContain("whether an unassigned group is intentional");
  expect(rows).toEqual(before);
});

it("checks each categorical field and reports an absent breakdown without a time dimension", () => {
  const findings = checkResultQuality(["revenue"], ["customers.country", "customers.segment", "channel"], {
    columns: ["revenue", "segment", "country"], rows: [[10, "", "US"], [20, "Enterprise", null]],
  });
  expect(findings.map(f => f.id)).toEqual(["segment-columns", "category-values:customers.country", "category-values:customers.segment"]);
  expect(findings[0].evidence).toBe("The result is missing channel.");
  expect(findings[1].evidence).toContain("1 missing (null or absent)");
  expect(findings[2].evidence).toContain("1 blank text");
});

it("keeps category findings scoped to returned rows under a limit and clears them after correction", () => {
  const dimensions = ["country"], columns = ["country", "revenue"];
  const findings = checkResultQuality(["revenue"], dimensions, { columns, rows: [[null, 10], ["US", 20]], truncated: true });
  expect(findings.map(f => f.id)).toEqual(["limited", "category-values:country"]);
  expect(findings[1].evidence).toContain("1 of 2 returned rows");
  expect(checkResultQuality(["revenue"], dimensions, { columns, rows: [["DE", 10], ["US", 20]] })).toEqual([]);
  expect(checkResultQuality(["revenue"], dimensions, { columns, rows: [] }).map(f => f.id)).toEqual(["empty"]);
});

it("keeps unassigned series independent while still checking their internal dates", () => {
  const findings = segmented([["2026-01-01", null, 10], ["2026-03-01", null, 20],
    ["2026-02-01", "null", 30], ["2026-01-01", "US", 40]]);
  expect(findings.map(f => f.id)).toEqual(["category-values:country", "gaps"]);
  expect(findings[1].evidence).toContain("country=(missing)");
  expect(findings[1].evidence).toContain("1 month period across 1 segment");
});
