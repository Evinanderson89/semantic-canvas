import { hcl, lab } from "d3";
import { createContext, useContext, type ReactNode } from "react";
import type { TileSpec } from "../compiler/spec.ts";

const MetricOrder = createContext<string[]>([]);

/** A shared metric identity, independent of tile position, query rows and presentation selection.
 * Explicit per-chart palettes still apply. Category and signed-value scales remain separate. */
export function MetricColorProvider({ tiles, children }: { tiles: Pick<TileSpec, "metrics">[]; children: ReactNode }) {
  const order = [...new Set(tiles.flatMap(tile => tile.metrics))].sort();
  return <MetricOrder value={order}>{children}</MetricOrder>;
}
export const useMetricOrder = () => useContext(MetricOrder);

/** Preserve the selected palette, then add separated shades rather than wrapping
 * its slots. Cycling a six-color palette made the seventh dashboard metric
 * indistinguishable from the first even when both appeared in one chart.
 * The sequence depends only on the palette, so subsets retain their identities. */
function expandedPalette(palette: string[], count: number): string[] {
  const colors = palette.length ? [...palette] : ["#5b8fb0"];
  if (count <= colors.length) return colors;
  const seen = new Set(colors.map(color => lab(color).formatHex()));
  const candidates = new Map<string, ReturnType<typeof lab>>();
  for (const color of colors) {
    const base = hcl(color);
    for (const lightness of [30, 45, 60, 75]) for (const chroma of [.65, 1]) {
      const candidate = hcl(base.h, base.c * chroma, lightness).formatHex();
      if (!seen.has(candidate)) candidates.set(candidate, lab(candidate));
    }
  }
  const selected = colors.map(color => lab(color));
  const distance = (a: ReturnType<typeof lab>, b: ReturnType<typeof lab>) =>
    (a.l - b.l) ** 2 + (a.a - b.a) ** 2 + (a.b - b.b) ** 2;
  let overflow = 0;
  while (colors.length < count) {
    // Unusually large catalogs can exhaust the shade candidates. Continue with
    // distinct hues; do not silently reintroduce identical metric colors.
    if (!candidates.size) {
      const candidate = hcl(overflow++ * 137.508, 48, 55).formatHex();
      if (seen.has(candidate)) continue;
      candidates.set(candidate, lab(candidate));
    }
    let best = "", separation = -1;
    for (const [color, value] of candidates) {
      const nearest = Math.min(...selected.map(other => distance(value, other)));
      if (nearest > separation) { best = color; separation = nearest; }
    }
    colors.push(best); selected.push(candidates.get(best)!); seen.add(best); candidates.delete(best);
  }
  return colors;
}

/** Only selected measures enter the legend; absent dashboard metrics reserve their color slot. */
export function metricColorScale(measures: string[], dashboardOrder: string[], palette: string[]) {
  const order = [...new Set([...dashboardOrder, ...[...measures].sort()])];
  const domain = order.filter(metric => measures.includes(metric));
  const colors = expandedPalette(palette, order.length);
  return { domain, range: domain.map(metric => colors[order.indexOf(metric)]) };
}
