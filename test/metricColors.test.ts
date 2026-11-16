import { expect, it } from "vitest";
import { metricColorScale } from "../src/charts/MetricColors.tsx";

it("reserves dashboard metric colors when a chart shows a subset or reverses measure order", () => {
  const palette = ["blue", "green", "amber"];
  expect(metricColorScale(["new", "expansion"], ["churn", "expansion", "new"], palette))
    .toEqual({ domain: ["expansion", "new"], range: ["green", "amber"] });
  expect(metricColorScale(["expansion", "new"], ["churn", "expansion", "new"], palette))
    .toEqual({ domain: ["expansion", "new"], range: ["green", "amber"] });
  expect(metricColorScale(["new"], ["churn", "expansion", "new"], palette))
    .toEqual({ domain: ["new"], range: ["amber"] });
});
it("uses the selected palette and includes only rendered measures in the legend", () => {
  expect(metricColorScale(["new"], ["churn", "expansion", "new"], ["red", "orange", "yellow"]))
    .toEqual({ domain: ["new"], range: ["yellow"] });
  expect(metricColorScale(["new", "expansion"], [], ["blue", "green"]))
    .toEqual({ domain: ["expansion", "new"], range: ["blue", "green"] });
});

it("does not recycle colors when a dashboard exceeds its palette, including new versus churned MRR", () => {
  const order = ["cac", "churned_mrr", "contraction_mrr", "ending_mrr", "expansion_mrr", "grr", "ltv_cac_ratio", "new_mrr", "nrr", "signup_conversion_rate", "web_sessions"];
  const palette = ["#5b8fb0", "#43866c", "#b18442", "#bb7460", "#9680b5", "#509b96"];
  const all = metricColorScale(order, order, palette);
  expect(new Set(all.range).size).toBe(order.length);
  expect(all.range.slice(0, palette.length)).toEqual(palette);
  const movements = metricColorScale(["new_mrr", "expansion_mrr", "churned_mrr", "contraction_mrr"], order, palette);
  expect(new Set(movements.range).size).toBe(4);
  for (const [i, metric] of movements.domain.entries())
    expect(movements.range[i]).toBe(all.range[all.domain.indexOf(metric)]);
  const extended = metricColorScale([...order, "zz-extra"], [...order, "zz-extra"], palette);
  expect(extended.range.slice(0, all.range.length)).toEqual(all.range);
});

it("keeps large and single-color palettes distinct without changing a selected metric's identity", () => {
  const order = Array.from({ length: 60 }, (_, i) => `metric-${i}`);
  for (const palette of [["#43866c"], ["#e5934d", "#e5736a", "#d8a24d"], []]) {
    const all = metricColorScale(order, order, palette);
    expect(new Set(all.range).size).toBe(order.length);
    expect(all.range.every(color => /^#[0-9a-f]{6}$/i.test(color))).toBe(true);
    expect(metricColorScale([order[59]], order, palette).range).toEqual([all.range[59]]);
  }
});
