import { expect, it } from "vitest";
import { funnelStages } from "../src/charts/funnel.ts";

it("retains order, repeated labels, increases and measured zero without hiding tiny stages", () => {
  const result = funnelStages([{ label: "Start", value: "1000" }, { label: "Repeat", value: 1500 }, { label: "Repeat", value: .01 }, { label: "Complete", value: 0 }]);
  expect(result.rows.map(r => r.label)).toEqual(["Start", "Repeat", "Repeat", "Complete"]);
  expect(new Set(result.rows.map(r => r.key)).size).toBe(4);
  expect(result.rows.map(r => r.relative)).toEqual(["100%", "150%", "<0.1%", "0%"]);
  expect(result.caption).toContain("do not establish a cohort conversion rate");
});

it("does not invent percentages for a zero first stage or unrepresentable ratios", () => {
  const zero = funnelStages([{ label: "Start", value: 0 }, { label: "Next", value: 10 }]);
  expect(zero.rows.map(r => r.relative)).toEqual(["—", "—"]);
  expect(zero.caption).toContain("first stage is zero");
  const overflow = funnelStages([{ label: "Start", value: 1e-300 }, { label: "Next", value: 1e308 }]);
  expect(overflow.rows[1].relative).toBe("—"); expect(overflow.caption).toContain("outside the supported numeric range");
  expect(funnelStages([{ label: "Start", value: 1e308 }, { label: "Tiny", value: 1e-300 }]).rows[1].relative).toBe("<0.1%");
  for (const value of [-1, null, "", true, NaN, Infinity]) expect(() => funnelStages([{ label: "Stage", value }])).toThrow();
});
