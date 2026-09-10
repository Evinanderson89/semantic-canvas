import type { DashboardSpec } from "../compiler/spec.ts";
import { DEFAULT_CANVAS } from "../canvas/presets.ts";
import type { Model } from "../semantic/model.ts";
import { suggestDashboard } from "../suggest/suggest.ts";
import { demoDashboard, demoDashboardAvailable } from "../suggest/demo.ts";
import { validateDashboard } from "../app/filters.ts";

export const LIBRARY_FOLDERS = [
  { key: "company", name: "Company overview", parent: null },
  { key: "revenue", name: "Revenue & retention", parent: null },
  { key: "growth", name: "Growth & customers", parent: null },
  { key: "shared", name: "Shared views", parent: null },
  { key: "kpis", name: "KPI summaries", parent: "shared" },
  { key: "trends", name: "Trends & comparisons", parent: "shared" },
  { key: "story", name: "Story sections", parent: "shared" },
  { key: "examples", name: "Examples", parent: null },
] as const;
const TOPICS = [
  ["fct_saas_monthly", "company", "SaaS overview"],
  ["fct_mrr_movements", "revenue", "MRR movements"],
  ["fct_subscriptions", "revenue", "Subscriptions"],
  ["fct_subscription_addons", "revenue", "Subscription add-ons"],
  ["fct_marketing_spend", "growth", "Marketing performance"],
  ["fct_web_sessions", "growth", "Web traffic"],
  ["dim_users", "growth", "Users"],
  ["fct_events", "growth", "Events & engagement"],
] as const;
export function folderForDashboard(model: Model, spec: { tiles: { metrics: string[] }[] }): string | null {
  const base = spec.tiles.flatMap(t => t.metrics).map(m => model.metrics[m]?.baseTable).find(Boolean);
  return TOPICS.find(([table]) => table === base)?.[1] ?? null;
}
/** Only offer the bundled business examples when their catalogue is present. No queries or result rows are stored. */
export function libraryStarters(model: Model) {
  if (!demoDashboardAvailable(model)) return [];
  const definitions: { folder: string; name: string; spec: DashboardSpec }[] = TOPICS.filter(([table]) => Object.values(model.metrics).some(m => m.baseTable === table))
    .map(([table, folder, name]) => ({ folder: String(folder), name, spec: { ...suggestDashboard(model, { table, width: 1120, grain: "month" }), title: name } }));
  definitions.push({ folder: "examples", name: "Dashboard cleanup demo", spec: demoDashboard(1120) });
  return definitions.filter(d => !validateDashboard(model, d.spec).length).map(d => ({ ...d, canvas: { ...DEFAULT_CANVAS, preset: "custom", width: 1120,
    height: Math.max(900, ...d.spec.tiles.map(t => t.layout.y + t.layout.h + 24)) } }));
}
export function orderLibraryFolders<T extends { name: string; parentId: string | null }>(folders: T[]): T[] {
  const rank = (f: T) => LIBRARY_FOLDERS.findIndex(d => d.name === f.name);
  return [...folders].sort((a, b) => (rank(a) < 0 ? 99 : rank(a)) - (rank(b) < 0 ? 99 : rank(b)) || a.name.localeCompare(b.name));
}
