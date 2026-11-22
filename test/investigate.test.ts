import { expect, it } from "vitest";
import { model, tile } from "./fixtures.ts";
import {
  defaultDetailViews,
  investigationContext,
  investigationOptions,
  rankStorySubdetails,
  storyArcsForOptions,
} from "../src/suggest/investigate.ts";
import { duckglueAdapter } from "../src/semantic/duckglue.ts";
import { tileSchema } from "../src/compiler/schema.ts";

const result = { columns: ["sold_on_month", "revenue"], rows: [["2026-01-01", 100], ["2026-03-01", 150]] };

it("captures the displayed reporting window, source filters, and viewer filters without mutating the source", () => {
  const source = tile({ dimensions: ["month:sold_on"], where: [{ id: "positive", field: "revenue", source: "metric", mode: "range", min: 0 }], limit: 2 });
  const control = { id: "control:country", field: "dim_users.country", source: "dimension" as const, mode: "discrete" as const, values: ["US"] };
  const context = investigationContext(model, source, [control], [], result);
  expect(context.where).toContainEqual(control);
  expect(context.where).toContainEqual({ id: "investigation:window", field: "sold_on", source: "dimension", mode: "range", min: "2026-01-01", max: "2026-04-01", maxExclusive: true });
  const options = investigationOptions(model, source, context);
  expect(options.find(o => o.id === "by:dim_users.country")).toBeUndefined();
  expect(options.find(o => o.id === "mix:dim_users.country")).toBeUndefined();
  expect(options.find(o => o.id === "trend")?.tile.where).toEqual(context.where);
  expect(source.where).toHaveLength(1);
  expect(source.limit).toBe(2);
  expect(options.every(o => tileSchema.safeParse(o.tile).success)).toBe(true);
});

it("carries a drill range and its finer grain into every candidate", () => {
  const source = tile({ dimensions: ["month:sold_on"] });
  const drill = [{ grain: "day" as const, column: "sold_on", min: "2026-03-01", max: "2026-04-01", label: "March" }];
  const context = investigationContext(model, source, [], drill, { columns: ["sold_on_day", "revenue"], rows: [["2026-03-02", 10], ["2026-03-05", 15]] });
  expect(context.query.dimensions).toEqual(["day:sold_on"]);
  expect(context.where).toContainEqual(expect.objectContaining({ id: "drill:t1", min: "2026-03-01", maxExclusive: true }));
  expect(context.where.at(-1)).toMatchObject({ min: "2026-03-02", max: "2026-03-06" });
});

it("does not invent a retention segment when the monthly table has none", async () => {
  const sample = (await duckglueAdapter.load("sample-data/warehouse.yaml"))!;
  const source = tile({ metrics: ["nrr"], dimensions: ["month:fct_saas_monthly.month"] });
  const context = investigationContext(sample, source, [], [], { columns: ["month_month", "nrr"], rows: [["2026-08-01", 1.028]] });
  const options = investigationOptions(sample, source, context);
  expect(options.map(o => o.id)).toEqual(["headline", "trend", "compare", "values"]);
  // Segmentless metrics must not offer a fake "Why Did It Move?" segment/bridge preset.
  const arcs = storyArcsForOptions("Net revenue retention", options);
  expect(arcs.some(a => a.id === "why-it-moved")).toBe(false);
});

it("aligns reporting windows across both tables for cross-table ratio sub-dashboards", async () => {
  const sample = (await duckglueAdapter.load("sample-data/warehouse.yaml"))!;
  const source = tile({ metrics: ["new_customers_per_session"], dimensions: ["month:fct_mrr_movements.movement_date"] });
  const context = investigationContext(sample, source, [], [], { columns: ["movement_date_month", "new_customers_per_session"], rows: [["2026-07-01", 0.04], ["2026-08-01", 0.05]] });
  const options = investigationOptions(sample, source, context);
  expect(options.map(o => o.id)).toContain("headline");
  expect(options.map(o => o.id)).toContain("trend");
});

it("does not offer ambiguous or fan-out joins as breakdowns", () => {
  const unsafe = structuredClone(model); unsafe.joins[0].cardinality = "one_to_many";
  const source = tile({ dimensions: ["month:sold_on"] });
  const options = investigationOptions(unsafe, source, investigationContext(unsafe, source, [], [], result));
  expect(options.some(o => o.id === "by:dim_users.country")).toBe(false);
  expect(options.some(o => o.id === "mix:dim_users.country")).toBe(false);
});

