import { describe, expect, it } from "vitest";
import { chartShapeIssue } from "../src/charts/capabilities.ts";
import { categoryPanels, categorySeries } from "../src/charts/series.ts";
import { recommend, type FieldProfile } from "../src/suggest/recommend.ts";
import { inferChart } from "../src/suggest/chartRules.ts";
import { model, tile } from "./fixtures.ts";
import { chartResult } from "../src/app/chartResult.ts";

const profile = (role: FieldProfile["role"], field: string = role, cardinality = 4): FieldProfile => ({
  field, role, type: role === "temporal" ? "date" : "string", cardinality, sample: [],
});
const kinds = (dims: FieldProfile[], measures = ["revenue"]) => recommend(measures, dims).map(o => o.kind);

describe("chart shape contract", () => {
  it("offers functioning category trends in either field order", () => {
    for (const dims of [[profile("temporal"), profile("categorical")], [profile("categorical"), profile("temporal")]]) {
      expect(kinds(dims)).toEqual(["line", "areaStacked", "heatmap", "smallMultiples", "table"]);
    }
    expect(kinds([profile("categorical"), profile("categorical")])).toEqual(["heatmap", "barStacked", "table"]);
  });

  it("keeps additional fields instead of suggesting charts that drop them", () => {
    expect(kinds([profile("temporal"), profile("categorical"), profile("geo")])).toEqual(["table"]);
    expect(kinds([profile("temporal"), profile("categorical")], ["revenue", "cost"])).toEqual(["table"]);
    expect(kinds([profile("categorical"), profile("geo")], ["revenue", "cost"])).toEqual(["table"]);
    expect(kinds([profile("geo")], ["revenue", "cost"])).toEqual(["bar", "table"]);
    expect(kinds([profile("categorical")], ["revenue", "cost", "profit"])).not.toContain("scatter");
    expect(kinds([profile("categorical", "account", 1000)], ["revenue", "cost"])).toEqual(["table"]);
  });

  it("keeps model hints inside supported shapes", () => {
    const dims = [profile("geo")];
    expect(recommend(["revenue", "cost"], dims, "map waterfall funnel").map(o => o.kind)).toEqual(["bar", "table"]);
    const roles: FieldProfile["role"][] = ["temporal", "categorical", "geo", "numeric"];
    const shapes = [[], ...roles.map(r => [profile(r)]), ...roles.flatMap(a => roles.map(b => [profile(a), profile(b)]))];
    for (const dims of shapes) for (const count of [1, 2, 3]) {
      const measures = ["revenue", "cost", "profit"].slice(0, count);
      const options = recommend(measures, dims, "trend waterfall funnel");
      expect(options.length).toBeGreaterThan(0);
      for (const option of options) expect(chartShapeIssue(option.kind, {
        measures: count, dimensions: dims.map(d => ({ temporal: d.role === "temporal", numeric: d.role === "numeric" })),
      })).toBeUndefined();
    }
  });

  it("infers time-by-category lines and uses a table when there are extra measures", () => {
    for (const dimensions of [["month:sold_on", "dim_users.country"], ["dim_users.country", "month:sold_on"]]) {
      expect(inferChart(model, tile({ dimensions }))).toBe("line");
      expect(inferChart(model, tile({ dimensions, metrics: ["revenue", "live_revenue"] }))).toBe("table");
    }
    expect(inferChart(model, tile({ dimensions: ["dim_users.country", "dim_plans.tier"] }))).toBe("heatmap");
    expect(chartShapeIssue("kpi", { measures: 2, dimensions: [] })).toBeTruthy();
    expect(chartShapeIssue("smallMultiples", { measures: 1, dimensions: [{ temporal: false }, { temporal: false }] })).toBeTruthy();
  });

  it("takes date roles from the model rather than date-like category values", () => {
    const spec = tile({ dimensions: ["dim_users.country", "month:sold_on"] });
    const plotted = chartResult(spec, { columns: ["country", "sold_on_month", "revenue"],
      rows: [["2025-01-01", "2026-05-01", 100]] }, spec.dimensions, model);
    expect(plotted.temporalColumns).toEqual(["sold_on_month"]);
    expect(plotted.rows[0][0]).toBe("2025-01-01");
  });
});

describe("category series", () => {
  const date = (month: number) => new Date(Date.UTC(2026, month - 1, 1));
  it("orders time, separates categories, and distinguishes absent values from zero", () => {
    const result = categorySeries([
      { time: date(3), segment: "Enterprise", revenue: 30 },
      { time: date(1), segment: "Enterprise", revenue: 10 },
      { time: date(3), segment: "SMB", revenue: null },
      { time: date(1), segment: "SMB", revenue: 0 },
      { time: date(2), segment: "SMB", revenue: 20 },
    ], "time", "segment", "revenue", true);
    const values = (category: string) => result.points.filter(p => result.labels.get(p.series) === category);
    expect(values("Enterprise").map(p => p.x)).toEqual([date(1), date(2), date(3)]);
    expect(values("Enterprise").map(p => p.value)).toEqual([10, null, 30]);
    expect(values("SMB").map(p => p.value)).toEqual([0, 20, null]);
  });

  it("preserves missing and numeric categories without colliding with text labels", () => {
    const result = categorySeries([null, "null", 1, "1"].map(segment => ({ time: date(1), segment, revenue: 5 })), "time", "segment", "revenue", true);
    expect(result.labels.size).toBe(4);
    expect(result.points).toHaveLength(4);
    expect([...result.labels.values()]).toContain("Missing category");
  });

  it("keeps panel coordinates separate from typed filter values and disambiguates colliding labels", () => {
    const values = [null, "Missing category", 1, "1", false, "false", "", "Empty text"];
    const series = categorySeries(values.map(segment => ({ time: date(1), segment, revenue: 5 })), "time", "segment", "revenue", true);
    const panels = categoryPanels(series);
    expect(panels.map(p => p.value)).toEqual(values);
    expect(panels.map(p => p.label)).toEqual(["Missing category (null)", '"Missing category" (text)', "1 (number)", '"1" (text)', "false (boolean)", '"false" (text)', '"" (text)', '"Empty text" (text)']);
    expect(panels.slice(3, 6).map(p => [p.col, p.row])).toEqual([[0, 1], [1, 1], [2, 1]]);
  });

  it("refuses duplicate category periods rather than silently summing or discarding a row", () => {
    expect(() => categorySeries([
      { time: date(1), segment: "Enterprise", revenue: 10 },
      { time: date(1), segment: "Enterprise", revenue: 20 },
    ], "time", "segment", "revenue", true)).toThrow("duplicate rows");
  });
});
