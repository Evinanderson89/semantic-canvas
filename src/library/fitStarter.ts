import type { DashboardSpec } from "../compiler/spec.ts";
import type { CanvasSpec } from "../canvas/presets.ts";
import { applyLayout } from "../canvas/layouts.ts";
import { overlaps } from "../canvas/geometry.ts";
import { tabsOf, tabView } from "../app/tabs.ts";

/** Fresh copies should be readable at this window size. Existing saved canvases keep their authored size. */
export function fitStarter(spec: DashboardSpec, canvas: CanvasSpec, width: number) {
  if (width >= canvas.width) return { spec, canvas };
  const tiles = tabsOf(spec).flatMap(tab => {
    const original = tabView(spec, tab.id).tiles;
    const messy = original.some((a, i) => original.slice(i + 1).some(b => overlaps(a.layout, b.layout)));
    // Preserve the cleanup exercise's deliberate overlaps until the user arranges it.
    if (messy) return original.map(t => ({ ...t, layout: { ...t.layout,
      x: Math.round(t.layout.x * width / canvas.width), w: Math.max(100, Math.round(t.layout.w * width / canvas.width)) } }));
    return applyLayout("exec-summary", original, width);
  });
  return { spec: { ...spec, tiles }, canvas: { ...canvas, preset: "custom", width,
    height: Math.max(900, ...tiles.map(t => t.layout.y + t.layout.h + 24)) } };
}
