import { format as d3format } from "d3-format";
import { componentValue } from "./values.ts";

/** Ratios describe the returned stage totals. They are not proof that the
 * same people progressed through a cohort or followed a declared sequence. */
export function funnelStages(input: { label: string; value: unknown }[]) {
  const stages = input.map((stage, i) => ({ key: `stage:${i}`, label: stage.label, value: componentValue(stage.value) }));
  if (stages.some(stage => stage.value < 0)) throw new Error("A funnel needs non-negative stage values. Use a bar or table for signed values.");
  const first = stages[0]?.value ?? 0;
  const rows = stages.map(stage => {
    const percent = first > 0 ? stage.value / first * 100 : NaN;
    const relative = !Number.isFinite(percent) ? "—" : stage.value === 0 ? "0%" : percent < .1 ? "<0.1%"
      : `${d3format(percent >= 1000 ? ".3~g" : ".1~f")(percent)}%`;
    return { ...stage, relative };
  });
  const caption = [
    first > 0 ? "Percentages compare each returned stage total with the first stage." : "The first stage is zero; percentages cannot be calculated.",
    first > 0 && rows.some(row => row.relative === "—") ? "A dash indicates a ratio outside the supported numeric range." : "",
    "Stage totals alone do not establish a cohort conversion rate.",
  ].filter(Boolean).join(" ");
  return { rows, caption };
}
