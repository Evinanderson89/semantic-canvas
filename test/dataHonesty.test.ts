import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bucketEnd, isPeriodKeyed, labelTile, reviewDataHonesty, sayDate, unsettledFilter } from "../src/suggest/dataHonesty.ts";
import { duckglueAdapter } from "../src/semantic/duckglue.ts";
import { model as base, tile } from "./fixtures.ts";
import type { Model } from "../src/semantic/model.ts";

// Data-honesty rules 2 and 6 (docs/data-honesty-review.md), on synthetic
// weekly results. "Today" is Friday 2026-09-11; Monday weeks.
const today = new Date("2026-09-11T15:00:00Z");
const weeks = (last: string, n = 6) => {
  const end = new Date(last + "T00:00:00Z");
  return Array.from({ length: n }, (_, i) => [new Date(end.getTime() - (n - 1 - i) * 7 * 86_400_000).toISOString().slice(0, 10), 100 + i]);
};
const withLag = (days: number): Model => ({ ...base, tables: { ...base.tables, fct_sales: { ...base.tables.fct_sales, reportingLagDays: days } } });
const review = (over: object, rows: unknown[][], partialEnd: boolean, model: Model = base, where?: any[]) =>
  reviewDataHonesty({ tile: tile({ dimensions: ["week:sold_on"], ...over }) as any, model, columns: ["sold_on_week", "revenue"], rows, partial: { start: false, end: partialEnd }, timeDimension: "week:sold_on", where, today });

describe("data honesty: lagging comparison", () => {
  it("says a comparison rests on the last complete period when the newest one was left out as partial", () => {
    const [f] = review({ compare: "prior" }, weeks("2026-08-31"), true);
    expect(f.rule).toBe("lagging");
    expect(f.text).toContain("through Sep 6 against the week before");
    expect(f.fixes).toEqual([{ kind: "label-through", date: "2026-09-06" }]);
  });
  it("uses the table's reporting lag to call the newest complete period unsettled, and offers to leave it out", () => {
    const [f] = review({ compare: "yoy" }, weeks("2026-09-07"), false, withLag(5));
    expect(f.rule).toBe("lagging");
    expect(f.text).toContain("fct_sales settles after 5 days");
    expect(f.text).toContain("the same period last year");
    expect(f.fixes[0]).toEqual({ kind: "exclude-unsettled", field: "fct_sales.sold_on", before: "2026-09-07" });
    const filter = unsettledFilter("t1", f.fixes[0] as any);
    expect(filter).toMatchObject({ id: "honesty:t1:settled", field: "fct_sales.sold_on", mode: "range", max: "2026-09-07", maxExclusive: true });
  });
  it("is quiet without a comparison, and when the newest period is complete and settled", () => {
    expect(review({}, weeks("2026-08-31"), true)).toEqual([]);
    expect(review({ compare: "prior" }, weeks("2026-08-31"), false, withLag(2))).toEqual([]);
  });
});

describe("data honesty: stale data", () => {
  it("flags a series whose newest complete week ended more than a week ago", () => {
    const [f] = review({}, weeks("2026-08-24"), false);
    expect(f.rule).toBe("stale");
    expect(f.text).toBe("Data ends Aug 30; today is Sep 11. Drawn without a date, the chart reads as current.");
    expect(f.fixes.map((x) => x.kind)).toEqual(["label-as-of", "freshness-note"]);
  });
  it("is quiet when data reaches into the current period, within the reporting lag, or inside a window the person chose", () => {
    expect(review({}, weeks("2026-08-24"), true)).toEqual([]);
    expect(review({}, weeks("2026-08-24"), false, withLag(10))).toEqual([]);
    expect(review({}, weeks("2026-08-24"), false, base, [{ id: "w", field: "sold_on", source: "dimension", mode: "range", max: "2026-08-31", maxExclusive: true }])).toEqual([]);
  });
  it("does not fire on a series that is one week old", () => {
    expect(review({}, weeks("2026-08-31"), false)).toEqual([]);
  });
});

describe("data honesty: helpers", () => {
  it("labels a title once, replacing an earlier honesty suffix", () => {
    const t = tile({ title: "Revenue by week" }) as any;
    const once = labelTile(t, "Revenue", { kind: "label-through", date: "2026-09-06" }, today);
    expect(once.title).toBe("Revenue by week (through Sep 6)");
    expect(labelTile(once, "Revenue", { kind: "label-as-of", date: "2025-12-31" }, today).title).toBe("Revenue by week (as of Dec 31, 2025)");
    expect(labelTile(tile() as any, "Revenue (USD)", { kind: "label-as-of", date: "2026-08-30" }, today).title).toBe("Revenue (USD) (as of Aug 30)");
  });
  it("knows bucket ends and how to say a date", () => {
    expect(bucketEnd(new Date("2026-08-31T00:00:00Z"), "week").toISOString().slice(0, 10)).toBe("2026-09-07");
    expect(bucketEnd(new Date("2026-12-01T00:00:00Z"), "month").toISOString().slice(0, 10)).toBe("2027-01-01");
    expect(bucketEnd(new Date("2026-10-01T00:00:00Z"), "quarter").toISOString().slice(0, 10)).toBe("2027-01-01");
    expect(sayDate("2026-09-06", today)).toBe("Sep 6");
    expect(sayDate("2025-09-06", today)).toBe("Sep 6, 2025");
  });
  it("treats a date-keyed snapshot table as period-keyed", () => {
    const snap: Model = { ...base, tables: { ...base.tables, fct_monthly: { name: "fct_monthly", grain: "one row per month", synonyms: [], partitionKeys: [], primaryKey: "month", columns: [{ name: "month", type: "date" }, { name: "mrr", type: "double" }] } },
      metrics: { ...base.metrics, mrr: { name: "mrr", label: "MRR", baseTable: "fct_monthly", expression: "SUM(fct_monthly.mrr)", filter: null, synonyms: [] } } };
    expect(isPeriodKeyed(snap, tile({ metrics: ["mrr"] }) as any, "month:month")).toBe(true);
    expect(isPeriodKeyed(base, tile() as any, "week:sold_on")).toBe(false);
  });
});

describe("reporting_lag in the YAML model", () => {
  it("is read in days and refused outside 0 to 365", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sc-lag-"));
    const yaml = (lag: string) => `tables:\n  fct_orders:\n    grain: one row per order\n    reporting_lag: ${lag}\n    columns:\n      - { name: ordered_on, type: date }\n      - { name: amount, type: double }\nmetrics:\n  orders:\n    label: Orders\n    base_table: fct_orders\n    expression: COUNT(*)\n`;
    writeFileSync(join(dir, "ok.yaml"), yaml("2"));
    const m = await duckglueAdapter.load(join(dir, "ok.yaml"));
    expect(m?.tables.fct_orders.reportingLagDays).toBe(2);
    writeFileSync(join(dir, "bad.yaml"), yaml("900"));
    await expect(duckglueAdapter.load(join(dir, "bad.yaml"))).rejects.toThrow(/reporting_lag/);
  });
});
