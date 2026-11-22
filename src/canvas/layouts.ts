import { metricOf, type Model } from "../semantic/model.ts";
import type { TileSpec } from "../compiler/spec.ts";
import { arrange, overlaps } from "./geometry.ts";
import { mergeTextFormat } from "../format/format.ts";

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
export const LAYOUT_NAMES = ["grid", "exec-summary", "story", "executive"] as const;
export type LayoutName = typeof LAYOUT_NAMES[number];

export interface LayoutInfo { name: LayoutName; label: string; description: string }

export const LAYOUTS: LayoutInfo[] = [
  { name: "exec-summary", label: "Exec Summary",
    description: "Readable KPI rows and supporting charts, keeping sections and pinned content together." },
  { name: "grid", label: "Grid",
    description: "Clean rows within each section. Keeps headings, notes and pinned content in place." },
  { name: "story", label: "Tell a story",
    description: "A vertical walkthrough, with large charts and room for commentary." },
  { name: "executive", label: "Build an executive dashboard",
    description: "Headline numbers, one leading chart, and compact supporting comparisons." },
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

// Multiple measures or a categorical series need legend space in addition to
// the title, result notices and interactive exploration row. The read-only
// preview omits some of that chrome; its smaller plot budget is not enough for
// the actual dashboard. Pinned content bypasses automatic sizing as before.
const chartHeightFloor = (t: TileSpec) => t.chart !== "table" && (t.metrics.length > 1 || t.dimensions.length > 1) ? 420 : 280;

/** A side caption becomes a short reading block when a report layout gives
 * it a whole row. Estimate conservatively, preserving paragraphs and room
 * for long words. Grid and pinned content keep their authored dimensions. */
function noteHeight(tile: TileSpec, width: number): number {
  const format = mergeTextFormat(tile.format);
  const usable = Math.max(1, width - 40);
  const capacity = Math.max(1, Math.floor(usable / (format.textSize * .55)));
  const lines = (tile.text ?? "").split("\n").reduce((sum, paragraph) => {
    let used = 0, count = 1;
    for (const word of paragraph.split(/\s+/)) {
      const length = [...word].reduce((n, c) => n + (c.codePointAt(0)! > 255 ? 2 : 1), 0);
      if (used && used + 1 + length > capacity) { count++; used = 0; }
      const total = used + (used ? 1 : 0) + length;
      count += Math.max(0, Math.ceil(total / capacity) - 1);
      used = total ? (total - 1) % capacity + 1 : 0;
    }
    return sum + count;
  }, 0);
  return Math.max(48, Math.ceil((lines * format.textSize * 1.55 + 24) / 8) * 8);
}

/**
 * How well a layout fits the CURRENT tile set -- higher is better, mirroring
 * how recommend() scores chart types rather than hiding the decision inside
 * an opaque if/else. "grid" always scores >0: it's the fallback that never
 * refuses a tile set, however it's composed.
 */
export function scoreLayout(name: LayoutName, tiles: TileSpec[]): number {
  if (name === "story" || name === "executive") return 0; // Explicit intent, never an automatic replacement.
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
    const owner = t.section === null ? "" : t.section && groups.has(t.section) ? t.section : current;
    groups.get(owner)!.push(t);
  }
  return [...groups.values()].filter(g => g.length);
}

/** A heading gives a pin an authored section to protect. Before any heading,
 * a pin belongs only to its own tile, not every loose chart on the canvas. */
export function pinnedContent(tiles: TileSpec[]): TileSpec[] {
  return sectionsOf(tiles).flatMap(group => group[0].kind === "heading" && group.some(t => t.pinned)
    ? group : group.filter(t => t.pinned));
}

/** Pack loose rows through the horizontal space around fixed content. A row
 * can split across free bands, but its reading order and readable minimum
 * widths survive. Explicit sections use the whole-section placement below. */
