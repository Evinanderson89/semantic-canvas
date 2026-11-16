import { createPortal } from "react-dom";
import { useState } from "react";
import type { PartialEdges } from "../compiler/compile.ts";
import type { FilterSpec } from "../compiler/spec.ts";
import { computedMetricIssue, metricComponents, metricOf, metricType, timeColumnOf, type Metric, type Model } from "../semantic/model.ts";
import { isScopeNote, type DataFinding } from "../suggest/resultQuality.ts";
import { StudioDialog } from "./StudioDialog.tsx";
import { DataExportActions } from "./DataExportActions.tsx";

export function findingTitle(finding: DataFinding, model?: Model): string {
  const match = /^(?:missing|null|invalid|precision):(.+)$/.exec(finding.id);
  const metric = match && model ? metricOf(model, match[1]) : undefined;
  return metric && finding.title.endsWith(`: ${match![1]}`)
    ? finding.title.slice(0, -match![1].length) + metric.label : finding.title;
}

export function DataFindings({ findings, model, compact = false }: { findings: DataFinding[]; model?: Model; compact?: boolean }) {
  return <ul className={`data-findings${compact ? " compact" : ""}`}>{[...findings].sort((a, b) => Number(isScopeNote(a)) - Number(isScopeNote(b))).map(f => <li key={f.id} className={isScopeNote(f) ? "scope-note" : "quality-finding"}>
    <span className="finding-category">{isScopeNote(f) ? "Reporting scope" : "Review before interpreting"}</span>
    <h4>{findingTitle(f, model)}</h4><p className="finding-evidence">{f.evidence}</p>{f.impact && <p><strong>Why it matters:</strong> {f.impact}</p>}<p><strong>What to check:</strong> {f.nextStep}</p>
  </li>)}</ul>;
}

export function describeFilter(filter: FilterSpec): string {
  const value = filter.mode === "discrete" ? `${filter.exclude ? "excludes" : "includes"} ${filter.values?.map(v => v === null ? "null" : String(v)).join(", ") || "no selected values"}`
    : `${filter.exclude ? "outside" : "within"} ${filter.min ?? "unbounded"} ≤ value ${filter.maxExclusive ? "<" : "≤"} ${filter.max ?? "unbounded"}`;
  return `${filter.field}: ${value}`;
}

function DefinitionFields({ metric: m, model }: { metric: Metric; model: Model }) {
  const period = model.tables[m.baseTable]?.period;
  const defaultTime = timeColumnOf(model, m.baseTable);
  return <>
    <code>{m.name}</code><p>{m.description || "No description supplied."}</p>
    <p>Base table: {m.baseTable} · Type: {metricType(m)}</p>
    {period && <p>Declared source periods: whole {period.grain} periods, dated by {m.baseTable}.{period.column}. This describes the rows; it does not certify that every period has arrived.</p>}
    {m.expression && <pre>{m.expression}</pre>}
    <p>Declared reporting grains: {m.timeGrains?.join(", ") || "No restriction declared"}</p>
    {m.timeDimension ? <p>Declared time field: <code>{m.timeDimension}</code></p>
      : defaultTime && <p>Default table time field: <code>{defaultTime}</code></p>}
    <p>Metric-level filter: {m.filter ? <code>{m.filter}</code> : "None declared"}</p>
  </>;
}

function MetricContract({ name, model }: { name: string; model: Model }) {
  const m = metricOf(model, name);
  if (!m) return <section className="metric-contract"><h4>{name}</h4><p className="err">This metric is not available in the current model. Its definition cannot be verified here.</p></section>;
  const type = metricType(m), issue = computedMetricIssue(model, m);
  // Supported calculations have one level of simple inputs. Reuse the
  // compiler's dependency resolution; do not infer lineage from labels or SQL.
  const inputs = type === "simple" ? [] : [...new Map(metricComponents(model, m).map(input => [input.name, input])).values()];
  const roles = (input: Metric) => type === "ratio"
    ? [m.numerator === input.name && "Numerator", m.denominator === input.name && "Denominator"].filter(Boolean).join(" · ")
    : type === "cumulative" ? "Accumulated input" : "Calculation input";
  return <section className="metric-contract">
    <h4>{m.label}</h4>
    <DefinitionFields metric={m} model={model} />
    {issue && <p className="err">Definition issue: {issue}</p>}
    {type === "ratio" && <>
      <p>Numerator: <code>{m.numerator}</code> · Denominator: <code>{m.denominator}</code></p>
      <p>Divides the aggregated numerator by the aggregated denominator. A zero denominator produces an unavailable value.</p>
    </>}
    {type === "cumulative" && <>
      <p>Input metric: {m.metric} · Window: {m.window ? `${m.window} reporting periods, including the current period` : "Since the start of the query input"}.</p>
      <p>{m.window ? "Uses this chart’s time grain and reporting calendar. Sums available input values within that window; missing periods do not pull in older values." : "Sums available input values from the start of the query input through each period."} Date and dimension filters restrict the input. A result does not certify complete period coverage.</p>
    </>}
    {!!inputs.length && <details className="metric-inputs">
      <summary>Inspect input definitions ({inputs.length})</summary>
      <p>Each input keeps its own metric-level filter and reporting restrictions. Chart filters and server-applied row rules also affect the calculation.</p>
      <ul>{inputs.map(input => <li key={input.name}>
        <span className="metric-input-role">{roles(input)}</span><h5>{input.label}</h5>
        <DefinitionFields metric={input} model={model} />
      </li>)}</ul>
    </details>}
  </section>;
}

