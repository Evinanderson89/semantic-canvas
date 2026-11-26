import { grainReviewKey, noiseSeriesReady, worthwhileCoarsening } from "../suggest/reviewChecks.ts";
import { breakdownStatement, reviewBreakdown } from "../suggest/breakdownReview.ts";
import { additionKey, hasEquivalentTile, rememberDecision, reviewGoals, type ReviewDecision } from "../suggest/reviewSession.ts";
import { visibleQuery } from "./query.ts";
import { readResponse } from "./http.ts";
import { validateTile } from "../compiler/compile.ts";
import type { DrillEntry } from "./drill.ts";
import { useState, useRef, useEffect, useMemo, useId } from "react";
import type { DashboardSpec, TileSpec, FilterSpec } from "../compiler/spec.ts";
import type { CanvasSpec } from "../canvas/presets.ts";
import type { Model } from "../semantic/model.ts";
import { applyLayout, pinnedContent } from "../canvas/layouts.ts";
import { applyProposal } from "../canvas/proposals.ts";
import { prepareStoryAddition } from "../suggest/storyAdditions.ts";
import { inferChart } from "../suggest/chartRules.ts";
import { metricOf, semanticHints, timeColumnOf, todayOf } from "../semantic/model.ts";
import { betterKind, recommend, coarserGrain, detectNoisy, noiseScores, type DegenerateFinding, type VizOption } from "../suggest/recommend.ts";
import { dimensionProfiles } from "./useFieldProfiles.ts";
import { renderInline, renderMarkdown } from "./markdown.tsx";
import { readableChartTitle, suggestStoryStructure } from "../suggest/storyStructure.ts";
import { futureFilter, labelTile, reviewDataHonesty, unsettledFilter, type HonestyFinding, type HonestyFix } from "../suggest/dataHonesty.ts";

/** A KPI card's natural height -- matches the headline tiles Exec Summary
 *  already packs at this height (layouts.ts: layoutExecSummary). A chart
 *  needs enough room for axis labels and a legend to not read as cramped. */
const KPI_HEIGHT = 156;
const CHART_MIN_HEIGHT = 300;

interface NoiseHit { kind: "noise"; tileId: string; title: string; grain: string; next: string }
interface DegenerateHit {
  kind: "degenerate"; tileId: string; title: string; finding: DegenerateFinding;
  timeDimension: string | null;
  scopeNote?: string;
}
interface ScopeHit { kind: "scope"; tileId: string; title: string; note: string }
interface KindHit { kind: "chart-kind"; tileId: string; title: string; option: VizOption; degenerate: boolean }
type Hit = NoiseHit | DegenerateHit | KindHit | ScopeHit;
interface Addition { metrics: string[]; title: string; reason: string; breakdown: "time" | "none" }
interface Story {
  layout?: "grid" | "exec-summary" | null;
  title: string; order: string[]; notes: { id: string; note: string }[];
  additions: Addition[]; summary: string;
}

/**
 * Dashboard-level Beautify: the same two-tier idea as a tile's own Beautify
 * (see Tile.tsx) -- a fast, deterministic rules pass first, an agent pass
 * underneath it -- just asked of the WHOLE dashboard instead of one tile.
 * The rules pass reuses detectNoisy()/detectDegenerate()/coarserGrain()
 * exactly as the tile one does, scanning every tile instead of just the
 * selected one. A separate composition pass suggests headings and a neutral
 * reading guide without changing queries. Optional AI adds editorial judgment;
 * all changes remain explicit user actions and participate in document undo.
 */
