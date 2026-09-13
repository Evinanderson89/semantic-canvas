import type { DashboardFilter, DashboardSpec, FilterSpec, FilterValue, TileSpec } from "../compiler/spec.ts";
import { fieldReachable, isTemporal, isNumeric, DEFAULT_CALENDAR, type Calendar, type Model } from "../semantic/model.ts";
import { validateTile } from "../compiler/compile.ts";
import { tabOf, tabsOf } from "./tabs.ts";
import { resolvePreset } from "./datePresets.ts";
import { FILTER_PRESENTATIONS } from "../compiler/schema.ts";

export function fieldKind(model: Model, field: string): DashboardFilter["control"] | null {
  const [table, column] = field.split(".");
  const col = model.tables[table]?.columns.find(c => c.name === column);
  return !col ? null : isTemporal(col) ? "date" : isNumeric(col) ? "number" : "select";
}
export function suggestedBindings(spec: DashboardSpec, model: Model, field: string, scope: "tab" | "report", tab: string) {
  return spec.tiles.filter(t => (t.kind ?? "metric") === "metric" && (scope === "report" || tabOf(spec, t) === tab)
    && fieldReachable(model, model.metrics[t.metrics[0]]?.baseTable ?? "", field)).map(t => ({ tileId: t.id, field }));
}
export const presentationOf = (f: Pick<DashboardFilter, "control" | "presentation">) => f.presentation ?? FILTER_PRESENTATIONS[f.control][0];
export const hasFilterValue = (v: FilterValue) => !!v.preset || !!v.values?.length || v.min != null && v.min !== "" || v.max != null && v.max !== "";
export function filtersForTile(spec: DashboardSpec, tile: TileSpec, values: Record<string, FilterValue>, now = new Date(), calendar: Calendar = DEFAULT_CALENDAR): FilterSpec[] {
  return (spec.filters ?? []).flatMap(f => {
    const b = f.bindings.find(b => b.tileId === tile.id);
    const v = resolvePreset(values[f.id] ?? f.defaultValue ?? {}, now, calendar);
    if (!b || f.scope === "tab" && f.tabId !== tabOf(spec, tile) || !hasFilterValue(v)) return [];
    const range = f.control === "date" && typeof v.max === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.max) && !Number.isNaN(Date.parse(v.max))
      ? { ...v, max: new Date(Date.parse(v.max) + 86400000).toISOString().slice(0, 10), maxExclusive: true } : v;
    return [{ id: `control:${f.id}`, field: b.field, source: "dimension" as const,
      mode: f.control === "select" ? "discrete" as const : "range" as const, ...range }];
  });
}
/** Shared save/import validation: a filter can never claim to affect an unrelated chart. */
export function validateDashboard(model: Model, spec: DashboardSpec) {
  const issues = spec.tiles.flatMap(t => validateTile(model, t));
  const issue = (tile: string, problem: string) => issues.push({ tile, problem });
  const tabs = tabsOf(spec), tabIds = new Set(tabs.map(t => t.id));
  if (tabs.length !== tabIds.size) issue("document", "Tab IDs must be unique");
  const filters = spec.filters ?? [], filterIds = new Set(filters.map(f => f.id));
  if (filters.length !== filterIds.size) issue("document", "Filter IDs must be unique");
  for (const t of spec.tiles) {
    if (!tabIds.has(tabOf(spec, t))) issue(t.id, "Tile references an unavailable tab");
    if (t.section && !spec.tiles.some(h => h.id === t.section && h.kind === "heading" && tabOf(spec, h) === tabOf(spec, t))) issue(t.id, "A section heading must be on the same tab");
    if (t.kind === "filter" && !filterIds.has(t.filterId ?? "")) issue(t.id, "Filter control has no definition");
    const f = filters.find(f => f.id === t.filterId);
    if (t.kind === "filter" && f?.scope === "tab" && f.tabId !== tabOf(spec, t)) issue(t.id, "This filter belongs to a different tab");
  }
  for (const f of filters) {
    if (fieldKind(model, f.field) !== f.control) issue(f.id, "Filter field and control type do not match the catalogue");
    if (f.scope === "tab" && !tabIds.has(f.tabId ?? "")) issue(f.id, "Filter references an unavailable tab");
    if (new Set(f.bindings.map(b => b.tileId)).size !== f.bindings.length) issue(f.id, "A chart can only have one binding per filter");
    for (const b of f.bindings) {
      const t = spec.tiles.find(t => t.id === b.tileId);
      if (!t || (t.kind ?? "metric") !== "metric" || !fieldReachable(model, model.metrics[t.metrics[0]]?.baseTable ?? "", b.field)
        || fieldKind(model, b.field) !== f.control || f.scope === "tab" && tabOf(spec, t) !== f.tabId) issue(f.id, "Filter binding must match a reachable field on a chart in scope");
    }
    if (f.presentation && !(FILTER_PRESENTATIONS[f.control] as readonly string[]).includes(f.presentation)) issue(f.id, "Filter presentation does not match its control");
    const v = f.defaultValue;
    if (v && (f.control === "select" ? v.min != null || v.max != null : !!v.values?.length)) issue(f.id, "Filter default does not match its control");
    if (v?.preset && f.control !== "date") issue(f.id, "Only a date filter can default to a preset");
    if (v && f.control !== "select") for (const bound of [v.min, v.max]) {
      if (bound != null && (f.control === "number" ? typeof bound !== "number" || !Number.isFinite(bound) : typeof bound !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(bound) || Number.isNaN(Date.parse(bound)))) issue(f.id, "Filter default has an invalid range value");
    }
    if (v?.min != null && v?.max != null && v.min > v.max) issue(f.id, "Filter range starts after it ends");
  }
  return issues;
}
