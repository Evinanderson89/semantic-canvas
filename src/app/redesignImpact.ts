import { proposalMetricChanges } from "../canvas/metricChanges.ts";
import type { DashboardSpec, FilterSpec, TileSpec } from "../compiler/spec.ts";
import type { Model } from "../semantic/model.ts";
import { metricOf } from "../semantic/model.ts";
import { inferChart } from "../suggest/chartRules.ts";
import { visibleQuery } from "./query.ts";
import type { DrillEntry } from "./drill.ts";

export interface ImpactChange { label: string; before: string; after: string; analytical: boolean }
export interface TileImpact { id: string; title: string; status: "added" | "removed" | "changed"; changes: ImpactChange[] }
export interface ImpactScope {
  filters?: Record<string, FilterSpec[]>;
  drills?: Record<string, DrillEntry[]>;
  warnings?: Record<string, string[]>;
}

export function filterDescription(f: FilterSpec): string {
  const field = `${f.field}${f.source === "metric" ? " (after aggregation)" : ""}`;
  if (f.mode === "discrete") return `${field} ${f.exclude ? "excludes" : "includes"} ${f.values?.map(v => v === null ? "null" : JSON.stringify(v)).join(", ") || "no selected values"}`;
  const bounds = [f.min != null ? `≥ ${f.min}` : "", f.max != null ? `${f.maxExclusive ? "<" : "≤"} ${f.max}` : ""].filter(Boolean).join(" and ") || "unbounded";
  return `${field}: ${f.exclude ? "outside" : "within"} ${bounds}`;
}
const metricTile = (t: TileSpec) => (t.kind ?? "metric") === "metric";
const comparison = (value: string | undefined) => value === "prior" ? "Previous period" : value === "yoy" ? "Same period last year" : "None";

/** Compare the validated result, not the agent's description of its actions.
 * Includes effective queries: a KPI can introduce an implicit comparison and
 * changing a metric can make a current interactive filter inapplicable. */
export function redesignImpact(before: DashboardSpec, after: DashboardSpec, model: Model, beforeScope: ImpactScope = {}, afterScope: ImpactScope = {}) {
  const describe = (t: TileSpec, spec: DashboardSpec, scope: ImpactScope) => {
    const values: Record<string, { value: string; analytical: boolean }> = {};
    const add = (key: string, value: string, analytical = false) => { values[key] = { value, analytical }; };
    add("Title", t.title ?? "Untitled");
    if (metricTile(t)) {
      const query = visibleQuery(model, t, [...(spec.crossFilters ?? []), ...(scope.filters?.[t.id] ?? [])], scope.drills?.[t.id]);
      add("Metrics", query.metrics.map(n => `${metricOf(model, n)?.label ?? n} [${n}]`).join(", "), true);
      add("Breakdown / reporting grain", query.dimensions.join(", ") || "Aggregate — no breakdown", true);
      add("Query filters", query.where.map(filterDescription).sort().join("; ") || "None", true);
      add("Comparison", comparison(query.compare), true);
      add("Displayed measure", query.compare && query.compare !== "none" ? t.compareShow === "delta" ? "Change" : t.compareShow === "percent" ? "Percentage change" : "Metric value" : "Metric value", true);
      add("Result row limit", String(Math.min(query.limit ?? 500, 5000)), true);
      add("Filters not applied", [...(scope.warnings?.[t.id] ?? [])].sort().join(", ") || "None reported", true);
      add("Chart", t.chart ?? inferChart(model, t));
    } else {
      add("Content type", t.kind ?? "metric");
      add("Text", t.text || "No text");
    }
    add("Size", `${t.layout.w} × ${t.layout.h}`);
    add("Position", `x ${t.layout.x}, y ${t.layout.y}`);
    add("Stacking order", String(t.layout.z ?? 0));
    add("Section", spec.tiles.find(s => s.id === t.section)?.text || spec.tiles.find(s => s.id === t.section)?.title || t.section || "No section");
    // Expose presentation settings if an existing tile is replaced/recreated.
    add("Formatting", JSON.stringify(t.format ?? {}));
    add("Sparkline", JSON.stringify(t.spark ?? {}));
    return values;
  };
  const changes: TileImpact[] = [];
  for (const id of new Set([...before.tiles.map(t => t.id), ...after.tiles.map(t => t.id)])) {
    const a = before.tiles.find(t => t.id === id), b = after.tiles.find(t => t.id === id);
    const left = a ? describe(a, before, beforeScope) : {}, right = b ? describe(b, after, afterScope) : {};
    const fields: ImpactChange[] = [];
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      if (left[key]?.value === right[key]?.value) continue;
      fields.push({ label: key, before: left[key]?.value ?? "Not present", after: right[key]?.value ?? "Not present", analytical: !!(left[key]?.analytical || right[key]?.analytical) });
    }
    if (fields.length) changes.push({ id, title: b?.title || a?.title || b?.text || a?.text || b?.metrics.join(", ") || a?.metrics.join(", ") || id, status: !a ? "added" : !b ? "removed" : "changed", changes: fields });
  }
  const metricChanges = proposalMetricChanges(before, after);
  const metricLabel = (name: string) => ({ name, label: metricOf(model, name)?.label ?? name });
  return {
    additions: metricChanges.additions.map(change => ({ ...change, added: change.added.map(metricLabel) })),
    substitutions: metricChanges.substitutions.map(change => ({ ...change, before: change.before.map(metricLabel), after: change.after.map(metricLabel) })),
    tiles: changes,
    added: changes.filter(t => t.status === "added").length,
    removed: changes.filter(t => t.status === "removed").length,
    analysisChanged: changes.filter(t => t.status === "changed" && t.changes.some(c => c.analytical)).length,
    presentationChanged: changes.filter(t => t.status === "changed" && t.changes.some(c => !c.analytical)).length,
    metrics: [...new Set(after.tiles.filter(metricTile).flatMap(t => t.metrics))],
    removedMetrics: metricChanges.removedMetrics.map(metricLabel),
    dashboardTitle: before.title !== after.title ? { before: before.title, after: after.title } : null,
    dashboardDescription: (before.description ?? "") !== (after.description ?? "")
      ? { before: before.description ?? "", after: after.description ?? "" } : null,
  };
}