it("refuses unreadable reporting dates instead of silently expanding the time window", () => {
  expect(() => investigationContext(model, tile({ dimensions: ["month:sold_on"] }), [], [], { columns: ["revenue"], rows: [[100]] })).toThrow(/reporting dates/);
});

it("retains the authored date range on a categorical chart without inventing a displayed time window", () => {
  const window = { id: "reporting", field: "sold_on", source: "dimension" as const, mode: "range" as const, min: "2026-01-01", max: "2026-03-31" };
  const source = tile({ dimensions: ["dim_users.country"], where: [window] });
  const context = investigationContext(model, source, [], [], { columns: ["country", "revenue"], rows: [["US", 250]] });
  expect(context.where).toEqual([window]);
  expect(investigationOptions(model, source, context).every(option => JSON.stringify(option.tile.where) === JSON.stringify([window]))).toBe(true);
});

it("offers the model-authored MRR waterfall for the latest displayed period, with an explicit separate-ledger caveat", async () => {
  const sample = (await duckglueAdapter.load("sample-data/warehouse.yaml"))!;
  const source = tile({ metrics: ["ending_mrr"], dimensions: ["month:fct_saas_monthly.month"], chart: "kpi" });
  const context = investigationContext(sample, source, [], [], { columns: ["month_month", "ending_mrr"], rows: [["2026-07-01", 100], ["2026-08-01", 104]] });
  const option = investigationOptions(sample, source, context)[0];
  expect(option.tile).toMatchObject({ metrics: ["net_new_mrr"], dimensions: ["fct_mrr_movements.movement_type"], chart: "waterfall", compare: "none" });
  expect(option.tile.where).toContainEqual(expect.objectContaining({ field: "fct_mrr_movements.movement_date", min: "2026-08-01", max: "2026-09-01", maxExclusive: true }));
  expect(option.tile.where?.some(f => f.field === "fct_saas_monthly.month")).toBe(false);
  expect(option.reason).toContain("not a reconciliation");
  expect(option.period).toContain("2026-08-01");
  expect(source.metrics).toEqual(["ending_mrr"]);
});

it("preserves full-month movement windows when a periodic monthly source has end-date or cross-filter bounds", async () => {
  const sample = (await duckglueAdapter.load("sample-data/warehouse.yaml"))!;
  const source = tile({ metrics: ["ending_mrr"], dimensions: ["month:fct_saas_monthly.month"], chart: "kpi" });
  for (const bound of [
    { id: "control:date", field: "fct_saas_monthly.month", source: "dimension" as const, mode: "range" as const, min: "2026-06-01", max: "2026-08-02", maxExclusive: true },
    { id: "authored:date", field: "fct_saas_monthly.month", source: "dimension" as const, mode: "range" as const, min: "2026-06-01", max: "2026-08-01" },
    { id: "cross:month", field: "fct_saas_monthly.month", source: "dimension" as const, mode: "discrete" as const, values: ["2026-08-01"] },
  ]) {
    const context = investigationContext(sample, source, [bound], [], { columns: ["month_month", "ending_mrr"], rows: [["2026-08-01", 202800]] });
    const waterfall = investigationOptions(sample, source, context).find(o => o.id.startsWith("waterfall:"))!;
    expect(waterfall.tile.where).toEqual([
      { id: "investigation:latest", field: "fct_mrr_movements.movement_date", source: "dimension", mode: "range", min: "2026-08-01", max: "2026-09-01", maxExclusive: true },
    ]);
  }
});

it("preserves country and date filters in a movement waterfall without changing the headline metric", async () => {
  const sample = (await duckglueAdapter.load("sample-data/warehouse.yaml"))!;
  const country = { id: "country", field: "dim_users.country", source: "dimension" as const, mode: "discrete" as const, values: ["US"] };
  const source = tile({ metrics: ["net_new_mrr"], dimensions: ["month:fct_mrr_movements.movement_date"], where: [country] });
  const context = investigationContext(sample, source, [], [], { columns: ["movement_date_month", "net_new_mrr"], rows: [["2026-08-01", 100]] });
  const option = investigationOptions(sample, source, context)[0];
  expect(option.tile.chart).toBe("waterfall");
  expect(option.tile.where).toContainEqual(country);
  expect(option.tile.metrics).toEqual(source.metrics);
  // HAVING on the original time buckets cannot safely become HAVING on movement categories.
  context.where.push({ id: "amount", field: "net_new_mrr", source: "metric", mode: "range", min: 0 });
  expect(investigationOptions(sample, source, context).some(o => o.tile.chart === "waterfall")).toBe(false);
});

