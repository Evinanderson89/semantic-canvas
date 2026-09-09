import { useEffect, useState } from "react";
import type { DashboardFilter, DashboardSpec, FilterValue } from "../compiler/spec.ts";
import { fieldReachable, prettifyModelName, type Model } from "../semantic/model.ts";
import { fieldKind, hasFilterValue, suggestedBindings } from "./filters.ts";
import { tabOf, tabsOf } from "./tabs.ts";
import { StudioDialog } from "./StudioDialog.tsx";
import { readResponse } from "./http.ts";

export function FilterDesigner({ spec, model, tabId, existing, onSave, onDelete, onClose }: {
  spec: DashboardSpec; model: Model; tabId: string; existing?: DashboardFilter;
  onSave: (filter: DashboardFilter) => void; onDelete: () => void; onClose: () => void;
}) {
  const fields = Object.values(model.tables).flatMap(t => t.columns.map(c => `${t.name}.${c.name}`)).filter(f => fieldKind(model, f));
  const [filter, setFilter] = useState<DashboardFilter>(() => existing ?? { id: crypto.randomUUID(), label: "", field: "", control: "select", scope: "report", bindings: [] });
  const charts = spec.tiles.filter(t => (t.kind ?? "metric") === "metric" && (filter.scope === "report" || tabOf(spec, t) === tabId));
  const changeField = (field: string, scope = filter.scope) => setFilter({ ...filter, field, scope, tabId: scope === "tab" ? tabId : undefined,
    control: fieldKind(model, field) ?? "select", label: filter.label || field.split(".").at(-1)!.replace(/_/g, " "), defaultValue: undefined,
    bindings: suggestedBindings(spec, model, field, scope, tabId) });
  return <StudioDialog title={existing ? "Edit filter" : "Add a canvas filter"} onClose={onClose} wide><form onSubmit={e => { e.preventDefault(); onSave(filter); }}>
    <section className="filter-designer"><p className="lede">One useful control. Connected only to the charts you choose.</p>
      <div className="form-grid"><label className="form-field">Catalogue field<select aria-label="Catalogue field" required value={filter.field} onChange={e => changeField(e.target.value)}><option value="">Choose a field…</option>{Object.values(model.tables).map(t => <optgroup key={t.name} label={prettifyModelName(t.name.replace(/^(dim|fct)_/, ""))}>{fields.filter(f => f.startsWith(`${t.name}.`)).map(f => <option key={f} value={f}>{prettifyModelName(f.split(".")[1])}</option>)}</optgroup>)}</select></label>
      <label className="form-field">Label<input required maxLength={100} value={filter.label} onChange={e => setFilter({ ...filter, label: e.target.value })} placeholder="Country, reporting period…" /></label></div>
      <label className="form-field">Where it applies<select aria-label="Where it applies" value={filter.scope} onChange={e => changeField(filter.field, e.target.value as "tab" | "report")}><option value="report">Across dashboard tabs</option><option value="tab">Only this tab</option></select></label>
      <div className="binding-heading"><b>Connected charts</b><span>{filter.bindings.length} of {charts.length} charts</span></div>
      <p className="muted">Matching fields connect automatically. Map a different field only when it represents the same thing.</p>
      <div className="binding-list">{charts.map(t => {
        const reachable = fields.filter(f => fieldKind(model, f) === filter.control && fieldReachable(model, model.metrics[t.metrics[0]]?.baseTable ?? "", f));
        const binding = filter.bindings.find(b => b.tileId === t.id);
        return <label className="binding-row" key={t.id}><span><b>{t.title || t.metrics.map(m => model.metrics[m]?.label ?? m).join(", ")}</b><small>{tabsOf(spec).find(tab => tab.id === tabOf(spec, t))?.title}</small></span>
          <select aria-label={`Connect ${t.title || t.id}`} value={binding?.field ?? ""} onChange={e => setFilter({ ...filter, bindings: [...filter.bindings.filter(b => b.tileId !== t.id), ...(e.target.value ? [{ tileId: t.id, field: e.target.value }] : [])] })}>
            <option value="">Not connected</option>{reachable.map(f => <option key={f} value={f}>{prettifyModelName(f.split(".")[1])} · {prettifyModelName(f.split(".")[0].replace(/^(dim|fct)_/, ""))}</option>)}
          </select></label>;
      })}{!charts.length && <p>Add a chart to connect this filter.</p>}</div>
    </section><footer>{existing && <button type="button" className="link danger" onClick={onDelete}>Delete filter</button>}<span className="spacer" /><button className="primary" disabled={!filter.field || !filter.label.trim() || !filter.bindings.length}>Save filter</button></footer>
  </form></StudioDialog>;
}

