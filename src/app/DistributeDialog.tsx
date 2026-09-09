import { useEffect, useState } from "react";
import type { DashboardSpec, TileSpec } from "../compiler/spec.ts";
import type { Model } from "../semantic/model.ts";
import { fieldReachable } from "../semantic/model.ts";
import { DEFAULT_CANVAS, type CanvasSpec } from "../canvas/presets.ts";
import { copiedTiles, tabsOf, tabView } from "./tabs.ts";
import { validateDashboard } from "./filters.ts";
import { StudioDialog } from "./StudioDialog.tsx";
import { readResponse } from "./http.ts";
import { dashboardSchema, canvasSchema } from "../compiler/schema.ts";

export function distributeCharts(target: DashboardSpec, charts: TileSpec[], tabId: string, width: number, model: Model): DashboardSpec {
  if (!tabsOf(target).some(t => t.id === tabId)) throw new Error("Choose an available destination tab");
  const eligible = charts.filter(t => (t.kind ?? "metric") === "metric");
  const existing = tabView(target, tabId).tiles;
  let y = Math.max(8, ...existing.map(t => t.layout.y + t.layout.h)) + 16;
  const copies = copiedTiles(eligible, tabId).map(t => { const next = { ...t, section: undefined, layout: { x: 24, y, w: Math.min(t.layout.w, width - 48), h: t.layout.h } }; y += t.layout.h + 16; return next; });
  const filters = target.filters?.map(f => ({ ...f, bindings: [...f.bindings, ...copies.filter(t => (f.scope === "report" || f.tabId === tabId) && fieldReachable(model, model.metrics[t.metrics[0]]?.baseTable ?? "", f.field)).map(t => ({ tileId: t.id, field: f.field }))] }));
  const next = { ...target, tiles: [...target.tiles, ...copies], filters };
  const parsed = dashboardSchema.parse(next), issues = validateDashboard(model, parsed);
  if (issues.length) throw new Error(issues[0].problem);
  return parsed;
}
export function DistributeDialog({ spec, selected, activeTab, currentId, model, canvas, onChange, onClose, onNotice }: {
  spec: DashboardSpec; selected: string[]; activeTab: string; currentId: string | null; model: Model; canvas: CanvasSpec;
  onChange: (s: DashboardSpec, c: CanvasSpec) => void; onClose: () => void; onNotice: (s: string) => void;
}) {
  const charts = tabView(spec, activeTab).tiles.filter(t => (t.kind ?? "metric") === "metric");
  const [ids, setIds] = useState(selected.length ? selected.filter(id => charts.some(t => t.id === id)) : charts.map(t => t.id));
  const [saved, setSaved] = useState<{ id: string; name: string }[]>([]), [destination, setDestination] = useState("current"), [tab, setTab] = useState(tabsOf(spec).find(t => t.id !== activeTab)?.id ?? tabsOf(spec)[0].id);
  const [target, setTarget] = useState<{ spec: DashboardSpec; canvas: CanvasSpec; revision: number; name: string } | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  useEffect(() => { const ac = new AbortController(); fetch("/api/dashboards", { signal: ac.signal }).then(readResponse).then(d => setSaved(d.dashboards.filter((d: { id: string }) => d.id !== currentId))).catch(e => { if (!ac.signal.aborted) setError(e.message); }); return () => ac.abort(); }, []);
  useEffect(() => {
    setTarget(null); setError(""); if (destination === "current") { setTab(tabsOf(spec).find(t => t.id !== activeTab)?.id ?? tabsOf(spec)[0].id); return; }
    const ac = new AbortController(); fetch(`/api/dashboards/${encodeURIComponent(destination)}`, { signal: ac.signal }).then(readResponse).then(d => { setTarget({ ...d, spec: dashboardSchema.parse(d.spec), canvas: canvasSchema.parse(d.canvas ?? DEFAULT_CANVAS) }); setTab(tabsOf(d.spec)[0].id); }).catch(e => { if (!ac.signal.aborted) setError(e.message); }); return () => ac.abort();
  }, [destination]);
  const doc = destination === "current" ? spec : target?.spec;
  return <StudioDialog title="Copy charts to another view" onClose={onClose}><form onSubmit={async e => {
    e.preventDefault(); if (!doc) return; setBusy(true); setError("");
    try {
      const surface = destination === "current" ? canvas : target!.canvas;
      const next = distributeCharts(doc, charts.filter(t => ids.includes(t.id)), tab, surface.width, model);
      const grown = { ...surface, height: Math.max(surface.height, ...next.tiles.map(t => t.layout.y + t.layout.h + 24)) };
      if (destination === "current") onChange(next, grown);
      else await fetch("/api/dashboards", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: destination, revision: target!.revision, name: target!.name, spec: next, canvas: grown }) }).then(readResponse);
      onNotice(`${ids.length} charts copied. Matching destination filters are connected; each copy can be edited independently.`); onClose();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }}><section><p className="lede">Reuse a useful chart without rebuilding it. Copies keep their chart settings and connect to matching filters in the destination.</p>
    <label className="form-field">Dashboard<select aria-label="Destination dashboard" value={destination} onChange={e => setDestination(e.target.value)} disabled={busy}><option value="current">This dashboard</option>{saved.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
    <label className="form-field">Destination tab<select aria-label="Destination tab" value={tab} onChange={e => setTab(e.target.value)} disabled={!doc || busy}>{doc && tabsOf(doc).map(t => <option key={t.id} value={t.id}>{t.title}</option>)}</select></label>
    <div className="filter-options">{charts.map(t => <label key={t.id}><input type="checkbox" checked={ids.includes(t.id)} onChange={e => setIds(e.target.checked ? [...ids, t.id] : ids.filter(id => id !== t.id))} />{t.title ?? t.metrics.join(", ")}</label>)}</div>
    <p className="muted">Current filter selections are not copied. Saved destinations are updated immediately; unsaved tabs stay in this dashboard until you save.</p>{error && <p role="alert">{error}</p>}
  </section><footer><span className="spacer" /><button className="primary" disabled={busy || !doc || !ids.length}>{busy ? "Copying…" : `Copy ${ids.length} charts`}</button></footer></form></StudioDialog>;
}
