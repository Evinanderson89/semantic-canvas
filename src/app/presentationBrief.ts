import type { DashboardSpec, PresentationBrief } from "../compiler/spec.ts";
import { currentTab, tabsOf } from "./tabs.ts";

export const emptyBrief = (): PresentationBrief => ({ question: "", takeaway: "", nextStep: "" });

/** Validation may reorder object properties during save. Only content changes
 * should reopen the presentation, never property order or brief metadata. */
export function presentationContentKey(spec: DashboardSpec): string {
  return JSON.stringify({ ...spec, tabs: undefined }, (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
}

/** Keep an empty, untouched legacy document unchanged. Explicit [] means no
 * evidence selected; undefined means all current charts, including new ones. */
export function withPresentationBrief(spec: DashboardSpec, tabId: string, brief: PresentationBrief): DashboardSpec {
  const active = currentTab(spec, tabId);
  if (JSON.stringify(active.brief ?? emptyBrief()) === JSON.stringify(brief)) return spec;
  return { ...spec, tabs: tabsOf(spec).map(tab => tab.id === active.id ? { ...tab, brief: structuredClone(brief) } : tab) };
}

export function briefEvidence(spec: DashboardSpec, brief: PresentationBrief) {
  const charts = spec.tiles.filter(t => (t.kind ?? "metric") === "metric");
  const ids = new Set(brief.evidenceIds ?? charts.map(t => t.id));
  return { selected: charts.filter(t => ids.has(t.id)), omitted: charts.filter(t => !ids.has(t.id)),
    missing: [...ids].filter(id => !charts.some(t => t.id === id)) };
}
