import React, { useEffect, useMemo, useState } from "react";
import { semanticHints, type Model } from "../semantic/model.ts";
import type { ChartKind, FilterSpec, TileSpec } from "../compiler/spec.ts";
import { recommend, type FieldProfile, type VizOption } from "../suggest/recommend.ts";

type Draft = Omit<TileSpec, "id" | "layout">;
type Field = { key: string; label: string; hint: string; numeric: boolean; temporal: boolean };

const uid = () => Math.random().toString(36).slice(2, 8);
const isNum = (t: string) => /^(double|float|decimal|numeric|int|bigint|smallint|real)/i.test(t);
const isTime = (t: string) => /date|timestamp/i.test(t);

export function Picker({ model, onAdd, onClose }: {
  model: Model; onAdd: (t: Draft) => void; onClose: () => void;
}) {
  const [metrics, setMetrics] = useState<string[]>([]);
  const [dims, setDims] = useState<string[]>([]);
  const [where, setWhere] = useState<FilterSpec[]>([]);
  const [over, setOver] = useState(false);
  const [big, setBig] = useState(false);
  // The drawer is a resizable pane, not a fixed strip: how much room filters
  // need depends entirely on how many values a field has.
  const [drawerH, setDrawerH] = useState(150);
  const [stage, setStage] = useState<"fields" | "viz">("fields");
  const [profiles, setProfiles] = useState<FieldProfile[] | null>(null);
  const [chart, setChart] = useState<ChartKind | null>(null);
  const dragRef = React.useRef<{ y: number; h: number } | null>(null);

  React.useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!dragRef.current) return;
      const next = dragRef.current.h + (dragRef.current.y - e.clientY);
      setDrawerH(Math.max(90, Math.min(next, window.innerHeight * 0.62)));
    };
    const up = () => { dragRef.current = null; document.body.style.cursor = ""; };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  }, []);

  // Adding a filter should reveal it, not squeeze it into the existing strip.
  React.useEffect(() => {
    if (where.length) setDrawerH((h) => Math.max(h, Math.min(150 + where.length * 110, 460)));
  }, [where.length]);

  const base = metrics.length ? model.metrics[metrics[0]].baseTable : null;

  const available: Field[] = useMemo(() => {
    if (!base) return [];
    const own = (model.tables[base]?.columns ?? []).map((c) => ({
      key: c.name, label: c.name, hint: c.type,
      numeric: isNum(c.type), temporal: isTime(c.type),
    }));
    const joined = model.joins.filter((j) => j.left === base).flatMap((j) =>
      (model.tables[j.right]?.columns ?? []).filter((c) => !/_id$/.test(c.name)).map((c) => ({
        key: `${j.right}.${c.name}`, label: `${j.right}.${c.name}`, hint: c.type,
        numeric: isNum(c.type), temporal: isTime(c.type),
      })));
    return [...own, ...joined];
  }, [base, model]);

  const toggle = (arr: string[], v: string, set: (x: string[]) => void) =>
    set(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

  /**
   * Dropping decides the filter's shape, the way Tableau decides continuous vs
   * discrete: a categorical field becomes a value list, anything numeric starts
   * as a range and can be converted to discrete values.
   */
  const drop = (e: React.DragEvent) => {
    e.preventDefault(); setOver(false);
    const raw = e.dataTransfer.getData("application/x-field");
    if (!raw) return;
    const d = JSON.parse(raw) as { field: string; source: "dimension" | "metric"; numeric: boolean };
    if (where.some((f) => f.field === d.field)) return;
    setWhere((w) => [...w, {
      id: uid(), field: d.field, source: d.source,
      mode: d.numeric || d.source === "metric" ? "range" : "discrete",
      values: [], min: null, max: null,
    }]);
  };

  const patch = (id: string, p: Partial<FilterSpec>) =>
    setWhere((w) => w.map((f) => (f.id === id ? { ...f, ...p } : f)));

  /** Profiling happens once, on the way to the visualization step. */
  const goViz = () => {
    setStage("viz"); setProfiles(null); setChart(null);
    const bare = dims.map((d) => (d.includes(":") ? d.split(":")[1] : d));
    if (!bare.length || !base) { setProfiles([]); return; }
    fetch(`/api/profile?base=${base}&fields=${encodeURIComponent(bare.join(","))}`)
      .then((r) => r.json())
      .then((d) => setProfiles((d.fields ?? []).map((f: FieldProfile, i: number) =>
        // A time grain in the selection forces the temporal reading, whatever
        // the raw column type profiles as.
        dims[i]?.includes(":") ? { ...f, role: "temporal" } : f)));
  };

  const options: VizOption[] = useMemo(
    () => (profiles ? recommend(metrics, profiles, semanticHints(model, metrics)) : []),
    [profiles, metrics, model]);

  useEffect(() => { if (options.length && !chart) setChart(options[0].kind); }, [options]);

  return (
    <div className="picker" onClick={onClose}>
      <div className={"sheet" + (big ? " big" : "")} onClick={(e) => e.stopPropagation()}>
        <header>
          <div>
            <h3>{stage === "fields" ? "Add a tile" : "Choose a visualization"}</h3>
            <div className="sub">
              {stage === "viz"
                ? `${metrics.length} measure${metrics.length === 1 ? "" : "s"}` +
                  (dims.length ? ` by ${dims.map((d) => d.split(":").pop()).join(", ")}` : ", no breakdown")
                : base ? `Dimensions reachable from ${base} — drag any field into Filters`
                       : "Pick a metric first"}
            </div>
          </div>
          <span className="spacer" />
          <button className="expand" title={big ? "Restore size" : "Expand"}
                  onClick={() => setBig((v) => !v)}>
            <svg viewBox="0 0 20 20" width="15" height="15" fill="none"
                 stroke="currentColor" strokeWidth="1.7">
              {big ? <path d="M8 3v5H3M12 17v-5h5M8 8 3 3M12 12l5 5" />
                   : <path d="M12 3h5v5M8 17H3v-5M17 3l-6 6M3 17l6-6" />}
            </svg>
          </button>
        </header>

        {stage === "fields" && <div className="cols">
          <div className="col">
            <h5>Metrics · {Object.keys(model.metrics).length}</h5>
            {Object.values(model.metrics).map((m) => {
              const disabled = base != null && m.baseTable !== base;
              return (
                <button key={m.name} draggable={!disabled}
                  onDragStart={(e) => e.dataTransfer.setData("application/x-field",
                    JSON.stringify({ field: m.name, source: "metric", numeric: true }))}
                  className={"opt" + (metrics.includes(m.name) ? " on" : "")}
                  style={disabled ? { opacity: 0.35 } : undefined} disabled={disabled}
                  onClick={() => toggle(metrics, m.name, (v) => { setMetrics(v); setDims([]); setWhere([]); })}>
                  {m.label}<small>{m.name} · {m.baseTable}</small>
                </button>
              );
            })}
          </div>
          <div className="col">
            <h5>Dimensions</h5>
            {!base && <div className="muted">—</div>}
            {available.map((d) => (
              <button key={d.key} draggable
                onDragStart={(e) => e.dataTransfer.setData("application/x-field",
                  JSON.stringify({ field: d.key, source: "dimension", numeric: d.numeric }))}
                className={"opt" + (dims.some((x) => x.endsWith(d.key)) ? " on" : "")}
                onClick={() => toggle(dims, d.temporal ? `month:${d.key}` : d.key, setDims)}>
                {d.label}{d.temporal ? " (by month)" : ""}<small>{d.hint}</small>
              </button>
            ))}
          </div>
        </div>}

        {stage === "fields" && <div className="split"
             onPointerDown={(e) => { dragRef.current = { y: e.clientY, h: drawerH };
                                     document.body.style.cursor = "row-resize"; }}
             title="Drag to resize the filters pane">
          <span />
        </div>}

        {stage === "fields" && <div className={"drawer" + (over ? " over" : "")} style={{ height: drawerH }}
             onDragOver={(e) => { e.preventDefault(); setOver(true); }}
             onDragLeave={() => setOver(false)} onDrop={drop}>
          <div className="drawer-head">
            <h5>Filters</h5>
            <span className="muted">
              {where.length ? `${where.length} applied` : "drag a metric or dimension here"}
            </span>
          </div>
          <div className="pills">
            {where.map((f) => (
              <FilterPill key={f.id} f={f} base={base!} model={model}
                          onPatch={(p) => patch(f.id, p)}
                          onRemove={() => setWhere((w) => w.filter((x) => x.id !== f.id))} />
            ))}
          </div>
        </div>}

        {stage === "viz" && (
          <VizStep options={options} profiles={profiles} metrics={metrics}
                   model={model} chart={chart} onChart={setChart} />
        )}

        <footer>
          <button onClick={stage === "viz" ? () => setStage("fields") : onClose}>
            {stage === "viz" ? "Back" : "Cancel"}
          </button>
          <span className="spacer" />
          {stage === "fields"
            ? <button className="primary" disabled={!metrics.length} onClick={goViz}>
                Choose visualization →
              </button>
            : <button className="primary" disabled={!chart}
                onClick={() => { onAdd({ metrics, dimensions: dims, where, chart: chart! }); onClose(); }}>
                Add tile
              </button>}
        </footer>
      </div>
    </div>
  );
}

