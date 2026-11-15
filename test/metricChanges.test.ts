import { expect, it } from "vitest";
import { proposalMetricChanges } from "../src/canvas/metricChanges.ts";
import { tile } from "./fixtures.ts";

it("discloses a repurposed chart even when its original metric is retained elsewhere", () => {
  const before = { title: "Before", tiles: [tile({ id: "a", metrics: ["revenue"] }), tile({ id: "b", metrics: ["revenue"] })] };
  const after = { ...before, tiles: [tile({ id: "a", title: "Efficiency", metrics: ["arpu"] }), before.tiles[1]] };
  const originals = structuredClone([before, after]);
  expect(proposalMetricChanges(before, after)).toEqual({ removedMetrics: [], substitutions: [
    { id: "a", title: "Efficiency", before: ["revenue"], after: ["arpu"], removed: ["revenue"], added: ["arpu"] },
  ] });
  expect([before, after]).toEqual(originals);
});
it("distinguishes partial substitution, complete disappearance and a removed tile", () => {
  const before = { title: "Before", tiles: [tile({ metrics: ["revenue", "users"] })] };
  const after = { ...before, tiles: [tile({ metrics: ["revenue", "arpu"] })] };
  expect(proposalMetricChanges(before, after)).toMatchObject({ removedMetrics: ["users"], substitutions: [{ removed: ["users"], added: ["arpu"] }] });
  expect(proposalMetricChanges(before, { ...before, tiles: [] })).toEqual({ removedMetrics: ["revenue", "users"], substitutions: [] });
});
it("does not call an addition or order change a substitution", () => {
  const before = { title: "Before", tiles: [tile({ metrics: ["revenue", "users"] })] };
  for (const metrics of [["users", "revenue"], ["revenue", "users", "arpu"]]) {
    expect(proposalMetricChanges(before, { ...before, tiles: [tile({ metrics })] })).toEqual({ removedMetrics: [], substitutions: [] });
  }
});