export function DashboardBeautify({ dash, canvas, model, aiAvailable, canConfigureAi = false, onConnections, onDash, queryContext, drills, filtersByTile = {}, activeTabId }: {
  dash: DashboardSpec; canvas: CanvasSpec; model: Model; aiAvailable: boolean;
  activeTabId?: string;
  /** Admins can add the key; everyone else is told who can. */
  canConfigureAi?: boolean; onConnections?: () => void;
  onDash: (d: DashboardSpec) => void;
  filtersByTile?: Record<string, FilterSpec[]>;
  queryContext: string; drills: Record<string, DrillEntry[]>;
}) {
  const [goal, setGoal] = useState<string>(reviewGoals[0].goal);
  const [continuous, setContinuous] = useState(true);
  const [decisions, setDecisions] = useState<ReviewDecision[]>([]);
  const [round, setRound] = useState(0);
  const reviewedGrains = useRef(new Set<string>());
  const [queued, setQueued] = useState(false);
  const editorialRequest = useRef<AbortController | null>(null);
  const editorialSerial = useRef(0);
  const [open, setOpen] = useState(false);
  const [hits, setHits] = useState<"checking" | Hit[] | null>(null);
  const [honesty, setHonesty] = useState<HonestyFinding[]>([]);
  // Dismissed findings stay dismissed for this document until the data
  // changes: the key carries the date the finding is about.
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [story, setStory] = useState<"checking" | Story | { error: string } | null>(null);
  const [additionError, setAdditionError] = useState("");
  const [structurePreview, setStructurePreview] = useState(false);
  const panelId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const previewTrigger = useRef<HTMLButtonElement>(null);
  const close = () => { request.current?.abort(); editorialRequest.current?.abort(); setOpen(false); trigger.current?.focus(); };
  // This is a nonmodal review: focus enters on opening, but rescans must not
  // pull the user away from a chart they have returned to editing.
  useEffect(() => { if (open) panelRef.current?.focus({ preventScroll: true }); }, [open]);
  useEffect(() => { if (structurePreview) previewRef.current?.focus({ preventScroll: true }); }, [structurePreview]);
  const returnFromStructure = () => requestAnimationFrame(() => (previewTrigger.current ?? panelRef.current)?.focus({ preventScroll: true }));
  const structure = useMemo(() => suggestStoryStructure(dash, model, canvas.width), [dash, model, canvas.width]);
  const proposedOrder = useMemo(() => {
    if (!story || story === "checking" || "error" in story) return null;
    const visualOrder = [...dash.tiles].sort((a,b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x).map(t => t.id);
    if (!story.layout && JSON.stringify(story.order) === JSON.stringify(visualOrder)) return null;
    const rank = new Map(story.order.map((id, i) => [id, i]));
    const fixed = new Set(pinnedContent(dash.tiles).map(t => t.id));
    // The row packer reads positions, so express the proposed reading order as temporary y values.
    const reranked = dash.tiles.map(t => fixed.has(t.id) ? t : ({ ...t, layout: { ...t.layout, y: rank.get(t.id) ?? 9999, x: 0 } }));
    const packed = applyLayout(story.layout ?? "grid", reranked, canvas.width);
    return packed.every(t => JSON.stringify(t.layout) === JSON.stringify(dash.tiles.find(before => before.id === t.id)?.layout)) ? null : packed;
  }, [story, dash, canvas.width]);
  const decisionRef = useRef(decisions); decisionRef.current = decisions;
  const remember = (key: string, label: string, status: ReviewDecision["status"]) => {
    const next = rememberDecision(decisionRef.current, { key: key.slice(0,4000), label: label.slice(0,1000), status });
    decisionRef.current = next; setDecisions(next);
  };
  const isDismissed = (key: string) => decisions.some(d => d.key === key && d.status === "dismissed");

  const [scan, setScan] = useState<{ reviewed: number; limited: number; failed: string[] } | null>(null);
  const context = JSON.stringify([dash, canvas, queryContext, drills, filtersByTile, model]);
  const current = useRef(context); current.current = context;
  const request = useRef<AbortController | null>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    const opening = open && !wasOpen.current; wasOpen.current = open;
    request.current?.abort(); editorialRequest.current?.abort();
    setHits(null); setHonesty([]); setStory(null); setScan(null); setStructurePreview(false);
    setQueued(open && (continuous || opening));
    const timer = open && (continuous || opening) ? setTimeout(() => { setQueued(false); scanTiles(); if (aiAvailable) askAgent(); }, 600) : undefined;
    return () => { clearTimeout(timer); request.current?.abort(); editorialRequest.current?.abort(); };
  }, [context, open, continuous, aiAvailable]);

  const scanTiles = async () => {
    request.current?.abort(); const ac = new AbortController(); request.current = ac;
    const snapshot = context;
    setQueued(false); setHits("checking"); setScan(null);
    const found: Hit[] = [], failed: string[] = [], honest: HonestyFinding[] = [];
    let reviewed = 0, limited = 0;
    for (const t of dash.tiles) {
      if ((t.kind ?? "metric") !== "metric" || !t.metrics.length) continue;
      const query = visibleQuery(model, t, [...(dash.crossFilters ?? []), ...(filtersByTile[t.id] ?? [])], drills[t.id]);
      const timeDimIdx = query.dimensions.findIndex(d => d.includes(":"));
      const isSingleCategorical = query.dimensions.length === 1 && t.metrics.length === 1 && timeDimIdx === -1;
      const title = t.title ?? t.metrics.map(m => metricOf(model, m)?.label ?? m).join(", ");
      try {
        const r = await fetch("/api/query", { method: "POST", signal: ac.signal,
          headers: { "content-type": "application/json", "x-sc-refresh": queryContext }, body: JSON.stringify(query) }).then(readResponse);
        reviewed++; if (r.truncated) limited++;
        if (timeDimIdx !== -1 && !drills[t.id]?.length) {
          honest.push(...reviewDataHonesty({ tile: { ...t, compare: query.compare }, model, columns: r.columns ?? [], rows: r.rows ?? [],
            partial: r.partial ?? { start: false, end: false }, timeDimension: query.dimensions[timeDimIdx], where: query.where, today: todayOf(model) }));
          const grain = query.dimensions[timeDimIdx].split(":")[0], next = coarserGrain(grain);
          const noise = detectNoisy(r.rows ?? [], r.columns ?? [], t.metrics);
          const coarser = next ? { ...query, dimensions: query.dimensions.map((d, i) => i === timeDimIdx ? `${next}:${d.split(":")[1]}` : d) } : null;
          if (next && coarser && noise.length && noiseSeriesReady(query, { ...r, rows: r.rows ?? [], columns: r.columns ?? [] }) && !reviewedGrains.current.has(grainReviewKey(query, queryContext)) && !validateTile(model, { ...t, ...coarser }).length) {
            const candidate = await fetch("/api/query", { method: "POST", signal: ac.signal, headers: { "content-type": "application/json", "x-sc-refresh": queryContext }, body: JSON.stringify(coarser) }).then(readResponse);
            if (noiseSeriesReady(coarser, { ...candidate, rows: candidate.rows ?? [], columns: candidate.columns ?? [] }) && worthwhileCoarsening(noise, noiseScores(candidate.rows ?? [], candidate.columns ?? [], t.metrics), candidate.rows?.length ?? 0))
              found.push({ kind: "noise", tileId: t.id, title, grain, next });
          }
        }
        let degenerate = false;
        if (isSingleCategorical) {
          const checked = await reviewBreakdown(t, query, { ...r, rows: r.rows ?? [], columns: r.columns ?? [] }, own =>
            fetch("/api/query", { method: "POST", signal: ac.signal, headers: { "content-type": "application/json", "x-sc-refresh": queryContext }, body: JSON.stringify(own) }).then(readResponse));
          if (ac.signal.aborted) return;
          if (checked.unavailable) failed.push(`${title}: ${checked.scopeNote}`);
          if (checked.limited && !r.truncated) limited++;
          if (checked.finding) { degenerate = true; found.push({ kind: "degenerate", tileId: t.id, title, finding: checked.finding, scopeNote: checked.scopeNote, timeDimension: timeColumnOf(model, metricOf(model, t.metrics[0])?.baseTable ?? null) }); }
          else if (checked.scopeNote) found.push({ kind: "scope", tileId: t.id, title, note: checked.scopeNote });
        }
        const kind = inferChart(model, { ...t, dimensions: query.dimensions });
        if (!["kpi", "stat"].includes(kind) && !drills[t.id]?.length) {
          const base = metricOf(model, t.metrics[0])?.baseTable;
          const bare = query.dimensions.map(d => d.includes(":") ? d.split(":")[1] : d);
          if (base && bare.length) {
            const profile = await fetch(`/api/profile?base=${encodeURIComponent(base)}&fields=${encodeURIComponent(bare.join(","))}`, { signal: ac.signal }).then(readResponse);
            const fields = dimensionProfiles(profile, query.dimensions);
            if (fields.some(p => p.warning)) throw new Error([...new Set(fields.flatMap(p => p.warning ? [p.warning] : []))].join(" "));
            const option = betterKind(kind, recommend(t.metrics, fields, semanticHints(model, t.metrics)));
            if (option && !validateTile(model, { ...t, chart: option.kind }).length) found.push({ kind: "chart-kind", tileId: t.id, title, option, degenerate });
          }
        }
      } catch (e: any) { if (ac.signal.aborted) return; failed.push(`${title}: ${e.message}`); }
    }
    if (current.current === snapshot && !ac.signal.aborted) { setHits(found); setHonesty(honest); setScan({ reviewed, limited, failed }); setRound(value => value + 1); }
  };

  const tileSummary = (t: TileSpec) => {
    const kind = (t.kind ?? "metric") === "metric" ? inferChart(model, t) : (t.kind ?? "text");
    const title = t.title ?? ((t.kind ?? "metric") === "metric"
      ? t.metrics.map((m) => metricOf(model, m)?.label ?? m).join(", ") || "(untitled)"
      : t.text ?? String(t.kind ?? "note"));
    return { id: t.id, title, kind, metrics: t.metrics ?? [], dimensions: t.dimensions ?? [], where: t.where, compare: t.compare, text: t.text, layout: t.layout, section: t.section, pinned: t.pinned };
  };

  const askAgent = (intent = goal) => {
    editorialRequest.current?.abort();
    const ac = new AbortController(); editorialRequest.current = ac;
    const serial = ++editorialSerial.current;
    setStory("checking");
    const snapshot = context;
    fetch("/api/agent/dashboard-story", {
      method: "POST", headers: { "content-type": "application/json" },
      signal: ac.signal, body: JSON.stringify({ tiles: dash.tiles.map(tileSummary), review: { goal: intent, dashboardTitle: dash.title, decisions: decisionRef.current } }),
    }).then(readResponse).then((d) => { if (current.current === snapshot && !ac.signal.aborted && serial === editorialSerial.current) setStory(d); })
      .catch((e) => { if (current.current === snapshot && !ac.signal.aborted && serial === editorialSerial.current) setStory({ error: String(e?.message ?? e) }); });
  };

  const run = () => {
    if (!open) { setOpen(true); return; }
    scanTiles();
    if (aiAvailable) askAgent();
  };

  const applyReviewed = (next: DashboardSpec) => {
    if (JSON.stringify(next) === JSON.stringify(dash)) return;
    onDash(next);
  };

  const applyCoarsen = (hit: NoiseHit) => {
    remember(`grain:${hit.tileId}:${hit.next}`, `Show ${hit.title} by ${hit.next}`, "applied");
    const tiles = dash.tiles.map(t => {
      if (t.id !== hit.tileId) return t;
      const next = { ...t, dimensions: t.dimensions.map(d => d.includes(":") && d.split(":")[0] === hit.grain ? `${hit.next}:${d.split(":")[1]}` : d) };
      return { ...next, title: readableChartTitle(model, t, next) };
    });
    const accepted = tiles.find(t => t.id === hit.tileId)!;
    reviewedGrains.current.add(grainReviewKey(visibleQuery(model, accepted, [...(dash.crossFilters ?? []), ...(filtersByTile[accepted.id] ?? [])], drills[accepted.id]), queryContext));
    applyReviewed({ ...dash, tiles });
  };

  const applyRemoveBreakdown = (hit: DegenerateHit) => {
    remember(`breakdown:${hit.tileId}`, `Remove the unhelpful breakdown from ${hit.title}`, "applied");
    // Caps the tile down to KPI height rather than leaving it sized for
    // whatever chart it was before -- a bare number in a tile still sized
    // for a full chart is a huge dead gap, not a fix.
    applyReviewed({ ...dash, tiles: dash.tiles.map((t) => t.id !== hit.tileId ? t : {
      ...t, dimensions: [], chart: undefined, title: readableChartTitle(model, t, { ...t, dimensions: [], chart: undefined }),
      layout: { ...t.layout, h: Math.min(t.layout.h, KPI_HEIGHT) } }) });
  };

  const applyShowOverTime = (hit: DegenerateHit) => {
    if (!hit.timeDimension) return;
    remember(`trend:${hit.tileId}`, `Show ${hit.title} over time`, "applied");
    applyReviewed({ ...dash, tiles: dash.tiles.map((t) => t.id !== hit.tileId ? t : {
      ...t, dimensions: [`month:${hit.timeDimension}`], chart: undefined, title: readableChartTitle(model, t, { ...t, dimensions: [`month:${hit.timeDimension}`], chart: undefined }),
      layout: { ...t.layout, h: Math.max(t.layout.h, CHART_MIN_HEIGHT) } }) });
  };

  const applyHonesty = (f: HonestyFinding, fix: HonestyFix) => {
    remember(`honesty:${f.key}:${fix.kind}`, `${f.title}: ${fixLabel(fix)}`, "applied");
    const today = todayOf(model);
    if (fix.kind === "freshness-note") {
      const note: TileSpec = {
        id: `t${Math.random().toString(36).slice(2, 8)}`, kind: "text", metrics: [], dimensions: [],
        text: `Data through ${fix.date}.`, layout: { x: 24, y: 999999, w: 480, h: KPI_HEIGHT },
      };
      applyReviewed({ ...dash, tiles: applyLayout("grid", [...dash.tiles, note], canvas.width, false) });
      return;
    }
    applyReviewed({ ...dash, tiles: dash.tiles.map((t) => {
      if (t.id !== f.tileId) return t;
      if (fix.kind === "exclude-unsettled" || fix.kind === "exclude-future") {
        const filter = fix.kind === "exclude-future" ? futureFilter(t.id, fix) : unsettledFilter(t.id, fix);
        return { ...t, where: [...(t.where ?? []).filter((w) => w.id !== filter.id), filter] };
      }
      return labelTile(t, f.title, fix, today);
    }) });
  };
  const fixLabel = (fix: HonestyFix) => fix.kind === "label-through" ? "Label as through that date"
    : fix.kind === "label-as-of" ? "Label as of that date" : fix.kind === "exclude-unsettled" ? "Compare complete periods only" : fix.kind === "exclude-future" ? "Leave out rows dated after today" : "Add a freshness note";
  const visibleHonesty = honesty.filter((f) => !dismissed.has(f.key));

  const applyTitle = () => {
    if (!story || story === "checking" || "error" in story) return;
    remember(`title:${story.title}`, `Use title: ${story.title}`, "applied");
    applyReviewed({ ...dash, title: story.title });
  };

  const applyOrder = () => {
    if (!story || story === "checking" || "error" in story || !proposedOrder) return;
    remember(`order:${story.layout ?? "grid"}:${story.order.join(",")}`, "Apply the proposed reading order", "applied");
    applyReviewed({ ...dash, tiles: proposedOrder });
  };

  const applyAddition = (addition: Addition) => {
    setAdditionError("");
    try {
      if (hasEquivalentTile(dash.tiles, addition, model)) return;
      const prepared = prepareStoryAddition(model, addition);
      const newTile = { ...prepared, id: crypto.randomUUID(), layout: { ...prepared.layout,
        y: Math.max(0, ...dash.tiles.map(t => t.layout.y + t.layout.h)) + 24, w: Math.min(480, canvas.width - 48) } };
      const next = applyProposal(dash, canvas, { title: addition.title, reason: addition.reason,
        actions: [{ type: "add", tile: newTile }] }, model, activeTabId);
      // stretch:false -- additions are typically applied one at a time (up to
      // 3 proposed per pass), each repacking from scratch. Stretching the
      // tile that just became a lone row would make it wider than 480px, so
      // the NEXT addition (also 480px) no longer fits beside it either --
      // every addition ends up in its own full-row-width tile, exactly the
      // "have to scroll forever" a growing dashboard shouldn't produce.
      // Leaving raw widths alone lets same-sized additions keep sharing rows.
      const packed = applyLayout("grid", next.spec.tiles, canvas.width, false);
      remember(additionKey(addition), `Add ${addition.title}`, "applied");
      applyReviewed({ ...next.spec, tiles: packed });
    } catch (e: any) { setAdditionError(e.message ?? "This addition could not be applied. Your dashboard is unchanged."); }
  };

  const additions = story && story !== "checking" && !("error" in story) ? story.additions.flatMap(a => {
    if (isDismissed(additionKey(a))) return [];
    try { prepareStoryAddition(model, a); return hasEquivalentTile(dash.tiles, a, model) ? [] : [{ addition: a, error: "" }]; }
    catch (e: any) { return [{ addition: a, error: e.message as string }]; }
  }) : [];

  return (
    <>
      <button ref={trigger} className="tgl" onClick={run} disabled={!dash.tiles.length} aria-describedby={aiAvailable ? undefined : "review-scope-note"}
              aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panelId : undefined}
              onKeyDown={e => { if (open && e.key === "Escape") { e.stopPropagation(); close(); } }}
              title="Review layout, supporting context, and storytelling as you build. Preview and apply changes; the next review uses your updated canvas.">
        <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M3 17l7-7" strokeLinecap="round" />
          <path d="M13 3v3M11.5 4.5h3" strokeLinecap="round" />
          <path d="M16.5 8.5v2M15.5 9.5h2" strokeLinecap="round" />
        </svg>
        Design review
        {!aiAvailable && <span className="review-scope" aria-hidden="true" title="Chart checks and story structure run without AI. The editorial review needs an AI provider.">checks only</span>}
      </button>
      {!aiAvailable && <span id="review-scope-note" hidden>Chart checks and story structure only; the editorial review needs an AI provider.</span>}
      {open && (
        <div ref={panelRef} id={panelId} tabIndex={-1} className={"dash-beautify-pop" + (structurePreview ? " showing-structure" : "")} role="dialog" aria-label="Design review"
          onKeyDown={e => { if (e.key === "Escape") { e.stopPropagation(); close(); } }}>
          <div className="explain-head">
            <span>Design review</span>
            <button className="icon" onClick={close} aria-label="Close">✕</button>
          </div>
          <div className="beautify-body">
            <div className="review-intro"><h3>Keep building the story.</h3><p>Review {round || 1} · {aiAvailable ? "Layout, chart checks, and editorial guidance" : "Layout and chart checks"}</p></div>
            <section className="review-direction" aria-label="Review direction">
              <label htmlFor="review-goal">What should this dashboard help someone decide?</label>
              <textarea id="review-goal" rows={2} maxLength={600} value={goal} onChange={e => setGoal(e.target.value)} />
              <div className="story-actions">{reviewGoals.map(item => <button key={item.label} className="tgl" onClick={() => { setGoal(item.goal); scanTiles(); if (aiAvailable) askAgent(item.goal); }}>{item.label}</button>)}</div>
              <button className="link" onClick={run}>Review this goal</button>
              <label className="review-continuous"><input type="checkbox" checked={continuous} onChange={e => setContinuous(e.target.checked)} />Keep reviewing while this panel is open</label>
              <small>Rechecks after edits settle. AI review uses your configured provider and may incur usage charges on each recheck. Changes still wait for you to apply them.</small>
            </section>
            <ul className="review-passes" aria-label="What this review covers">
              <li className="on" title="Results, grain, breakdowns and layout, from the current queries.">Chart checks</li>
              <li className="on" title="Partial periods, lagging comparisons and freshness, from the current results.">Data honesty</li>
              <li className="on" title="A reading order from your headings and sections.">Story structure</li>
              <li className={aiAvailable ? "on" : "off"} title={aiAvailable ? "An AI read of the dashboard as a story." : "Did not run: the editorial review needs an AI provider."}>
                Editorial{!aiAvailable && <> · {canConfigureAi ? <button className="link" onClick={onConnections}>add a key</button> : "optional (AI not connected)"}</>}
              </li>
            </ul>
            {hits === "checking" && <p className="explain-body loading">Checking the current charts…</p>}
            {Array.isArray(hits) && hits.length > 0 && (
              <div className="beautify-suggestion">
                {hits.map((h) => h.kind === "noise" ? (
                  <div key={`${h.kind}:${h.tileId}`} className="review-finding">
                    <h4>{h.title}</h4>
                    <p>The {h.grain === "day" ? "daily" : h.grain} view is noisy. A {h.next} view can make the broader pattern easier to read.</p>
                    <button className="primary small" onClick={() => applyCoarsen(h)}>Switch to {h.next}</button>
                  </div>
                ) : h.kind === "chart-kind" ? (
                  <div key={`${h.kind}:${h.tileId}`} className="review-finding">
                    <h4>{h.title}</h4><p>{h.option.why}</p>
                    {h.degenerate && <p>This changes the display only. The one-category breakdown still needs the separate fix above.</p>}
                    <button className="primary small" onClick={() => { remember(`kind:${h.tileId}:${h.option.kind}`, `Use ${h.option.label} for ${h.title}`, "applied"); applyReviewed({ ...dash, tiles: dash.tiles.map(t => t.id === h.tileId ? { ...t, chart: h.option.kind } : t) }); }}>Use {h.option.label}</button>
                  </div>
                ) : h.kind === "scope" ? (
                  <div key={`${h.kind}:${h.tileId}`} className="review-finding"><h4>{h.title}</h4><p>{h.note}</p></div>
                ) : (
                  <div key={`${h.kind}:${h.tileId}`} className="review-finding">
                    <h4>{h.title}</h4>
                    <p>{breakdownStatement(h.finding)} A trend or headline number may make better use of this space.</p>
                    {h.scopeNote && <p>{h.scopeNote}</p>}
                    <div className="story-actions">
                      {h.timeDimension &&
                        <button className="primary small" onClick={() => applyShowOverTime(h)}>Show over time</button>}
                      <button className="primary small" onClick={() => applyRemoveBreakdown(h)}>Remove breakdown</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {visibleHonesty.length > 0 && (
              <section className="beautify-suggestion honesty-review" aria-label="Data honesty">
                <div className="eyebrow">Data honesty</div>
                {visibleHonesty.map((f) => (
                  <div key={f.key} className="review-finding">
                    <h4>{f.title}</h4>
                    <p>{f.text}</p>
                    <div className="story-actions">
                      {f.fixes.map((fix) => <button key={fix.kind} className="primary small" onClick={() => applyHonesty(f, fix)}>{fixLabel(fix)}</button>)}
                      <button className="tgl" onClick={() => setDismissed((d) => new Set(d).add(f.key))}>Dismiss</button>
                    </div>
                  </div>
                ))}
              </section>
            )}
            {scan && <div className="review-coverage" role="status"><b>{scan.failed.length ? "Review incomplete" : "Query checks complete"}</b> · {scan.reviewed} chart{scan.reviewed === 1 ? "" : "s"} reviewed{scan.limited ? ` · ${scan.limited} limited result window${scan.limited === 1 ? "" : "s"}` : ""}{scan.failed.length ? ` · ${scan.failed.length} unavailable` : ""}{Array.isArray(hits) && hits.length === 0 && !visibleHonesty.length ? (scan.failed.length ? " · nothing to change in the readable tiles" : " · no issues found by these query checks; rendered charts and business conclusions still need review") : ""}{scan.failed.map(message => <p key={message} className="err">{message}</p>)}</div>}
            {queued && <p className="explain-body loading" role="status">Reviewing the updated dashboard…</p>}
            {hits === null && !queued && <p className="explain-body">{continuous ? "The dashboard changed." : "Automatic review is paused."} <button className="link" onClick={run}>Review this version</button></p>}
            {!scan && Array.isArray(hits) && hits.length === 0 &&
              <p className="explain-body">No chart changes suggested for the results reviewed.</p>}

            {structure && <section className="structure-review" aria-label="Story structure">
              <div className="eyebrow">Shape the story</div>
              <h3>Give every chart a place.</h3>
              <p>{structure.refinement ? "Refine chart sizes and spacing inside your existing sections. Keep headings, authored notes, and pinned sections." : `Add ${structure.sections.length} section headings, an editable reading guide, and a clear visual hierarchy${structure.renamed ? `, with ${structure.renamed} clearer chart ${structure.renamed === 1 ? "label" : "labels"}` : ""}.`}</p>
              {!structurePreview ? <button ref={previewTrigger} className="primary small" onClick={() => setStructurePreview(true)}>Preview story structure</button> : <>
                <div ref={previewRef} tabIndex={-1} className="structure-preview" aria-label="Proposed story structure">
                  <h4>{structure.spec.title}</h4>
                  <ol>{structure.sections.map(s => <li key={s.title}><b>{s.title}</b><p>{s.purpose}</p><span>{s.labels.join(" · ")}</span></li>)}</ol>
                  <div className="reading-guide-preview"><b>Reading guide</b><p>{structure.guide}</p></div>
                </div>
                <div className="story-actions"><button className="primary small" onClick={() => { remember("structure", structure.refinement ? "Refine existing story layout" : "Apply story structure", "applied"); setStructurePreview(false); applyReviewed(structure.spec); returnFromStructure(); }}>Apply story structure</button><button className="tgl" onClick={() => { setStructurePreview(false); returnFromStructure(); }}>Keep current</button></div>
                <small>Reuses your charts and queries. One undo restores the previous version.</small>
              </>}
            </section>}
            {!structure && dash.tiles.some(t => t.kind === "heading") && <p className="explain-body hint">No additional automatic layout proposal for this version. Your headings and pinned sections are preserved. Choose a new direction above to review the next question.</p>}
            {story === "checking" && <p className="explain-body loading">Reading the dashboard as a story…</p>}
            {story && story !== "checking" && "error" in story && <section className="beautify-suggestion" aria-label="AI review unavailable"><p className="explain-body error" role="alert">AI review couldn’t finish.</p><p className="explain-body">Your dashboard and review choices are unchanged. You can still use the chart checks and layout suggestions.</p><button className="primary small" onClick={() => askAgent()}>Retry AI review</button><details className="explain-body"><summary>Error details</summary><p>{story.error}</p></details></section>}
            {story && story !== "checking" && !("error" in story) && (
              <div className="beautify-suggestion">
                <div className="explain-body">{renderMarkdown(story.summary)}</div>
                {story.title !== dash.title && !isDismissed(`title:${story.title}`) && <div className="review-title-option"><p className="explain-body"><b>Optional title:</b> {story.title}</p><div className="story-actions"><button className="tgl" onClick={applyTitle}>Use this title</button><button className="link" onClick={() => remember(`title:${story.title}`, `Keep current title instead of ${story.title}`, "dismissed")}>Keep current title</button></div></div>}
                {proposedOrder && !isDismissed(`order:${story.layout ?? "grid"}:${story.order.join(",")}`) && <div className="story-actions"><button className="primary small" onClick={applyOrder}>{story.layout ? "Apply suggested layout" : "Reorder top to bottom"}</button><button className="link" onClick={() => remember(`order:${story.layout ?? "grid"}:${story.order.join(",")}`, "Keep current reading order", "dismissed")}>Keep this order</button></div>}
                {story.notes.length > 0 && (
                  <ul className="story-notes">
                    {story.notes.map((n) => <li key={n.id}>{renderInline(n.note)}</li>)}
                  </ul>
                )}
                {additionError && <p role="alert" className="error">{additionError}</p>}
                {additions.length > 0 && (
                  <div className="story-additions">
                    {additions.map(({ addition: a, error }, i) => (
                      <div key={i} className="addition-item">
                        <p className="explain-body"><b>{a.title}</b> — {renderInline(a.reason)}</p>
                        {error && <p className="explain-body">{error}</p>}
                        <div className="story-actions"><button className="primary small" disabled={!!error} onClick={() => applyAddition(a)}>Add this tile</button><button className="link" onClick={() => remember(additionKey(a), `Skip ${a.title}`, "dismissed")}>Not useful</button></div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {decisions.length > 0 && <details className="review-history"><summary>Your choices in this review ({decisions.length})</summary><ul>{decisions.map(d => <li key={d.key}>{d.status === "applied" ? "Applied" : "Kept out"}: {d.label}</li>)}</ul><button className="link" onClick={() => { decisionRef.current = []; setDecisions([]); }}>Forget these choices</button></details>}
          </div>
        </div>
      )}
    </>
  );
}
