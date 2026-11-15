import { expect, it } from "vitest";
import { redesignReadiness } from "../src/app/redesignReadiness.ts";
import { redesignImpact } from "../src/app/redesignImpact.ts";
import { model, tile } from "./fixtures.ts";
import type { TileSpec } from "../src/compiler/spec.ts";
import type { Readiness } from "../src/app/readiness.ts";

const original = tile({ id: "chart", chart: "line", dimensions: ["month:sold_on"] });
const error: Readiness = { status: "error", message: "Synthetic warehouse unavailable" };
const before = { title: "Original", tiles: [original] };
function check(afterTile: TileSpec, baseline: Readiness = error) {
  const after = { ...before, tiles: [afterTile] };
  return redesignReadiness(after.tiles, { chart: error }, { chart: baseline }, redesignImpact(before, after, model).tiles);
}
it("separates a known existing failure when only placement or the title changes", () => {
  const result = check({ ...original, title: "Revenue trend", layout: { ...original.layout, x: original.layout.x + 24, z: 2 } });
  expect(result.existing.map(t => t.id)).toEqual(["chart"]);
  expect(result.blocking).toEqual([]);
  expect(result.settled).toBe(true);
});
it.each([
  ["visualization", { ...original, chart: "area" }],
  ["render size", { ...original, layout: { ...original.layout, w: original.layout.w + 40 } }],
  ["formatting", { ...original, format: { lineScale: "fit" } }],
  ["metrics", { ...original, metrics: ["users"] }],
  ["reporting grain", { ...original, dimensions: ["day:sold_on"] }],
  ["comparison", { ...original, compare: "prior" }],
] as [string, TileSpec][])("keeps a failed %s change blocking even when the baseline also failed", (_name, next) => {
  expect(check(next).blocking.map(t => t.id)).toEqual(["chart"]);
  expect(check(next).settled).toBe(false);
});
it("does not classify a failure as existing when the original succeeded, is pending, or failed differently", () => {
  for (const baseline of [{ status: "ready" }, { status: "checking" }, { status: "error", message: "Different failure" }] as Readiness[])
    expect(check(original, baseline).blocking.map(t => t.id)).toEqual(["chart"]);
  expect(redesignReadiness([original], { chart: error }, {}, []).settled).toBe(false);
});
it("includes effective filter scope changes even when the tile itself is unchanged", () => {
  const impact = redesignImpact(before, before, model, {}, { filters: { chart: [{ id: "country", source: "dimension", field: "dim_users.country", mode: "discrete", values: ["US"] }] } });
  expect(redesignReadiness(before.tiles, { chart: error }, { chart: error }, impact.tiles).blocking).toHaveLength(1);
});
it("does not wait for imaginary chart queries in a text-only layout, and still waits for a real pending chart", () => {
  expect(redesignReadiness([], {}, {}, []).settled).toBe(true);
  expect(redesignReadiness([original], {}, {}, []).settled).toBe(false);
});
