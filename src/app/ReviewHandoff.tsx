import { MetricColorProvider } from "../charts/MetricColors.tsx";
import { useEvidenceDigest } from "./useEvidenceDigest.ts";
import { briefReviewStatus } from "./evidenceFingerprint.ts";
import { DataFindings, describeFilter } from "./MetricEvidence.tsx";
import { visibleQuery } from "./query.ts";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DashboardSpec, FilterSpec, PresentationBrief } from "../compiler/spec.ts";
import type { Model } from "../semantic/model.ts";
import type { CanvasSpec } from "../canvas/presets.ts";
import type { DrillEntry } from "./drill.ts";
import type { Readiness } from "./readiness.ts";
import { DashboardRender } from "./AiRedesign.tsx";
import { StudioDialog } from "./StudioDialog.tsx";
import { PRESENTATIONS, ReportPresentation, type PresentationMode } from "./ReportPresentation.tsx";
import { downloadPng, slugForFilename } from "./export.ts";
import { isScopeNote } from "../suggest/resultQuality.ts";
import { briefEvidence, emptyBrief } from "./presentationBrief.ts";
import { currentTab } from "./tabs.ts";
import { BriefEvidence } from "./BriefEvidence.tsx";
import { cardComparison, CARD_COMPARISONS } from "../charts/cardComparison.ts";
import { resolvedChartKind } from "../suggest/chartRules.ts";

