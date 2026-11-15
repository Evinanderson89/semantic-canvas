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

/** Only selected measures enter the legend; absent dashboard metrics reserve their color slot. */
export function metricColorScale(measures: string[], dashboardOrder: string[], palette: string[]) {
  const order = [...new Set([...dashboardOrder, ...[...measures].sort()])];
  const domain = order.filter(metric => measures.includes(metric));
  return { domain, range: domain.map(metric => palette[order.indexOf(metric) % palette.length]) };
}
