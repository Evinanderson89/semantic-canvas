import type { FilterSpec, TileSpec } from "../compiler/spec.ts";
import { metricOf, fieldReachable, type Model } from "../semantic/model.ts";
import { compatibleDrill, type DrillEntry } from "./drill.ts";
import { resolvedChartKind } from "../suggest/chartRules.ts";
import { cardComparison } from "../charts/cardComparison.ts";

/** Charts and critique must ask the same question, including exploration state. */
export function visibleQuery(model: Model, tile: TileSpec, filters: FilterSpec[] = [], drill: DrillEntry[] = []) {
  const base = metricOf(model, tile.metrics[0])?.baseTable;
  // Never ask for a grain the tile cannot be reported at, even from a stale drill stack.
  const active = compatibleDrill(model, tile, drill).at(-1);
  const time = tile.dimensions.findIndex(d => d.includes(":"));
  const dimensions = tile.dimensions.map((d, i) => active && i === time ? `${active.grain}:${d.split(":")[1]}` : d);
  const mode = resolvedChartKind(model, { ...tile, dimensions }) === "kpi" ? cardComparison({ ...tile, dimensions }) : tile.compare;
  const where: FilterSpec[] = [...(tile.where ?? []), ...filters.filter(f => base && f.source === "dimension" && fieldReachable(model, base, f.field)),
    ...(active ? [{ id: `drill:${tile.id}`, field: active.column, source: "dimension" as const, mode: "range" as const, min: active.min, max: active.max, maxExclusive: true }] : [])];
  return { id: tile.id, metrics: tile.metrics, dimensions, where, limit: tile.limit,
    compare: mode === "first" ? "none" as const : mode };
}
