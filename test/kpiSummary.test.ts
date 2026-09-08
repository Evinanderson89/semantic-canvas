import { expect, it } from "vitest";
import { kpiSummary } from "../src/app/kpiSummary.ts";
it("does not label an older observed month as the prior period", () => {
  expect(kpiSummary([{ x: "2024-01-01", y: 100 }, { x: "2024-03-01", y: 300 }], "prior", "month")).toEqual({ latest: 300, delta: null });
});
it("does not turn null into zero or carry forward an older known KPI", () => {
  expect(kpiSummary([{ x: "2024-01-01", y: 100 }, { x: "2024-02-01", y: NaN }], "prior", "month")).toEqual({ latest: null, delta: null });
});
it("uses the server's calendar comparison when requested", () => {
  expect(kpiSummary([{ x: "2024-01-01", y: 100 }, { x: "2024-02-01", y: 300 }], "prior", "month", 200)).toEqual({ latest: 300, delta: .5 });
});
