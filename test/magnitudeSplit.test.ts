import { describe, expect, it } from "vitest";
import { definedRows, magnitudeSplit, preciseTickFormat } from "../src/charts/Chart.tsx";

const row = (spend: number, cpc: number) => ({ month: "x", marketing_spend: spend, cost_per_click: cpc });

describe("magnitudeSplit", () => {
  it("splits two measures of the same unit class when magnitudes differ by more than the threshold", () => {
    // The reported bug: spend in the hundreds of thousands, CPC around a
    // couple of dollars -- both "currency," 50,000x apart.
    const data = [row(1000, 2.1), row(50000, 1.9), row(203000, 2.4)];
    const plan = magnitudeSplit(data, ["marketing_spend", "cost_per_click"]);
    expect(plan).not.toBeNull();
    expect(plan!.primary).toEqual(["marketing_spend"]);
    expect(plan!.secondary).toEqual(["cost_per_click"]);
  });

  it("does not split measures within the threshold of each other", () => {
    const data = [row(100, 90), row(150, 140)];
    expect(magnitudeSplit(data, ["marketing_spend", "cost_per_click"])).toBeNull();
  });

  it("does nothing for a single measure", () => {
    expect(magnitudeSplit([{ x: "a", m: 5 }], ["m"])).toBeNull();
  });

  it("remaps a secondary value into the primary axis's numeric range", () => {
    const data = [row(0, 0), row(200000, 4)];
    const plan = magnitudeSplit(data, ["marketing_spend", "cost_per_click"])!;
    // cost_per_click's domain is [0, 4]; marketing_spend's is [0, 200000] --
    // the midpoint of one should land at the midpoint of the other.
    expect(plan.remap(2)).toBeCloseTo(100000, 0);
    expect(plan.remap(0)).toBeCloseTo(0, 0);
    expect(plan.remap(4)).toBeCloseTo(200000, 0);
  });

  it("handles negative values (a contraction/decline series) without breaking the domain", () => {
    const data = [row(-500, 100000), row(500, -50000)];
    // marketing_spend here is the small one (max abs 500) vs a much larger
    // swing metric -- whichever has the larger span becomes primary.
    const plan = magnitudeSplit(data, ["marketing_spend", "cost_per_click"]);
    expect(plan).not.toBeNull();
    expect(plan!.primary).toEqual(["cost_per_click"]);
    expect(plan!.secondary).toEqual(["marketing_spend"]);
  });

  it("does not zero-anchor a secondary series whose real range never gets near zero", () => {
    // Regression: real cost_per_click hovering at $0.8403-$0.8406 (a tiny
    // but genuine wobble) was being forced onto a [0, 0.84] domain, which
    // crushed that entire wobble into an invisible sliver at the very top
    // of the secondary axis -- the same "reads as always the same value"
    // failure this feature exists to prevent, just self-inflicted on the
    // axis it draws by hand instead of the one Plot draws.
    const data = [row(4077, 0.84045), row(3400, 0.84069), row(4640, 0.84054), row(3585, 0.84053)];
    const plan = magnitudeSplit(data, ["marketing_spend", "cost_per_click"])!;
    expect(plan.secondaryDomain.min).toBeCloseTo(0.84045, 5);
    expect(plan.secondaryDomain.max).toBeCloseTo(0.84069, 5);
    // The tiny real spread should map across nearly the FULL primary
    // range, not get compressed into a sliver near primaryDomain.max.
    const lo = plan.remap(0.84045), hi = plan.remap(0.84069);
    expect(hi - lo).toBeCloseTo(4640 - 3400, 0);
  });

  it("splits a genuinely squashed pair that's under the old 20x threshold but still unreadable", () => {
    // Real data: logo_churn_rate (0-12.1%) next to nrr/grr (90.1-104.4%),
    // ~8.6x apart -- churn reads as a flat line pinned to the bottom of an
    // axis two retention rates near 100% dominate. The 20x threshold this
    // feature shipped with never caught it.
    const data = [
      { month: "a", nrr: 0.9014, grr: 0.9014, logo_churn_rate: 0 },
      { month: "b", nrr: 1.0444, grr: 1.0, logo_churn_rate: 0.1212 },
    ];
    const plan = magnitudeSplit(data, ["nrr", "grr", "logo_churn_rate"]);
    expect(plan).not.toBeNull();
    expect(plan!.primary.sort()).toEqual(["grr", "nrr"]);
    expect(plan!.secondary).toEqual(["logo_churn_rate"]);
  });

  it("splits cac_payback_months from ltv_cac_ratio (~7.7x, also under the old threshold)", () => {
    const data = [
      { month: "a", ltv_cac_ratio: 0.1821, cac_payback_months: 9.8557 },
      { month: "b", ltv_cac_ratio: 5.8547, cac_payback_months: 45.2959 },
    ];
    const plan = magnitudeSplit(data, ["ltv_cac_ratio", "cac_payback_months"]);
    expect(plan).not.toBeNull();
    expect(plan!.primary).toEqual(["cac_payback_months"]);
    expect(plan!.secondary).toEqual(["ltv_cac_ratio"]);
  });

  it("three measures: only the ones far enough from the top get split off", () => {
    const data = [{ x: "a", big: 200000, mid: 8000, tiny: 3 }];
    // 200000/8000 = 25x and 200000/3 = 66,666x -- both over the 20x
    // threshold, so both join the secondary axis alongside "big" alone.
    const plan = magnitudeSplit(data, ["big", "mid", "tiny"]);
    expect(plan).not.toBeNull();
    expect(plan!.primary).toEqual(["big"]);
    expect(plan!.secondary.sort()).toEqual(["mid", "tiny"]);
  });
});

