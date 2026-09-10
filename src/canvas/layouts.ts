import type { TileSpec } from "../compiler/spec.ts";
import { arrange, overlaps } from "./geometry.ts";

/**
 * Named layout templates Smart Arrange chooses between, rather than always
 * doing generic row-packing. Pure and framework-agnostic on purpose -- the
 * EditBar button and the agent-facing /api/dashboards/:id/arrange endpoint
 * both call the same functions, so "arrange this" means the same thing
 * everywhere it's invoked from.
 *
 * Both templates preserve sections and pinned positions. "grid" packs rows
 * within each section; "exec-summary" gives headline KPIs readable widths
 * and places supporting charts beneath them. Headings and narrative content
 * travel with their section rather than being collected at the end.
 */
export type LayoutName = "grid" | "exec-summary";

export interface LayoutInfo { name: LayoutName; label: string; description: string }

export const LAYOUTS: LayoutInfo[] = [
  { name: "exec-summary", label: "Exec Summary",
    description: "Readable KPI rows and supporting charts, keeping sections and pinned content together." },
  { name: "grid", label: "Grid",
    description: "Clean rows within each section. Keeps headings, notes and pinned content in place." },
];

/**
 * A "headline number" tile: renders as a compact stat/KPI card, not a chart
 * that needs real width to be readable. Must match inferChart's own "stat"
 * rule (chartRules.ts) exactly -- a single-metric tile is only dimensionless
 * stat/kpi when it has NO dimensions. A single-metric tile WITH a time or
 * categorical dimension (revenue by month, signups by plan) still renders as
 * an area/bar/line chart, and packing it at KPI-card width is what produced
 * the illegible, over-cropped row this used to ship: every single-metric
 * chart on the dashboard -- which is most of them, since one metric per tile
 * is the common case -- got miscounted as a KPI regardless of its dimensions.
 */
const isKpiTile = (t: TileSpec) =>
  (t.kind ?? "metric") === "metric" &&
  (t.chart === "kpi" || t.chart === "stat" ||
   (!t.chart && (t.dimensions ?? []).length === 0 && t.metrics.length === 1));
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

/** Infer legacy sections from reading order; explicit membership survives manual moves. */
export function sectionsOf(tiles: TileSpec[]): TileSpec[][] {
  const ordered = [...tiles].sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x);
  const groups = new Map<string, TileSpec[]>([["", []]]);
  for (const t of ordered) if (t.kind === "heading") groups.set(t.id, [t]);
  let current = "";
  for (const t of ordered) {
    if (t.kind === "heading") { current = t.id; continue; }
    const owner = t.section && groups.has(t.section) ? t.section : current;
    groups.get(owner)!.push(t);
  }
  return [...groups.values()].filter(g => g.length);
}

export function applyLayout(name: LayoutName, tiles: TileSpec[], width: number, stretch = true): TileSpec[] {
  const PAD = 24, GAP = 16, avail = Math.max(1, width - PAD * 2);
  const groups = sectionsOf(tiles);
  // A pinned item anchors its whole section, so its title and notes stay meaningful.
  const fixed = groups.filter(g => g.some(t => t.pinned)).flat();
  const out: TileSpec[] = [...fixed];
  let y = PAD;
  for (const group of groups) {
    if (group.some(t => t.pinned)) continue;
    const heading = group[0].kind === "heading" ? group[0] : null;
    const members = heading ? group.slice(1) : group;
    const kpis = members.filter(isKpiTile);
    const body = name === "exec-summary" ? [...kpis, ...members.filter(t => !isKpiTile(t))] : members;
    const packed: TileSpec[] = [];
    let localY = 0;
    if (heading) {
      packed.push({ ...heading, layout: { ...heading.layout, x: PAD, y: localY, w: avail, h: Math.max(48, heading.layout.h) } });
      localY += Math.max(48, heading.layout.h) + 12;
    }
    for (let i = 0; i < body.length;) {
      const isKpi = isKpiTile(body[i]);
      const text = !isDataTile(body[i]);
      const run: TileSpec[] = [];
      do { run.push(body[i++]); } while (i < body.length && isKpiTile(body[i]) === isKpi && isDataTile(body[i]) === !text && !text);
      let row: TileSpec[];
      if (isKpi) {
        const cols = Math.max(1, Math.floor((avail + GAP) / (180 + GAP)));
        row = run.map((t, j) => {
          const count = Math.min(cols, run.length - Math.floor(j / cols) * cols);
          const w = Math.floor((avail - GAP * (count - 1)) / count);
          return { ...t, layout: { ...t.layout, x: PAD + (j % cols) * (w + GAP), y: Math.floor(j / cols) * (156 + GAP), w, h: 156 } };
        });
      } else {
        row = arrange(run.map(t => ({ ...t, layout: { ...t.layout, w: text ? Math.min(t.layout.w, avail) : Math.min(avail, Math.max(360, t.layout.w)), h: text ? t.layout.h : Math.max(280, t.layout.h) } })), width, { stretch });
        row = row.map(t => ({ ...t, layout: { ...t.layout, y: t.layout.y - PAD } }));
      }
      packed.push(...row.map(t => ({ ...t, ...(heading ? { section: heading.id } : {}), layout: { ...t.layout, y: t.layout.y + localY } })));
      localY += Math.max(...row.map(t => t.layout.y + t.layout.h)) + GAP;
    }
    let collisions: TileSpec[];
    do {
      collisions = fixed.filter(f => packed.some(t => overlaps({ ...t.layout, y: t.layout.y + y }, f.layout)));
      if (collisions.length) y = Math.max(...collisions.map(t => t.layout.y + t.layout.h)) + GAP;
    } while (collisions.length);
    out.push(...packed.map(t => ({ ...t, layout: { ...t.layout, y: t.layout.y + y } })));
    y += localY + (heading ? 20 : 0);
  }
  // Keep document identity/order stable; geometry defines the visual reading order.
  const byId = new Map(out.map(t => [t.id, t]));
  return tiles.map(t => byId.get(t.id) ?? t);
}

export function applyBestLayout(tiles: TileSpec[], width: number): { name: LayoutName; tiles: TileSpec[] } {
  if (!tiles.length) return { name: "grid", tiles };
  const name = bestLayout(tiles);
  return { name, tiles: applyLayout(name, tiles, width) };
}
