import { expect, it } from "vitest";
import { readableChartTitle, suggestStoryStructure } from "../src/suggest/storyStructure.ts";
import { model, tile } from "./fixtures.ts";
import { overlaps } from "../src/canvas/geometry.ts";
import { validateTile } from "../src/compiler/compile.ts";
import type { DashboardSpec } from "../src/compiler/spec.ts";

const draft = (): DashboardSpec => ({ title: "Revenue (rough draft)",
  crossFilters: [{ id: "region", source: "dimension", field: "dim_users.country", mode: "discrete", values: ["US"] }],
  tiles: [
    tile({ id: "kpi", chart: "kpi", dimensions: ["month:sold_on"], compare: "prior", format: { number: "currency" } }),
    tile({ id: "trend", title: "Revenue (USD)", chart: "line", dimensions: ["month:sold_on"], limit: 50 }),
    tile({ id: "detail", title: "Where should we invest next?", dimensions: ["dim_users.country"] }),
    tile({ id: "story-1", kind: "text", metrics: [], text: "Keep my analysis exactly as written." }),
  ] });

it("updates obsolete automatic breakdown labels while keeping authored questions", () => {
  const old = tile({ title: "Revenue (USD) by country", dimensions: ["dim_users.country"], chart: "bar" });
  const trend = { ...old, dimensions: ["month:sold_on"], chart: undefined };
  expect(readableChartTitle(model, old, trend)).toBe("Revenue (USD) over time");
  expect(readableChartTitle(model, { ...old, title: "Where should we invest next?" }, trend)).toBe("Where should we invest next?");
});

it("adds a reading order without altering queries, authored text or filters", () => {
  const before = draft(), original = structuredClone(before);
  const result = suggestStoryStructure(before, model, 1200)!;
  expect(before).toEqual(original);
  expect(result.spec.title).toBe("Revenue");
  expect(result.sections.map(s => s.title)).toEqual(["At a glance", "How it's changing", "A closer look", "Notes & context"]);
  expect(result.spec.crossFilters).toEqual(before.crossFilters);
  for (const t of before.tiles) {
    const next = result.spec.tiles.find(n => n.id === t.id)!;
    const { title: _a, layout: _b, section: _c, ...content } = t;
    const { title: _d, layout: _e, section: _f, ...nextContent } = next;
    expect(nextContent).toEqual(content);
    expect(validateTile(model, next)).toEqual([]);
  }
  expect(result.spec.tiles.find(t => t.id === "detail")!.title).toBe("Where should we invest next?");
  expect(result.spec.tiles.find(t => t.id === "trend")!.title).toBe("Revenue (USD) over time");
  expect(result.guide).toContain("Check each chart's reporting period and filters");
  expect(result.spec.tiles.find(t => t.title === "Reading guide")!.text).toBe(result.guide);
});

it.each([640, 1200])("builds a collision-free composition with a focal trend at %i pixels", width => {
  const result = suggestStoryStructure(draft(), model, width)!;
  expect(result.spec.tiles.find(t => t.id === "trend")!.layout.w).toBe(width - 48);
  expect(new Set(result.spec.tiles.map(t => t.id)).size).toBe(result.spec.tiles.length);
  for (const [i, t] of result.spec.tiles.entries()) {
    expect(t.layout.x + t.layout.w).toBeLessThanOrEqual(width);
    expect(result.spec.tiles.slice(i + 1).some(other => overlaps(t.layout, other.layout))).toBe(false);
    if (t.section) expect(result.spec.tiles.find(h => h.id === t.section)!.kind).toBe("heading");
  }
});

it("does not duplicate headings or replace pinned or existing editorial structure", () => {
  const first = suggestStoryStructure(draft(), model, 1200)!;
  expect(suggestStoryStructure(first.spec, model, 1200)).toBeNull();
  const pinned = draft(); pinned.tiles[0].pinned = true;
  expect(suggestStoryStructure(pinned, model, 1200)).toBeNull();
});

it("does not offer a composition for invalid governed queries or exceed the document limit", () => {
  const invalid = draft(); invalid.tiles[0].metrics = ["invented"];
  expect(suggestStoryStructure(invalid, model, 1200)).toBeNull();
  const full = { title: "Full", tiles: Array.from({ length: 500 }, (_, i) => tile({ id: `t${i}` })) };
  expect(suggestStoryStructure(full, model, 1200)).toBeNull();
});
