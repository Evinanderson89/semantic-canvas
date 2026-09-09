import { visibleQuery } from "./query.ts";
import { readResponse } from "./http.ts";
import { validateTile } from "../compiler/compile.ts";
import type { DrillEntry } from "./drill.ts";
import { useState, useRef, useEffect, useMemo } from "react";
import type { DashboardSpec, TileSpec, FilterSpec } from "../compiler/spec.ts";
import type { CanvasSpec } from "../canvas/presets.ts";
import type { Model } from "../semantic/model.ts";
import { applyLayout, sectionsOf } from "../canvas/layouts.ts";
import { inferChart } from "../suggest/chartRules.ts";
import { timeColumnOf } from "../semantic/model.ts";
import { coarserGrain, detectDegenerate, detectNoisy, type DegenerateFinding } from "../suggest/recommend.ts";
import { renderInline, renderMarkdown } from "./markdown.tsx";
import { readableChartTitle, suggestStoryStructure } from "../suggest/storyStructure.ts";

/** A KPI card's natural height -- matches the headline tiles Exec Summary
 *  already packs at this height (layouts.ts: layoutExecSummary). A chart
 *  needs enough room for axis labels and a legend to not read as cramped. */
const KPI_HEIGHT = 156;
const CHART_MIN_HEIGHT = 300;

