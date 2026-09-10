import { describe, expect, it } from "vitest";
import { model, tile } from "./fixtures.ts";
import { mergeTab, duplicateTab, removeTab, tabView } from "../src/app/tabs.ts";
import { filtersForTile, suggestedBindings, validateDashboard } from "../src/app/filters.ts";
import { distributeCharts } from "../src/app/DistributeDialog.tsx";
import { fingerprint } from "../src/app/document.ts";
import { DEFAULT_CANVAS } from "../src/canvas/presets.ts";
import type { DashboardSpec } from "../src/compiler/spec.ts";
const document = (): DashboardSpec => ({ title: "Sales", tabs: [{ id: "one", title: "Overview" }, { id: "two", title: "Detail" }], tiles: [tile({ id: "a", tabId: "one" }), tile({ id: "b", tabId: "two" })], filters: [{ id: "country", label: "Country", field: "dim_users.country", control: "select", scope: "report", bindings: [{ tileId: "a", field: "dim_users.country" }, { tileId: "b", field: "dim_users.country" }] }] });
describe("document tabs", () => {
  it("edits only the active tab and preserves the saved document", () => {
    const d = document(); const view = tabView(d, "one"); view.tiles[0] = { ...view.tiles[0], title: "Changed" };
    const next = mergeTab(d, view, "one"); expect(next.tiles.find(t => t.id === "b")).toEqual(d.tiles[1]); expect(next.tiles.find(t => t.id === "a")?.title).toBe("Changed"); expect(next.filters).toEqual(d.filters);
    expect(fingerprint(next, DEFAULT_CANVAS)).not.toBe(fingerprint(d, DEFAULT_CANVAS));
  });
  it("keeps legacy tiles on the first tab", () => { const d = document(); delete d.tiles[0].tabId; expect(tabView(d, "one").tiles.map(t => t.id)).toEqual(["a"]); expect(tabView(d, "missing").tiles.map(t => t.id)).toEqual(["a"]); });
  it("prunes deleted chart bindings without removing other tabs", () => { const d = document(); const next = mergeTab(d, { ...tabView(d, "one"), tiles: [] }, "one"); expect(next.filters![0].bindings.map(b => b.tileId)).toEqual(["b"]); });
  it("duplicates local controls and extends shared controls using fresh IDs", () => {
    const d = document(); d.filters!.push({ ...d.filters![0], id: "local", scope: "tab", tabId: "one", bindings: [d.filters![0].bindings[0]] }); d.tiles.push(tile({ id: "control", kind: "filter", tabId: "one", filterId: "local", metrics: [] }));
    const next = duplicateTab(d, "one"), copied = tabView(next, next.tabs!.at(-1)!.id);
    expect(next.filters).toHaveLength(3); expect(next.filters![0].bindings).toHaveLength(3); expect(copied.tiles[1].filterId).not.toBe("local"); expect(validateDashboard(model, next)).toEqual([]);
  });
  it("deletes only the requested tab and keeps surviving bindings", () => { const next = removeTab(document(), "one"); expect(next.tiles.map(t => t.id)).toEqual(["b"]); expect(next.filters![0].bindings.map(b => b.tileId)).toEqual(["b"]); expect(validateDashboard(model, next)).toEqual([]); expect(() => removeTab(next, "two")).toThrow(); });
});
describe("filter truthfulness", () => {
  it("suggests only reachable targets in scope", () => { const d = document(); d.tiles.push(tile({ id: "other", tabId: "two", metrics: ["users"] })); expect(suggestedBindings(d, model, "fct_sales.sold_on", "report", "one").map(b => b.tileId)).toEqual(["a", "b"]); expect(suggestedBindings(d, model, "dim_users.country", "tab", "one").map(b => b.tileId)).toEqual(["a"]); });
  it("shares runtime selections across tabs but honors explicit unbinding", () => { const d = document(), values = { country: { values: ["US"] } }; expect(filtersForTile(d, d.tiles[0], values)).toEqual(filtersForTile(d, d.tiles[1], values)); d.filters![0].bindings.pop(); expect(filtersForTile(d, d.tiles[1], values)).toEqual([]); });
  it("lets reset override an authored default without modifying the document", () => { const d = document(); d.filters![0].defaultValue = { values: ["US"] }; expect(filtersForTile(d, d.tiles[0], {})).toHaveLength(1); expect(filtersForTile(d, d.tiles[0], { country: {} })).toEqual([]); });
  it("rejects forged targets, cross-tab local bindings and invalid defaults", () => {
    const d = document(); d.filters![0].scope = "tab"; d.filters![0].tabId = "one"; expect(validateDashboard(model, d).length).toBeGreaterThan(0);
    d.filters![0].scope = "report"; d.filters![0].bindings[0].field = "private.secret"; expect(validateDashboard(model, d).length).toBeGreaterThan(0);
    d.filters![0] = { id: "date", label: "Date", field: "fct_sales.sold_on", scope: "report", control: "date", bindings: [], defaultValue: { min: 12 } }; expect(validateDashboard(model, d).length).toBeGreaterThan(0);
  });
  it("copies independent charts and auto-connects destination fields", () => { const d = document(), next = distributeCharts(d, [d.tiles[0]], "two", 1200, model); const copy = next.tiles.at(-1)!; expect(copy.id).not.toBe("a"); expect(copy.tabId).toBe("two"); expect(copy.layout.y).toBeGreaterThan(d.tiles[1].layout.y + d.tiles[1].layout.h); expect(next.filters![0].bindings.at(-1)!.tileId).toBe(copy.id); expect(d.tiles).toHaveLength(2); });
});
it("date controls include the whole last day without including the next day", async () => {
  const { compileTile } = await import("../src/compiler/compile.ts"); const { conn } = await import("./fixtures.ts");
  const d = document(); d.filters![0] = { id: "date", label: "Period", field: "fct_sales.sold_on", control: "date", scope: "report", bindings: [{ tileId: "a", field: "fct_sales.sold_on" }] };
  const where = filtersForTile(d, d.tiles[0], { date: { min: "2026-03-01", max: "2026-03-31" } });
  expect(where[0]).toMatchObject({ min: "2026-03-01", max: "2026-04-01", maxExclusive: true });
  expect(compileTile(model, conn, { ...d.tiles[0], where })).toContain('< \'2026-04-01\'');
});
