import { useEffect, useRef, useState } from "react";
import { readResponse } from "./http.ts";
import type { DriftFinding } from "../modeler/extend.ts";
import { driftFindingsSchema, driftReportSchema, type DriftReport } from "../modeler/driftReport.ts";

/**
 * Drift, on demand (docs/modeler.md, "Drift"): what a source's model
 * declares that its warehouse no longer has, and what that breaks. Lives on
 * the Modeler's front page so it can be run without starting a draft.
 */
export function DriftCheck({ sources }: { sources: { id: string; label: string; status: "ready" | "error" }[] }) {
  const ready = sources.filter((s) => s.status === "ready");
  const [source, setSource] = useState(ready[0]?.id ?? "");
  const [report, setReport] = useState<DriftReport | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const pending = useRef<AbortController | null>(null);
  const selected = ready.some(s => s.id === source) ? source : ready[0]?.id ?? "";
  useEffect(() => {
    pending.current?.abort(); setReport(null); setError(null); setBusy(false);
    return () => pending.current?.abort();
  }, [selected]);
  const check = async () => {
    pending.current?.abort();
    const controller = new AbortController(); pending.current = controller;
    setBusy(true); setError(null); setReport(null);
    try {
      const result = await fetch(`/api/modeler/drift?source=${encodeURIComponent(selected)}`, { signal: controller.signal }).then(readResponse);
      if (controller.signal.aborted) return;
      const parsed = driftReportSchema.safeParse(result);
      if (!parsed.success) throw new Error("The server returned an incomplete or invalid drift report. Check again.");
      if (parsed.data.source !== selected) throw new Error("The drift response did not match the selected source. Check again.");
      setReport(parsed.data);
    } catch (e: any) { if (!controller.signal.aborted) setError(e.message); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  };
  if (!ready.length) return null;
  return (
    <section className="cform modeler-drift" aria-label="Drift">
      <div className="eyebrow">Drift</div>
      <p className="tbl-body-p">Check the model against the warehouse catalogue for missing tables, missing columns and changed types. See which metric inputs, chart groupings, filters and joins may be affected. This does not execute dashboard queries or repair the source.</p>
      <div className="story-actions">
        <select value={selected} aria-label="Source to check" onChange={(e) => setSource(e.target.value)}>{ready.map((s) => <option key={s.id} value={s.id}>{s.label} ({s.id})</option>)}</select>
        <button className="primary small" onClick={check} disabled={busy || !selected}>{busy ? "Reading the warehouse…" : "Check drift"}</button>
      </div>
      {error && <p className="conn-err" role="alert">{error}</p>}
      {report?.source === selected && <DriftPanel report={report} />}
    </section>
  );
}

export function DriftPanel({ report, drift }: { report?: DriftReport; drift?: DriftFinding[] }) {
  const parsed = driftFindingsSchema.safeParse(report ? report.drift : drift);
  if (!parsed.success) return <p className="conn-err" role="alert">No usable drift snapshot is available. Return to All drafts and use Check drift for the source to get current findings.</p>;
  const findings = parsed.data;
  const context = report ? `${report.source} · Checked ${new Date(report.checkedAt).toLocaleString()} · ${report.tables} catalogue tables read.` : "Recorded when this draft was made; check the source again for current evidence.";
  if (!findings.length) return <div role="status"><p className="conn-meta">{context}</p><p>No schema differences detected by the supported checks. This does not verify data completeness, freshness or successful dashboard queries.</p></div>;
  return (
    <div className="beautify-suggestion modeler-warnings" role="status">
      <div className="eyebrow">{findings.length} drift finding{findings.length === 1 ? "" : "s"}{report ? ` in ${report.source}` : ""}</div>
      <p className="conn-meta">{context}</p>
      <ul>{findings.map((f) => <li key={JSON.stringify([f.kind, f.table, f.column])} className={f.kind === "type_changed" ? "" : "err"}>{f.text}</li>)}</ul>
      {report && report.dashboards.length > 0 && <>
        <div className="eyebrow">Saved dashboards to review</div>
        <ul>{report.dashboards.map((d) => <li key={d.id}><b>{d.name}</b> — {d.metrics.join(", ")}
          {!!d.charts?.length && <ul>{d.charts.map(c => <li key={c.id}>{c.title}: {c.findings.join("; ")}</li>)}</ul>}
        </li>)}</ul>
      </>}
      {report && !report.dashboards.length && <p className="conn-meta">No saved chart dependencies matched these findings in {report.source}.</p>}
      <p>Review the affected definitions and charts, repair the warehouse or model as appropriate, then check again. This catalogue comparison identifies potential impact; it does not prove a query failed or inspect unsaved dashboards, temporary exploration or access-rule SQL.</p>
    </div>
  );
}
