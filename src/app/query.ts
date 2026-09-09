import type { FilterSpec, TileSpec } from "../compiler/spec.ts";
import { fieldReachable, type Model } from "../semantic/model.ts";
import type { DrillEntry } from "./drill.ts";

/** Charts and critique must ask the same question, including exploration state. */
export function visibleQuery(model: Model, tile: TileSpec, filters: FilterSpec[] = [], drill: DrillEntry[] = []) {
  const base = model.metrics[tile.metrics[0]]?.baseTable;
  const active = drill.at(-1);
  const time = tile.dimensions.findIndex(d => d.includes(":"));
  const dimensions = tile.dimensions.map((d, i) => active && i === time ? `${active.grain}:${d.split(":")[1]}` : d);
  const where: FilterSpec[] = [...(tile.where ?? []), ...filters.filter(f => base && f.source === "dimension" && fieldReachable(model, base, f.field)),
    ...(active ? [{ id: `drill:${tile.id}`, field: active.column, source: "dimension" as const, mode: "range" as const, min: active.min, max: active.max, maxExclusive: true }] : [])];
  return { id: tile.id, metrics: tile.metrics, dimensions, where, limit: tile.limit,
    compare: tile.compare ?? (tile.chart === "kpi" && time >= 0 ? "prior" as const : undefined) };
}
