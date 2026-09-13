import { useState } from "react";
import { readResponse } from "./http.ts";
import type { DriftFinding } from "../modeler/extend.ts";

/**
 * Drift, on demand (docs/modeler.md, "Drift"): what a source's model
 * declares that its warehouse no longer has, and what that breaks. Lives on
 * the Modeler's front page so it can be run without starting a draft.
 */
export interface DriftReport { source: string; checkedAt: string; tables: number; drift: DriftFinding[]; dashboards: { id: string; name: string; metrics: string[] }[] }

export function DriftCheck({ sources }: { sources: { id: string; label: string; status: "ready" | "error" }[] }) {
  const ready = sources.filter((s) => s.status === "ready");
  const [source, setSource] = useState(ready[0]?.id ?? "");
  const [report, setReport] = useState<DriftReport | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const check = async () => {
    setBusy(true); setError(null); setReport(null);
    try { setReport(await fetch(`/api/modeler/drift?source=${encodeURIComponent(source)}`).then(readResponse)); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  if (!ready.length) return null;
  return (
    <section className="cform modeler-drift" aria-label="Drift">
      <div className="eyebrow">Drift</div>
      <p className="tbl-body-p">Has the warehouse moved under a model? Columns gone or retyped, tables missing, and the metrics and dashboards each one breaks. Reads the catalogue only; changes nothing.</p>
      <div className="story-actions">
        <select value={source} aria-label="Source to check" onChange={(e) => setSource(e.target.value)}>{ready.map((s) => <option key={s.id} value={s.id}>{s.label} ({s.id})</option>)}</select>
        <button className="primary small" onClick={check} disabled={busy || !source}>{busy ? "Reading the warehouse…" : "Check drift"}</button>
      </div>
      {error && <p className="conn-err" role="alert">{error}</p>}
      {report && <DriftPanel report={report} />}
    </section>
  );
}

export function DriftPanel({ report, drift }: { report?: DriftReport; drift?: DriftFinding[] }) {
  const findings = report?.drift ?? drift ?? [];
  if (!findings.length) return <p className="conn-meta" role="status">{report ? `No drift: every table and column the model declares is in the warehouse (${report.tables} tables read).` : "No drift when this draft was made."}</p>;
  return (
    <div className="beautify-suggestion modeler-warnings" role="status">
      <div className="eyebrow">{findings.length} drift finding{findings.length === 1 ? "" : "s"}{report ? ` in ${report.source}` : ""}</div>
      <ul>{findings.map((f) => <li key={`${f.table}.${f.column}`} className={f.kind === "type_changed" ? "" : "err"}>{f.text}</li>)}</ul>
      {report && report.dashboards.length > 0 && <>
        <div className="eyebrow">Dashboards this breaks</div>
        <ul>{report.dashboards.map((d) => <li key={d.id}><b>{d.name}</b> — {d.metrics.join(", ")}</li>)}</ul>
      </>}
      {report && !report.dashboards.length && <p className="conn-meta">No saved dashboard in {report.source} charts an affected metric.</p>}
    </div>
  );
}