function placeAroundPins(packed: TileSpec[], fixed: TileSpec[], width: number, startY: number, name: LayoutName, lead?: string): TileSpec[] {
  const PAD = 24, GAP = 16, available = Math.max(1, width - 2 * PAD);
  const rows = new Map<number, TileSpec[]>();
  for (const tile of packed) { const row = rows.get(tile.layout.y) ?? []; row.push(tile); rows.set(tile.layout.y, row); }
  const placed: TileSpec[] = [];
  let y = startY;
  const minWidth = (t: TileSpec) => Math.min(available, isKpiTile(t) ? 180
    : name === "story" || name === "executive" && (t.id === lead || !isDataTile(t)) ? available
    : isDataTile(t) ? 360 : Math.min(200, t.layout.w));
  for (const row of rows.values()) {
    const remaining = [...row].sort((a, b) => a.layout.x - b.layout.x);
    while (remaining.length) {
      const height = Math.max(...remaining.map(t => t.kind === "text" && name !== "grid" ? Math.max(t.layout.h, noteHeight(t, minWidth(t))) : t.layout.h));
      const blockers = fixed.filter(t => t.layout.y < y + height + GAP && t.layout.y + t.layout.h + GAP > y);
      let bands = [{ left: PAD, right: PAD + available }];
      for (const { layout: b } of blockers) bands = bands.flatMap(band => {
        if (b.x - GAP >= band.right || b.x + b.w + GAP <= band.left) return [band];
        return [{ left: band.left, right: Math.min(band.right, b.x - GAP) },
          { left: Math.max(band.left, b.x + b.w + GAP), right: band.right }].filter(b => b.right > b.left);
      });
      let rowHeight = 0;
      for (const band of bands) {
        const space = band.right - band.left;
        const fitting: TileSpec[] = [];
        let used = 0;
        while (remaining.length) {
          const min = minWidth(remaining[0]);
          if (used + (fitting.length ? GAP : 0) + min > space) break;
          used += (fitting.length ? GAP : 0) + min;
          fitting.push(remaining.shift()!);
        }
        if (!fitting.length) continue;
        const extra = space - used;
        const desiredExtra = fitting.map(t => Math.max(0, t.layout.w - minWidth(t)));
        const totalExtra = desiredExtra.reduce((a, b) => a + b, 0);
        let x = band.left;
        fitting.forEach((t, i) => {
          const w = minWidth(t) + (totalExtra ? Math.min(1, extra / totalExtra) * desiredExtra[i] : 0);
          const h = t.kind === "text" && name !== "grid" ? noteHeight(t, Math.floor(w)) : t.layout.h;
          placed.push({ ...t, layout: { ...t.layout, x: Math.round(x), y: Math.round(y), w: Math.floor(w), h } });
          x += w + GAP; rowHeight = Math.max(rowHeight, h);
        });
      }
      if (rowHeight) y += rowHeight + GAP;
      else {
        // At least one fixed rectangle is withholding the required width.
        // Jump to its next lower edge instead of scanning pixel by pixel.
        const next = blockers.map(t => t.layout.y + t.layout.h + GAP).filter(bottom => bottom > y);
        y = next.length ? Math.min(...next) : y + height + GAP;
      }
    }
  }
  return placed;
}