function RatioInputPeriods({ periods }: { periods: NonNullable<PartialEdges["ratio"]> }) {
  const [limit, setLimit] = useState(50);
  const range = (start: string | null, end: string | null) => !start && !end ? "No observed period" : `${start ?? "Unknown start"} to ${end ?? "Unknown end"}`;
  return <details className="ratio-period-evidence"><summary>Inspect affected input periods ({periods.length})</summary>
    <p>Each row identifies the input windows for an affected returned ratio. These observed boundaries do not certify that every source record arrived.</p>
    <div className="ratio-period-scroll" role="region" aria-label="Affected ratio input periods" tabIndex={0}>
      <table><caption>Numerator and denominator coverage</caption><thead><tr><th scope="col">Period</th><th scope="col">Breakdown</th><th scope="col">Numerator</th><th scope="col">Denominator</th></tr></thead>
        <tbody>{periods.slice(0, limit).map((row, i) => <tr key={i}><td>{row.period ?? "Undated bucket"}</td>
          <td>{row.dimensions ? Object.entries(row.dimensions).map(([name, value]) => `${name}: ${value == null ? "Missing" : JSON.stringify(value)}`).join("; ") : "No categorical breakdown"}</td>
          <td>{range(row.numeratorStart, row.numeratorEnd)}</td><td>{range(row.denominatorStart, row.denominatorEnd)}</td></tr>)}</tbody>
      </table>
    </div>
    <p>{Math.min(limit, periods.length)} of {periods.length} affected rows shown.</p>
    {limit < periods.length && <button className="review-action" onClick={() => setLimit(n => n + 50)}>Show next {Math.min(50, periods.length - limit)} rows</button>}
  </details>;
}

export function MetricEvidence({ title, metrics, dimensions, where, model, findings, state, scopeWarnings = [], policy, provenance, sql, onExportCsv, onExportSpreadsheet, exporting, exportError, onClose }: {
  title: string; metrics: string[]; dimensions: string[]; where: FilterSpec[]; model: Model; findings: DataFinding[];
  state: { status: string; message?: string; rows?: unknown[][]; cached?: boolean; ms?: number; window?: { start: string; end: string }; rlsApplied?: string[]; partial?: PartialEdges };
  scopeWarnings?: string[]; policy?: string; provenance?: string; sql?: string; onExportCsv?: () => void;
  onExportSpreadsheet?: () => void; exporting?: boolean; exportError?: string; onClose: () => void;
}) {
  return createPortal(<div onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}><StudioDialog title="Metric definition and scope" onClose={onClose} className="metric-evidence-dialog">
    <section className="metric-evidence-body">
      <span className="eyebrow">Evidence for this chart</span><h2>{title}</h2>
      <p>Model: <strong>{model.name}</strong> · Adapter: {model.source}</p>
      <h3>Data checks</h3>
      {state.status !== "ok" ? <p role="status">{state.status === "loading" ? "Waiting for the current query. Earlier results are not being assessed." : state.message ?? "The query did not complete."}</p>
        : <><p>{state.rows?.length ?? 0} returned rows checked · {state.cached ? "Cached query result" : "Query result"}{state.ms != null ? ` · ${state.ms} ms` : ""}</p>
          {findings.length ? <DataFindings findings={findings} model={model} /> : <p>No issues found by the returned-row checks.</p>}
          {!!state.partial?.ratio?.length && <RatioInputPeriods periods={state.partial.ratio} />}
          {onExportCsv && onExportSpreadsheet && <DataExportActions onCsv={onExportCsv} onSpreadsheet={onExportSpreadsheet} busy={exporting} error={exportError} />}</>}
      <p className="evidence-boundary">These checks inspect query results, not every source record. They do not certify completeness, freshness or business accuracy. With one time dimension, gaps and repeated periods are checked separately for each returned breakdown combination. Gaps are checked only between that series’ observed dates, not before its first or after its last row.</p>
      <h3>Reporting scope</h3>
      <p>{dimensions.length ? dimensions.join(", ") : "Aggregate — no breakdown"}</p>
      {state.status === "ok" && state.window && <p>Returned bucket dates: {state.window.start} to {state.window.end}.</p>}
      {model.calendar?.today && <p>Reporting clock override: {model.calendar.today}. Relative reporting windows use this date.</p>}
      {provenance && <p>{provenance}</p>}
      <h4>Query filters</h4>
      {where.length ? <ul>{where.map((f, i) => <li key={`${f.id}:${i}`}>{describeFilter(f)}</li>)}</ul> : <p>No interactive or chart-level filters.</p>}
      {!!scopeWarnings.length && <p className="err">Not filtered by {scopeWarnings.join(", ")}</p>}
      <p>Server-applied row rules: {state.status === "ok" ? state.rlsApplied?.join(", ") || "None reported by this query" : "Available after the query completes"}.</p>
      {policy && <p>{policy}</p>}
      <h3>Metric definitions</h3>
      {metrics.map(name => <MetricContract key={name} name={name} model={model} />)}
      {sql && <details><summary>Inspect executed SQL</summary><pre>{sql}</pre></details>}
    </section>
  </StudioDialog></div>, document.body);
}