interface NoiseHit { kind: "noise"; tileId: string; title: string; grain: string; next: string }
interface DegenerateHit {
  kind: "degenerate"; tileId: string; title: string; finding: DegenerateFinding;
  timeDimension: string | null;
}
type Hit = NoiseHit | DegenerateHit;
interface Addition { metrics: string[]; title: string; reason: string; breakdown: "time" | "none" }
interface Story {
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
export function DashboardBeautify({ dash, canvas, model, aiAvailable, onDash, queryContext, drills, filtersByTile = {} }: {
  dash: DashboardSpec; canvas: CanvasSpec; model: Model; aiAvailable: boolean;
  onDash: (d: DashboardSpec) => void;
  filtersByTile?: Record<string, FilterSpec[]>;
  queryContext: string; drills: Record<string, DrillEntry[]>;
}) {
  const [open, setOpen] = useState(false);
  const [hits, setHits] = useState<"checking" | Hit[] | null>(null);
  const [story, setStory] = useState<"checking" | Story | { error: string } | null>(null);
  const [structurePreview, setStructurePreview] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const previewTrigger = useRef<HTMLButtonElement>(null);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  useEffect(() => { if (structurePreview) previewRef.current?.focus({ preventScroll: true }); }, [structurePreview]);
  const structure = useMemo(() => suggestStoryStructure(dash, model, canvas.width), [dash, model, canvas.width]);
  const rescanAfterEdit = useRef(false);

  const [scan, setScan] = useState<{ reviewed: number; limited: number; failed: string[] } | null>(null);
  const context = JSON.stringify([dash, canvas, queryContext, drills, filtersByTile]);
  const current = useRef(context); current.current = context;
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    request.current?.abort(); setHits(null); setStory(null); setScan(null); setStructurePreview(false);
    if (rescanAfterEdit.current && open) scanTiles();
    rescanAfterEdit.current = false;
    return () => request.current?.abort();
  }, [context]);

  const scanTiles = async () => {
    request.current?.abort(); const ac = new AbortController(); request.current = ac;
    const snapshot = context;
    setHits("checking"); setScan(null);
    const found: Hit[] = [], failed: string[] = [];
    let reviewed = 0, limited = 0;
    for (const t of dash.tiles) {
      if ((t.kind ?? "metric") !== "metric" || !t.metrics.length) continue;
      const query = visibleQuery(model, t, [...(dash.crossFilters ?? []), ...(filtersByTile[t.id] ?? [])], drills[t.id]);
      const timeDimIdx = query.dimensions.findIndex(d => d.includes(":"));
      const isSingleCategorical = query.dimensions.length === 1 && t.metrics.length === 1 && timeDimIdx === -1;
      const title = t.title ?? t.metrics.map(m => model.metrics[m]?.label ?? m).join(", ");
      try {
        const r = await fetch("/api/query", { method: "POST", signal: ac.signal,
          headers: { "content-type": "application/json", "x-sc-refresh": queryContext }, body: JSON.stringify(query) }).then(readResponse);
        reviewed++; if (r.truncated) limited++;
        if (timeDimIdx !== -1 && !drills[t.id]?.length) {
          const grain = query.dimensions[timeDimIdx].split(":")[0], next = coarserGrain(grain);
          if (next && !validateTile(model, { ...t, dimensions: t.dimensions.map(d => d.includes(":") ? `${next}:${d.split(":")[1]}` : d) }).length && detectNoisy(r.rows ?? [], r.columns ?? [], t.metrics).length)
            found.push({ kind: "noise", tileId: t.id, title, grain, next });
        }
        if (isSingleCategorical) {
          const finding = detectDegenerate(r.rows ?? [], r.columns ?? [], r.columns?.[0], t.metrics[0]);
          if (finding) found.push({ kind: "degenerate", tileId: t.id, title, finding, timeDimension: timeColumnOf(model, model.metrics[t.metrics[0]]?.baseTable ?? null) });
        }
      } catch (e: any) { if (ac.signal.aborted) return; failed.push(`${title}: ${e.message}`); }
    }
    if (current.current === snapshot && !ac.signal.aborted) { setHits(found); setScan({ reviewed, limited, failed }); }
  };

  const tileSummary = (t: TileSpec) => {
    const kind = (t.kind ?? "metric") === "metric" ? inferChart(model, t) : (t.kind ?? "text");
    const title = t.title ?? ((t.kind ?? "metric") === "metric"
      ? t.metrics.map((m) => model.metrics[m]?.label ?? m).join(", ") || "(untitled)"
      : t.text ?? String(t.kind ?? "note"));
    return { id: t.id, title, kind, metrics: t.metrics ?? [], dimensions: t.dimensions ?? [], text: t.text, layout: t.layout, section: t.section, pinned: t.pinned };
  };

  const askAgent = () => {
    setStory("checking");
    const snapshot = context;
    fetch("/api/agent/dashboard-story", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tiles: dash.tiles.map(tileSummary) }),
    }).then(readResponse).then((d) => { if (current.current === snapshot) setStory(d); })
      .catch((e) => { if (current.current === snapshot) setStory({ error: String(e?.message ?? e) }); });
  };

  const run = () => {
    setOpen(true);
    scanTiles();
    if (aiAvailable) askAgent();
  };

  const applyReviewed = (next: DashboardSpec) => {
    rescanAfterEdit.current = true;
    onDash(next);
  };

  const applyCoarsen = (hit: NoiseHit) => {
    applyReviewed({ ...dash, tiles: dash.tiles.map((t) => t.id !== hit.tileId ? t : {
      ...t,
      dimensions: t.dimensions.map((d) =>
        d.includes(":") && d.split(":")[0] === hit.grain ? `${hit.next}:${d.split(":")[1]}` : d),
    }) });
  };

  const applyRemoveBreakdown = (hit: DegenerateHit) => {
    // Caps the tile down to KPI height rather than leaving it sized for
    // whatever chart it was before -- a bare number in a tile still sized
    // for a full chart is a huge dead gap, not a fix.
    applyReviewed({ ...dash, tiles: dash.tiles.map((t) => t.id !== hit.tileId ? t : {
      ...t, dimensions: [], chart: undefined, title: readableChartTitle(model, t, { ...t, dimensions: [], chart: undefined }),
      layout: { ...t.layout, h: Math.min(t.layout.h, KPI_HEIGHT) } }) });
  };

  const applyShowOverTime = (hit: DegenerateHit) => {
    if (!hit.timeDimension) return;
    applyReviewed({ ...dash, tiles: dash.tiles.map((t) => t.id !== hit.tileId ? t : {
      ...t, dimensions: [`month:${hit.timeDimension}`], chart: undefined, title: readableChartTitle(model, t, { ...t, dimensions: [`month:${hit.timeDimension}`], chart: undefined }),
      layout: { ...t.layout, h: Math.max(t.layout.h, CHART_MIN_HEIGHT) } }) });
  };

  const applyTitle = () => {
    if (!story || story === "checking" || "error" in story) return;
    onDash({ ...dash, title: story.title });
  };

  const applyOrder = () => {
    if (!story || story === "checking" || "error" in story) return;
    const rank = new Map(story.order.map((id, i) => [id, i]));
    // arrange() (under applyLayout) packs in order of each tile's CURRENT
    // layout.y/x, not array order -- so the suggested order is expressed as
    // synthetic y positions first, then handed to the same row-packer Smart
    // Arrange already uses, rather than inventing new placement math here.
    const fixed = new Set(sectionsOf(dash.tiles).filter(group => group.some(t => t.pinned)).flat().map(t => t.id));
    const reranked = dash.tiles.map((t) => fixed.has(t.id) ? t : ({ ...t, layout: { ...t.layout, y: rank.get(t.id) ?? 9999, x: 0 } }));
    const packed = applyLayout("grid", reranked, canvas.width);
    onDash({ ...dash, tiles: packed });
  };

  const applyAddition = (addition: Addition) => {
    const base = model.metrics[addition.metrics[0]]?.baseTable ?? null;
    const timeCol = addition.breakdown === "time" ? timeColumnOf(model, base) : null;
    const newTile: TileSpec = {
      id: `t${Math.random().toString(36).slice(2, 8)}`,
      kind: "metric", title: addition.title, metrics: addition.metrics,
      dimensions: timeCol ? [`month:${timeCol}`] : [],
      // A huge starting y, same trick applyOrder uses -- arrange() sorts by
      // current y/x before repacking, so this just needs to sort last.
      // Height matches what actually gets drawn: a real trend needs room
      // for axes, a bare KPI/one-row table (no time column exists, or
      // "none" was requested) would be dead space at chart height.
      layout: { x: 24, y: 999999, w: 480, h: timeCol ? CHART_MIN_HEIGHT : KPI_HEIGHT },
    };
    // stretch:false -- additions are typically applied one at a time (up to
    // 3 proposed per pass), each repacking from scratch. Stretching the
    // tile that just became a lone row would make it wider than 480px, so
    // the NEXT addition (also 480px) no longer fits beside it either --
    // every addition ends up in its own full-row-width tile, exactly the
    // "have to scroll forever" a growing dashboard shouldn't produce.
    // Leaving raw widths alone lets same-sized additions keep sharing rows.
    const packed = applyLayout("grid", [...dash.tiles, newTile], canvas.width, false);
    onDash({ ...dash, tiles: packed });
    setStory((s) => (s && s !== "checking" && !("error" in s))
      ? { ...s, additions: s.additions.filter((a) => a !== addition) } : s);
  };

  return (
    <>
      <button ref={trigger} className="tgl" onClick={run} disabled={!dash.tiles.length}
              title="Suggest a title and a top-to-bottom reading order for the whole dashboard, and flag any tile that's hard to read at its current grain. Review the current results and composition. Changes are applied only when you choose a suggestion.">
        <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M3 17l7-7" strokeLinecap="round" />
          <path d="M13 3v3M11.5 4.5h3" strokeLinecap="round" />
          <path d="M16.5 8.5v2M15.5 9.5h2" strokeLinecap="round" />
        </svg>
        Design review
      </button>
      {open && (
        <div className={"dash-beautify-pop" + (structurePreview ? " showing-structure" : "")} role="dialog" aria-label="Design review"
          onKeyDown={e => { if (e.key === "Escape") { e.stopPropagation(); close(); } }}>
          <div className="explain-head">
            <span>Design review</span>
            <button className="icon" onClick={close} aria-label="Close">✕</button>
          </div>
          <div className="beautify-body">
            <div className="review-intro"><h3>Make the story easier to see.</h3><p>Refine the charts, give them a reading order, and keep every change in your hands.</p></div>
            {hits === "checking" && <p className="explain-body loading">Checking the current charts…</p>}
            {Array.isArray(hits) && hits.length > 0 && (
              <div className="beautify-suggestion">
                {hits.map((h) => h.kind === "noise" ? (
                  <div key={h.tileId} className="review-finding">
                    <h4>{h.title}</h4>
                    <p>The {h.grain === "day" ? "daily" : h.grain} view is noisy. A {h.next} view can make the broader pattern easier to read.</p>
                    <button className="primary small" onClick={() => applyCoarsen(h)}>Switch to {h.next}</button>
                  </div>
                ) : (
                  <div key={h.tileId} className="review-finding">
                    <h4>{h.title}</h4>
                    <p>Only “{h.finding.dominantValue}” has a nonzero value in the reviewed results. A trend or headline number would make better use of this space.</p>
                    <div className="story-actions">
                      {h.timeDimension &&
                        <button className="primary small" onClick={() => applyShowOverTime(h)}>Show over time</button>}
                      <button className="primary small" onClick={() => applyRemoveBreakdown(h)}>Remove breakdown</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {scan && <div className="review-coverage" role="status"><b>{scan.failed.length ? "Review incomplete" : "Review complete"}</b><p>{scan.reviewed} charts reviewed{scan.limited ? ` · ${scan.limited} limited result window${scan.limited === 1 ? "" : "s"}` : ""}{scan.failed.length ? ` · ${scan.failed.length} unavailable` : ""}.</p>{scan.failed.map(message => <p key={message} className="err">{message}</p>)}</div>}
            {hits === null && <p className="explain-body">The dashboard changed. <button className="link" onClick={run}>Review this version</button></p>}
            {Array.isArray(hits) && hits.length === 0 &&
              <p className="explain-body">{scan?.failed.length ? "The readable tiles have no additional chart suggestions. The review is incomplete." : "No chart changes suggested for the results reviewed."}</p>}

            {structure && <section className="structure-review" aria-label="Story structure">
              <div className="eyebrow">Shape the story</div>
              <h3>Give every chart a place.</h3>
              <p>Add {structure.sections.length} section headings, an editable reading guide, and a clear visual hierarchy{structure.renamed ? `, with ${structure.renamed} clearer chart label${structure.renamed === 1 ? "" : "s"}` : ""}.</p>
              {!structurePreview ? <button ref={previewTrigger} className="primary small" onClick={() => setStructurePreview(true)}>Preview story structure</button> : <>
                <div ref={previewRef} tabIndex={-1} className="structure-preview" aria-label="Proposed story structure">
                  <h4>{structure.spec.title}</h4>
                  <ol>{structure.sections.map(s => <li key={s.title}><b>{s.title}</b><p>{s.purpose}</p><span>{s.labels.join(" · ")}</span></li>)}</ol>
                  <div className="reading-guide-preview"><b>Reading guide</b><p>{structure.guide}</p></div>
                </div>
                <div className="story-actions"><button className="primary small" onClick={() => { onDash(structure.spec); close(); }}>Apply story structure</button><button className="tgl" onClick={() => { setStructurePreview(false); requestAnimationFrame(() => previewTrigger.current?.focus()); }}>Keep current</button></div>
                <small>Reuses your charts and queries. One undo restores the previous version.</small>
              </>}
            </section>}
            {!structure && dash.tiles.some(t => t.kind === "heading") && <p className="explain-body hint">Your section headings already establish a reading order. Smart arrange keeps those sections together.</p>}
            {!aiAvailable &&
              <p className="explain-body hint">Chart checks and story structure work without AI. Connect a provider in Connections for an additional editorial review.</p>}
            {story === "checking" && <p className="explain-body loading">Reading the dashboard as a story…</p>}
            {story && story !== "checking" && "error" in story && <p className="explain-body error">{story.error}</p>}
            {story && story !== "checking" && !("error" in story) && (
              <div className="beautify-suggestion">
                <div className="explain-body">{renderMarkdown(story.summary)}</div>
                <p className="explain-body"><b>Suggested title:</b> {story.title}</p>
                <div className="story-actions">
                  <button className="primary small" onClick={applyTitle}>Use this title</button>
                  <button className="primary small" onClick={applyOrder}>Reorder top to bottom</button>
                </div>
                {story.notes.length > 0 && (
                  <ul className="story-notes">
                    {story.notes.map((n) => <li key={n.id}>{renderInline(n.note)}</li>)}
                  </ul>
                )}
                {story.additions.length > 0 && (
                  <div className="story-additions">
                    {story.additions.map((a, i) => (
                      <div key={i} className="addition-item">
                        <p className="explain-body"><b>{a.title}</b> — {renderInline(a.reason)}</p>
                        <button className="primary small" onClick={() => applyAddition(a)}>Add this tile</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