export function applyLayout(name: LayoutName, tiles: TileSpec[], width: number, stretch = true, model?: Model): TileSpec[] {
  const PAD = 24, GAP = 16, avail = Math.max(1, width - PAD * 2);
  const groups = sectionsOf(tiles);
  const unsectioned = new Set(groups.filter(g => g[0].kind !== "heading").flat().map(t => t.id));
  const hasHeadings = tiles.some(t => t.kind === "heading");
  const purposeful = name === "story" || name === "executive";
  const fixed = pinnedContent(tiles), fixedIds = new Set(fixed.map(t => t.id));
  // Reserve an authored pinned section as a reading block, including its
  // whitespace. Unrelated loose tiles must not slip between its notes/charts.
  const obstacles = groups.flatMap(group => {
    if (group[0].kind !== "heading" || !group.some(t => t.pinned)) return group.filter(t => t.pinned);
    const top = Math.min(...group.map(t => t.layout.y)), bottom = Math.max(...group.map(t => t.layout.y + t.layout.h));
    return [{ ...group[0], layout: { ...group[0].layout, x: PAD, y: top, w: avail, h: bottom - top } }];
  });
  const lead = groups.flat().find(t => !fixedIds.has(t.id) && isDataTile(t) && !isKpiTile(t) && t.dimensions.some(d => d.includes(":")))?.id;
  const out: TileSpec[] = [...fixed];
  let y = PAD;
  for (const originalGroup of groups) {
    const group = originalGroup.filter(t => !fixedIds.has(t.id));
    if (!group.length) continue;
    const heading = group[0].kind === "heading" ? group[0] : null;
    const members = heading ? group.slice(1) : group;
    const kpis = members.filter(isKpiTile);
    const body = name !== "grid" ? [...kpis, ...members.filter(t => !isKpiTile(t))] : members;
    const packed: TileSpec[] = [];
    let localY = 0;
    if (heading) {
      packed.push({ ...heading, layout: { ...heading.layout, x: PAD, y: localY, w: avail, h: Math.max(48, heading.layout.h,
        noteHeight({ ...heading, text: heading.text ?? heading.title ?? "" }, avail - 64)) } });
      localY += packed[0].layout.h + 12;
    }
    for (let i = 0; i < body.length;) {
      const isKpi = isKpiTile(body[i]);
      const text = !isDataTile(body[i]);
      const run: TileSpec[] = [];
      do { run.push(body[i++]); } while (i < body.length && isKpiTile(body[i]) === isKpi && isDataTile(body[i]) === !text && !text);
      let row: TileSpec[];
      if (isKpi) {
        if (model) { const priority = (t: TileSpec) => Math.max(0, ...t.metrics.map(m => metricOf(model, m)?.importance ?? 0)); run.sort((a, b) => priority(b) - priority(a)); }
        // In a spacious story layout, give interactive KPIs wider columns and taller
        // room for wrapped labels, data checks, and sparklines; compact executive/grid
        // rows keep the 180px minimum so three KPIs fit side-by-side at 640px.
        const minWidth = name === "story" && run.some(t => t.chart === "kpi") ? 240 : 180;
        const rowHeight = name === "story" && run.some(t => t.chart === "kpi") ? 224 : 156;
        const cols = Math.max(1, Math.min(purposeful ? 3 : Infinity, Math.floor((avail + GAP) / (minWidth + GAP))));
        row = run.map((t, j) => {
          const count = Math.min(cols, run.length - Math.floor(j / cols) * cols);
          const w = Math.floor((avail - GAP * (count - 1)) / count);
          return { ...t, layout: { ...t.layout, x: PAD + (j % cols) * (w + GAP), y: Math.floor(j / cols) * (rowHeight + GAP), w, h: rowHeight } };
        });
      } else {
        row = arrange(run.map(t => {
          const w = purposeful ? (text || name === "story" || t.id === lead || avail < 736 ? avail : Math.floor((avail - GAP) / 2))
            : text ? Math.min(t.layout.w, avail) : Math.min(avail, Math.max(360, t.layout.w));
          const h = text ? t.layout.h : Math.max(chartHeightFloor(t),
            name === "story" ? 360 : name === "executive" ? (t.id === lead ? 320 : 280) : t.layout.h);
          return { ...t, layout: { ...t.layout, w, h } };
        }), width, { stretch, fillRows: name !== "grid" });
        row = row.map(t => ({ ...t, layout: { ...t.layout, y: t.layout.y - PAD } }));
        if (name !== "grid" && run[0].kind === "text") row = row.map(t => ({ ...t, layout: { ...t.layout, h: noteHeight(t, t.layout.w) } }));
      }
      packed.push(...row.map(t => ({ ...t, ...(heading ? { section: heading.id } : {}), layout: { ...t.layout, y: t.layout.y + localY } })));
      localY += Math.max(...row.map(t => t.layout.y + t.layout.h)) + GAP;
    }
    if (!heading && fixed.length) {
      const placed = placeAroundPins(packed, obstacles, width, y, name, lead);
      out.push(...placed);
      y = Math.max(y, ...placed.map(t => t.layout.y + t.layout.h + GAP));
      continue;
    }
    let collisions: TileSpec[];
    do {
      collisions = obstacles.filter(f => packed.some(t => overlaps({ ...t.layout, y: t.layout.y + y }, f.layout)));
      if (collisions.length) y = Math.max(...collisions.map(t => t.layout.y + t.layout.h)) + GAP;
    } while (collisions.length);
    out.push(...packed.map(t => ({ ...t, layout: { ...t.layout, y: t.layout.y + y } })));
    y += localY + (heading ? 20 : 0);
  }
  // Keep document identity/order stable; geometry defines the visual reading order.
  const byId = new Map(out.map(t => [t.id, t]));
  return tiles.map(t => {
    const after = byId.get(t.id) ?? t;
    // Moving a heading above a loose tile must not adopt it into that
    // heading's section on the next arrangement (especially a pinned tile).
    return hasHeadings && unsectioned.has(t.id) ? { ...after, section: null } : after;
  });
}

export function applyBestLayout(tiles: TileSpec[], width: number, model?: Model): { name: LayoutName; tiles: TileSpec[] } {
  if (!tiles.length) return { name: "grid", tiles };
  const name = bestLayout(tiles);
  return { name, tiles: applyLayout(name, tiles, width, true, model) };
}
