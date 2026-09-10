import { canvasSchema, dashboardSchema } from "../compiler/schema.ts";
import type { DashboardSpec } from "../compiler/spec.ts";
import type { CanvasSpec } from "../canvas/presets.ts";
import type { Model } from "../semantic/model.ts";
import { validateDashboard } from "../app/filters.ts";
import { currentTab, tabView } from "../app/tabs.ts";
import { applyLayout } from "../canvas/layouts.ts";

/** Save authored definitions, never query results or transient exploration state. */
export function captureView(book: DashboardSpec, canvas: CanvasSpec, tabId: string, selected: string[], title: string) {
  const active = tabView(book, tabId), selectedIds = new Set(selected);
  const chosen = active.tiles.filter(t => !selected.length || selectedIds.has(t.id) || !!t.section && selectedIds.has(t.section));
  if (!chosen.length) throw new Error("Choose at least one tile to save as a view");
  const ids = new Set(chosen.map(t => t.id));
  const left = Math.min(...chosen.map(t => t.layout.x)), top = Math.min(...chosen.map(t => t.layout.y));
  const filters = (book.filters ?? []).filter(f => f.bindings.some(b => ids.has(b.tileId)) || chosen.some(t => t.filterId === f.id))
    .map(f => ({ ...structuredClone(f), scope: "tab" as const, tabId: "main", bindings: f.bindings.filter(b => ids.has(b.tileId)) }));
  const tiles = chosen.map(t => ({ ...structuredClone(t), tabId: "main", section: t.section && ids.has(t.section) ? t.section : undefined,
    pinned: false, layout: { ...t.layout, x: t.layout.x - left + 24, y: t.layout.y - top + 24 } }));
  const spec = dashboardSchema.parse({ title, tabs: [{ id: "main", title: "Overview" }], tiles, filters });
  const surface = canvasSchema.parse({ ...canvas, preset: "custom", locked: false,
    width: Math.max(320, ...tiles.map(t => t.layout.x + t.layout.w + 24)), height: Math.max(320, ...tiles.map(t => t.layout.y + t.layout.h + 24)) });
  return { spec, canvas: surface };
}

/** Insert independent copies, preserving section and filter relationships. */
export function insertView(book: DashboardSpec, canvas: CanvasSpec, tabId: string, view: DashboardSpec, model: Model) {
  const tab = currentTab(book, tabId).id;
  const tileIds = new Map(view.tiles.map(t => [t.id, crypto.randomUUID()]));
  const filterIds = new Map((view.filters ?? []).map(f => [f.id, crypto.randomUUID()]));
  const existing = tabView(book, tab).tiles;
  const top = Math.min(...view.tiles.map(t => t.layout.y));
  const left = Math.min(...view.tiles.map(t => t.layout.x));
  const start = existing.length ? Math.max(...existing.map(t => t.layout.y + t.layout.h)) + 24 : 24;
  let copies = view.tiles.map(t => ({ ...structuredClone(t), id: tileIds.get(t.id)!, tabId: tab, pinned: false,
    section: t.section ? tileIds.get(t.section) : undefined, filterId: t.filterId ? filterIds.get(t.filterId) : undefined,
    layout: { ...t.layout, x: t.layout.x - left + 24, y: t.layout.y - top + 24 } }));
  if (copies.some(t => t.layout.x + t.layout.w > canvas.width - 24)) copies = applyLayout("grid", copies, canvas.width, false) as typeof copies;
  const localTop = Math.min(...copies.map(t => t.layout.y));
  copies = copies.map(t => ({ ...t, layout: { ...t.layout, y: t.layout.y - localTop + start } }));
  const filters = (view.filters ?? []).map(f => ({ ...structuredClone(f), id: filterIds.get(f.id)!, scope: "tab" as const, tabId: tab,
    bindings: f.bindings.map(b => ({ ...b, tileId: tileIds.get(b.tileId)! })) }));
  const spec = dashboardSchema.parse({ ...book, tiles: [...book.tiles, ...copies], filters: [...(book.filters ?? []), ...filters] });
  const issues = validateDashboard(model, spec); if (issues.length) throw new Error(issues[0].problem);
  const surface = canvasSchema.parse({ ...canvas, height: Math.max(canvas.height, ...copies.map(t => t.layout.y + t.layout.h + 24)) });
  return { spec, canvas: surface, inserted: copies.map(t => t.id), top: start };
}
