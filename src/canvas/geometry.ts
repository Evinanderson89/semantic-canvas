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
 * preserving each box's own HEIGHT and z, and its WIDTH relative to the
 * other boxes sharing its row -- but not its absolute width. A row that
 * doesn't quite fill `width` on its own stretches every box in it
 * proportionally to close that gap, rather than leaving the rest of the
 * row as dead margin: a tile that was twice as wide as its row-mate stays
 * twice as wide, it just isn't allowed to leave the canvas edge empty
 * doing it. That dead margin -- one lone chart at half the canvas width
 * with nothing beside it -- is exactly what "clean rows" is supposed to
 * rule out, so leaving widths untouched was working against this
 * function's own job, not respecting deliberate sizing. The stretch
 * itself is capped well short of the full row, though: a box entirely
 * alone in its row stretching all the way to the canvas edge trades one
 * problem (dead margin) for another (a chart with a modest number of
 * points spread thin across an unnaturally wide tile) -- see the cap
 * below.
 *
 * Reading order is the CURRENT layout's top-to-bottom, then left-to-right
 * position, not creation order -- so re-arranging keeps roughly the same
 * story a viewer would already read into the jumbled version.
 */
export function arrange<T extends { layout: Box }>(
  items: T[], width: number,
  opts: { pad?: number; gap?: number; stretch?: boolean } = {},
): T[] {
  if (!items.length) return items;
  const pad = opts.pad ?? 24, gap = opts.gap ?? 16, stretch = opts.stretch ?? true;
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
    const rawWidths = r.map((it) => Math.min(it.layout.w, avail));
    const rawSum = rawWidths.reduce((a, b) => a + b, 0);
    const leftover = avail - gap * (r.length - 1) - rawSum;
    // Grow each box by its own share of the row's raw width -- a box
    // already twice as wide as its row-mate gets twice as much of the
    // leftover too, so relative sizing survives even though nothing keeps
    // its EXACT original width. Capped, not unbounded: a box that ends up
    // ALONE in its row -- easy to happen after a reorder, since reading
    // order, not width-compatibility, decides what shares a row -- would
    // otherwise stretch to fill the entire row on its own, and a chart
    // with a modest number of points spread across the full canvas width
    // reads as sparse and thin, not clean. Proportional to `avail`, not a
    // fixed pixel count, so the cap scales with the canvas instead of
    // being wrong at both a narrow and a very wide one; never below any
    // box's own raw width, so this only ever limits a STRETCH, never
    // shrinks a box that's already bigger than the cap.
    // Skippable entirely (`stretch: false`): stretching is exactly right
    // for a deliberate, one-shot "make this look clean" pass (Smart
    // Arrange, Beautify's "Reorder top to bottom") where the tile set is
    // final -- but repacking after adding ONE new tile (Beautify's
    // "Add this tile", applied one at a time and each repacking from
    // scratch) or after a collision correction is a different situation:
    // stretching the tile that just became a lone row means the NEXT
    // addition inherits that wider row and can no longer share it either,
    // compounding into every addition landing in its own full-width row --
    // the exact "have to scroll forever" a growing dashboard shouldn't
    // produce. Leaving raw widths alone there means a same-sized tile added
    // right after still fits beside it.
    const cap = Math.max(avail * 0.72, ...rawWidths);
    const widths = stretch && leftover > 0
      ? rawWidths.map((w) => Math.min(w + leftover * (w / rawSum), cap))
      : rawWidths;
    let x = pad;
    r.forEach((it, i) => {
      const w = widths[i];
      out.push({ ...it, layout: { ...it.layout, x: Math.round(x), y: Math.round(y), w: Math.round(w) } });
      x += w + gap;
    });
    y += rowH + gap;
  }
  return out;
}
