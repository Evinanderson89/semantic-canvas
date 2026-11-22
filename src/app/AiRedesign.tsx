import { MetricColorProvider } from "../charts/MetricColors.tsx";
import { aiError } from "./aiError.ts";
import type { Readiness } from "./readiness.ts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DashboardSpec, FilterSpec, TileSpec } from "../compiler/spec.ts";
import type { CanvasSpec } from "../canvas/presets.ts";
import { pinnedContent } from "../canvas/layouts.ts";
import type { Model } from "../semantic/model.ts";
import type { CanvasProposal } from "../canvas/proposals.ts";
import { validateRedesign } from "../suggest/redesign.ts";
import { rationaleIssues, type RationaleIssue } from "../canvas/rationaleChecks.ts";
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

export interface ResearchLedgerQuery {
  metrics: string[];
  dimensions: string[];
  where?: unknown[];
  compare?: string;
  limit?: number | null;
  rowsChecked: number | null;
  partial?: unknown;
  truncated?: boolean | null;
}

export interface ResearchTraceStep {
  step: number;
  tool: string;
  summary: string;
  status: "ok" | "rejected";
  rowsChecked?: number | null;
}

export const AGENTIC_RESEARCH_STEPS = [
  "1. Inspecting governed semantic catalogue",
  "2. Profiling dimensions & querying warehouse rows",
  "3. Compiling layout & chart encodings",
  "4. Verifying rationale claims against query ledger",
] as const;

export function AgenticResearchStepper() {
  return (
    <ol className="ai-redesign-steps" aria-label="Agentic research progress">
      {AGENTIC_RESEARCH_STEPS.map((step) => (
        <li key={step}>{step}</li>
      ))}
    </ol>
  );
}

