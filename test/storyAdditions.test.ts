import { beforeAll, expect, it } from "vitest";
import { duckglueAdapter } from "../src/semantic/duckglue.ts";
import { prepareStoryAddition, equivalentStoryTile } from "../src/suggest/storyAdditions.ts";
import { validateTile } from "../src/compiler/compile.ts";
import { model as fixture } from "./fixtures.ts";
import type { Model } from "../src/semantic/model.ts";
let model: Model;
beforeAll(async () => { model = (await duckglueAdapter.load("sample-data/warehouse.yaml"))!; });
const headline = { title: "Net retention", metrics: ["nrr"], breakdown: "none" as const };

it("prepares a monthly retention headline and distinguishes it from a full trend", () => {
  const tile = prepareStoryAddition(model, headline);
  expect(tile).toMatchObject({ chart: "kpi", dimensions: ["month:fct_saas_monthly.month"], section: null, layout: { h: 156 } });
  expect(validateTile(model, tile)).toEqual([]);
  const renamed = { ...tile, title: "Different title", dimensions: ["month:month"] };
  expect(equivalentStoryTile(model, [renamed], headline)).toBe(true);
  expect(equivalentStoryTile(model, [{ ...tile, kind: "kpi", chart: undefined }], headline)).toBe(true);
  expect(equivalentStoryTile(model, [{ ...tile, chart: "line" }], headline)).toBe(false);
  expect(equivalentStoryTile(model, [tile], { ...headline, breakdown: "time" })).toBe(false);
  expect(equivalentStoryTile(model, [{ ...tile, where: [{ id: "region", field: "country", source: "dimension", mode: "discrete", values: ["US"] }] }], headline)).toBe(false);
});

it("uses required grains for the selected metric and its governed components", () => {
  const limited = structuredClone(fixture);
  Object.assign(limited.metrics.revenue, { timeGrains: ["quarter"], timeDimension: "fct_sales.sold_on" });
  limited.metrics.double_revenue = { ...limited.metrics.revenue, name: "double_revenue", type: "derived", expression: "revenue * 2", timeGrains: undefined, timeDimension: undefined };
  for (const metrics of [["revenue"], ["double_revenue"]]) {
    const tile = prepareStoryAddition(limited, { title: "Quarterly revenue", metrics, breakdown: "none" });
    expect(tile.dimensions).toEqual(["quarter:fct_sales.sold_on"]);
    expect(tile.chart).toBe("kpi"); expect(validateTile(limited, tile)).toEqual([]);
  }
});

it("refuses impossible additions before Apply and does not invent a time axis", () => {
  expect(() => prepareStoryAddition(fixture, { title: "Users", metrics: ["users"], breakdown: "time" })).toThrow(/no declared date/);
  expect(() => prepareStoryAddition(fixture, { title: "Missing", metrics: ["invented"], breakdown: "none" })).toThrow(/governed catalog/);
  expect(() => prepareStoryAddition(model, { title: "Mixed", metrics: ["nrr", "new_mrr"], breakdown: "time" })).toThrow(/one tile is one base table/);
  expect(prepareStoryAddition(fixture, { title: "Users", metrics: ["users"], breakdown: "none" })).toMatchObject({ chart: "stat", dimensions: [] });
});
