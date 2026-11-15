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
