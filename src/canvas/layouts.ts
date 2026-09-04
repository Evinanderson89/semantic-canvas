import type { TileSpec } from "../compiler/spec.ts";
import { arrange } from "./geometry.ts";

/**
 * Named layout templates Smart Arrange chooses between, rather than always
 * doing generic row-packing. Pure and framework-agnostic on purpose -- the
 * EditBar button and the agent-facing /api/dashboards/:id/arrange endpoint
 * both call the same functions, so "arrange this" means the same thing
 * everywhere it's invoked from.
 *
 * Two templates for now (a thin first slice, not the full library): "grid"
 * is exactly the row-packer Smart Arrange already used. "exec-summary" is
 * new -- headline KPIs in one row, then charts, then everything else -- and
 * is deliberately close to what suggest.ts already builds for a headline-led
 * dashboard, just derived from whatever tiles are already on the canvas.
 */
export type LayoutName = "grid" | "exec-summary";

export interface LayoutInfo { name: LayoutName; label: string; description: string }

export const LAYOUTS: LayoutInfo[] = [
  { name: "exec-summary", label: "Exec Summary",
    description: "Headline KPIs in one row, trend and breakdown charts below." },
  { name: "grid", label: "Grid",
    description: "Packs every tile into clean rows, in reading order. Fits any mix." },
];

const isKpiTile = (t: TileSpec) =>
  (t.kind ?? "metric") === "metric" && (t.chart === "kpi" || (!t.chart && t.metrics.length === 1));
const isDataTile = (t: TileSpec) => (t.kind ?? "metric") === "metric";

/**
 * How well a layout fits the CURRENT tile set -- higher is better, mirroring
 * how recommend() scores chart types rather than hiding the decision inside
 * an opaque if/else. "grid" always scores >0: it's the fallback that never
 * refuses a tile set, however it's composed.
 */
export function scoreLayout(name: LayoutName, tiles: TileSpec[]): number {
  const kpis = tiles.filter(isKpiTile).length;
  const charts = tiles.filter((t) => isDataTile(t) && !isKpiTile(t)).length;
  if (name === "exec-summary") {
    // Wants a couple of headline numbers AND something backing them up --
    // KPIs alone, or charts alone, don't make this the better fit than grid.
    return kpis >= 2 && charts >= 1 ? 3 + Math.min(kpis, 4) * 0.1 : 0;
  }
  return 1;
}

export function bestLayout(tiles: TileSpec[]): LayoutName {
  return [...LAYOUTS].sort((a, b) => scoreLayout(b.name, tiles) - scoreLayout(a.name, tiles))[0]?.name ?? "grid";
}

function layoutGrid(tiles: TileSpec[], width: number): TileSpec[] {
  return arrange(tiles, width);
}

function layoutExecSummary(tiles: TileSpec[], width: number): TileSpec[] {
  const PAD = 24, GAP = 16;
  const kpis = tiles.filter(isKpiTile);
  const charts = tiles.filter((t) => isDataTile(t) && !isKpiTile(t));
  // Headings, text, dividers, images: not enough structure here yet to place
  // a heading just above the section it introduces, so they're packed as
  // their own block after the data. A real gap, not papered over.
  const rest = tiles.filter((t) => !isDataTile(t));

  const out: TileSpec[] = [];
  let y = PAD;

  if (kpis.length) {
    const w = Math.round((width - PAD * 2 - GAP * (kpis.length - 1)) / kpis.length);
    kpis.forEach((t, i) => out.push({ ...t, layout: { x: PAD + i * (w + GAP), y, w, h: 156, z: 1 } }));
    y += 156 + GAP;
  }

  const packBelow = (group: TileSpec[]) => {
    if (!group.length) return;
    const packed = arrange(group, width, { pad: PAD });
    const shift = y - PAD;
    const shifted = packed.map((t) => ({ ...t, layout: { ...t.layout, y: t.layout.y + shift } }));
    out.push(...shifted);
    y = Math.max(...shifted.map((t) => t.layout.y + t.layout.h)) + GAP;
  };
  packBelow(charts);
  packBelow(rest);

  return out;
}

export function applyLayout(name: LayoutName, tiles: TileSpec[], width: number): TileSpec[] {
  return name === "exec-summary" ? layoutExecSummary(tiles, width) : layoutGrid(tiles, width);
}

export function applyBestLayout(tiles: TileSpec[], width: number): { name: LayoutName; tiles: TileSpec[] } {
  if (!tiles.length) return { name: "grid", tiles };
  const name = bestLayout(tiles);
  return { name, tiles: applyLayout(name, tiles, width) };
}