describe("definedRows", () => {
  it("drops a genuine null value", () => {
    // Regression: an annualized metric with no trailing history yet for
    // its first period or two comes back as a real SQL NULL. Plot.line
    // already gaps a null y on its own; Plot.areaY does not, and drew a
    // wedge from an implicit zero up to the first real value -- reading
    // as "this shot up from nothing" instead of "no data yet".
    const rows = [{ month: "2024-07", churn: null }, { month: "2024-10", churn: 0.64 }];
    expect(definedRows(rows, "churn")).toEqual([{ month: "2024-10", churn: 0.64 }]);
  });

  it("keeps a genuine zero -- not the same thing as null", () => {
    const rows = [{ month: "2024-10", churn: 0 }, { month: "2024-11", churn: 0.79 }];
    expect(definedRows(rows, "churn")).toEqual(rows);
  });

  it("does not drop a real zero via Number(null) coincidentally also being 0", () => {
    // A finiteness check on Number(d[key]) would wrongly keep null here,
    // since Number(null) is 0 -- a finite number -- not NaN.
    const rows = [{ churn: null }, { churn: 0 }];
    expect(definedRows(rows, "churn")).toEqual([{ churn: 0 }]);
  });

  it("also drops undefined", () => {
    const rows = [{ churn: undefined }, { churn: 0.5 }];
    expect(definedRows(rows, "churn")).toEqual([{ churn: 0.5 }]);
  });
});

describe("preciseTickFormat", () => {
  const currency2dp = (v: number) => `$${v.toFixed(2)}`;

  it("keeps the base formatter when its labels already distinguish every tick", () => {
    const fmt = preciseTickFormat([0, 50000, 100000, 150000, 200000], currency2dp);
    expect(fmt(100000)).toBe("$100000.00");
  });

  it("falls back to more decimal precision when the base formatter collapses every tick to the same label", () => {
    // Exactly the bug: four ticks a few ten-thousandths apart all render
    // as "$0.84" under a fixed-2-decimal formatter.
    const ticks = [0.8403, 0.8404, 0.8405, 0.8406, 0.8407];
    const fmt = preciseTickFormat(ticks, currency2dp);
    const labels = ticks.map(fmt);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels[0]).toMatch(/^\$0\.8403/);
  });

  it("keeps the base formatter's prefix and suffix for a plain-value fallback", () => {
    const dollarsNoPrefix = (v: number) => `${v.toFixed(1)} USD`;
    const ticks = [1000.001, 1000.002];
    const fmt = preciseTickFormat(ticks, dollarsNoPrefix);
    expect(fmt(1000.001)).toMatch(/ USD$/);
    expect(new Set(ticks.map(fmt)).size).toBe(2);
  });

  it("special-cases percent -- multiplies by 100 rather than appending a literal % to the raw value", () => {
    // A percent formatter's "%" isn't just a suffix: 0.10001 has to read as
    // "10.0...%", not "0.10001%" (a fake hundred-fold error).
    const percent1dp = (v: number) => `${(v * 100).toFixed(1)}%`;
    const ticks = [0.10001, 0.10002, 0.10003];
    const fmt = preciseTickFormat(ticks, percent1dp);
    const label = fmt(0.10001);
    expect(label).toMatch(/^10\.00\d*%$/);
    expect(new Set(ticks.map(fmt)).size).toBe(3);
  });
});
