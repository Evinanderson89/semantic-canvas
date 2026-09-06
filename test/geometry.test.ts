import { describe, expect, it } from "vitest";
import { arrange, boundsOf, overlaps } from "../src/canvas/geometry.ts";

const box = (id: string, x: number, y: number, w: number, h: number) => ({ id, layout: { x, y, w, h } });

describe("overlaps", () => {
  it("detects genuine overlap", () => {
    expect(overlaps({ x: 0, y: 0, w: 100, h: 100 }, { x: 50, y: 50, w: 100, h: 100 })).toBe(true);
  });
  it("does not flag boxes that merely touch at an edge", () => {
    expect(overlaps({ x: 0, y: 0, w: 100, h: 100 }, { x: 100, y: 0, w: 100, h: 100 })).toBe(false);
  });
  it("does not flag boxes with no overlap at all", () => {
    expect(overlaps({ x: 0, y: 0, w: 50, h: 50 }, { x: 200, y: 200, w: 50, h: 50 })).toBe(false);
  });
});

describe("arrange", () => {
  it("packs boxes that fit into one row without overlap", () => {
    const out = arrange([box("a", 400, 300, 300, 150), box("b", 0, 0, 300, 150)], 900);
    // Reading order follows the ORIGINAL layout (b was above a), not input order.
    const [b, a] = out;
    expect(b.layout.x).toBe(24);
    expect(a.layout.x).toBeGreaterThan(b.layout.x);
    expect(a.layout.y).toBe(b.layout.y);
    // The row stretches to fill the canvas edge to edge -- no dead margin
    // after the last box.
    expect(a.layout.x + a.layout.w).toBe(900 - 24);
  });

  it("wraps to a new row once the running width exceeds the canvas", () => {
    const items = [box("a", 0, 0, 500, 200), box("b", 0, 0, 500, 200), box("c", 0, 0, 500, 200)];
    // avail = 1100 - 24*2 = 1052: two 500s + a 16 gap (1016) fit, a third doesn't.
    const out = arrange(items, 1100);
    const [a, b, c] = out;
    expect(a.layout.y).toBe(b.layout.y);
    expect(c.layout.y).toBeGreaterThan(a.layout.y);
  });

  it("never overlaps, regardless of the starting mess", () => {
    const items = [box("a", 900, 900, 300, 150), box("b", -50, 400, 300, 150),
                    box("c", 200, 700, 300, 150), box("d", 0, 0, 200, 100)];
    const out = arrange(items, 1000);
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const A = out[i].layout, B = out[j].layout;
        const overlap = A.x < B.x + B.w && B.x < A.x + A.w && A.y < B.y + B.h && B.y < A.y + A.h;
        expect(overlap).toBe(false);
      }
    }
  });

  it("clamps a box wider than the canvas rather than looping forever", () => {
    const out = arrange([box("a", 0, 0, 5000, 200)], 900);
    expect(out[0].layout.w).toBeLessThanOrEqual(900 - 24 * 2);
  });

  it("preserves each box's own height, and grows its width some -- but capped, not filling the whole row", () => {
    const out = arrange([box("a", 0, 0, 333, 271)], 900);
    expect(out[0].layout.h).toBe(271);
    const avail = 900 - 24 * 2;
    // Alone in its row, it grows from its raw width (still better than the
    // dead margin doing nothing would leave) but stops well short of the
    // full row -- filling all the way to the edge is its own problem for a
    // chart with a modest number of points (see arrange()'s own comment).
    expect(out[0].layout.w).toBeGreaterThan(333);
    expect(out[0].layout.w).toBeLessThan(avail);
  });

  it("never lets a box stretch past roughly three-quarters of the row, however alone it is", () => {
    // A box that ends up entirely alone in its row is easy to produce --
    // Beautify's "Reorder top to bottom" sorts by reading order, not width
    // compatibility, so a chart can land with nothing to share a row with.
    const out = arrange([box("a", 0, 0, 100, 200)], 2000);
    const avail = 2000 - 24 * 2;
    expect(out[0].layout.w).toBeLessThan(avail * 0.8);
  });

  it("with stretch:false, leaves a lone box at its own raw width instead of filling the row", () => {
    // Regression: a lone box stretched up toward the cap left no room for
    // the NEXT box of similar size to share its row, so repeated additions
    // (each repacked one at a time) piled up one full-width row per
    // addition -- the "have to scroll forever" this option exists to avoid.
    const out = arrange([box("a", 0, 0, 480, 300)], 1440, { stretch: false });
    expect(out[0].layout.w).toBe(480);
  });

  it("with stretch:false, still lets a same-sized box added right after share the row", () => {
    const first = arrange([box("a", 24, 999999, 480, 300)], 1440, { stretch: false });
    const second = arrange([...first, box("b", 24, 999999, 480, 300)], 1440, { stretch: false });
    expect(second[0].layout.y).toBe(second[1].layout.y);
    expect(second[1].layout.x).toBeGreaterThan(second[0].layout.x);
  });

  it("does not shrink a box that's already wider than the cap would allow", () => {
    const out = arrange([box("a", 0, 0, 1200, 200)], 1300);
    // avail = 1300 - 48 = 1252; the box is wider than any stretch cap would
    // suggest, but it must never come out SMALLER than it went in.
    expect(out[0].layout.w).toBeGreaterThanOrEqual(1200);
  });

  it("keeps relative width between boxes sharing a row, even though neither keeps its exact original width", () => {
    const out = arrange([box("a", 0, 0, 200, 100), box("b", 0, 0, 100, 100)], 900);
    const [first, second] = [...out].sort((x, y) => x.layout.x - y.layout.x);
    // "a" was twice as wide as "b" -- still is (within a pixel of independent
    // rounding), both just grew to fill the row.
    expect(Math.abs(first.layout.w - second.layout.w * 2)).toBeLessThanOrEqual(1);
  });

  it("is a no-op shape-wise on an empty list", () => {
    expect(arrange([], 900)).toEqual([]);
  });
});

describe("boundsOf", () => {
  it("still works after arrange -- packed content starts at the pad", () => {
    const out = arrange([box("a", 400, 300, 300, 150), box("b", 0, 0, 300, 150)], 900);
    const b = boundsOf(out.map((o) => o.layout));
    expect(b.x).toBe(24);
    expect(b.y).toBe(24);
  });
});
