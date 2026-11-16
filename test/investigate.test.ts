import { expect, it } from "vitest";
import { model, tile } from "./fixtures.ts";
import { investigationContext, investigationOptions } from "../src/suggest/investigate.ts";
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
  expect(options.find(o => o.id === "by:dim_users.country")?.tile).toMatchObject({ chart: "table", where: context.where, dimensions: ["month:sold_on", "dim_users.country"] });
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
  expect(options.map(o => o.id)).toEqual(["trend", "compare", "values"]);
});

it("does not offer ambiguous or fan-out joins as breakdowns", () => {
  const unsafe = structuredClone(model); unsafe.joins[0].cardinality = "one_to_many";
  const source = tile({ dimensions: ["month:sold_on"] });
  const options = investigationOptions(unsafe, source, investigationContext(unsafe, source, [], [], result));
  expect(options.some(o => o.id === "by:dim_users.country")).toBe(false);
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
