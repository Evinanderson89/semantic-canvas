import { expect, it } from "vitest";
import { dashboardSchema } from "../src/compiler/schema.ts";
import { briefEvidence, emptyBrief, presentationContentKey, withPresentationBrief } from "../src/app/presentationBrief.ts";
import { duplicateTab, mergeTab, tabView, removeTab } from "../src/app/tabs.ts";
import type { DashboardSpec } from "../src/compiler/spec.ts";
import { tile } from "./fixtures.ts";

const spec = (): DashboardSpec => ({ title: "Operating review", tabs: [{ id: "growth", title: "Growth" }, { id: "cost", title: "Cost" }],
  tiles: [tile({ id: "revenue", tabId: "growth" }), tile({ id: "retention", tabId: "growth" }), tile({ id: "spend", tabId: "cost" })] });
const brief = { question: "Is growth durable?", takeaway: "Review growth and retention together.", nextStep: "Investigate renewal cohorts.", evidenceIds: ["retention"] };

it("round-trips a tab's authored brief without editing charts, filters or another tab", () => {
  const before = spec();
  const next = dashboardSchema.parse(JSON.parse(JSON.stringify(withPresentationBrief(before, "growth", brief))));
  expect(next.tiles).toEqual(before.tiles); expect(next.tabs![1]).toEqual(before.tabs![1]);
  expect(next.tabs![0].brief).toEqual(brief); expect(before.tabs![0].brief).toBeUndefined();
  expect(briefEvidence(tabView(next, "growth"), brief).selected.map(t => t.id)).toEqual(["retention"]);
  expect(briefEvidence(tabView(next, "growth"), brief).omitted.map(t => t.id)).toEqual(["revenue"]);
});

it("distinguishes all, none and unavailable selections instead of silently adding evidence", () => {
  const view = tabView(spec(), "growth");
  expect(briefEvidence(view, emptyBrief()).selected).toHaveLength(2);
  expect(briefEvidence(view, { ...emptyBrief(), evidenceIds: [] }).selected).toEqual([]);
  const missing = briefEvidence(view, { ...brief, evidenceIds: ["deleted", "spend"] });
  expect(missing.selected).toEqual([]); expect(missing.missing).toEqual(["deleted", "spend"]);
});

it("copies evidence references onto the copied tab and removes only that tab's brief", () => {
  const original = withPresentationBrief(spec(), "growth", brief);
  const copied = duplicateTab(original, "growth"), tab = copied.tabs!.at(-1)!;
  expect(tab.brief!.evidenceIds).not.toEqual(brief.evidenceIds);
  const evidence = briefEvidence(tabView(copied, tab.id), tab.brief!);
  expect(evidence.selected).toHaveLength(1); expect(evidence.missing).toEqual([]);
  expect(evidence.selected[0].tabId).toBe(tab.id);
  expect(removeTab(copied, tab.id).tabs).toEqual(original.tabs);
});

it("does not mutate untouched legacy dashboards and rejects ambiguous or oversized briefs", () => {
  const legacy = { title: "Legacy", tiles: [tile()] };
  expect(withPresentationBrief(legacy, "main", emptyBrief())).toBe(legacy);
  expect(dashboardSchema.parse(withPresentationBrief(legacy, "main", brief)).tabs![0].brief).toEqual(brief);
  for (const invalid of [{ ...brief, question: "x".repeat(1001) }, { ...brief, evidenceIds: ["revenue", "revenue"] }]) {
    expect(dashboardSchema.safeParse(withPresentationBrief(legacy, "main", invalid)).success).toBe(false);
  }
});

it("keeps the presentation open across validated metadata saves but resets for changed analysis", () => {
  const before = spec(), after = dashboardSchema.parse(withPresentationBrief(before, "growth", brief));
  expect(presentationContentKey(before)).toBe(presentationContentKey(after));
  after.tiles[0].metrics = ["other_metric"];
  expect(presentationContentKey(before)).not.toBe(presentationContentKey(after));
});

it("remaps brief evidence when an edited page collides with another tab's tile ID", () => {
  const before = spec(), view = withPresentationBrief(tabView(before, "growth"), "growth", { ...brief, evidenceIds: ["spend"] });
  view.tiles = [tile({ id: "spend", tabId: "growth" })];
  const merged = mergeTab(before, view, "growth"), active = tabView(merged, "growth");
  const evidence = briefEvidence(active, merged.tabs![0].brief!);
  expect(evidence.missing).toEqual([]); expect(evidence.selected).toHaveLength(1);
  expect(evidence.selected[0].id).not.toBe("spend");
  expect(tabView(merged, "cost").tiles).toEqual(tabView(before, "cost").tiles);
});

it("validates a bounded review marker while keeping older briefs valid", () => {
  const reviewed = { ...brief, review: { version: 1, reviewedAt: "2026-11-14T12:00:00.000Z", fingerprint: "a".repeat(64) } };
  expect(dashboardSchema.parse(withPresentationBrief(spec(), "growth", reviewed as any)).tabs![0].brief).toEqual(reviewed);
  for (const review of [{ ...reviewed.review, version: 2 }, { ...reviewed.review, fingerprint: "raw data" }, { ...reviewed.review, reviewedAt: "yesterday" }]) {
    expect(dashboardSchema.safeParse(withPresentationBrief(spec(), "growth", { ...brief, review } as any)).success).toBe(false);
  }
});
