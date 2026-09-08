import type { DashboardSpec } from "../compiler/spec.ts";
import type { CanvasSpec } from "../canvas/presets.ts";

export interface DocumentSnapshot { spec: DashboardSpec; canvas: CanvasSpec }
export interface Draft extends DocumentSnapshot { key: string; id: string | null; revision: number; source: string; updated: string }
/** Cross-filters are exploration state, not authored document content. */
export function documentSnapshot(spec: DashboardSpec, canvas: CanvasSpec): DocumentSnapshot {
  const { crossFilters: _, ...authored } = spec;
  return { spec: authored, canvas };
}
export const fingerprint = (spec: DashboardSpec, canvas: CanvasSpec) => JSON.stringify(documentSnapshot(spec, canvas));
export function withGrain(spec: DashboardSpec, grain: string): DashboardSpec {
  return { ...spec, tiles: spec.tiles.map((tile) => ({ ...tile,
    dimensions: tile.dimensions.map((d) => d.includes(":") ? `${grain}:${d.split(":")[1]}` : d),
  })) };
}
