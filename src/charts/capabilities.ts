import type { ChartKind } from "../compiler/spec.ts";

export interface ChartShape {
  dimensions: readonly { temporal: boolean; numeric?: boolean }[];
  measures: number;
}

/** Structural support, shared by suggestions, inference and rendering.
 * Value checks (missing components, negative funnel stages, etc.) still need
 * the actual query result. Supporting a shape does not certify its meaning. */
export function chartShapeIssue(kind: ChartKind, { dimensions, measures: m }: ChartShape): string | undefined {
  const d = dimensions.length;
  const timeAndCategory = d === 2 && dimensions.filter(d => d.temporal).length === 1;
  if (kind === "table") return;
  if (!m) return "Choose a measure to draw this chart.";
  let supported: boolean;
  switch (kind) {
    case "stat": case "kpi":
      supported = m === 1 && (d === 0 || d === 1 && dimensions[0].temporal); break;
    case "line": case "areaStacked":
      supported = d === 1 || timeAndCategory && m === 1; break;
    case "area": case "barH": case "barHorizontal": case "map": case "donut":
      supported = d === 1 && m === 1; break;
    case "bar":
      supported = d <= 1 || d === 2 && m === 1; break;
    case "barGrouped": case "barStacked":
      supported = d === 1 || d === 2 && m === 1; break;
    case "combo":
      supported = d === 1 && m === 2; break;
    case "waterfall": case "funnel":
      supported = d === 0 || d === 1 && m === 1; break;
    case "heatmap":
      supported = d === 1 || d === 2 && m === 1; break;
    case "smallMultiples":
      supported = timeAndCategory && m === 1; break;
    case "scatter":
      supported = d <= 1 && m === 2 || d === 1 && !!dimensions[0].numeric && m === 1; break;
  }
  if (!supported) return "This chart cannot show every selected breakdown and measure. Choose a supported chart or use a table to keep all selected fields.";
}
