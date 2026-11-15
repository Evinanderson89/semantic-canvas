import { expect, it } from "vitest";
import { proposalMetricChanges } from "../src/canvas/metricChanges.ts";
import { tile } from "./fixtures.ts";

it("discloses a repurposed chart even when its original metric is retained elsewhere", () => {
  const before = { title: "Before", tiles: [tile({ id: "a", metrics: ["revenue"] }), tile({ id: "b", metrics: ["revenue"] })] };
  const after = { ...before, tiles: [tile({ id: "a", title: "Efficiency", metrics: ["arpu"] }), before.tiles[1]] };
  const originals = structuredClone([before, after]);
  expect(proposalMetricChanges(before, after)).toMatchObject({ removedMetrics: [], substitutions: [
    { id: "a", title: "Efficiency", before: ["revenue"], after: ["arpu"], removed: ["revenue"], added: ["arpu"] },
  ] });
  expect([before, after]).toEqual(originals);
});
it("distinguishes partial substitution, complete disappearance and a removed tile", () => {
  const before = { title: "Before", tiles: [tile({ metrics: ["revenue", "users"] })] };
  const after = { ...before, tiles: [tile({ metrics: ["revenue", "arpu"] })] };
  expect(proposalMetricChanges(before, after)).toMatchObject({ removedMetrics: ["users"], substitutions: [{ removed: ["users"], added: ["arpu"] }] });
  expect(proposalMetricChanges(before, { ...before, tiles: [] })).toMatchObject({ removedMetrics: ["revenue", "users"], substitutions: [] });
});
it("does not call an addition or order change a substitution", () => {
  const before = { title: "Before", tiles: [tile({ metrics: ["revenue", "users"] })] };
  for (const metrics of [["users", "revenue"], ["revenue", "users", "arpu"]]) {
    expect(proposalMetricChanges(before, { ...before, tiles: [tile({ metrics })] })).toMatchObject({ removedMetrics: [], substitutions: [] });
  }
});

it("distinguishes enriching existing charts from reusing metrics on new charts", () => {
  const before = { title: "Before", tiles: [tile({ id: "movement", metrics: ["new_mrr"] }), tile({ id: "traffic", metrics: ["web_sessions"] }), tile({ id: "revenue", metrics: ["ending_mrr"] })] };
  const after = { ...before, tiles: [
    { ...before.tiles[0], metrics: ["new_mrr", "expansion_mrr", "lost_mrr"] },
    { ...before.tiles[1], metrics: ["web_sessions", "signup_conversion_rate"] }, before.tiles[2],
    tile({ id: "trend", title: "Revenue and retention", metrics: ["ending_mrr", "nrr"] }),
    tile({ id: "caption", kind: "text", text: "Context", metrics: [] }),
  ] };
  expect(proposalMetricChanges(before, after)).toEqual({ removedMetrics: [], substitutions: [], additions: [
    { id: "movement", title: "movement", newTile: false, added: ["expansion_mrr", "lost_mrr"], newToDashboard: ["expansion_mrr", "lost_mrr"] },
    { id: "traffic", title: "traffic", newTile: false, added: ["signup_conversion_rate"], newToDashboard: ["signup_conversion_rate"] },
    { id: "trend", title: "Revenue and retention", newTile: true, added: ["ending_mrr", "nrr"], newToDashboard: ["nrr"] },
  ] });
  expect(proposalMetricChanges(before, before).additions).toEqual([]);
});
