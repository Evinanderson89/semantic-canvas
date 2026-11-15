import type { TileSpec } from "../compiler/spec.ts";
import type { Readiness } from "./readiness.ts";
import type { TileImpact } from "./redesignImpact.ts";

// These edits cannot change a chart's query, visual encoding, or render size.
const placementOnly = new Set(["Title", "Position", "Stacking order", "Section"]);
export function redesignReadiness(charts: TileSpec[], checks: Record<string, Readiness>, baseline: Record<string, Readiness>, changes: TileImpact[]) {
  const failed = charts.filter(tile => checks[tile.id]?.status === "error");
  const existing = failed.filter(tile => {
    const before = baseline[tile.id], after = checks[tile.id];
    if (before?.status !== "error" || !before.message || before.message !== after.message) return false;
    const change = changes.find(change => change.id === tile.id);
    return !change || change.status === "changed" && change.changes.every(field => placementOnly.has(field.label));
  });
  const existingIds = new Set(existing.map(tile => tile.id));
  const blocking = failed.filter(tile => !existingIds.has(tile.id));
  return { failed, existing, blocking,
    settled: charts.every(tile => checks[tile.id]?.status === "ready" || existingIds.has(tile.id)),
  };
}
