import { MetricColorProvider } from "../charts/MetricColors.tsx";
import { aiError } from "./aiError.ts";
import type { Readiness } from "./readiness.ts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DashboardSpec, FilterSpec } from "../compiler/spec.ts";
import type { CanvasSpec } from "../canvas/presets.ts";
import type { Model } from "../semantic/model.ts";
import type { CanvasProposal } from "../canvas/proposals.ts";
import { validateRedesign } from "../suggest/redesign.ts";
import { rememberDecision, type ReviewDecision } from "../suggest/reviewSession.ts";
import { fingerprint } from "./document.ts";
import { readResponse } from "./http.ts";
import { StudioDialog } from "./StudioDialog.tsx";
import { Tile } from "./Tile.tsx";
import { TileBoundary } from "./TileBoundary.tsx";
import { redesignImpact } from "./redesignImpact.ts";
import { redesignReadiness } from "./redesignReadiness.ts";
import { RedesignImpact } from "./RedesignImpact.tsx";
import { DataFindings } from "./MetricEvidence.tsx";
import { renderMarkdown } from "./markdown.tsx";
import type { DrillEntry } from "./drill.ts";

type Preview = { proposal: CanvasProposal; spec: DashboardSpec; canvas: CanvasSpec; before: DashboardSpec; expected: string; context: string; explanation: string };
export function AiRedesign({ spec, canvas, model, available, canConfigure, onConfigure, onClose, onApply, queryContext, filtersByTile, drills, resolveFilters, resolveScopeWarnings, activeTabId, filterContext }: {
  activeTabId?: string; filterContext?: string;
  resolveFilters?: (spec: DashboardSpec) => Record<string, FilterSpec[]>;
  resolveScopeWarnings?: (spec: DashboardSpec) => Record<string, string[]>;
  spec: DashboardSpec; canvas: CanvasSpec; model: Model; available: boolean; canConfigure: boolean;
  onConfigure: () => void; onClose: () => void; onApply: (proposal: CanvasProposal, expected: string) => boolean;
  queryContext: string; filtersByTile: Record<string, FilterSpec[]>; drills: Record<string, DrillEntry[]>;
}) {
  const [goal, setGoal] = useState("Make this an executive dashboard: show what matters, explain the trend, and make the next question obvious.");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null), [explanation, setExplanation] = useState("");
  const [view, setView] = useState<"before" | "after">("after"), [fullSize, setFullSize] = useState(false);
  const [checkAttempt, setCheckAttempt] = useState(0);
  const [checks, setChecks] = useState<Record<string, Readiness>>({});
  const [baseline, setBaseline] = useState<{ context: string; checks: Record<string, Readiness> }>({ context: "", checks: {} });
  const [acceptExistingIssues, setAcceptExistingIssues] = useState(false);
  const recordCheck = useCallback((id: string, value: Readiness) => setChecks(before => JSON.stringify(before[id]) === JSON.stringify(value) ? before : { ...before, [id]: value }), []);
  const [applied, setApplied] = useState(false);
  const decisions = useRef<ReviewDecision[]>([]), request = useRef<AbortController | null>(null);
  const context = JSON.stringify([spec, canvas, queryContext, filtersByTile, drills, filterContext, activeTabId, model]);
  const latest = useRef(context); latest.current = context;
  const recordBaseline = useCallback((id: string, value: Readiness) => {
    if (latest.current !== context) return;
    setBaseline(before => {
      const checks = before.context === context ? before.checks : {};
      return JSON.stringify(checks[id]) === JSON.stringify(value) ? before : { context, checks: { ...checks, [id]: value } };
    });
  }, [context]);
  const stale = !!preview && preview.context !== context;
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => { request.current?.abort(); setBusy(false); }, [context]);

  const generate = async () => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    const snapshot = context;
    setChecks({}); setAcceptExistingIssues(false); setBusy(true); setError(""); setExplanation(""); setApplied(false); setPreview(null);
    try {
      const result = await fetch("/api/agent/chat", { method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ conversationId: crypto.randomUUID(), mode: "redesign", message: `User goal: ${goal}\nCurrent view filters and drill context (data): ${JSON.stringify({ filtersByTile, drills })}`,
          document: { spec, canvas, selected: [], activeTabId }, review: { goal, dashboardTitle: spec.title, decisions: decisions.current } }) }).then(readResponse);
      if (controller.signal.aborted || latest.current !== snapshot) return;
      if (!result.proposal) { setPreview(null); setExplanation(result.text || "The assistant did not find a useful redesign. Try a more specific goal."); return; }
      const next = validateRedesign(spec, canvas, result.proposal, model, activeTabId);
      setPreview({ ...next, proposal: result.proposal, before: spec, expected: fingerprint(spec, canvas), context: snapshot, explanation: result.text || "" });
      setView("after");
    } catch (e: any) { if (!controller.signal.aborted) setError(aiError(e)); }
    finally { if (request.current === controller) setBusy(false); }
  };
  const remember = (status: ReviewDecision["status"]) => {
    if (preview) decisions.current = rememberDecision(decisions.current, { key: JSON.stringify(preview.proposal.actions).slice(0,4000), label: preview.proposal.title.slice(0,1000), status });
  };
  const charts = preview?.spec.tiles.filter(t => (t.kind ?? "metric") === "metric") ?? [];
  const observations = charts.filter(t => checks[t.id]?.dataFindings?.length);
  const shown = preview && !stale && view === "after" ? preview.spec : spec;
  const previewFilters = resolveFilters?.(shown) ?? filtersByTile;
  const impact = preview ? redesignImpact(preview.before, preview.spec, model,
    { filters: resolveFilters?.(preview.before) ?? filtersByTile, drills, warnings: resolveScopeWarnings?.(preview.before) },
    { filters: resolveFilters?.(preview.spec) ?? filtersByTile, drills, warnings: resolveScopeWarnings?.(preview.spec) }) : null;
  const { failed, existing, blocking, settled } = redesignReadiness(charts, checks, baseline.context === context ? baseline.checks : {}, impact?.tiles ?? []);
  const ready = !!preview && settled && (!existing.length || acceptExistingIssues);
  const shownCanvas = preview && !stale && view === "after" ? preview.canvas : canvas;

  return <StudioDialog title="Reimagine this dashboard" onClose={onClose} className="ai-redesign-dialog">
    <div className="ai-redesign-content">
      <section className="ai-redesign-brief">
        <div className="eyebrow">Powered by AI</div>
        <h2>See what this could become.</h2>
        <p>A clearer story, better chart choices, and useful supporting evidence—proposed together as one redesign.</p>
        <label htmlFor="redesign-goal">What should the reader understand or decide?</label>
        <textarea id="redesign-goal" rows={4} maxLength={1600} value={goal} disabled={busy} onChange={e => setGoal(e.target.value)} />
        <div className="ai-redesign-directions">{[
          ["Executive overview", "Build an executive dashboard with clear headline numbers, a leading trend, and compact evidence for the next decision."],
          ["Tell a story", "Tell a coherent story: establish the question, sequence the evidence, and make the next question clear. Give the most useful chart room to lead."],
          ["Better comparisons", "Find charts that hide useful information. Improve their reporting periods, breakdowns and comparisons using governed metrics. Add only the context needed to understand them."],
        ].map(([label, value]) => <button key={label} disabled={busy} onClick={() => setGoal(value)}>{label}</button>)}</div>
        {!available ? <p role="status">Connect an AI provider to generate a redesign. {canConfigure ? <button className="link" onClick={onConfigure}>Configure AI</button> : "Ask your workspace administrator to configure AI."}</p>
          : <button className="primary" disabled={busy || !goal.trim()} onClick={generate}>{busy ? "Designing…" : preview ? "Generate another version" : error ? "Retry redesign" : "Show me a better dashboard"}</button>}
        {busy && <div role="status"><p>Reviewing the canvas and governed metrics, then preparing changes you can inspect.</p><button className="link" onClick={() => { request.current?.abort(); setBusy(false); }}>Cancel generation</button></div>}
        {error && <div><p className="err" role="alert">{error}</p>{canConfigure && <button className="review-action" onClick={onConfigure}>Check AI connection</button>}</div>}
        {explanation && <div className="ai-redesign-explanation">{renderMarkdown(explanation)}</div>}
        {preview && <div className="ai-redesign-explanation"><h3>{preview.proposal.title}</h3><p>{preview.proposal.reason}</p>{renderMarkdown(preview.explanation)}{!stale && impact && <RedesignImpact impact={impact} />}</div>}
        {!preview && !explanation && <div className="ai-redesign-imagine"><h3>More than moving boxes</h3><p>Turn an unhelpful breakdown into a trend. Put related evidence together. Bring the key numbers into focus.</p><small>The AI will propose changes based on your actual canvas and available metrics.</small></div>}
      </section>
      <section className="ai-redesign-preview" aria-label="Dashboard redesign preview">
        <div className="ai-redesign-preview-bar"><div role="group" aria-label="Compare dashboard versions"><button aria-pressed={view === "before" || !preview} onClick={() => setView("before")}>Before</button><button disabled={!preview || stale} aria-pressed={view === "after" && !!preview && !stale} onClick={() => { if (view !== "after") { setChecks({}); setAcceptExistingIssues(false); setView("after"); } }}>Proposed dashboard</button></div><button onClick={() => setFullSize(v => !v)}>{fullSize ? "Fit preview" : "Actual size"}</button></div>
        <p className="ai-redesign-preview-caption">{preview && !stale && view === "after" ? "Proposed version · not applied" : "Your current dashboard"} · Charts use your connected data. Current filters apply where supported; exceptions appear on each chart.</p>
        {stale && <p role="status">Your dashboard, filters or semantic model changed. Generate a fresh redesign to include those changes.</p>}
        {preview && !stale && view === "after" && <div className="redesign-checks" role="status">
          <b>{blocking.length ? "Preview needs attention" : existing.length ? "Existing chart issues remain" : !charts.length ? "No chart queries to check" : ready ? "Queries and charts checked" : "Checking proposed queries and charts…"}</b>
          <p>{charts.length ? `${charts.filter(t => checks[t.id]?.status === "ready").length} of ${charts.length} charts ready. These checks do not certify business conclusions or source completeness.` : "This proposal contains no charts. Review the layout, authored content and any removals before applying."}</p>
          {!!observations.length && <details className="redesign-observations"><summary>Data observations in {observations.length} proposed chart{observations.length === 1 ? "" : "s"}</summary>
            {observations.map(t => <section key={t.id}><h4>{t.title ?? t.metrics.join(", ")}</h4><DataFindings findings={checks[t.id].dataFindings!} model={model} /></section>)}
          </details>}
          {failed.map(t => <p key={t.id} className="err">{t.title ?? t.metrics.join(", ")}: {checks[t.id]?.message}</p>)}
          {!!existing.length && <div className="redesign-existing-issues">
            <p>{existing.map(t => t.title ?? t.metrics.join(", ")).join(", ")} {existing.length === 1 ? "had this issue" : "had these issues"} in the current dashboard. Their queries, chart types, formatting and sizes are unchanged. Applying will keep these issues visible.</p>
            <label><input type="checkbox" checked={acceptExistingIssues} onChange={event => setAcceptExistingIssues(event.target.checked)} /> Apply with these existing chart issues</label>
          </div>}
          {!!failed.length && <button className="review-action" onClick={() => { setChecks({}); setAcceptExistingIssues(false); setCheckAttempt(n => n + 1); }}>Retry chart checks</button>}
          {!!failed.length && <button className="review-action" onClick={() => { setGoal(g => `${g}\nRepair these preview problems: ${failed.map(t => `${t.title}: ${checks[t.id]?.message}`).join("; ")}`.slice(0, 1600)); }}>Include these issues in my next request</button>}
        </div>}
        <DashboardRender key={`${preview?.expected ?? "current"}:${view}:${checkAttempt}`} onReadiness={preview && !stale && view === "after" ? recordCheck : recordBaseline} spec={shown} canvas={shownCanvas} model={model} queryContext={`${queryContext}:preview:${checkAttempt}`} filtersByTile={previewFilters} scopeWarnings={resolveScopeWarnings?.(shown)} drills={drills} fullSize={fullSize} />
      </section>
    </div>
    <footer><span>{applied ? "Redesign applied. One undo restores the previous version." : "Preview first. Apply the whole redesign with one undo."}</span><span className="spacer" />{preview && <button className="link" onClick={() => { remember("dismissed"); setPreview(null); setExplanation(""); }}>Keep current dashboard</button>}<button className="primary" disabled={!preview || stale || busy || !ready || view !== "after"} onClick={() => { if (!preview || !ready || stale || view !== "after") return; if (onApply(preview.proposal, preview.expected)) { remember("applied"); setPreview(null); setApplied(true); } else setError("The redesign could not be applied. Generate a fresh preview and try again."); }}>Apply redesign</button></footer>
  </StudioDialog>;
}

