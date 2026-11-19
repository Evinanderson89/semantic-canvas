import { tableDisplay } from "../format/tableDisplay.ts";
import { dimensionProfiles } from "./useFieldProfiles.ts";
import { prepareMap } from "../charts/geo.ts";
import { numericValue } from "../charts/values.ts";
import { chartEvidence } from "./evidenceFingerprint.ts";
import { useEvidenceDigest } from "./useEvidenceDigest.ts";
import { readResponse } from "./http.ts";
import { grainReviewKey, noiseSeriesReady, worthwhileCoarsening } from "../suggest/reviewChecks.ts";
import { readableChartTitle } from "../suggest/storyStructure.ts";
import { breakdownStatement, reviewBreakdown } from "../suggest/breakdownReview.ts";
import type { InvestigationResult } from "../suggest/investigate.ts";
import { resultIssue, type Readiness } from "./readiness.ts";
import { checkResultQuality, isScopeNote } from "../suggest/resultQuality.ts";
import { queryObservations } from "../suggest/queryObservations.ts";
import { MetricEvidence } from "./MetricEvidence.tsx";
import { DataExportActions } from "./DataExportActions.tsx";
import { aiError } from "./aiError.ts";
import { ChartActivityButtons } from "./ChartActivity.tsx";
import { visibleQuery } from "./query.ts";
import { chartResult, chartUnits, dimensionAlias as dimAlias } from "./chartResult.ts";
import { validateTile } from "../compiler/compile.ts";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { format as d3format } from "d3-format";
import { Chart, DataTable, Stat } from "../charts/Chart.tsx";
import { Kpi } from "./Kpi.tsx";
import { TileActions } from "./TileChrome.tsx";
import { FloatingPanel } from "./FloatingPanel.tsx";
import { FONT_STACKS, makeFormatter, mergeTextFormat, resolveFormat, tileFill } from "../format/format.ts";
import { pickImage } from "./imagePicker.ts";
import { resolvedChartKind, tileChartShape } from "../suggest/chartRules.ts";
import { cardComparison, withCardComparison } from "../charts/cardComparison.ts";
import { chartShapeIssue } from "../charts/capabilities.ts";
import type { TileSpec } from "../compiler/spec.ts";
import type { Model } from "../semantic/model.ts";
import { calendarOf, metricOf, semanticHints, timeColumnOf } from "../semantic/model.ts";
import { dataAsOf } from "./connected.tsx";
import type { FilterSpec } from "../compiler/spec.ts";
import { drillGrain, drillInto, type DrillEntry, type DrillGrain } from "./drill.ts";
import { downloadCsv, downloadSpreadsheet, downloadPng, slugForFilename } from "./export.ts";
import { renderMarkdown } from "./markdown.tsx";
import { betterKind, coarserGrain, detectNoisy, noiseScores, recommend,
         type DegenerateFinding, type FieldProfile, type VizOption } from "../suggest/recommend.ts";
import { useSession } from "./Session.tsx";
import { issuesText } from "../compiler/issueText.ts";

/** A KPI card's natural height -- matches the headline tiles Exec Summary
 *  already packs at this height (layouts.ts: layoutExecSummary). A chart
 *  needs enough room for axis labels and a legend to not read as cramped. */
const KPI_HEIGHT = 156;
const CHART_MIN_HEIGHT = 300;


/** The gateway rules a query reported applying (ids `gateway:<field>:<mode>`), said in words from the session's own policy. */
export function scopedBy(applied: string[] | undefined, policy: { field: string; mode: "only" | "not"; values: string[] }[] | undefined): { short: string; full: string } | null {
  const rules = (applied ?? []).filter((id) => id.startsWith("gateway:")).map((id) => { const [, field, mode] = id.split(":"); return policy?.find((r) => r.field === field && r.mode === mode) ?? { field, mode: mode as "only" | "not", values: [] }; });
  if (!rules.length) return null;
  const word = (m: string) => (m === "only" ? "only" : "not");
  return {
    short: rules.map((r) => `${r.field.split(".").pop()} ${word(r.mode)} ${r.values.slice(0, 3).join(", ")}${r.values.length > 3 ? "…" : ""}`.trim()).join("; "),
    full: rules.map((r) => `${r.field} ${word(r.mode)} ${r.values.join(", ")}`).join("\n"),
  };
}

function EvidenceWarning({ message, label, onInspect, title }: { message: string; label: string; onInspect: () => void; title?: string }) {
  return <div className="result-warning" role="status" title={title}>{message} <button className="warning-evidence-action" data-export-ignore
    onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onInspect(); }}>{label}</button></div>;
}