export function FilterControl({ filter, value, onChange, spec, model, queryContext, onEdit, activeTab, compact = false }: {
  filter: DashboardFilter; value: FilterValue; onChange: (v: FilterValue) => void;
  spec: DashboardSpec; model: Model; queryContext: string; activeTab?: string; onEdit?: () => void; compact?: boolean;
}) {
  const [choosing, setChoosing] = useState(false);
  const [options, setOptions] = useState<(string | number | boolean | null)[]>([]), [error, setError] = useState(""), [loading, setLoading] = useState(false), [search, setSearch] = useState("");
  const load = () => {
    if (filter.control !== "select") return;
    setLoading(true); setError("");
    const binding = filter.bindings.find(b => b.field === filter.field), tile = spec.tiles.find(t => t.id === binding?.tileId);
    const base = tile ? model.metrics[tile.metrics[0]]?.baseTable : filter.field.split(".")[0];
    const ac = new AbortController();
    fetch(`/api/values?field=${encodeURIComponent(filter.field)}&base=${encodeURIComponent(base ?? "")}`, { signal: ac.signal }).then(readResponse).then(d => { setOptions(d.values.map((x: { value: string | number | boolean | null }) => x.value)); setLoading(false); }).catch(e => { if (!ac.signal.aborted) { setError(e.message); setLoading(false); } });
    return () => ac.abort();
  };
  useEffect(() => { setOptions([]); setSearch(""); return load(); }, [filter.field, JSON.stringify(filter.bindings), queryContext]);
  const label = value.values?.length ? value.values.map(v => v == null ? "(empty)" : String(v)).join(", ") : "All values";
  const invalid = value.min != null && value.max != null && value.min > value.max;
  return <div className={`filter-control${compact ? " compact" : ""}`} onPointerDown={e => { if ((e.target as HTMLElement).closest("button,input,select,label,dialog")) e.stopPropagation(); }}>
    <div className="filter-control-head"><b>{filter.label}</b>{onEdit && <button className="link" aria-label={`Edit ${filter.label} filter`} onClick={onEdit}>Edit</button>}</div>
    {filter.control === "select" ? <><button className="studio-trigger" aria-label={`Choose ${filter.label}`} onClick={() => setChoosing(true)}><span className="filter-selection">{label}</span><span>⌄</span></button>{choosing && <StudioDialog title={`Choose ${filter.label}`} onClose={() => setChoosing(false)}><section><input aria-label={`Search ${filter.label}`} placeholder="Find a value…" value={search} onChange={e => setSearch(e.target.value)} />
        {loading && <p role="status">Loading values…</p>}{error && <p role="alert">{error}</p>}
        <div className="filter-options">{[...new Set([...(value.values ?? []), ...options])].filter(v => String(v ?? "(empty)").toLowerCase().includes(search.toLowerCase())).map(v => <label key={JSON.stringify(v)}><input type="checkbox" checked={value.values?.includes(v) ?? false} onChange={e => onChange({ values: e.target.checked ? [...(value.values ?? []), v] : value.values?.filter(x => x !== v) })} />{v == null ? "(empty)" : String(v)}</label>)}</div>
        {!loading && !error && <small>Up to 500 available values</small>}
        <button className="link" onClick={() => onChange({})}>Clear selection</button>
      </section><footer><span className="spacer" /><button className="primary" onClick={() => setChoosing(false)}>Done</button></footer></StudioDialog>}</> : <div className="filter-range">{(["min", "max"] as const).map((key, i) => <label key={key}><span>{i ? "To" : "From"}</span><input aria-label={`${filter.label} ${i ? "to" : "from"}`} type={filter.control === "date" ? "date" : "number"} value={value[key] ?? ""} onChange={e => onChange({ ...value, [key]: e.target.value === "" ? undefined : filter.control === "number" ? Number(e.target.value) : e.target.value })} /></label>)}</div>}
    {invalid && <small role="alert">The end must follow the start.</small>}
    <div className="filter-caption"><span>{filter.scope === "report" ? "Across tabs" : "This tab"} · {activeTab ? `${filter.bindings.filter(b => spec.tiles.some(t => t.id === b.tileId && tabOf(spec, t) === activeTab)).length} of ${spec.tiles.filter(t => (t.kind ?? "metric") === "metric" && tabOf(spec, t) === activeTab).length} charts here` : `${filter.bindings.length} connected charts`}</span>{hasFilterValue(value) && <button className="link" onClick={() => onChange({})}>Reset</button>}</div>
  </div>;
}
