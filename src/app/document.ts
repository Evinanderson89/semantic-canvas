import { z } from "zod";
import { canvasSchema, dashboardSchema } from "../compiler/schema.ts";
import type { DashboardSpec } from "../compiler/spec.ts";
import type { CanvasSpec } from "../canvas/presets.ts";

export interface DocumentSnapshot { spec: DashboardSpec; canvas: CanvasSpec }
export interface Draft extends DocumentSnapshot { key: string; id: string | null; revision: number; source: string; updated: string; folderId?: string | null }
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

const draftSchema = z.object({ spec: dashboardSchema, canvas: canvasSchema, key: z.string(), id: z.string().nullable(), revision: z.number().int().nonnegative(), source: z.string(), updated: z.string(), folderId: z.string().nullable().optional() });
export function parseDrafts(raw: string | null): Draft[] {
  const result = z.array(draftSchema).safeParse(JSON.parse(raw ?? "[]"));
  if (!result.success) throw new Error("Recovery storage contains an unreadable draft. Download your current document before leaving.");
  return result.data;
}
export function documentGrain(spec: DashboardSpec | null): string {
  const grains = new Set(spec?.tiles.flatMap(t => t.dimensions.filter(d => d.includes(":")).map(d => d.split(":")[0])) ?? []);
  return grains.size > 1 ? "mixed" : [...grains][0] ?? "month";
}
