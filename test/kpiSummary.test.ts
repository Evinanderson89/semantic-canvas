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
it("requires another shown period before comparing with the first", () => {
  for (const percent of [false, true]) for (const y of [100, 0, -100]) {
    expect(kpiSummary([{ x: "2026-08-01", y }], "first", "month", 50, percent)).toEqual({ latest: y, delta: null });
  }
  expect(kpiSummary([], "first", "month")).toEqual({ latest: null, delta: null });
});
it("distinguishes a real unchanged baseline from missing first-period data", () => {
  expect(kpiSummary([{ x: "2026-06-01", y: 100 }, { x: "2026-08-01", y: 100 }], "first", "month")).toEqual({ latest: 100, delta: 0 });
  expect(kpiSummary([{ x: "2026-06-01", y: NaN }, { x: "2026-07-01", y: 50 }, { x: "2026-08-01", y: 100 }], "first", "month")).toEqual({ latest: 100, delta: null });
});
