import { describe, expect, it } from "vitest";
import { PRESETS, PRESET_IDS, resolvePreset } from "../src/app/datePresets.ts";
import { dashboardFilterSchema, filterValueSchema } from "../src/compiler/schema.ts";
import { filtersForTile, hasFilterValue, validateDashboard } from "../src/app/filters.ts";
import { model, tile } from "./fixtures.ts";
import type { DashboardSpec } from "../src/compiler/spec.ts";
const at = (iso: string) => new Date(`${iso}T12:00:00`);
describe("date presets", () => {
  it("resolves every preset in the local calendar, inclusive of today", () => {
    const cases: Record<string, Record<keyof typeof PRESETS, [string, string]>> = {
      "2024-02-29": { "last-7-days": ["2024-02-23", "2024-02-29"], "last-30-days": ["2024-01-31", "2024-02-29"], "last-90-days": ["2023-12-02", "2024-02-29"], "this-month": ["2024-02-01", "2024-02-29"], "this-quarter": ["2024-01-01", "2024-02-29"], "year-to-date": ["2024-01-01", "2024-02-29"] },
      "2026-12-31": { "last-7-days": ["2026-12-25", "2026-12-31"], "last-30-days": ["2026-12-02", "2026-12-31"], "last-90-days": ["2026-10-03", "2026-12-31"], "this-month": ["2026-12-01", "2026-12-31"], "this-quarter": ["2026-10-01", "2026-12-31"], "year-to-date": ["2026-01-01", "2026-12-31"] },
      "2026-09-12": { "last-7-days": ["2026-09-06", "2026-09-12"], "last-30-days": ["2026-08-14", "2026-09-12"], "last-90-days": ["2026-06-15", "2026-09-12"], "this-month": ["2026-09-01", "2026-09-12"], "this-quarter": ["2026-07-01", "2026-09-12"], "year-to-date": ["2026-01-01", "2026-09-12"] },
      "2025-01-01": { "last-7-days": ["2024-12-26", "2025-01-01"], "last-30-days": ["2024-12-03", "2025-01-01"], "last-90-days": ["2024-10-04", "2025-01-01"], "this-month": ["2025-01-01", "2025-01-01"], "this-quarter": ["2025-01-01", "2025-01-01"], "year-to-date": ["2025-01-01", "2025-01-01"] },
    };
    for (const [now, expected] of Object.entries(cases)) for (const id of PRESET_IDS) expect({ id, now, ...PRESETS[id].resolve(at(now)) }).toEqual({ id, now, min: expected[id][0], max: expected[id][1] });
    expect(PRESET_IDS.map(p => PRESETS[p].label)).toEqual(["Last 7 days", "Last 30 days", "Last 90 days", "This month", "This quarter", "Year to date"]);
  });
  it("turns a preset into a plain range and leaves ranges alone", () => {
    expect(resolvePreset({ preset: "this-month" }, at("2026-03-15"))).toEqual({ min: "2026-03-01", max: "2026-03-15" });
    expect(resolvePreset({ min: "2026-01-01" }, at("2026-03-15"))).toEqual({ min: "2026-01-01" });
    expect(hasFilterValue({ preset: "last-7-days" })).toBe(true); expect(hasFilterValue({})).toBe(false);
  });
  it("is resolved before the compiler sees it, with the exclusive next-day bound", () => {
    const d: DashboardSpec = { title: "Presets", tiles: [tile({ id: "a" })], filters: [{ id: "when", label: "When", field: "fct_sales.sold_on", control: "date", presentation: "presets", scope: "report", defaultValue: { preset: "last-30-days" }, bindings: [{ tileId: "a", field: "fct_sales.sold_on" }] }] };
    expect(validateDashboard(model, d)).toEqual([]);
    expect(filtersForTile(d, d.tiles[0], {}, at("2026-09-12"))).toEqual([{ id: "control:when", field: "fct_sales.sold_on", source: "dimension", mode: "range", min: "2026-08-14", max: "2026-09-13", maxExclusive: true }]);
    expect(filtersForTile(d, d.tiles[0], { when: { preset: "year-to-date" } }, at("2026-09-12"))[0]).toMatchObject({ min: "2026-01-01", max: "2026-09-13" });
    expect(filtersForTile(d, d.tiles[0], { when: {} })).toEqual([]);
    d.filters![0].control = "select"; d.filters![0].presentation = "chips"; d.filters![0].field = "dim_users.country"; d.filters![0].bindings[0].field = "dim_users.country";
    expect(validateDashboard(model, d).map(i => i.problem)).toContain("Only a date filter can default to a preset");
  });
});
describe("filter presentation schema", () => {
  const base = { id: "f", label: "Country", field: "dim_users.country", control: "select", scope: "report", bindings: [] };
  it("accepts documents without a presentation and every valid pairing", () => {
    expect(dashboardFilterSchema.parse(base).presentation).toBeUndefined();
    for (const [control, presentations] of [["select", ["dropdown", "chips", "segmented"]], ["date", ["range", "presets"]], ["number", ["range"]]] as const)
      for (const presentation of presentations) expect(dashboardFilterSchema.parse({ ...base, control, presentation }).presentation).toBe(presentation);
  });
  it("rejects a presentation that belongs to another control type with a clear message", () => {
    const result = dashboardFilterSchema.safeParse({ ...base, control: "number", presentation: "chips" });
    expect(result.success).toBe(false); expect(result.error!.issues[0]).toMatchObject({ path: ["presentation"], message: "A number filter cannot be shown as chips; choose range" });
    expect(dashboardFilterSchema.safeParse({ ...base, control: "date", presentation: "segmented" }).success).toBe(false);
    expect(dashboardFilterSchema.safeParse({ ...base, control: "select", presentation: "slider" }).success).toBe(false);
  });
  it("keeps a preset and a literal range apart", () => {
    expect(filterValueSchema.parse({ preset: "last-30-days" })).toEqual({ preset: "last-30-days" });
    expect(filterValueSchema.safeParse({ preset: "last-30-days", min: "2026-01-01" }).success).toBe(false);
    expect(filterValueSchema.safeParse({ preset: "last-year" }).success).toBe(false);
    expect(validateDashboard(model, { title: "x", tiles: [], filters: [{ ...base, control: "select", presentation: "presets", bindings: [] } as any] }).map(i => i.problem)).toContain("Filter presentation does not match its control");
  });
});