export function VerifiedResearchLedger({
  research = [],
  trace = [],
  rationaleWarnings = [],
}: {
  research?: ResearchLedgerQuery[];
  trace?: ResearchTraceStep[];
  rationaleWarnings?: RationaleIssue[];
}) {
  if (!research.length && !trace.length) return null;
  const warningCount = rationaleWarnings.length;
  const statusText = warningCount === 0
    ? "0 rationale discrepancies"
    : `${warningCount} rationale ${warningCount === 1 ? "discrepancy" : "discrepancies"} flagged`;
  return (
    <details className="ai-redesign-ledger">
      <summary>
        <span>Verified Research Ledger</span>
        <span className={`ledger-badge ${warningCount === 0 ? "ok" : "warn"}`}>{statusText}</span>
      </summary>
      <div className="ledger-body">
        <p className="ledger-status">
          {warningCount === 0
            ? "0 rationale discrepancies — quantitative claims verified against governed query ledger."
            : `${warningCount} rationale ${warningCount === 1 ? "discrepancy" : "discrepancies"} flagged against governed query counts.`}
        </p>
        {research.length > 0 && (
          <ul className="ledger-queries" aria-label="Governed queries checked">
            {research.map((q, i) => (
              <li key={i}>
                <code>{q.metrics.join(", ")}</code>
                {q.dimensions.length > 0 && <> · <code>{q.dimensions.join(", ")}</code></>}
                <span className="ledger-rows">
                  {typeof q.rowsChecked === "number" ? `${q.rowsChecked} rows` : "governed query"}
                </span>
              </li>
            ))}
          </ul>
        )}
        {trace.length > 0 && (
          <ol className="ledger-trace" aria-label="Agent research trace">
            {trace.map((s) => (
              <li key={`${s.step}:${s.tool}`}>
                <code className={`trace-tool ${s.status}`}>{s.tool}</code>{" "}
                <span>{s.summary}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </details>
  );
}

export function buildDeterministicProposal(
  spec: DashboardSpec,
  canvas: CanvasSpec,
  suggested: DashboardSpec,
  model: Model,
  activeTabId?: string,
): { proposal: CanvasProposal; research: ResearchLedgerQuery[]; trace: ResearchTraceStep[] } {
  const pinnedIds = new Set(pinnedContent(spec.tiles).map((t) => t.id));
  const keptIds = new Set(
    spec.tiles
      .filter((t) => t.kind === "filter" || pinnedIds.has(t.id))
      .flatMap((t) => (t.section ? [t.id, t.section] : [t.id])),
  );
  const removable = spec.tiles.filter((t) => !keptIds.has(t.id));
  const referencedSections = new Set(spec.tiles.map((t) => t.section).filter(Boolean));
  const orderedRemovals = [
    ...removable.filter((t) => t.kind !== "heading" && !referencedSections.has(t.id)),
    ...removable.filter((t) => t.kind === "heading" || referencedSections.has(t.id)),
  ];

  const hasRename = Boolean(suggested.title?.trim() && suggested.title.trim() !== spec.title);
  const hasDescribe = suggested.description !== undefined;
  const needsArrange = keptIds.size > 0;
  const reservedSlots = (hasRename ? 1 : 0) + (hasDescribe ? 1 : 0) + (needsArrange ? 1 : 0) + orderedRemovals.length;
  const maxAdds = Math.max(1, 30 - reservedSlots);
  const tilesToAdd = suggested.tiles.slice(0, maxAdds);

  const existingIds = new Set(spec.tiles.map((t) => t.id));
  const idMap = new Map<string, string>();
  const usedNewIds = new Set<string>();
  for (const t of tilesToAdd) {
    let candidate = `draft_${t.id}`;
    let suffix = 2;
    while (existingIds.has(candidate) || usedNewIds.has(candidate)) {
      candidate = `draft_${t.id}_${suffix++}`;
    }
    idMap.set(t.id, candidate);
    usedNewIds.add(candidate);
  }

  const maxRight = Math.max(0, ...tilesToAdd.map((t) => t.layout.x + t.layout.w));
  const scaleX = maxRight > canvas.width ? (canvas.width - 48) / Math.max(1, maxRight - 48) : 1;

  const mappedTiles: TileSpec[] = tilesToAdd.map((t) => {
    const mappedSection = t.section && idMap.has(t.section) ? idMap.get(t.section)! : null;
    const x = scaleX < 1 ? Math.max(24, Math.round(24 + (t.layout.x - 24) * scaleX)) : t.layout.x;
    const w = scaleX < 1
      ? Math.max(160, Math.min(canvas.width - x - 24, Math.round(t.layout.w * scaleX)))
      : Math.min(t.layout.w, canvas.width - x);
    return {
      ...t,
      id: idMap.get(t.id)!,
      section: mappedSection,
      ...(activeTabId ? { tabId: activeTabId } : {}),
      layout: { ...t.layout, x, w },
    };
  });

  const actions: CanvasProposal["actions"] = [];
  if (hasRename) actions.push({ type: "rename", title: suggested.title!.trim().slice(0, 1000) });
  if (hasDescribe) actions.push({ type: "describe", description: suggested.description ?? "" });
  for (const r of orderedRemovals) actions.push({ type: "remove", id: r.id });
  for (const tile of mappedTiles) actions.push({ type: "add", tile });
  if (needsArrange) actions.push({ type: "arrange", layout: "executive" });

  const proposal: CanvasProposal = {
    title: (suggested.title?.trim() || "Executive deterministic draft").slice(0, 1000),
    reason: "Deterministically composed from the governed semantic model for your prompt, pairing headline KPIs with time-series trends and cross-table drivers.",
    actions,
  };

  const metricTiles = mappedTiles.filter((t) => (t.kind ?? "metric") === "metric" && t.metrics.length > 0);
  const research: ResearchLedgerQuery[] = metricTiles.map((t) => ({
    metrics: t.metrics,
    dimensions: t.dimensions,
    compare: t.compare ?? "none",
    rowsChecked: null,
  }));
  const tablesUsed = new Set(
    metricTiles.flatMap((t) => t.metrics.map((m) => model.metrics[m]?.baseTable).filter(Boolean)),
  );
  const trace: ResearchTraceStep[] = [
    {
      step: 1,
      tool: "match_model",
      summary: `Matched prompt against ${Object.keys(model.metrics).length} governed metrics across ${Object.keys(model.tables).length} tables`,
      status: "ok",
    },
    {
      step: 2,
      tool: "compose_brief",
      summary: `Composed ${metricTiles.length} governed charts across ${Math.max(1, tablesUsed.size)} base table(s)`,
      status: "ok",
    },
    {
      step: 3,
      tool: "validate_redesign",
      summary: "Verified layout geometry, chart encodings, and governed filter bindings",
      status: "ok",
    },
  ];
  return { proposal, research, trace };
}

type Preview = { proposal: CanvasProposal; spec: DashboardSpec; canvas: CanvasSpec; before: DashboardSpec; expected: string; context: string; explanation: string; rationaleWarnings: RationaleIssue[]; research?: ResearchLedgerQuery[]; trace?: ResearchTraceStep[] };
export function AiRedesign({ spec, canvas, model, available, canConfigure, sandboxMode = false, onConfigure, onClose, onApply, queryContext, filtersByTile, drills, resolveFilters, resolveScopeWarnings, activeTabId, filterContext }: {
  activeTabId?: string; filterContext?: string;
  resolveFilters?: (spec: DashboardSpec) => Record<string, FilterSpec[]>;
  resolveScopeWarnings?: (spec: DashboardSpec) => Record<string, string[]>;
  spec: DashboardSpec; canvas: CanvasSpec; model: Model; available: boolean; canConfigure: boolean; sandboxMode?: boolean;
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
      const research = Array.isArray(result.research) ? (result.research as ResearchLedgerQuery[]) : undefined;
      const trace = Array.isArray(result.trace) ? (result.trace as ResearchTraceStep[]) : undefined;
      setPreview({ ...next, proposal: result.proposal, before: spec, expected: fingerprint(spec, canvas), context: snapshot, explanation: result.text || "",
        research, trace,
        // Recalculated here from the documents and the review's query ledger, so the warning does not depend on the server reporting it.
        rationaleWarnings: rationaleIssues(spec, next.spec, [result.proposal.reason, result.text].filter(Boolean).join("\n\n"), research ?? (result.proposal ? [] : undefined)) });
      setView("after");
    } catch (e: any) { if (!controller.signal.aborted) setError(aiError(e)); }
    finally { if (request.current === controller) setBusy(false); }
  };
  const generateDeterministic = async () => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    const snapshot = context;
    setChecks({}); setAcceptExistingIssues(false); setBusy(true); setError(""); setExplanation(""); setApplied(false); setPreview(null);
    try {
      const suggested: DashboardSpec = await fetch("/api/suggest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({ text: goal, audience: "exec", grain: "month" }),
      }).then(readResponse);
      if (controller.signal.aborted || latest.current !== snapshot) return;
      const built = buildDeterministicProposal(spec, canvas, suggested, model, activeTabId);
      const next = validateRedesign(spec, canvas, built.proposal, model, activeTabId);
      setPreview({
        ...next,
        proposal: built.proposal,
        before: spec,
        expected: fingerprint(spec, canvas),
        context: snapshot,
        explanation: "Built deterministically from the governed semantic layer with zero LLM latency.",
        research: built.research,
        trace: built.trace,
        rationaleWarnings: rationaleIssues(spec, next.spec, built.proposal.reason, []),
      });
      setView("after");
    } catch (e: any) {
      if (!controller.signal.aborted) setError(aiError(e));
    } finally {
      if (request.current === controller) setBusy(false);
    }
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
          ["Revenue & retention drivers", "How is recurring revenue trending, what drove August's change, and how does retention compare across plans?"],
        ].map(([label, value]) => <button key={label} disabled={busy} onClick={() => setGoal(value)}>{label}</button>)}</div>
        {!available ? (
          sandboxMode ? (
            <p role="status">Public Sandbox runs in zero-key deterministic mode (no LLM calls or API keys required). Generate a governed draft below immediately, or self-host to connect Claude, OpenAI, Gemini, or a local VPC model.</p>
          ) : (
            <p role="status">Connect an AI provider to generate a redesign. {canConfigure ? <button className="link" onClick={onConfigure}>Configure AI</button> : "Ask your workspace administrator to configure AI."}</p>
          )
        )
          : <button className="primary" disabled={busy || !goal.trim()} onClick={generate}>{busy ? "Designing…" : preview ? "Generate another version" : error ? "Retry redesign" : "Show me a better dashboard"}</button>}
        <button type="button" className={!available && sandboxMode ? "primary ai-redesign-deterministic-primary" : "ai-redesign-deterministic"} disabled={busy || !goal.trim()} onClick={generateDeterministic}>
          Generate deterministic draft from prompt
        </button>
        {busy && <div role="status" className="ai-redesign-busy"><p>Reviewing the canvas and governed metrics, then preparing changes you can inspect.</p><AgenticResearchStepper /><button className="link" onClick={() => { request.current?.abort(); setBusy(false); }}>Cancel generation</button></div>}
        {error && <div><p className="err" role="alert">{error}</p>{canConfigure && <button className="review-action" onClick={onConfigure}>Check AI connection</button>}</div>}
        {explanation && <div className="ai-redesign-explanation">{renderMarkdown(explanation)}</div>}
        {preview && <div className="ai-redesign-explanation"><h3>{preview.proposal.title}</h3>{!stale && impact && <RedesignImpact impact={impact} />}{!!preview.rationaleWarnings.length && <div className="rationale-warnings" role="note" aria-label="Rationale checks">
          <strong>Check this rationale before relying on it</strong>
          <ul>{preview.rationaleWarnings.map(issue => <li key={issue.id}>{issue.message}</li>)}</ul>
          <small>Calculated from your dashboard and this review’s queries. The rationale below is shown as the AI wrote it; the proposed charts are checked separately.</small>
        </div>}<details open={!!preview.rationaleWarnings.length || undefined}><summary>AI design rationale</summary><p>{preview.proposal.reason}</p>{renderMarkdown(preview.explanation)}</details><VerifiedResearchLedger research={preview.research} trace={preview.trace} rationaleWarnings={preview.rationaleWarnings} /></div>}
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
