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
    expect(a.layout.x).toBe(24 + 300 + 16);
    expect(a.layout.y).toBe(b.layout.y);
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

  it("preserves each box's own size", () => {
    const out = arrange([box("a", 0, 0, 333, 271)], 900);
    expect(out[0].layout.w).toBe(333);
    expect(out[0].layout.h).toBe(271);
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
