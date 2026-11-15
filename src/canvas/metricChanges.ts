import type { DashboardSpec } from "../compiler/spec.ts";

/** Derive evidence changes from the final documents, never from an AI's explanation. */
export function proposalMetricChanges(before: DashboardSpec, after: DashboardSpec) {
  const metricTiles = (spec: DashboardSpec) => spec.tiles.filter(t => (t.kind ?? "metric") === "metric");
  const previous = metricTiles(before), proposed = metricTiles(after);
  const shown = new Set(proposed.flatMap(t => t.metrics));
  return {
    removedMetrics: [...new Set(previous.flatMap(t => t.metrics))].filter(name => !shown.has(name)),
    substitutions: previous.flatMap(tile => {
      const next = proposed.find(t => t.id === tile.id);
      if (!next) return [];
      const removed = tile.metrics.filter(m => !next.metrics.includes(m));
      const added = next.metrics.filter(m => !tile.metrics.includes(m));
      return removed.length && added.length ? [{ id: tile.id, title: next.title || tile.title || tile.id,
        before: tile.metrics, after: next.metrics, removed, added }] : [];
    }),
  };
}