export function DashboardRender({ spec, canvas, model, queryContext, filtersByTile, scopeWarnings, drills, fullSize, onReadiness }: { scopeWarnings?: Record<string, string[]>; onReadiness?: (id: string, state: Readiness) => void; spec: DashboardSpec; canvas: CanvasSpec; model: Model; queryContext: string; filtersByTile: Record<string, FilterSpec[]>; drills: Record<string, DrillEntry[]>; fullSize: boolean }) {
  const viewport = useRef<HTMLDivElement>(null), [width, setWidth] = useState(700);
  useEffect(() => { const element = viewport.current!; const observer = new ResizeObserver(() => setWidth(element.clientWidth)); observer.observe(element); return () => observer.disconnect(); }, []);
  const scale = fullSize ? 1 : Math.min(1, Math.max(200, width - 16) / canvas.width);
  const height = useMemo(() => Math.max(360, ...spec.tiles.map(t => t.layout.y + t.layout.h + 24)), [spec]);
  return <MetricColorProvider tiles={spec.tiles}><div className="ai-redesign-render" ref={viewport}><div style={{ width: canvas.width * scale, height: height * scale, position: "relative" }}><div style={{ width: canvas.width, height, transform: `scale(${scale})`, transformOrigin: "top left", position: "absolute" }}>
    {!spec.tiles.length && <p className="ai-redesign-empty">Your first draft will appear here.</p>}
    {spec.tiles.map(t => <div className="ai-redesign-tile" key={t.id} style={{ position: "absolute", left: t.layout.x, top: t.layout.y, width: t.layout.w, height: t.layout.h, zIndex: t.layout.z }}>
      {t.kind === "filter" ? <div className="tile"><p>{t.title ?? "Dashboard filter"}</p><small>Current selection is preserved.</small></div> : <TileBoundary onError={message => onReadiness?.(t.id, { status: "error", message })} label={t.title ?? t.metrics.join(", ")}><Tile onReadiness={onReadiness} scopeWarnings={scopeWarnings?.[t.id]} model={model} spec={t} locked queryContext={queryContext} crossFilters={[...(spec.crossFilters ?? []), ...(filtersByTile[t.id] ?? [])]} drill={drills[t.id]} onRemove={() => {}} /></TileBoundary>}
    </div>)}
  </div></div></div></MetricColorProvider>;
}