function TileInner({ model, spec, onRemove, onUpdate, locked, crossFilters, onCrossFilter,
                     drill, onDrill, onDrillUp, aiAvailable, queryContext, onReadiness, scopeWarnings, onInvestigate, presentation = false }: {
  presentation?: boolean;
  onInvestigate?: (result: InvestigationResult) => void;
  onReadiness?: (id: string, state: Readiness) => void;
  scopeWarnings?: string[];
  queryContext?: string;
  model: Model; spec: TileSpec; onRemove: (id: string) => void;
  onUpdate?: (t: TileSpec) => void; locked?: boolean;
  crossFilters?: FilterSpec[];
  onCrossFilter?: (f: FilterSpec) => void;
  /** Per-tile drill stack -- ephemeral view state, not part of the saved
   *  spec, the same way `selected`/`zoom` aren't. Drilling one tile's chart
   *  into a month never changes what another tile, or a save, sees. */
  drill?: DrillEntry[];
  onDrill?: (entry: DrillEntry) => void;
  /** Truncate the stack to length `toIndex` (0 clears it entirely). */
  onDrillUp?: (toIndex: number) => void;
  /** Whether the embedded agent is configured -- hides the Explain button
   *  the same way AgentChat's own toggle hides, rather than showing a
   *  button that always 503s. */
  aiAvailable?: boolean;
}) {
  const [state, setState] = useState<any>({ status: "loading" });
  const session = useSession();
  const [explain, setExplain] = useState<{ status: "loading" | "ok" | "error"; text: string } | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const explainRequest = useRef<AbortController | null>(null);
  const closeExplain = () => { explainRequest.current?.abort(); setExplain(null); };
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [spreadsheetBusy, setSpreadsheetBusy] = useState(false);
  const [exportError, setExportError] = useState("");
  const exportRequest = useRef<AbortController | null>(null);
  const reviewedGrains = useRef(new Set<string>());
  const explorationFocus = useRef(false);
  const [beautifyOpen, setBeautifyOpen] = useState(false);
  const [ruleSuggestion, setRuleSuggestion] = useState<VizOption | null | "checking">(null);
  const [ruleError, setRuleError] = useState("");
  const [noiseSuggestion, setNoiseSuggestion] = useState<{ measure: string; grain: string; next: string } | null>(null);
  const [breakdownScopeNote, setBreakdownScopeNote] = useState<string | undefined>();
  const reviewRequest = useRef<AbortController | null>(null);
  const tipsRequest = useRef<AbortController | null>(null);
  const closeReview = () => { reviewRequest.current?.abort(); tipsRequest.current?.abort(); setBeautifyOpen(false); setAgentTips(null); };
  const [degenerateSuggestion, setDegenerateSuggestion] =
    useState<(DegenerateFinding & { timeDimension: string | null }) | null>(null);
  const [agentTips, setAgentTips] = useState<{ status: "loading" | "ok" | "error"; text: string } | null>(null);
  const tileRef = useRef<HTMLDivElement>(null);
  const kindOf = spec.kind ?? "metric";
  const readiness = useRef(onReadiness); readiness.current = onReadiness;
  const [rendered, setRendered] = useState<{ key: string; error: string | null } | null>(null);

  // One key covering everything the query depends on. `where` and `limit` were
  // missing before, so changing a filter left the tile showing the previous
  // result with no sign it was stale.
  const base = metricOf(model, spec.metrics[0])?.baseTable ?? null;
  // A connected table is a snapshot; every tile on it says how old (docs/connected-canvas.md).
  const connected = base ? model.tables[base]?.connected : undefined;
  const activeDrill = drill?.at(-1) ?? null;
  const timeDimIndex = spec.dimensions.findIndex(d => d.includes(":"));
  const query = visibleQuery(model, spec, crossFilters, drill);
  const { dimensions, where } = query;
  const grain = timeDimIndex !== -1 ? dimensions[timeDimIndex].split(":")[0] : null;
  // The finer grain a click on a time bucket opens -- null when the metric or
  // its period column allows nothing finer (Ending MRR is month-only), so the
  // bucket is not offered as a drill instead of drilling into a rejected query.
  const drillNext = useMemo(() => onDrill && timeDimIndex !== -1 ? drillGrain(model, { ...spec, dimensions }) : null,
    [!!onDrill, timeDimIndex, model, spec, JSON.stringify(dimensions)]);

  const queryKey = JSON.stringify({
    m: spec.metrics, d: dimensions, w: where, l: spec.limit,
    c: query.compare, queryContext,
  });
  const reviewContext = useRef({ key: queryKey, chart: spec.chart, model });
  reviewContext.current = { key: queryKey, chart: spec.chart, model };
  useEffect(() => {
    reviewRequest.current?.abort();
    tipsRequest.current?.abort(); setAgentTips(null);
    explainRequest.current?.abort(); setExplain(null);
    exportRequest.current?.abort(); setSpreadsheetBusy(false); setExportError("");
    setBeautifyOpen(false); setRuleSuggestion(null); setRuleError(""); setNoiseSuggestion(null); setDegenerateSuggestion(null); setBreakdownScopeNote(undefined);
    return () => { reviewRequest.current?.abort(); tipsRequest.current?.abort(); explainRequest.current?.abort(); exportRequest.current?.abort(); };
  }, [queryKey, spec.chart, model]);

  useEffect(() => {
    if (kindOf !== "metric") return;
    const ac = new AbortController();
    setState({ status: "loading" });
    // Send the QUERY, not the tile. Layout, format and spark are presentation;
    // including them meant moving a tile changed the body of a data request,
    // which makes caching and de-duping impossible.
    fetch("/api/query", {
      method: "POST", headers: { "content-type": "application/json", "x-sc-refresh": queryContext ?? "" },
      body: JSON.stringify(query), signal: ac.signal,
    })
      .then(async (r) => ({ ok: r.ok, body: await r.json() }))
      .then(({ ok, body }) => {
        if (ac.signal.aborted) return;
        setState(ok ? { status: "ok", ...body, key: queryKey, receivedAt: new Date().toISOString() }
          : { status: "error", key: queryKey, message: body.issues
              ? issuesText(body.issues) : body.error });
      })
      .catch((e) => {
        // An aborted request is a superseded one, not a failure to report.
        if (e?.name !== "AbortError") setState({ status: "error", key: queryKey, message: String(e) });
      });
    return () => ac.abort();
  }, [queryKey, kindOf]);

  const dataFindings = useMemo(() => {
    if (state.key !== queryKey || state.status !== "ok") return [];
    const columns: string[] = state.columns ?? [], rows: unknown[][] = state.rows ?? [];
    const findings = checkResultQuality(spec.metrics, dimensions, { ...state, columns, rows });
    if (resolvedChartKind(model, { ...spec, dimensions }) === "map" && dimensions.length === 1 && spec.metrics.length === 1) {
      const place = columns.indexOf(dimAlias(dimensions[0])), value = columns.indexOf(spec.metrics[0]);
      findings.push(...prepareMap(rows.map(row => ({ place: row[place], value: row[value] }))).findings);
    }
    return findings;
  }, [state, queryKey, spec.chart, model]);
  const reviewFindingCount = dataFindings.filter(f => !isScopeNote(f)).length;
  const evidenceSummary = useMemo(() => onReadiness && state.key === queryKey && state.status === "ok"
    ? queryObservations(model, { ...spec, ...query }, { columns: state.columns ?? [], rows: state.rows ?? [], truncated: state.truncated, partial: state.partial })
    : undefined, [onReadiness, model, state, queryKey, spec.compareShow, spec.spark?.compare]);
  const evidenceDigest = useEvidenceDigest(onReadiness && state.key === queryKey && state.status === "ok" ? chartEvidence(query, state) : undefined);
  const renderKey = JSON.stringify([queryKey, spec.chart, spec.format, spec.compareShow, state.columns, state.rows]);
  useEffect(() => {
    if (kindOf !== "metric") return;
    let result: Readiness = { status: "checking" };
    if (state.key === queryKey && state.status === "error") result = { status: "error", message: state.message };
    if (state.key === queryKey && state.status === "ok") {
      const kind = resolvedChartKind(model, { ...spec, dimensions });
      let issue = resultIssue(spec.metrics, state.columns ?? [], state.rows ?? [])
        ?? chartShapeIssue(kind, tileChartShape(model, { ...spec, dimensions })) ?? chartUnits({ ...spec, chart: kind }, model).issue;
      if (!issue && !["kpi", "stat", "table"].includes(kind)) {
        try { const plotted = chartResult(spec, state, dimensions, model); issue = resultIssue(spec.metrics, plotted.columns, plotted.rows); }
        catch (e: any) { issue = e.message; }
      }
      result = issue ? { status: "error", message: issue }
        : ["kpi", "stat", "table"].includes(kind) ? { status: "ready" }
        : rendered?.key === renderKey ? rendered.error ? { status: "error", message: rendered.error } : { status: "ready" }
        : { status: "checking" };
    }
    if (state.key === queryKey && state.status === "ok") { result.dataFindings = dataFindings; result.window = state.window; result.rowRules = state.rlsApplied; result.observations = evidenceSummary?.observations; result.observationNote = evidenceSummary?.note; }
    result.evidenceFingerprint = evidenceDigest.digest;
    result.evidencePending = evidenceDigest.pending;
    readiness.current?.(spec.id, result);
  }, [state, queryKey, kindOf, renderKey, rendered, spec.id, dataFindings, evidenceSummary, evidenceDigest.digest, evidenceDigest.pending]);

  // Non-data tiles: no query, no chart inference, editable in place.
  if (kindOf !== "metric") {
    const commit = (text: string) => onUpdate?.({ ...spec, text });
    // format.background/border were read here before but never applied --
    // every bare tile silently ignored its own "Tile" section in the
    // inspector. backgroundColor/backgroundOpacity let background be an
    // actual color, not just on/off.
    const tf = mergeTextFormat(spec.format);
    const chromeStyle = {
      background: tileFill(tf),
      borderColor: tf.border ? undefined : "transparent",
    };

    if (kindOf === "divider")
      return (
        <div className={"tile bare" + (locked ? "" : " editable")} style={chromeStyle}>
          <hr className="rule" />
        </div>
      );

    if (kindOf === "image") {
      const choose = () => pickImage((data) => onUpdate?.({ ...spec, imageData: data }));
      return (
        <div className={"tile bare image" + (locked ? "" : " editable")} style={chromeStyle}>
          {spec.imageData ? (
            // draggable=false matters: an <img> is natively draggable, so
            // grabbing the tile to move it (pointerdown lands on the image)
            // triggered the browser's own HTML5 drag ghost -- a full-size
            // copy of the image following the cursor, fighting the canvas's
            // own drag-to-reposition -- instead of moving the tile.
            <img src={spec.imageData} alt="" draggable={false}
                 style={{ objectFit: tf.imageFit }}
                 onDoubleClick={() => !locked && choose()} />
          ) : !locked ? (
            <button className="img-empty" onClick={choose}>Click to choose an image</button>
          ) : <div className="img-empty" />}
          {!locked && <TileActions onRemove={() => onRemove(spec.id)} />}
        </div>
      );
    }

    return (
      <div className={"tile bare " + kindOf + (locked ? "" : " editable")} style={chromeStyle}>
        <div className={kindOf === "heading" ? "heading-text" : "note-text"}
             style={{ textAlign: tf.textAlign, fontSize: tf.textSize,
                      fontFamily: FONT_STACKS[tf.fontFamily],
                      fontStyle: tf.textItalic ? "italic" : undefined,
                      textDecoration: tf.textUnderline ? "underline" : undefined }}
             contentEditable={!locked} suppressContentEditableWarning
             data-placeholder={kindOf === "heading" ? "Heading" : "Note"}
             onBlur={(e) => commit(e.currentTarget.textContent ?? "")}>
          {spec.text ?? (kindOf === "heading" ? spec.title : undefined)}
        </div>
        {!locked && <TileActions onRemove={() => onRemove(spec.id)} />}
      </div>
    );
  }

  const shape = tileChartShape(model, { ...spec, dimensions });
  const kpiTimeDimIndex = shape.dimensions.findIndex(d => d.temporal);
  const kind = resolvedChartKind(model, { ...spec, dimensions });
  const fmt = resolveFormat(model, spec);
  const showingPercentChange = spec.compare && spec.compare !== "none" && spec.compareShow === "percent";
  const chartFmt = showingPercentChange ? { ...fmt, number: "percent" as const } : fmt;
  // Combo and dual-axis line charts can contain metrics with different units.
  // A combo tile's bar and line are two DIFFERENT metrics by fixed position
  // (see Chart.tsx), and each can need its own number style -- spend as
  // currency, click-through rate as a percent. `fmt` above already answers
  // "what style for the first metric"; this is the same question asked of
  // the second one, only computed here (not in Chart.tsx, which has no
  // model to infer a style from) and handed down for the secondary axis.
  const secondaryFmt = (kind === "combo" || kind === "line") && spec.metrics.length > 1
    ? resolveFormat(model, { ...spec, metrics: [spec.metrics[1]] }) : undefined;
  const currentResult = state.key === queryKey;
  let plotted: ReturnType<typeof chartResult> | undefined;
  const units = chartUnits({ ...spec, chart: kind }, model);
  let plotIssue: string | undefined = chartShapeIssue(kind, shape) ?? units.issue;
  if (currentResult && state.status === "ok" && !["kpi", "stat", "table"].includes(kind)) {
    try { plotted = chartResult(spec, state, dimensions, model); }
    catch (e: any) { plotIssue = e.message; }
  }
  const title = spec.title ?? spec.metrics.map((m) => metricOf(model, m)?.label ?? m).join(", ");

  const investigate = onInvestigate && state.status === "ok" && state.key === queryKey ? () => onInvestigate({ columns: state.columns, rows: state.rows }) : undefined;

  const runExplain = () => {
    explainRequest.current?.abort();
    const ac = new AbortController(); explainRequest.current = ac;
    setExplain({ status: "loading", text: "" });
    fetch("/api/agent/explain", {
      method: "POST", signal: ac.signal, headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title, metrics: spec.metrics, dimensions, where, compare: query.compare,
        columns: state.columns, rows: state.rows,
        scopeNotes: dataFindings.map(f => `${f.title}: ${f.evidence}`),
      }),
    }).then(readResponse).then((d) => {
      if (ac.signal.aborted) return;
      setExplain(d.error ? { status: "error", text: aiError(d.error) } : { status: "ok", text: d.text || "(no explanation)" });
    }).catch((e) => { if (!ac.signal.aborted) setExplain({ status: "error", text: aiError(e) }); });
  };

  const exportCsv = () => {
    if (state.status !== "ok" || state.key !== queryKey) return;
    downloadCsv(`${slugForFilename(title)}${state.truncated ? "-limited-window" : ""}.csv`, state.columns, state.rows);
    setExportOpen(false);
  };
  const exportSpreadsheet = async () => {
    if (state.status !== "ok" || state.key !== queryKey || spreadsheetBusy) return;
    exportRequest.current?.abort();
    const controller = new AbortController(); exportRequest.current = controller;
    setSpreadsheetBusy(true); setExportError("");
    try {
      await downloadSpreadsheet(`${slugForFilename(title)}${state.truncated ? "-limited-window" : ""}.xlsx`, state.columns, state.rows, [
        ["Chart", title], ["Semantic model", model.name], ["Adapter", model.source],
        ["Connection", state.source?.label ?? "Not reported by this query"],
        ["Connection ID", state.source?.id ?? "Not reported by this query"],
        ["Query principal", state.principal ?? "None reported by this query"],
        ["Exported at (UTC)", new Date().toISOString()], ["Response received at (UTC)", state.receivedAt],
        ["Cached response", !!state.cached], ["Query", JSON.stringify(query)],
        ["Returned rows", state.rows.length], ["Query limit", state.limit ?? query.limit ?? "Not reported"],
        ["Truncated", !!state.truncated], ["Returned window", state.window ? JSON.stringify(state.window) : "Not reported"],
        ["Reporting calendar", JSON.stringify(calendarOf(model))],
        ["Row rules applied", state.rlsApplied?.join(", ") || "None reported by this query"],
        ["Policy", scopedBy(state.rlsApplied, session?.policy)?.full ?? "Not reported"],
        ["Source snapshot", connected ? dataAsOf(connected) : "No snapshot timestamp reported"],
        ["Scope warnings", scopeWarnings?.length ? `Not filtered by ${scopeWarnings.join(", ")}` : "None reported"],
        ["Query warnings", (state.warnings ?? []).join("\n") || "None reported"],
        ["Returned-row checks", dataFindings.length ? JSON.stringify(dataFindings) : "No issues found by returned-row checks; not a source-data certification."],
      ], controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) setExportError(error instanceof Error ? error.message : "The spreadsheet could not be created. Try again or download raw CSV.");
    } finally { if (!controller.signal.aborted) setSpreadsheetBusy(false); }
  };
  const exportPng = async () => {
    // Close the popover FIRST -- flushSync forces React to actually commit
    // that to the DOM before the snapshot below, rather than an ordinary
    // setState here (which React is free to not have flushed yet by the
    // time an async function's next line runs) leaving the popover captured
    // sitting on top of the chart it's exporting.
    flushSync(() => setExportOpen(false));
    try {
      if (tileRef.current) await downloadPng(`${slugForFilename(title)}.png`, tileRef.current);
    } catch (e: any) {
      console.error("tile PNG export failed:", e); // rare; not worth reopening the popover to show it
    }
  };

  // The rules half of Beautify: reuses recommend() (chart-type inference)
  // rather than any bespoke "does this look right" heuristic -- pointed
  // back at a chart that already exists instead of one still being built.
  const runBeautify = async () => {
    if (state.status !== "ok" || state.key !== queryKey) return;
    tipsRequest.current?.abort();
    reviewRequest.current?.abort(); const ac = new AbortController(); reviewRequest.current = ac;
    const current = () => !ac.signal.aborted && reviewRequest.current === ac && reviewContext.current.key === queryKey && reviewContext.current.chart === spec.chart && reviewContext.current.model === model;
    setBeautifyOpen(true);
    setAgentTips(null);
    setRuleSuggestion("checking"); setRuleError("");
    setDegenerateSuggestion(null); setBreakdownScopeNote(undefined);
    // Only propose a coarser grain when its actual result is materially clearer.
    // Keep the same filters and skip drill contexts whose visible grain differs.
    setNoiseSuggestion(null);
    if (!activeDrill && timeDimIndex !== -1 && !reviewedGrains.current.has(grainReviewKey(query, queryContext))) {
      const grain = spec.dimensions[timeDimIndex].split(":")[0], next = coarserGrain(grain);
      const noise = detectNoisy(state.rows ?? [], state.columns ?? [], spec.metrics);
      const coarser = next ? { ...query, dimensions: query.dimensions.map((d, i) => i === timeDimIndex ? `${next}:${d.split(":")[1]}` : d) } : null;
      if (next && coarser && noise.length && noiseSeriesReady(query, { ...state, rows: state.rows ?? [], columns: state.columns ?? [] }) && !validateTile(model, { ...spec, ...coarser }).length) {
        try {
          const candidate = await fetch("/api/query", { method: "POST", signal: ac.signal, headers: { "content-type": "application/json", "x-sc-refresh": queryContext ?? "" }, body: JSON.stringify(coarser) }).then(readResponse);
          if (!current()) return;
          if (noiseSeriesReady(coarser, { ...candidate, rows: candidate.rows ?? [], columns: candidate.columns ?? [] }) && worthwhileCoarsening(noise, noiseScores(candidate.rows ?? [], candidate.columns ?? [], spec.metrics), candidate.rows?.length ?? 0))
            setNoiseSuggestion({ measure: noise[0].measure, grain, next });
        } catch { /* An unverified improvement is not a recommendation. */ }
      }
    }
    // A THIRD rules check, also local: a single-dimension, single-measure
    // breakdown where only one category actually carries a value -- the
    // classic cause being a metric already filtered to one value of the
    // exact dimension it's cut by (New MRR broken down by movement_type,
    // when New MRR is already `movement_type = 'new'`). Scoped to exactly
    // this shape and a non-temporal dimension, same reasoning as the noise
    // check above: a time series legitimately having one active period
    // among empty ones is a real finding, not a pointless chart.
    if (!current()) return;
    const checked = await reviewBreakdown(spec, query, { ...state, rows: state.rows ?? [], columns: state.columns ?? [] }, own =>
      fetch("/api/query", { method: "POST", signal: ac.signal, headers: { "content-type": "application/json", "x-sc-refresh": queryContext ?? "" }, body: JSON.stringify(own) }).then(readResponse));
    if (!current()) return;
    setDegenerateSuggestion(checked.finding ? { ...checked.finding, timeDimension: timeColumnOf(model, base) } : null);
    setBreakdownScopeNote(checked.scopeNote);
    try {
      const bare = dimensions.map((d) => (d.includes(":") ? d.split(":")[1] : d));
      let profiles: FieldProfile[] = [];
      if (base && bare.length) {
        const r = await fetch(`/api/profile?base=${encodeURIComponent(base)}&fields=${encodeURIComponent(bare.join(","))}`, { signal: ac.signal }).then(readResponse);
        if (!current()) return;
        profiles = dimensionProfiles(r, dimensions);
        if (profiles.some(p => p.warning)) throw new Error([...new Set(profiles.flatMap(p => p.warning ? [p.warning] : []))].join(" "));
      }
      const options = recommend(spec.metrics, profiles, semanticHints(model, spec.metrics));
      setRuleSuggestion(betterKind(kind, options));
    } catch (e: any) {
      if (!current()) return;
      setRuleError(e instanceof Error ? e.message : "Field evidence is unavailable. Try again.");
      setRuleSuggestion(null);
    }
  };
  const applySuggestion = (opt: VizOption) => {
    onUpdate?.({ ...spec, chart: opt.kind });
    setRuleSuggestion(null);
  };
  const applyCoarsen = () => {
    if (!noiseSuggestion) return;
    const next = { ...spec, dimensions: spec.dimensions.map((d, i) =>
      i === timeDimIndex ? `${noiseSuggestion.next}:${d.split(":")[1]}` : d) };
    reviewedGrains.current.add(grainReviewKey(visibleQuery(model, next, crossFilters, drill), queryContext));
    onUpdate?.({ ...next, title: readableChartTitle(model, spec, next) });
    setNoiseSuggestion(null);
  };
  const applyRemoveBreakdown = () => {
    if (!degenerateSuggestion) return;
    // The tile's height was sized for whatever chart it was before --
    // collapsing to a bare KPI without also shrinking it left a huge dead
    // gap below a single line of text. Only ever caps down, never grows a
    // tile that was already this short or shorter.
    onUpdate?.({ ...spec, dimensions: [], chart: undefined,
      title: readableChartTitle(model, spec, { ...spec, dimensions: [], chart: undefined }),
      layout: { ...spec.layout, h: Math.min(spec.layout.h, KPI_HEIGHT) } });
    setDegenerateSuggestion(null);
  };
  const applyShowOverTime = () => {
    if (!degenerateSuggestion?.timeDimension) return;
    // The reverse case: a tile that's currently KPI-height doesn't have
    // room for a real chart's axis labels once it becomes one.
    onUpdate?.({ ...spec, dimensions: [`month:${degenerateSuggestion.timeDimension}`], chart: undefined,
      title: readableChartTitle(model, spec, { ...spec, dimensions: [`month:${degenerateSuggestion.timeDimension}`], chart: undefined }),
      layout: { ...spec.layout, h: Math.max(spec.layout.h, CHART_MIN_HEIGHT) } });
    setDegenerateSuggestion(null);
  };
  const runAgentTips = () => {
    if (state.status !== "ok" || state.key !== queryKey) return;
    tipsRequest.current?.abort();
    const ac = new AbortController(); tipsRequest.current = ac;
    setAgentTips({ status: "loading", text: "" });
    fetch("/api/agent/beautify", {
      method: "POST", signal: ac.signal, headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title, metrics: spec.metrics, dimensions, where, compare: query.compare,
        columns: state.columns, rows: state.rows,
        scopeNotes: dataFindings.map(f => `${f.title}: ${f.evidence}`),
      }),
    }).then(readResponse).then((d) => {
      if (ac.signal.aborted) return;
      setAgentTips(d.error ? { status: "error", text: aiError(d.error) } : { status: "ok", text: d.text || "(no suggestions)" });
    }).catch((e) => { if (!ac.signal.aborted) setAgentTips({ status: "error", text: aiError(e) }); });
  };

  return (
    <div className={"tile" + (kind === "stat" ? " tile-stat" : "")} ref={tileRef} style={{ background: tileFill(fmt),
                                   borderColor: fmt.border ? undefined : "transparent" }}>
      {spec.evidence && <div className="evidence-origin" title={`${spec.evidence.period}. Scope captured ${spec.evidence.capturedAt}. Live values; further filtering may narrow this scope.`}>Evidence from {spec.evidence.sourceTitle} · captured scope</div>}
      {!!scopeWarnings?.length && <EvidenceWarning message={`Not filtered by ${scopeWarnings.join(", ")}`} label="Inspect filter scope" onInspect={() => setEvidenceOpen(true)} />}
      {kind !== "kpi" && kind !== "table" && spec.compare && spec.compare !== "none" && spec.compareShow && spec.compareShow !== "value" && <div className="result-warning">{showingPercentChange ? "Percentage change" : "Change"} vs. {spec.compare === "yoy" ? "same period last year" : "prior period"}</div>}
      {kind !== "kpi" && (
        <header>
          {editingTitle && !locked && onUpdate ? (
            <input
              className="tile-title-input"
              aria-label="Edit tile title"
              autoFocus
              value={titleDraft}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={() => {
                const trimmed = titleDraft.trim();
                setEditingTitle(false);
                if (trimmed && trimmed !== title) onUpdate({ ...spec, title: trimmed });
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  const trimmed = titleDraft.trim();
                  setEditingTitle(false);
                  if (trimmed && trimmed !== title) onUpdate({ ...spec, title: trimmed });
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setEditingTitle(false);
                }
              }}
            />
          ) : (
            <h4
              className={!locked && onUpdate ? "is-editable" : undefined}
              title={!locked && onUpdate ? `${title} · Double-click to rename` : title}
              onMouseDown={!locked && onUpdate ? (e) => { if (e.detail >= 2) e.preventDefault(); } : undefined}
              onDoubleClick={!locked && onUpdate ? (e) => { e.stopPropagation(); setTitleDraft(title); setEditingTitle(true); } : undefined}
            >
              {title}
            </h4>
          )}
          <div className="tile-header-actions">
          {state.status === "ok" && <button className="chart-note-button" aria-label="Chart notes and query details" title={[
            `Query ran in ${state.ms}ms`,
            connected ? `${dataAsOf(connected)} · ${connected.provenance.source}` : null,
            state.coverage === "unknown" ? "Period completeness is not declared by the source." : null,
            scopedBy(state.rlsApplied, session?.policy)?.full,
            state.partial?.start || state.partial?.end ? `Partial ${state.partial.start && state.partial.end ? "first and last" : state.partial.start ? "first" : "last"} ${grain ?? "period"} left out.` : null,
          ].filter(Boolean).join("\n")} onPointerDown={e => e.stopPropagation()} onClick={() => setEvidenceOpen(true)}>ⓘ</button>}
          {investigate && <button className={"investigate-trigger" + (kind === "stat" ? " compact" : "")} aria-label="Investigate this" title="Investigate this" onPointerDown={e => e.stopPropagation()} onClick={investigate}>{kind === "stat" ? <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5" /><path d="m12 12 4.5 4.5" /></svg> : "Investigate this"}</button>}
          <ChartActivityButtons tileId={spec.id} />
          <TileActions onInspect={() => setEvidenceOpen(true)} sql={!locked ? state.sql : undefined}
                       onRemove={!locked ? () => onRemove(spec.id) : undefined}
                       onExplain={aiAvailable && state.status === "ok" ? runExplain : undefined}
                       onBeautify={!locked && state.status === "ok" ? runBeautify : undefined}
                       onExport={state.status === "ok" ? () => setExportOpen((v) => !v) : undefined} />
          </div>
        </header>
      )}
      {kind === "kpi" && timeDimIndex < 0 && <div className="kpi-activity"><ChartActivityButtons tileId={spec.id} /></div>}
      {kind === "kpi" && connected && <span className="ms mono data-as-of kpi-as-of" title={`${connected.provenance.source}, loaded by ${connected.provenance.loadedBy}`}>{dataAsOf(connected)}</span>}
      {currentResult && state.status === "ok" && state.truncated && <EvidenceWarning message={`${state.window ? "Latest window" : "Limited results"} · ${state.limit} rows · export is limited`} title={state.warnings?.join(" ")} label="Inspect result limit" onInspect={() => setEvidenceOpen(true)} />}
      {currentResult && state.status === "ok" && (state.partial?.selected?.start || state.partial?.selected?.end) && <EvidenceWarning message="Selected window includes partial observed periods · comparisons involving those periods are unavailable" label="Inspect selected period" onInspect={() => setEvidenceOpen(true)} />}
      {currentResult && state.status === "ok" && !!state.partial?.ratio?.length && <EvidenceWarning message="Ratio input periods need review · inspect both input windows before interpreting" label="Inspect input periods" onInspect={() => setEvidenceOpen(true)} />}
      {!presentation && reviewFindingCount > 0 && !(kind === "kpi" && kpiTimeDimIndex >= 0) && <div className="data-check-notice"><button onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); setEvidenceOpen(true); }}>{reviewFindingCount} data check{reviewFindingCount === 1 ? "" : "s"} to review</button></div>}
      {evidenceOpen && <MetricEvidence title={title} metrics={spec.metrics} dimensions={dimensions} where={where} model={model}
        findings={dataFindings} state={state.key === queryKey ? state : { status: "loading" }} scopeWarnings={scopeWarnings}
        policy={scopedBy(state.rlsApplied, session?.policy)?.full} provenance={connected ? dataAsOf(connected) : undefined}
        onExportCsv={currentResult && state.status === "ok" ? exportCsv : undefined}
        onExportSpreadsheet={currentResult && state.status === "ok" ? exportSpreadsheet : undefined}
        exporting={spreadsheetBusy} exportError={exportError}
        sql={!locked && state.key === queryKey && state.status === "ok" ? state.sql : undefined} onClose={() => setEvidenceOpen(false)} />}
      {beautifyOpen && (
        <FloatingPanel anchor={tileRef} anchorTop className="explain-pop beautify-pop" role="dialog" aria-label="Chart design review" focusOnOpen onDismiss={closeReview}>
          <div className="explain-head">
            <span>Design review</span>
            <button className="icon" onClick={closeReview} aria-label="Close">✕</button>
          </div>
          <div className="beautify-body">
            {ruleSuggestion === "checking" && <p className="explain-body loading">Checking the chart type…</p>}
            {ruleSuggestion && ruleSuggestion !== "checking" && (
              <div className="beautify-suggestion">
                <p className="explain-body">
                  Might read better as <b>{ruleSuggestion.label}</b> — {ruleSuggestion.why}
                </p>
                <button className="primary small" onClick={() => applySuggestion(ruleSuggestion)}>
                  Switch to {ruleSuggestion.label}
                </button>
              </div>
            )}
            {ruleSuggestion !== "checking" && noiseSuggestion && (
              <div className="beautify-suggestion">
                <p className="explain-body">
                  <b>{metricOf(model, noiseSuggestion.measure)?.label ?? noiseSuggestion.measure}</b> swings
                  noisily at the {noiseSuggestion.grain} grain — hard to read as a trend. Try {noiseSuggestion.next} instead.
                </p>
                <button className="primary small" onClick={applyCoarsen}>
                  Switch to {noiseSuggestion.next}
                </button>
              </div>
            )}
            {ruleSuggestion !== "checking" && degenerateSuggestion && (
              <div className="beautify-suggestion">
                <p className="explain-body">
                  {breakdownStatement(degenerateSuggestion)}
                  {degenerateSuggestion.timeDimension && " Try it as a trend over time instead."}
                </p>
                <div className="story-actions">
                  {degenerateSuggestion.timeDimension &&
                    <button className="primary small" onClick={applyShowOverTime}>Show over time</button>}
                  <button className="primary small" onClick={applyRemoveBreakdown}>Remove breakdown</button>
                </div>
              </div>
            )}
            {breakdownScopeNote && <p className="explain-body">{breakdownScopeNote}</p>}
            {ruleError && <div className="beautify-suggestion">
              <p className="explain-body error" role="alert">Chart-type review incomplete. {ruleError}</p>
              <button className="small" onClick={runBeautify}>Retry chart review</button>
            </div>}
            {ruleSuggestion === null && !ruleError && !noiseSuggestion && !degenerateSuggestion && !breakdownScopeNote &&
              <p className="explain-body">No chart changes suggested by these checks.</p>}
            {aiAvailable && (
              <>
                <button className="link-btn" disabled={agentTips?.status === "loading"} onClick={runAgentTips}>
                  {agentTips ? "Ask again" : "Ask the agent for more"}
                </button>
                {agentTips?.status === "loading" && <p className="explain-body loading">Thinking…</p>}
                {agentTips?.status === "error" && <p className="explain-body error">{agentTips.text}</p>}
                {agentTips?.status === "ok" && <div className="explain-body">{renderMarkdown(agentTips.text)}</div>}
              </>
            )}
          </div>
        </FloatingPanel>
      )}
      {exportOpen && (
        <FloatingPanel anchor={tileRef} anchorTop className="explain-pop export-pop" role="dialog" aria-label="Chart export" focusOnOpen onDismiss={() => setExportOpen(false)}>
          <div className="explain-head">
            <span>Export</span>
            <button className="icon" onClick={() => setExportOpen(false)} aria-label="Close">✕</button>
          </div>
          <div className="export-opts">
            {currentResult && state.status === "ok" ? <DataExportActions onSpreadsheet={exportSpreadsheet} onCsv={exportCsv} busy={spreadsheetBusy} error={exportError} />
              : <p role="status">Refresh the chart successfully before exporting its data.</p>}
            <button onClick={exportPng}>Download PNG</button>
          </div>
        </FloatingPanel>
      )}
      {explain && (
        <FloatingPanel anchor={tileRef} anchorTop className="explain-pop" role="dialog" aria-label="Chart explanation" focusOnOpen style={{ width: 360 }} onDismiss={closeExplain}>
          <div className="explain-head">
            <span>Explain</span>
            <button className="icon" onClick={closeExplain} aria-label="Close">✕</button>
          </div>
          {explain.status === "loading" && <p className="explain-body loading">Thinking…</p>}
          {explain.status === "error" && <p className="explain-body error">{explain.text}</p>}
          {explain.status === "ok" && <div className="explain-body">{renderMarkdown(explain.text)}</div>}
        </FloatingPanel>
      )}
      {drill && drill.length > 0 && (
        <div className="drill-crumbs">
          <button className="crumb" onClick={() => onDrillUp?.(0)}>{title}</button>
          {drill.map((d, i) => (
            <span key={i}>
              <i>›</i>
              <button className="crumb" disabled={i === drill.length - 1}
                      onClick={() => onDrillUp?.(i + 1)}>{d.label}</button>
            </span>
          ))}
        </div>
      )}
      <div className={"body" + (kind === "kpi" ? " kpi-body" : kind === "table" ? " table-body" : "")}
           style={{ padding: fmt.padding }}>
        {(!currentResult || state.status === "loading") && <span style={{ color: "var(--ink-3)" }}>Running…</span>}
        {currentResult && state.status === "error" && <div className="err">{state.message}</div>}
        {currentResult && state.status === "ok" && (state.rows?.length ?? 0) === 0 && (state.partial?.start || state.partial?.end) && (
          // Distinct from a plain "no data" empty tile: there IS data here,
          // it just doesn't span one full period at this grain yet -- e.g.
          // a source only a few days old, viewed at month grain. Naming
          // that beats a bare empty chart, which reads as broken rather
          // than "too early".
          <span style={{ color: "var(--ink-3)" }}>Not enough data yet for a full {grain}.</span>
        )}
        {currentResult && state.status === "ok" && !((state.rows?.length ?? 0) === 0 && (state.partial?.start || state.partial?.end)) && (
          plotIssue ? <div className="chart-err">{plotIssue}</div> : kind === "kpi" && kpiTimeDimIndex >= 0
            ? <Kpi label={title} actions={<>{investigate && <button className="investigate-trigger compact" aria-label="Investigate this" title="Investigate this" onPointerDown={e => e.stopPropagation()} onClick={investigate}><svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5" /><path d="m12 12 4.5 4.5" /></svg></button>}<button className="link" aria-label="Metric definition and scope" onClick={() => setEvidenceOpen(true)}>ⓘ</button><ChartActivityButtons tileId={spec.id} /></>} grain={grain} direction={metricOf(model, spec.metrics[0])?.direction}
                   previous={query.compare && query.compare !== "none" ? numericValue(state.rows?.at(-1)?.[state.columns.indexOf(`${spec.metrics[0]}__prev`)]) : undefined}
                   comparison={cardComparison({ ...spec, dimensions })}
                   onComparison={onUpdate && !locked ? mode => onUpdate(withCardComparison(spec, mode)) : undefined}
                   precisionLimited={dataFindings.some(f => f.id === `precision:${spec.metrics[0]}`)}
                   partialWindow={state.partial?.selected}
                   notice={!presentation && reviewFindingCount > 0 ? <button className="kpi-data-check" aria-label={`${reviewFindingCount} data check${reviewFindingCount === 1 ? "" : "s"} to review`} title="Review data checks" onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); setEvidenceOpen(true); }}>{reviewFindingCount} check{reviewFindingCount === 1 ? "" : "s"}</button> : undefined}
                   unverifiedPeriods={state.partial?.ratio?.map((r: { period: string | null }) => r.period).filter((p: string | null) => p != null)}
                   series={(state.rows ?? []).filter((r: any[]) => r[state.columns.indexOf(dimAlias(dimensions[kpiTimeDimIndex]))] != null).map((r: any[]) =>
                     ({ x: r[state.columns.indexOf(dimAlias(dimensions[kpiTimeDimIndex]))], y: numericValue(r[state.columns.indexOf(spec.metrics[0])]) ?? NaN }))
                     .sort((a: { x: unknown }, b: { x: unknown }) => +new Date(String(a.x)) - +new Date(String(b.x)))}
                   options={spec.spark}
                   format={
                     fmt.number === "currency" && fmt.decimals == null
                       ? (n: number) => (Math.abs(n) >= 10000 ? "$" + d3format(".4~s")(n).replace("G", "B") : makeFormatter(fmt)(n))
                       : fmt.number === "compact" && fmt.decimals == null
                       ? (n: number) => d3format(".4~s")(n).replace("G", "B")
                       : makeFormatter(fmt)
                   }
                   percent={fmt.number === "percent"}
                   onRename={onUpdate && !locked ? (next) => onUpdate({ ...spec, title: next }) : undefined}
                   onDeltaClick={investigate}
                   onOptions={onUpdate && !locked ? (spark) => onUpdate({ ...spec, spark }) : undefined} />
          : kind === "stat" || kind === "kpi"
            ? <Stat value={state.rows?.[0]?.[state.columns.indexOf(spec.metrics[0])]} format={makeFormatter(fmt)} />
            : kind === "table"
              ? <DataTable display={tableDisplay(model, spec)} presentation={presentation} columns={state.columns} rows={state.rows} defaultSortColumn={timeDimIndex === -1 && spec.metrics.length === 1 ? spec.metrics[0] : undefined} />
              : <Chart kind={kind} separateAxes={units.separateAxes} onStatus={error => setRendered(previous => previous?.key === renderKey && previous.error === error ? previous : { key: renderKey, error })} labels={Object.fromEntries(Object.values(model.metrics).map(m => [m.name, m.label]))} {...plotted!} format={chartFmt} secondaryFormat={showingPercentChange ? chartFmt : secondaryFmt} metricFormats={["heatmap", "scatter"].includes(kind) ? Object.fromEntries(spec.metrics.map(m => [m, showingPercentChange ? chartFmt : resolveFormat(model, { ...spec, metrics: [m] })])) : undefined}
                       explorationFocus={explorationFocus}
                       pickableColumns={dimensions?.filter(d => d.includes(":") ? !!onDrill && !!drillNext : !!onCrossFilter).map(dimAlias)}
                       onPick={(kind === "smallMultiples" ? onCrossFilter : onCrossFilter || onDrill) && dimensions?.length
                         ? (col, value) => {
                             const dim = dimensions.find((d) => dimAlias(d) === col);
                             if (!dim) return;
                             if (dim.includes(":")) {
                               if (!onDrill) return;
                               const grain = dim.split(":")[0] as DrillGrain;
                               const column = dim.split(":")[1];
                               const date = value instanceof Date ? value : new Date(String(value));
                               if (Number.isNaN(+date)) return;
                               const entry = drillInto(grain, column, date, calendarOf(model), drillNext);
                               if (entry) onDrill(entry);
                               return;
                             }
                             if (!onCrossFilter || value instanceof Date) return;
                             onCrossFilter({ id: `x${Date.now().toString(36)}`, field: dim,
                                             source: "dimension", mode: "discrete", values: [value] });
                           }
                         : undefined} />
        )}
      </div>
    </div>
  );
}

// React's default comparison includes query context and callbacks. A custom
// subset can retain stale refresh/auth context or an old readiness callback.
// Query effects still depend only on query inputs, not presentation changes.
export const Tile = memo(TileInner);