export function ReviewHandoff({ spec, canvas, model, queryContext, evidenceScope, filtersByTile, drills, scopeWarnings, dirty, canSave, canEdit, activeTabId, initialMode = "dashboard", onKeepBrief, onClose, onSave, onWatch, onLoadMessyDraft, onImproveArrange }: {
  spec: DashboardSpec; canvas: CanvasSpec; model: Model; queryContext: string; evidenceScope: string;
  filtersByTile: Record<string, FilterSpec[]>; drills: Record<string, DrillEntry[]>;
  scopeWarnings: Record<string, string[]>; dirty: boolean; canSave: boolean; canEdit: boolean; activeTabId: string;
  initialMode?: PresentationMode;
  onKeepBrief: (brief: PresentationBrief) => void;
  onClose: () => void; onSave: (brief: PresentationBrief) => Promise<void>; onWatch: () => void;
  onLoadMessyDraft?: () => void; onImproveArrange?: () => void;
}) {
  const [checks, setChecks] = useState<Record<string, Readiness>>({});
  const [message, setMessage] = useState("");
  const [brief, setBrief] = useState<PresentationBrief>(() => structuredClone(currentTab(spec, activeTabId).brief ?? emptyBrief()));
  const [savingBrief, setSavingBrief] = useState(false);
  const { question, takeaway, nextStep } = brief;
  const [mode, setMode] = useState<PresentationMode>(initialMode), [expanded, setExpanded] = useState(initialMode !== "dashboard");
  useEffect(() => {
    setMode(initialMode);
    if (initialMode !== "dashboard") setExpanded(true);
  }, [initialMode]);
  const [exporting, setExporting] = useState(false), [preparedAt] = useState(() => new Date().toISOString());
  const busy = exporting || savingBrief;
  const close = () => { if (!busy) { if (canEdit) onKeepBrief(brief); onClose(); } };
  const editBrief = (field: "question" | "takeaway" | "nextStep", value: string) => setBrief(previous => ({ ...previous, [field]: value }));
  const chooseEvidence = (ids?: string[]) => { setBrief(previous => ({ ...previous, evidenceIds: ids })); setChecks({}); setMessage(""); };
  const report = useRef<HTMLElement>(null), previewScroll = useRef<HTMLDivElement>(null);
  const presentation = PRESENTATIONS.find(p => p.id === mode)!;
  const changeMode = (next: PresentationMode) => {
    if (next === mode || busy) return;
    setChecks({}); setMode(next); setMessage(""); previewScroll.current?.scrollTo(0, 0);
  };
  const record = useCallback((id: string, value: Readiness) => setChecks(before => JSON.stringify(before[id]) === JSON.stringify(value) ? before : { ...before, [id]: value }), []);
  const charts = spec.tiles.filter(t => (t.kind ?? "metric") === "metric");
  const evidence = briefEvidence(spec, brief);
  const shownCharts = mode === "infographic" ? evidence.selected : charts;
  const selectedIds = new Set(shownCharts.map(t => t.id));
  const reportSpec = mode === "infographic" ? { ...spec, tiles: spec.tiles.filter(t => (t.kind ?? "metric") !== "metric" || selectedIds.has(t.id)) } : spec;
  const ready = shownCharts.length > 0 && (mode !== "infographic" || evidence.missing.length === 0) && shownCharts.every(t => checks[t.id]?.status === "ready");
  const hasInterpretation = !!(question.trim() || takeaway.trim() || nextStep.trim());
  const evidenceReady = ready && shownCharts.every(t => !!checks[t.id]?.evidenceFingerprint);
  const currentEvidence = useEvidenceDigest(evidenceReady ? {
    version: 1, model, scope: evidenceScope, question, takeaway, nextStep,
    charts: shownCharts.map(t => ({ id: t.id, title: t.title, chart: t.chart, format: t.format, compareShow: t.compareShow,
      cardComparison: resolvedChartKind(model, t) === "kpi" ? cardComparison(t) : undefined,
      fingerprint: checks[t.id].evidenceFingerprint, scopeWarnings: scopeWarnings[t.id] ?? [] })).sort((a, b) => a.id.localeCompare(b.id)),
  } : undefined);
  const reviewPending = shownCharts.some(t => !checks[t.id] || checks[t.id].status === "checking" || checks[t.id].evidencePending) || currentEvidence.pending;
  const reviewStatus = briefReviewStatus(brief, currentEvidence.digest, reviewPending);
  const reviewNotice = reviewStatus === "matches" ? `Evidence and brief match your review from ${brief.review!.reviewedAt}.`
    : reviewStatus === "changed" ? "Review needed: the evidence, viewing scope, metric model or brief has changed since your last review."
    : reviewStatus === "checking" ? "Checking the saved brief against current evidence…"
    : reviewStatus === "unavailable" ? "The saved brief cannot be compared with the current evidence. Review it before sharing."
    : "This brief has not been marked reviewed against the current evidence.";
  const briefDirty = JSON.stringify(brief) !== JSON.stringify(currentTab(spec, activeTabId).brief ?? emptyBrief());
  const findingsCount = shownCharts.reduce((count, t) => count + (checks[t.id]?.dataFindings?.filter(f => !isScopeNote(f)).length ?? 0), 0);
  const queryFor = (t: DashboardSpec["tiles"][number]) => visibleQuery(model, t, [...(spec.crossFilters ?? []), ...(filtersByTile[t.id] ?? [])], drills[t.id]);
  const readyCount = shownCharts.filter(t => checks[t.id]?.status === "ready").length;
  const failedCount = shownCharts.filter(t => checks[t.id]?.status === "error").length;
  const outline = () => [spec.title, `Review prepared: ${preparedAt}`, `Context copied: ${new Date().toISOString()} (not a warehouse freshness timestamp)`,
    `Presentation: ${presentation.label}`, dirty || briefDirty ? "Contains unsaved edits." : "Saved composition and brief.",
    `Model: ${model.name}${model.calendar?.today ? `\nReporting date: ${model.calendar.today} (fixed model clock)` : ""}`,
    `Chart checks: ${readyCount} ready, ${failedCount} failed, ${shownCharts.length - readyCount - failedCount} checking. ${ready ? "Included charts queried and rendered." : "Incomplete presentation. PNG export is unavailable; this context can be shared for diagnosis."}`,
    ...(hasInterpretation ? [reviewNotice, "A review marker records an author acknowledgement, not verification of the conclusion or warehouse freshness."] : []),
    "Current tab and current viewing scope. Query/render checks do not certify source completeness or business conclusions.",
    question ? `Business question: ${question}` : "Business question: not supplied.",
    takeaway ? `Author's takeaway: ${takeaway}` : "Takeaway: not supplied.",
    nextStep ? `Next action or question: ${nextStep}` : "Next action: not supplied.",
    mode === "infographic" ? `Selected evidence: ${shownCharts.length} of ${charts.length} charts. Not shown: ${evidence.omitted.map(t => t.title ?? t.metrics.join(", ")).join("; ") || "None"}.` : "All charts in this tab.",
    ...(mode === "infographic" && evidence.missing.length ? [`Unavailable evidence selections: ${evidence.missing.join(", ")}. Update the selection before exporting.`] : []),
    ...shownCharts.map(t => {
      const query = queryFor(t), check = checks[t.id], status = check?.status ?? "checking";
      const observations = (check?.dataFindings ?? []).map(f => `${f.title}: ${f.evidence}${f.impact ? ` Why it matters: ${f.impact}` : ""} What to check: ${f.nextStep}`).join("\n");
      const noObservations = status === "error" ? "Unavailable because this chart failed its query or rendering checks."
        : status === "checking" ? "Pending; this chart has not finished its query and rendering checks."
        : "No findings reported; this is not a source audit.";
      return [t.title ?? t.metrics.join(", "),
        `Metrics: ${t.metrics.map(m => `${model.metrics[m]?.label ?? m} [${m}]`).join(", ")}`,
        `Reporting: ${query.dimensions.join(", ") || "Aggregate"}`,
        `Comparison: ${resolvedChartKind(model, { ...t, dimensions: query.dimensions }) === "kpi" ? CARD_COMPARISONS.find(([value]) => value === cardComparison({ ...t, dimensions: query.dimensions }))![1] : query.compare ?? "none"}`,
        `Filters: ${JSON.stringify(query.where)}`, `Drill: ${JSON.stringify(drills[t.id] ?? [])}`,
        `Scope exceptions: ${scopeWarnings[t.id]?.join(", ") || "None"}`,
        `Check: ${status}${check?.message ? ` — ${check.message}` : ""}`,
        `Returned bucket dates: ${check?.window ? `${check.window.start} to ${check.window.end}` : "Not reported."}`,
        `Access rules reported: ${check?.rowRules?.length ? check.rowRules.join(", ") : "None reported; this does not establish unrestricted access."}`,
        `Data observations: ${observations || noObservations}`,
      ].join("\n");
    }),
  ].join("\n\n");
  const exportPresentation = async () => {
    if (!ready || !report.current || busy) return;
    setExporting(true); setMessage("");
    try { await downloadPng(`${slugForFilename(spec.title)}-${mode}.png`, report.current, { hideControls: true }); setMessage(`${presentation.label} PNG downloaded with the displayed scope and review note.`); }
    catch (error: any) { setMessage(`Could not export: ${error.message ?? "Try again."}`); }
    finally { setExporting(false); }
  };
  return <StudioDialog title="Review and share" onClose={close} className={`ai-redesign-dialog report-dialog${expanded ? " report-expanded" : ""}`}>
    <div className="report-toolbar">
      <div className="journey-bar" role="group" aria-label="Presentation format">
        <button type="button" className="journey-step" aria-pressed={mode === "dashboard"} disabled={busy} onClick={() => changeMode("dashboard")}><span className="journey-num" aria-hidden="true">1</span>Dashboard</button>
        <button type="button" className="journey-step" aria-pressed={mode === "story"} disabled={busy} onClick={() => changeMode("story")}><span className="journey-num" aria-hidden="true">2</span>Story</button>
        <button type="button" className="journey-step" aria-pressed={mode === "infographic"} disabled={busy} onClick={() => changeMode("infographic")}><span className="journey-num" aria-hidden="true">3</span>Infographic</button>
      </div>
      {onImproveArrange && <button type="button" className="review-action" disabled={busy} onClick={() => { if (canEdit) onKeepBrief(brief); onImproveArrange(); }}>Improve &amp; Arrange</button>}
      <button type="button" className="review-action" disabled={busy} onClick={() => setExpanded(v => !v)}>{expanded ? "Edit brief & evidence" : "Expand presentation"}</button>
      <span className="spacer" />
      <button type="button" className="primary" disabled={!ready || busy} onClick={() => void exportPresentation()}>{exporting ? "Exporting…" : `Export ${presentation.label.toLowerCase()} as PNG`}</button>
      {message && <p role="status">{message}</p>}
    </div>
    <div className="ai-redesign-content">
      <section className="ai-redesign-brief">
        <span className="eyebrow">Presentation preview · not published</span><h2>Make the review easy to follow.</h2>
        <p role="status">{readyCount} of {shownCharts.length} selected charts queried and rendered. Source completeness and business conclusions still need your review.</p>
        {findingsCount > 0 && <p role="status">{findingsCount} data observation{findingsCount === 1 ? "" : "s"} to review. Open the chart details below for evidence and next steps.</p>}
        <label htmlFor="review-question">What decision should this help someone make?</label>
        <textarea disabled={busy} id="review-question" value={question} maxLength={1000} onChange={e => editBrief("question", e.target.value)} rows={2} placeholder="For example: Is growth becoming more durable?" />
        <label htmlFor="review-takeaway">What should the reader take away?</label>
        <textarea disabled={busy} id="review-takeaway" value={takeaway} maxLength={4000} onChange={e => editBrief("takeaway", e.target.value)} rows={4} placeholder="State the finding, its evidence, and the next question." />
        <label htmlFor="review-next-step">What should happen next?</label>
        <textarea disabled={busy} id="review-next-step" value={nextStep} maxLength={2000} onChange={e => editBrief("nextStep", e.target.value)} rows={2} placeholder="Name an investigation or decision, and who should take it forward." />
        <p>{canEdit ? "Your question, takeaway, next step and evidence selection are kept in this tab. Save dashboard to persist them." : "Your brief is a preview only; you do not have permission to save this dashboard."} These are your interpretations, not automatically verified conclusions.</p>
        {hasInterpretation && <section className="brief-review-control" aria-label="Brief evidence review">
          <p role="status">{reviewNotice}</p>
          <p>Review the takeaway and next step against the displayed charts and caveats. This records your acknowledgement, not verification of the conclusion or warehouse freshness.</p>
          <button className="review-action" disabled={busy || !currentEvidence.digest || reviewStatus === "matches"} onClick={() => {
            if (currentEvidence.digest) setBrief(previous => ({ ...previous, review: { version: 1, reviewedAt: new Date().toISOString(), fingerprint: currentEvidence.digest! } }));
          }}>{reviewStatus === "matches" ? "Brief review recorded" : "Mark brief reviewed"}</button>
        </section>}
        {mode === "infographic" && <fieldset className="report-evidence-picker" disabled={busy}><legend>Choose evidence for the infographic</legend>
          <p>Keep the charts that answer your question, including counter-evidence. The full dashboard stays intact.</p>
          {charts.map(t => <label key={t.id}><input type="checkbox" checked={selectedIds.has(t.id)} onChange={e => chooseEvidence(e.target.checked ? [...evidence.selected.map(t => t.id), t.id] : evidence.selected.filter(chart => chart.id !== t.id).map(chart => chart.id))} />{t.title ?? t.metrics.map(name => model.metrics[name]?.label ?? name).join(", ")}</label>)}
          <button className="review-action" onClick={() => chooseEvidence()}>Include all charts</button>
          {!shownCharts.length && <p role="status">Select at least one chart to export.</p>}
          {!!evidence.missing.length && <p role="alert">{evidence.missing.length} saved selection(s) are no longer available in this tab. Update the selection or include all charts before exporting.</p>}
        </fieldset>}
        <BriefEvidence charts={shownCharts} checks={checks} model={model} brief={brief} busy={busy} scopeWarnings={scopeWarnings} filtersFor={t => queryFor(t).where}
          onAppend={(field, text) => setBrief(previous => ({ ...previous, [field]: [previous[field].trim(), text].filter(Boolean).join("\n\n") }))} />
        {shownCharts.map(t => <details key={t.id}><summary>{t.title ?? t.metrics.join(", ")}</summary>
          <p>{checks[t.id]?.message ?? (checks[t.id]?.status === "ready" ? "Query and chart ready." : "Checking…")}</p>
          {!!checks[t.id]?.dataFindings?.length && <DataFindings findings={checks[t.id].dataFindings!} model={model} />}
          {!!scopeWarnings[t.id]?.length && <p className="err">Not filtered by {scopeWarnings[t.id].join(", ")}</p>}
          <p>Reporting: {queryFor(t).dimensions.join(", ") || "Aggregate"}</p>
          {t.metrics.map(name => <p key={name}><b>{model.metrics[name]?.label ?? name}</b><br />{model.metrics[name]?.description || "No description supplied."}</p>)}
        </details>)}
        <p>Each format keeps the included charts’ current filters and drill context. Presentation changes do not alter your saved layout or definitions. Copy the review context alongside your PNG, or share it to diagnose pending and failed charts.</p>
        <button className="review-action" onClick={async () => { try { await navigator.clipboard.writeText(outline()); setMessage("Review context copied."); } catch { setMessage("Could not copy. Allow clipboard access and try again."); } }}>Copy review context</button>
        <h3>Keep watching what matters</h3><p>Save your dashboard, then choose a chart’s bell to preview a personal watch. Watches use saved filter defaults.</p>
        <button className="review-action" disabled={busy} onClick={() => { if (canEdit) onKeepBrief(brief); onWatch(); }}>Show chart alerts</button>
      </section>
      <section className="ai-redesign-preview" aria-label="Review preview">
        <p className="ai-redesign-preview-caption">{presentation.description} Presentation only; your dashboard stays intact.</p>
        <div className="report-scroll" ref={previewScroll}>
          <article className={`report-document report-${mode}`} ref={report} aria-label={`${presentation.label} presentation`}>
            <header className="report-cover doc-head"><span className="eyebrow">Semantic Canvas · {presentation.label}</span>
              {(question.trim() || spec.description) && (
                <div className="report-question">
                  <span>Business question</span>
                  <h2>{question.trim() || spec.description}</h2>
                </div>
              )}
              <h1>{spec.title}</h1>
              {spec.description && question.trim() && <p className="report-description">{spec.description}</p>}
              <div className="report-masthead-pills">
                <span className="masthead-pill">Partial periods hatched</span>
                <span className="masthead-pill" title="SHA-256 checks content integrity, not analytical correctness or authorship.">Snapshot with integrity checksum (SHA-256)</span>
              </div>
              <p className="report-model">Model: {model.name} · Current tab and viewing scope{model.calendar?.today ? ` · Reporting date: ${model.calendar.today} (fixed model clock)` : ""}</p>
              {takeaway.trim() && <div className="report-takeaway"><strong>Author’s takeaway</strong><p>{takeaway}</p></div>}
              {hasInterpretation && <p className={`report-review-note ${reviewStatus === "matches" ? "review-matches" : "review-needed"}`}>{reviewNotice} This is an author acknowledgement, not a certification of the conclusion or source freshness.</p>}
              {mode === "infographic" && evidence.omitted.length > 0 && <p className="report-selection">Selected evidence · {shownCharts.length} of {charts.length} charts from this tab. Full coverage is available in Dashboard and Story.</p>}
            </header>
            <MetricColorProvider tiles={spec.tiles}>{mode === "dashboard" ? <DashboardRender key={mode} spec={spec} canvas={canvas} model={model} queryContext={queryContext} filtersByTile={filtersByTile} scopeWarnings={scopeWarnings} drills={drills} fullSize={false} onReadiness={record} />
              : <ReportPresentation key={`${mode}:${JSON.stringify(brief.evidenceIds)}`} mode={mode} spec={reportSpec} model={model} queryContext={queryContext} filtersByTile={filtersByTile} scopeWarnings={scopeWarnings} drills={drills} checks={checks} onReadiness={record} />}</MetricColorProvider>
            {nextStep.trim() && <section className="report-next-step"><span>Next action or question</span><h2>{nextStep}</h2><p>Proposed by the author. No task or notification has been sent.</p></section>}
            {mode === "infographic" && evidence.omitted.length > 0 && <section className="report-omitted"><h2>Outside this brief</h2><p>Not shown: {evidence.omitted.map(t => t.title ?? t.metrics.join(", ")).join("; ")}. Their results are not assessed in this presentation.</p></section>}
            <footer className="report-evidence"><h2>Reading this report</h2><p>Prepared {preparedAt}. This is a snapshot of the current viewing scope. Query and rendering checks do not certify source completeness or business conclusions.</p>
              {mode === "dashboard" && charts.map(t => <section key={t.id}><h3>{t.title ?? t.metrics.join(", ")}</h3><p>{queryFor(t).dimensions.join(", ") || "Aggregate · no breakdown"}</p>
                {checks[t.id]?.window && <p>Returned bucket dates: {checks[t.id].window!.start} to {checks[t.id].window!.end}</p>}
                {!!checks[t.id]?.rowRules?.length && <p>Access rules applied: {checks[t.id].rowRules!.join(", ")}.</p>}
                {queryFor(t).where.map((f, i) => <p key={`${f.id}:${i}`}>{describeFilter(f)}</p>)}
                {!!scopeWarnings[t.id]?.length && <p className="err">Not filtered by {scopeWarnings[t.id].join(", ")}</p>}
                {!!checks[t.id]?.dataFindings?.length && <DataFindings findings={checks[t.id].dataFindings!} model={model} />}
              </section>)}
              <p>Metric definitions are shared across every format. In the live dashboard, use a chart’s information control to inspect its definition, filters and query evidence.</p>
            </footer>
          </article>
        </div>
      </section>
    </div>
    <footer><span>{dirty || briefDirty ? "Save to keep the dashboard and brief." : "Dashboard and brief saved."}</span><span className="spacer" /><button className="review-action" disabled={busy} onClick={close}>Back to dashboard</button><button className="primary" disabled={!canSave || busy} onClick={async () => { setSavingBrief(true); try { await onSave(brief); setMessage("Dashboard and brief saved."); } catch { setMessage("Could not save. Your brief is still here; retry when ready."); } finally { setSavingBrief(false); } }}>{savingBrief ? "Saving…" : "Save dashboard"}</button></footer>
  </StudioDialog>;
}
