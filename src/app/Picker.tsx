import React, { useEffect, useMemo, useState } from "react";
import { dimensionsOf, isRowCount, isUnreviewed, unreviewedDependencies, joinedTableOptions, metricOf, rowCountName, semanticHints, type Model } from "../semantic/model.ts";
import type { ChartKind, FilterSpec, TileSpec } from "../compiler/spec.ts";
import { recommend, type FieldProfile, type VizOption } from "../suggest/recommend.ts";

import { requiredDimensions } from "../suggest/prepareTile.ts";
import { validateTile } from "../compiler/compile.ts";
import { useFieldProfiles } from "./useFieldProfiles.ts";
import { filterValueLabels, useFilterMetadata } from "./useFilterMetadata.ts";

type Draft = Omit<TileSpec, "id" | "layout">;
type Field = { key: string; label: string; hint: string; numeric: boolean; temporal: boolean };

const uid = () => Math.random().toString(36).slice(2, 8);
const isNum = (t: string) => /^(double|float|decimal|numeric|int|bigint|smallint|real)/i.test(t);
const isTime = (t: string) => /date|timestamp/i.test(t);

export function Picker({ model, queryContext = "", onAdd, onClose }: {
  model: Model; queryContext?: string; onAdd: (t: Draft) => void; onClose: () => void;
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
  const [profileAttempt, setProfileAttempt] = useState(0);
  const [validationError, setValidationError] = useState("");
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

  const base = metrics.length ? metricOf(model, metrics[0])?.baseTable ?? null : null;
  const { profiles, error: profileError, retry: retryProfiles } = useFieldProfiles(model, base, dims, JSON.stringify([metrics, queryContext, profileAttempt]), stage === "viz");
  /** The tile counts rows rather than a declared metric: what a dimension picked first gives you. */
  const counting = metrics.length === 1 && isRowCount(metrics[0]);
  const joinedTables = useMemo(() => base ? joinedTableOptions(model, base) : [], [base, model]);
  const unavailable = joinedTables.flatMap(({ table, path }) => "error" in path ? [{ table: table.name, reason: path.error }] : []);

  const available: Field[] = useMemo(() => {
    if (!base) return [];
    const own = (model.tables[base]?.columns ?? []).map((c) => ({
      key: c.name, label: c.name, hint: c.type,
      numeric: isNum(c.type), temporal: isTime(c.type),
    }));
    const joined = joinedTables.flatMap(({ table, path }) => "error" in path ? [] :
      table.columns.filter((c) => !/(_id$|^id$)/.test(c.name)).map((c) => ({
        key: `${table.name}.${c.name}`, label: `${table.name}.${c.name}`,
        hint: `${c.type} · ${[base, ...path.joins.map(j => j.right)].join(" → ")}`,
        numeric: isNum(c.type), temporal: isTime(c.type),
      })));
    return [...own, ...joined];
  }, [base, model, joinedTables]);

  /** Before a table is chosen: every table's group-by columns, so a person can start from a dimension, the way Tableau lets you. */
  const byTable = useMemo(() => Object.values(model.tables).map((t) => ({
    table: t.name, grain: t.grain,
    fields: dimensionsOf(t).map((c): Field => ({ key: c.name, label: c.name, hint: c.type, numeric: isNum(c.type), temporal: isTime(c.type) })),
  })).filter((g) => g.fields.length), [model]);

  const toggle = (arr: string[], v: string, set: (x: string[]) => void) =>
    set(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

  /**
   * Choosing a metric keeps the breakdown when the table stays the same. A
   * declared metric replaces the row count; unselecting the last metric
   * while a breakdown remains falls back to counting rows, so a tile never
   * loses its dimensions just because the measure changed.
   */
  const pickMetric = (name: string) => {
    const table = metricOf(model, name).baseTable;
    let next = metrics.includes(name) ? metrics.filter((x) => x !== name) : [...metrics.filter((x) => !isRowCount(x)), name];
    if (!next.length && dims.length) next = [rowCountName(table)];
    const nextBase = next.length ? metricOf(model, next[0]).baseTable : null;
    setMetrics(next);
    if (nextBase !== base) { setDims([]); setWhere([]); }
  };

  /** A dimension picked before any metric names the table; the tile counts its rows until a metric is chosen. */
  const pickFirstDimension = (table: string, d: Field) => {
    setMetrics([rowCountName(table)]);
    setDims([d.temporal ? `month:${d.key}` : d.key]);
  };

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
    let prepared: string[];
    try {
      prepared = requiredDimensions(model, metrics, dims);
      const issues = validateTile(model, { id: "draft", metrics, dimensions: prepared, where, layout: { x: 0, y: 0, w: 400, h: 300 } });
      if (issues.length) throw new Error(issues.map(i => i.problem).join("; "));
    } catch (e: any) { setValidationError(e.message); return; }
    setValidationError(""); setDims(prepared);
    setStage("viz"); setProfileAttempt(n => n + 1); setChart(null);
  };

  const options: VizOption[] = useMemo(
    () => (profiles ? recommend(metrics, profiles, semanticHints(model, metrics)) : []),
    [profiles, metrics, model]);

  useEffect(() => { if (options.length && !options.some(o => o.kind === chart)) setChart(options[0].kind); }, [options, chart]);

  return (
    <div className="picker" onClick={onClose}>
      <div className={"sheet" + (big ? " big" : "")} onClick={(e) => e.stopPropagation()}>
        <header>
          <div>
            <h3>{stage === "fields" ? "Add a tile" : "Choose a visualization"}</h3>
            <div className="sub">
              {stage === "viz"
                ? (counting ? `Row count of ${base}` : `${metrics.length} measure${metrics.length === 1 ? "" : "s"}`) +
                  (dims.length ? ` by ${dims.map((d) => d.split(":").pop()).join(", ")}` : ", no breakdown")
                : base ? `${counting ? `Counting rows of ${base}` : `Dimensions reachable from ${base}`} — drag any field into Filters`
                       : "Pick a metric, or a dimension to count rows by"}
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
            {base && (
              <button className={"opt count" + (counting ? " on" : "")} data-testid="row-count"
                onClick={() => pickMetric(rowCountName(base))}>
                Row count<small>COUNT(*) · {model.tables[base]?.grain ?? `one row per ${base} row`}</small>
              </button>
            )}
            {Object.values(model.metrics).map((m) => {
              const disabled = base != null && m.baseTable !== base;
              return (
                <button key={m.name} draggable={!disabled}
                  onDragStart={(e) => e.dataTransfer.setData("application/x-field",
                    JSON.stringify({ field: m.name, source: "metric", numeric: true }))}
                  className={"opt" + (metrics.includes(m.name) ? " on" : "")}
                  style={disabled ? { opacity: 0.35 } : undefined} disabled={disabled}
                  onClick={() => pickMetric(m.name)}>
                  {m.label}<small>{m.name} · {m.baseTable}{unreviewedDependencies(model, m).length ? " · Dependencies need review" : isUnreviewed(model, m) ? " · Ingested, unreviewed" : ""}</small>
                </button>
              );
            })}
          </div>
          <div className="col">
            <h5>Dimensions{base ? "" : " · by table"}</h5>
            {!base && byTable.map((g) => (
              <div key={g.table} className="dim-group">
                <div className="dim-table" title={g.grain ?? undefined}>{g.table}</div>
                {g.fields.map((d) => (
                  <button key={d.key} className="opt" onClick={() => pickFirstDimension(g.table, d)}>
                    {d.label}{d.temporal ? " (by month)" : ""}<small>{d.hint}</small>
                  </button>
                ))}
              </div>
            ))}
            {available.map((d) => (
              <button key={d.key} draggable
                onDragStart={(e) => e.dataTransfer.setData("application/x-field",
                  JSON.stringify({ field: d.key, source: "dimension", numeric: d.numeric }))}
                aria-pressed={dims.includes(d.temporal ? `month:${d.key}` : d.key)}
                className={"opt" + (dims.includes(d.temporal ? `month:${d.key}` : d.key) ? " on" : "")}
                onClick={() => toggle(dims, d.temporal ? `month:${d.key}` : d.key, setDims)}>
                {d.label}{d.temporal ? " (by month)" : ""}<small>{d.hint}</small>
              </button>
            ))}
            {unavailable.length > 0 && <details className="joined-unavailable">
              <summary>Unavailable joined tables</summary>
              <p>These paths cannot safely group or filter this metric. Use a metric on the related table, or review the join definitions.</p>
              {unavailable.map(({ table, reason }) => <p key={table}><strong>{table}</strong><br />{reason}</p>)}
            </details>}
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
              {where.length ? `${where.length} ${where.length === 1 ? "filter" : "filters"}` : "drag a metric or dimension here"}
            </span>
          </div>
          <div className="pills">
            {where.map((f) => (
              <FilterPill key={f.id} f={f} base={base!} model={model} queryContext={queryContext}
                          onPatch={(p) => patch(f.id, p)}
                          onRemove={() => setWhere((w) => w.filter((x) => x.id !== f.id))} />
            ))}
          </div>
        </div>}

        {stage === "viz" && (
          profileError ? <div className="viz-step"><p role="alert">{profileError}</p><button className="review-action" onClick={retryProfiles}>Retry field profiles</button></div>
          : <VizStep options={options} profiles={profiles} metrics={metrics}
                   model={model} chart={chart} onChart={setChart} />
        )}

        {validationError && <p className="err" role="alert">{validationError}</p>}
        {stage === "viz" && metrics.some(m => metricOf(model, m)?.timeGrains?.length) && <p role="status">Using the reporting period required by these metric definitions.</p>}
        <footer>
          <button onClick={stage === "viz" ? () => setStage("fields") : onClose}>
            {stage === "viz" ? "Back" : "Cancel"}
          </button>
          <span className="spacer" />
          {stage === "fields"
            ? <button className="primary" disabled={!metrics.length} onClick={goViz}>
                Choose visualization →
              </button>
            : <button className="primary" disabled={!profiles || !!profileError || !options.some(o => o.kind === chart)}
                onClick={() => { onAdd({ metrics, dimensions: dims, where, chart: chart! }); onClose(); }}>
                Add tile
              </button>}
        </footer>
      </div>
    </div>
  );
}

