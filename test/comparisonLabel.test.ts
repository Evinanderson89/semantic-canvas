import { expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Kpi } from "../src/app/Kpi.tsx";
import { DEFAULT_FORMAT, makeFormatter } from "../src/format/format.ts";

const card = (latest: number, previous: number, percent = false) => renderToStaticMarkup(createElement(Kpi, {
  label: "Measured change", series: [{ x: "2026-08-01", y: latest }], grain: "month", previous, comparison: "prior", percent,
}));
it("distinguishes small real changes from displayed zero in currency/count comparisons", () => {
  expect(card(99.99, 100)).toContain("Down &lt;0.1%");
  expect(card(100.01, 100)).toContain("Up &lt;0.1%");
  expect(card(100, 100)).toContain("+0.0%");
  expect(card(99.9, 100)).toContain("−0.1%");
});
it("uses percentage points for small movements in percentage metrics", () => {
  expect(card(.0351254, .035126, true)).toContain("Down &lt;0.1 pp");
  expect(card(.035126, .0351254, true)).toContain("Up &lt;0.1 pp");
  expect(card(.035, .035, true)).toContain("+0.0 pp");
  expect(card(.95, .96, true)).toContain("−1.0 pp");
});
it("preserves the side of 100% in default value labels while honoring explicit precision", () => {
  const defaults = makeFormatter({ ...DEFAULT_FORMAT, number: "percent" });
  expect(defaults(.9996)).toBe("99.96%");
  expect(defaults(1.0004)).toBe("100.04%");
  expect(defaults(.9999999999)).toBe("<100%");
  expect(defaults(1.0000000001)).toBe(">100%");
  expect(defaults(1)).toBe("100.0%");
  expect(defaults(1.028)).toBe("102.8%");
  expect(makeFormatter({ ...DEFAULT_FORMAT, number: "percent", decimals: 1 })(.9996)).toBe("100.0%");
  expect(defaults.exact!(.9996)).toContain("99.96");
});
