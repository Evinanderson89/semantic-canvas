export interface Box { x: number; y: number; w: number; h: number }

export const snapTo = (v: number, grid: number, on: boolean) =>
  on ? Math.round(v / grid) * grid : Math.round(v);

/** Edges of a box that other boxes can align to. */
export function edges(b: Box) {
  return {
    v: [b.x, b.x + b.w / 2, b.x + b.w],
    h: [b.y, b.y + b.h / 2, b.y + b.h],
  };
}

/**
 * Alignment guides: when a dragged box comes within `tol` of another box's
 * edge or centre, snap to it and report the line to draw. This is what makes a
 * free canvas feel precise instead of approximate.
 */
export function guidesFor(moving: Box, others: Box[], tol = 5) {
  let dx = 0, dy = 0;
  const me = edges(moving);
  let bestV = tol + 1, bestH = tol + 1;
  // Only the winning edge on each axis becomes a guide. Pushing every improving
  // candidate drew lines at positions the tile did not actually snap to.
  let lineV: number | null = null;
  let lineH: number | null = null;

  for (const o of others) {
    const oe = edges(o);
    for (const mv of me.v) for (const ov of oe.v) {
      const d = Math.abs(mv - ov);
      if (d <= tol && d < bestV) { bestV = d; dx = ov - mv; lineV = ov; }
    }
    for (const mh of me.h) for (const oh of oe.h) {
      const d = Math.abs(mh - oh);
      if (d <= tol && d < bestH) { bestH = d; dy = oh - mh; lineH = oh; }
    }
  }
  const lines: { axis: "v" | "h"; at: number }[] = [];
  if (lineV !== null) lines.push({ axis: "v", at: lineV });
  if (lineH !== null) lines.push({ axis: "h", at: lineH });
  return { dx: bestV <= tol ? dx : 0, dy: bestH <= tol ? dy : 0, lines };
}

export function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export function boundsOf(boxes: Box[]): Box {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const r = Math.max(...boxes.map((b) => b.x + b.w));
  const bt = Math.max(...boxes.map((b) => b.y + b.h));
  return { x, y, w: r - x, h: bt - y };
}

/**
 * Repacks a set of boxes into clean top-to-bottom rows within `width`,
 * preserving each box's own size and z -- this fixes overlapping tiles,
 * ragged gaps and drift after a bunch of manual moves, without
 * second-guessing how anything was deliberately sized.
 *
 * Reading order is the CURRENT layout's top-to-bottom, then left-to-right
 * position, not creation order -- so re-arranging keeps roughly the same
 * story a viewer would already read into the jumbled version.
 */
export function arrange<T extends { layout: Box }>(
  items: T[], width: number, opts: { pad?: number; gap?: number } = {},
): T[] {
  if (!items.length) return items;
  const pad = opts.pad ?? 24, gap = opts.gap ?? 16;
  const avail = Math.max(1, width - pad * 2);
  const ordered = [...items].sort((a, b) =>
    a.layout.y - b.layout.y || a.layout.x - b.layout.x);

  const rows: T[][] = [];
  let row: T[] = [];
  let rowW = 0;
  for (const it of ordered) {
    const w = Math.min(it.layout.w, avail);
    const next = row.length ? rowW + gap + w : w;
    if (row.length && next > avail) { rows.push(row); row = []; rowW = 0; }
    row.push(it);
    rowW = row.length === 1 ? w : rowW + gap + w;
  }
  if (row.length) rows.push(row);

  const out: T[] = [];
  let y = pad;
  for (const r of rows) {
    const rowH = Math.max(...r.map((it) => it.layout.h));
    let x = pad;
    for (const it of r) {
      const w = Math.min(it.layout.w, avail);
      out.push({ ...it, layout: { ...it.layout, x: Math.round(x), y: Math.round(y), w: Math.round(w) } });
      x += w + gap;
    }
    y += rowH + gap;
  }
  return out;
}