function FilterPill({ f, base, model, onPatch, onRemove }: {
  f: FilterSpec; base: string; model: Model;
  onPatch: (p: Partial<FilterSpec>) => void; onRemove: () => void;
}) {
  const [open, setOpen] = useState(true);
  const [values, setValues] = useState<{ value: any; n: number }[] | null>(null);
  const [extent, setExtent] = useState<{ min: number; max: number } | null>(null);
  const label = f.source === "metric" ? model.metrics[f.field]?.label ?? f.field : f.field;

  useEffect(() => {
    if (f.source === "metric") return;
    if (f.mode === "discrete" && !values)
      fetch(`/api/values?base=${base}&field=${encodeURIComponent(f.field)}`)
        .then((r) => r.json()).then((d) => setValues(d.values ?? []));
    if (f.mode === "range" && !extent)
      fetch(`/api/extent?base=${base}&field=${encodeURIComponent(f.field)}`)
        .then((r) => r.json()).then(setExtent);
  }, [f.mode, f.field, base]);

  const chosen = new Set((f.values ?? []).map(String));
  const summary = f.mode === "discrete"
    ? (f.values?.length ? `${f.exclude ? "not " : ""}${f.values.slice(0, 3).join(", ")}${f.values.length > 3 ? ` +${f.values.length - 3}` : ""}` : "any")
    : `${f.min ?? "−∞"} … ${f.max ?? "∞"}`;

  return (
    <div className={"pill-f" + (open ? " open" : "")}>
      <div className="pill-head">
        <span className={"tag " + f.source}>{f.source === "metric" ? "Σ" : "A"}</span>
        <b onClick={() => setOpen((v) => !v)}>{label}</b>
        <span className="sum">{summary}</span>
        <button className="x" onClick={onRemove}>✕</button>
      </div>
      {open && (
        <div className="pill-body">
          <div className="modes">
            <button className={f.mode === "discrete" ? "on" : ""}
                    onClick={() => onPatch({ mode: "discrete" })}>Discrete</button>
            <button className={f.mode === "range" ? "on" : ""}
                    onClick={() => onPatch({ mode: "range" })}>Range</button>
            <label className="check">
              <input type="checkbox" checked={!!f.exclude}
                     onChange={(e) => onPatch({ exclude: e.target.checked })} /> Exclude
            </label>
            {f.source === "metric" && <span className="having">filters the aggregate (HAVING)</span>}
          </div>

          {f.mode === "discrete" ? (
            f.source === "metric" ? <div className="muted sm">
              Discrete filtering on an aggregate isn't meaningful — use Range.</div>
            : !values ? <div className="muted sm">Loading values…</div>
            : (
              <div className="vals">
                {values.slice(0, 60).map((v, i) => {
                  const key = String(v.value);
                  return (
                    <label key={i} className={"val" + (chosen.has(key) ? " on" : "")}>
                      <input type="checkbox" checked={chosen.has(key)}
                        onChange={() => onPatch({ values: chosen.has(key)
                          ? (f.values ?? []).filter((x) => String(x) !== key)
                          : [...(f.values ?? []), v.value] })} />
                      <span>{key === "null" ? "(null)" : key}</span>
                      <em>{v.n.toLocaleString()}</em>
                    </label>
                  );
                })}
              </div>
            )
          ) : (
            <div className="range">
              <label>min<input type="number" value={f.min ?? ""} placeholder={extent ? String(Math.floor(extent.min)) : ""}
                onChange={(e) => onPatch({ min: e.target.value === "" ? null : +e.target.value })} /></label>
              <label>max<input type="number" value={f.max ?? ""} placeholder={extent ? String(Math.ceil(extent.max)) : ""}
                onChange={(e) => onPatch({ max: e.target.value === "" ? null : +e.target.value })} /></label>
              {extent && <span className="muted sm">data range {Math.floor(extent.min)} … {Math.ceil(extent.max)}</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The visualization step. Options are ranked by fit, and every card carries the
 * reason it was ranked there — the point is not to hide the choice but to make
 * it obvious, so "country" showing Map, Horizontal bar and Table together with
 * *why* teaches the user something rather than just deciding for them.
 */
function VizStep({ options, profiles, metrics, model, chart, onChart }: {
  options: VizOption[]; profiles: FieldProfile[] | null; metrics: string[];
  model: Model; chart: ChartKind | null; onChart: (k: ChartKind) => void;
}) {
  if (!profiles) return <div className="viz-step"><div className="muted">Profiling fields…</div></div>;

  const best = options.filter((o) => o.fit === "ideal" || o.fit === "good");
  const rest = options.filter((o) => o.fit === "possible" || o.fit === "poor");

  return (
    <div className="viz-step">
      {profiles.length > 0 && (
        <div className="shape">
          {profiles.map((p) => (
            <span key={p.field} className={"role " + p.role}>
              <b>{p.field.split(".").pop()}</b>
              <em>{p.role}</em>
              {p.cardinality != null && <i>{p.cardinality.toLocaleString()} distinct</i>}
            </span>
          ))}
          <span className="role measure"><b>{metrics.length} measure{metrics.length === 1 ? "" : "s"}</b></span>
        </div>
      )}

      <h5 className="viz-h">Recommended</h5>
      <div className="viz-grid">
        {best.map((o) => (
          <VizCard key={o.kind} o={o} on={chart === o.kind} onPick={() => onChart(o.kind)} />
        ))}
      </div>

      {rest.length > 0 && (
        <>
          <h5 className="viz-h">Also possible</h5>
          <div className="viz-grid">
            {rest.map((o) => (
              <VizCard key={o.kind} o={o} on={chart === o.kind} onPick={() => onChart(o.kind)} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function VizCard({ o, on, onPick }: { o: VizOption; on: boolean; onPick: () => void }) {
  return (
    <button className={`vizcard ${o.fit}` + (on ? " on" : "")} onClick={onPick}>
      <span className="glyph"><Glyph kind={o.kind} /></span>
      <b>{o.label}</b>
      <span className={"fit " + o.fit}>{o.fit}</span>
      <small>{o.why}</small>
      <em>{o.emphasis}</em>
    </button>
  );
}

/** Tiny schematic previews — shape at a glance, no data required. */
function Glyph({ kind }: { kind: ChartKind }) {
  const c = "currentColor";
  const paths: Partial<Record<ChartKind, React.ReactNode>> = {
    line: <polyline points="2,16 8,10 13,13 22,4" fill="none" stroke={c} strokeWidth="1.6" />,
    area: <><polygon points="2,16 8,10 13,13 22,4 22,18 2,18" fill={c} opacity=".25" />
          <polyline points="2,16 8,10 13,13 22,4" fill="none" stroke={c} strokeWidth="1.4" /></>,
    areaStacked: <><polygon points="2,14 12,9 22,11 22,18 2,18" fill={c} opacity=".35" />
          <polygon points="2,9 12,5 22,7 22,11 12,9 2,14" fill={c} opacity=".18" /></>,
    bar: <>{[3, 8, 13, 18].map((x, i) => <rect key={x} x={x} y={16 - [10, 6, 13, 8][i]} width="3.4" height={[10, 6, 13, 8][i]} fill={c} />)}</>,
    barGrouped: <>{[2.5, 6, 11, 14.5, 19].map((x, i) => <rect key={x} x={x} y={16 - [9, 6, 12, 7, 10][i]} width="2.6" height={[9, 6, 12, 7, 10][i]} fill={c} opacity={i % 2 ? .5 : 1} />)}</>,
    barStacked: <>{[4, 10, 16].map((x, i) => <g key={x}><rect x={x} y={16 - [12, 8, 14][i]} width="4" height={[5, 3, 6][i]} fill={c} opacity=".5" /><rect x={x} y={16 - [7, 5, 8][i]} width="4" height={[7, 5, 8][i]} fill={c} /></g>)}</>,
    barH: <>{[3, 8, 13].map((y, i) => <rect key={y} x="2" y={y} width={[16, 10, 13][i]} height="3.4" fill={c} />)}</>,
    scatter: <>{[[5, 13], [9, 8], [13, 11], [18, 5], [7, 15]].map(([x, y], i) => <circle key={i} cx={x} cy={y} r="1.8" fill={c} />)}</>,
    heatmap: <>{[0, 1, 2].flatMap((r) => [0, 1, 2, 3].map((k) => <rect key={`${r}${k}`} x={3 + k * 4.6} y={4 + r * 4.4} width="4" height="3.8" fill={c} opacity={0.2 + ((r + k) % 4) * 0.22} />))}</>,
    map: <><path d="M3 6l5-2 5 2 5-2v12l-5 2-5-2-5 2z" fill="none" stroke={c} strokeWidth="1.3" />
          <path d="M8 4v12M13 6v12" stroke={c} strokeWidth="1" opacity=".55" /></>,
    donut: <><circle cx="12" cy="10" r="7" fill="none" stroke={c} strokeWidth="4" opacity=".3" />
          <path d="M12 3a7 7 0 0 1 6.1 10.4" fill="none" stroke={c} strokeWidth="4" /></>,
    table: <>{[4, 8.5, 13]. map((y) => <rect key={y} x="2" y={y} width="20" height="2.6" fill={c} opacity={y === 4 ? 1 : .4} />)}</>,
    kpi: <><rect x="3" y="5" width="12" height="5" rx="1" fill={c} />
          <polyline points="3,16 9,13 15,15 21,10" fill="none" stroke={c} strokeWidth="1.3" opacity=".6" /></>,
  };
  return <svg viewBox="0 0 24 20" width="26" height="22">{paths[kind] ?? paths.bar}</svg>;
}