function FilterPill({ f, base, model, queryContext, onPatch, onRemove }: {
  f: FilterSpec; base: string; model: Model; queryContext: string;
  onPatch: (p: Partial<FilterSpec>) => void; onRemove: () => void;
}) {
  const [open, setOpen] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const { data, error, retry } = useFilterMetadata(model, base, f, queryContext);
  const values = data?.kind === "values" ? data.values : null;
  const extent = data?.kind === "extent" ? data : null;
  const [table, column] = f.field.includes(".") ? f.field.split(".", 2) : [base, f.field];
  const temporal = f.source === "dimension" && isTime(model.tables[table]?.columns.find(c => c.name === column)?.type ?? "");
  const bound = (value: number | string | null | undefined) => value == null ? "" : temporal ? String(value).slice(0, 10) : String(value);
  const lastDate = temporal && f.maxExclusive && typeof f.max === "string" && Number.isFinite(Date.parse(f.max))
    ? new Date(Date.parse(f.max) - 86400000).toISOString().slice(0, 10) : bound(f.max);
  const label = f.source === "metric" ? metricOf(model, f.field)?.label ?? f.field : f.field;

  const chosen = new Set((f.values ?? []).map(v => JSON.stringify(v)));
  const valueLabels = filterValueLabels([...(f.values ?? []), ...(values ?? []).map(v => v.value)]);
  const summary = f.mode === "discrete"
    ? (f.values?.length ? `${f.exclude ? "not " : ""}${f.values.slice(0, 3).map(v => valueLabels.get(v)).join(", ")}${f.values.length > 3 ? ` +${f.values.length - 3}` : ""}` : "any")
    : `${f.min ?? "−∞"} … ${temporal ? lastDate || "∞" : f.max ?? "∞"}`;

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
          {f.source === "dimension" && <p className="muted sm">Values reflect this source and role before chart filters.</p>}
          {error && <div><p role="alert">{error}</p><button className="review-action" onClick={retry}>Retry filter values</button></div>}

          {f.mode === "discrete" ? (
            f.source === "metric" ? <div className="muted sm">
              Use Range to filter an aggregate value.</div>
            : error ? null : !values ? <div className="muted sm" role="status">Loading values…</div>
            : (
              <><div className="vals">
                {values.slice(0, showAll ? values.length : 60).map((v, i) => {
                  const key = JSON.stringify(v.value);
                  return (
                    <label key={i} className={"val" + (chosen.has(key) ? " on" : "")}>
                      <input type="checkbox" checked={chosen.has(key)}
                        onChange={() => onPatch({ values: chosen.has(key)
                          ? (f.values ?? []).filter((x) => JSON.stringify(x) !== key)
                          : [...(f.values ?? []), v.value] })} />
                      <span>{valueLabels.get(v.value)}</span>
                      <em>{v.n.toLocaleString()}</em>
                    </label>
                  );
                })}
              </div>
              {!values.length && <p className="muted sm">No values returned for this source and role.</p>}
              {values.length > 60 && <button className="link" onClick={() => setShowAll(v => !v)}>{showAll ? "Show fewer values" : `Show all ${values.length} returned values`}</button>}
              {data?.kind === "values" && data.truncated && <p className="muted sm" role="status">Only the {values.length} most frequent values are available here. Other values may exist.</p>}
              </>
            )
          ) : (
            <div className="range">
              <label>{temporal ? "from" : "min"}<input type={temporal ? "date" : "number"} value={bound(f.min)} placeholder={bound(extent?.min)}
                onChange={(e) => onPatch({ min: e.target.value === "" ? null : temporal ? e.target.value : +e.target.value })} /></label>
              <label>{temporal ? "through" : "max"}<input type={temporal ? "date" : "number"} value={temporal ? lastDate : bound(f.max)} placeholder={bound(extent?.max)}
                onChange={(e) => onPatch(temporal ? { max: e.target.value === "" ? null : new Date(Date.parse(e.target.value) + 86400000).toISOString().slice(0, 10), maxExclusive: true }
                  : { max: e.target.value === "" ? null : +e.target.value, maxExclusive: false })} /></label>
              {f.source === "dimension" && !extent && !error && <span className="muted sm" role="status">Loading data range…</span>}
              {extent && <span className="muted sm">{extent.min == null || extent.max == null ? "No data range is available for this source and role." : `data range ${bound(extent.min)} … ${bound(extent.max)}`}</span>}
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
      {profiles.some(p => p.warning) && <p className="sm" role="status">Some field evidence is unavailable. These suggestions use the available evidence and field types. You can still choose a chart.</p>}
      <p className="muted sm">Based on field profiles for this source and role, before chart filters. Check the resulting chart against your question.</p>
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