it("does not broaden unsupported scope or invent paths for similarly named metrics", async () => {
  const sample = (await duckglueAdapter.load("sample-data/warehouse.yaml"))!;
  const source = tile({ metrics: ["ending_mrr"], dimensions: ["month:fct_saas_monthly.month"] });
  const context = investigationContext(sample, source, [], [], { columns: ["month_month", "ending_mrr"], rows: [["2026-08-01", 100]] });
  context.where.push({ id: "unmapped", field: "fct_saas_monthly.ending_mrr_usd", source: "dimension", mode: "range", min: 0 });
  expect(investigationOptions(sample, source, context).some(o => o.tile.chart === "waterfall")).toBe(false);
  context.where.pop();
  sample.metrics.ending_mrr.explorations = undefined;
  expect(investigationOptions(sample, source, context).some(o => o.tile.chart === "waterfall")).toBe(false);
});

it("chooses several complementary views, builds valid story arcs, and persists optional story subtitles", async () => {
  const sample = (await duckglueAdapter.load("sample-data/warehouse.yaml"))!;
  const source = tile({ metrics: ["ending_mrr"], dimensions: ["month:fct_saas_monthly.month"] });
  const context = investigationContext(sample, source, [], [], { columns: ["month_month", "ending_mrr"], rows: [["2026-08-01", 100]] });
  const options = investigationOptions(sample, source, context);
  const views = defaultDetailViews(options);
  expect(views).toEqual(["headline", "waterfall:net_new_mrr:fct_mrr_movements.movement_type", "trend"]);
  const configuration = { title: "Revenue detail", subtitle: "Monthly balance with governed movement bridges.", views, layout: "grid" as const };
  expect(tileSchema.parse({ ...source, detailDashboard: configuration }).detailDashboard).toEqual(configuration);
  expect(tileSchema.safeParse({ ...source, detailDashboard: { ...configuration, views: [] } }).success).toBe(false);
  expect(tileSchema.safeParse({ ...source, detailDashboard: { ...configuration, views: ["trend", "trend"] } }).success).toBe(false);

  const arcs = storyArcsForOptions("Ending MRR", options, "dim_plans.plan_tier");
  expect(arcs.length).toBeGreaterThanOrEqual(2);
  for (const arc of arcs) {
    expect(arc.views.length).toBeGreaterThanOrEqual(1);
    expect(arc.views.length).toBeLessThanOrEqual(6);
    expect(tileSchema.safeParse({ ...source, detailDashboard: { title: arc.title, subtitle: arc.subtitle, layout: arc.layout, views: arc.views } }).success).toBe(true);
  }
});

it("offers visual latest-period bar mixes and promotes live driver dimensions in smart ranking", async () => {
  const sample = (await duckglueAdapter.load("sample-data/warehouse.yaml"))!;
  const source = tile({ metrics: ["net_new_mrr"], dimensions: ["month:fct_mrr_movements.movement_date"] });
  const context = investigationContext(sample, source, [], [], { columns: ["movement_date_month", "net_new_mrr"], rows: [["2026-07-01", 80], ["2026-08-01", 120]] });
  const options = investigationOptions(sample, source, context);
  const planMix = options.find(o => o.id === "mix:dim_plans.plan_tier");
  expect(planMix?.tile).toMatchObject({ chart: "bar", dimensions: ["dim_plans.plan_tier"], compare: "none" });
  const ranked = rankStorySubdetails(options, ["headline", "trend"], {
    "dim_plans.plan_tier": "Top mover: pro (+$4,200 · 64% of shift)",
  });
  expect(ranked[0].active).toBe(false);
  expect(ranked.find(r => r.option.id === "mix:dim_plans.plan_tier")?.driverBadge).toContain("Top mover: pro");
});

it("does not move an aggregate filter to a different reporting grain", () => {
  const source = tile({ dimensions: [], where: [{ id: "large", field: "revenue", source: "metric", mode: "range", min: 100 }] });
  const options = investigationOptions(model, source, investigationContext(model, source, [], [], { columns: ["revenue"], rows: [[150]] }));
  expect(options.map(o => o.id)).toEqual(["values"]);
});
