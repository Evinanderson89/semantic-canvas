import type { DashboardSpec, TileSpec } from "../compiler/spec.ts";

export const tabsOf = (spec: DashboardSpec) => spec.tabs ?? [{ id: "main", title: "Overview" }];
export const tabOf = (spec: DashboardSpec, tile: TileSpec) => tile.tabId ?? tabsOf(spec)[0].id;
export const currentTab = (spec: DashboardSpec, id: string) => tabsOf(spec).find(t => t.id === id) ?? tabsOf(spec)[0];
export function tabView(spec: DashboardSpec, id: string): DashboardSpec {
  const active = currentTab(spec, id).id;
  return { ...spec, tiles: spec.tiles.filter(t => tabOf(spec, t) === active) };
}

/** Replace only the visible page. All other pages remain in the document. */
export function mergeTab(spec: DashboardSpec | null, view: DashboardSpec, id: string): DashboardSpec {
  if (!spec) return view;
  const active = currentTab(spec, id).id;
  const other = spec.tiles.filter(t => tabOf(spec, t) !== active);
  const used = new Set(other.map(t => t.id));
  const remap = new Map(view.tiles.filter(t => used.has(t.id)).map(t => [t.id, crypto.randomUUID()]));
  const tiles = view.tiles.map(t => ({ ...t, id: remap.get(t.id) ?? t.id,
    ...(spec.tabs ? { tabId: active } : {}), section: t.section ? remap.get(t.section) ?? t.section : undefined }));
  const result = { ...spec, ...view, tiles: [...other, ...tiles] };
  const present = new Set(result.tiles.map(t => t.id));
  const removedControls = new Set(spec.tiles.filter(t => tabOf(spec, t) === active && t.kind === "filter" && !result.tiles.some(n => n.filterId === t.filterId)).map(t => t.filterId));
  if (result.filters) result.filters = result.filters.filter(f => !removedControls.has(f.id)).map(f => ({ ...f, bindings: f.bindings.filter(b => present.has(b.tileId)) }));
  return result;
}

export function copiedTiles(tiles: TileSpec[], tabId: string, y = 24): TileSpec[] {
  const ids = new Map(tiles.map(t => [t.id, crypto.randomUUID()]));
  const top = tiles.length ? Math.min(...tiles.map(t => t.layout.y)) : 0;
  return tiles.map(t => ({ ...structuredClone(t), id: ids.get(t.id)!, tabId, pinned: false,
    section: t.section ? ids.get(t.section) : undefined, layout: { ...t.layout, y: t.layout.y - top + y } }));
}

export function removeTab(spec: DashboardSpec, id: string): DashboardSpec {
  const tabs = tabsOf(spec).filter(t => t.id !== id);
  if (!tabs.length) throw new Error("Keep at least one tab");
  const tiles = spec.tiles.filter(t => tabOf(spec, t) !== id).map(t => ({ ...t, tabId: tabOf(spec, t) }));
  const ids = new Set(tiles.map(t => t.id));
  const filters = spec.filters?.filter(f => f.scope !== "tab" || f.tabId !== id).map(f => ({ ...f, bindings: f.bindings.filter(b => ids.has(b.tileId)) }));
  const filterIds = new Set(filters?.map(f => f.id));
  return { ...spec, tabs, tiles: tiles.filter(t => t.kind !== "filter" || filterIds.has(t.filterId!)), filters };
}

/** Copies authored content and local controls; shared controls keep their identity. */
export function duplicateTab(spec: DashboardSpec, sourceId: string): DashboardSpec {
  const source = currentTab(spec, sourceId), id = crypto.randomUUID();
  const original = tabView(spec, source.id).tiles;
  const copies = copiedTiles(original, id, original.length ? Math.min(...original.map(t => t.layout.y)) : 24);
  const map = new Map(original.map((t, i) => [t.id, copies[i].id]));
  const local = new Map((spec.filters ?? []).filter(f => f.scope === "tab" && f.tabId === source.id).map(f => [f.id, crypto.randomUUID()]));
  const filters = (spec.filters ?? []).flatMap(f => {
    const extra = f.bindings.filter(b => map.has(b.tileId)).map(b => ({ ...b, tileId: map.get(b.tileId)! }));
    return f.scope === "report" ? [{ ...f, bindings: [...f.bindings, ...extra] }]
      : local.has(f.id) ? [f, { ...structuredClone(f), id: local.get(f.id)!, tabId: id, bindings: extra }] : [f];
  });
  return { ...spec, tabs: [...tabsOf(spec), { id, title: `${source.title.slice(0, 93)} (copy)` }],
    tiles: [...spec.tiles, ...copies.map(t => ({ ...t, filterId: t.filterId ? local.get(t.filterId) ?? t.filterId : undefined }))], filters };
}
