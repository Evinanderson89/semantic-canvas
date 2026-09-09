import { visibleQuery } from "./query.ts";
import { readResponse } from "./http.ts";
import { validateTile } from "../compiler/compile.ts";
import type { DrillEntry } from "./drill.ts";
import { useState, useRef, useEffect } from "react";
import type { DashboardSpec, TileSpec } from "../compiler/spec.ts";
import type { CanvasSpec } from "../canvas/presets.ts";
import type { Model } from "../semantic/model.ts";
import { applyLayout, sectionsOf } from "../canvas/layouts.ts";
import { inferChart } from "../suggest/chartRules.ts";
import { timeColumnOf } from "../semantic/model.ts";
import { coarserGrain, detectDegenerate, detectNoisy, type DegenerateFinding } from "../suggest/recommend.ts";
import { renderInline, renderMarkdown } from "./markdown.tsx";

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
 * selected one -- one query per tile covers both checks, rather than
 * fetching the same result twice. The agent pass is new: title and
 * reading-order are judgment calls no rule can make, so they're the one
 * thing here that needs the model -- and unlike "Explain this" or a tile's
 * own Beautify, this suggestion gets APPLIED (a new title, a new tile
 * order), not just displayed, so the agent call returns structured JSON
 * instead of a paragraph.
 */
export function DashboardBeautify({ dash, canvas, model, aiAvailable, onDash, queryContext, drills }: {
  dash: DashboardSpec; canvas: CanvasSpec; model: Model; aiAvailable: boolean;
  onDash: (d: DashboardSpec) => void;
  queryContext: string; drills: Record<string, DrillEntry[]>;
}) {
  const [open, setOpen] = useState(false);
  const [hits, setHits] = useState<"checking" | Hit[] | null>(null);
  const [story, setStory] = useState<"checking" | Story | { error: string } | null>(null);

  const [scan, setScan] = useState<{ reviewed: number; limited: number; failed: string[] } | null>(null);
  const context = JSON.stringify([dash, canvas, queryContext, drills]);
  const current = useRef(context); current.current = context;
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    request.current?.abort(); setHits(null); setStory(null); setScan(null);
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
      const query = visibleQuery(model, t, dash.crossFilters, drills[t.id]);
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

  const dropHit = (tileId: string) =>
    setHits((h) => Array.isArray(h) ? h.filter((x) => x.tileId !== tileId) : h);

  const applyCoarsen = (hit: NoiseHit) => {
    onDash({ ...dash, tiles: dash.tiles.map((t) => t.id !== hit.tileId ? t : {
      ...t,
      dimensions: t.dimensions.map((d) =>
        d.includes(":") && d.split(":")[0] === hit.grain ? `${hit.next}:${d.split(":")[1]}` : d),
    }) });
    dropHit(hit.tileId);
  };

  const applyRemoveBreakdown = (hit: DegenerateHit) => {
    // Caps the tile down to KPI height rather than leaving it sized for
    // whatever chart it was before -- a bare number in a tile still sized
    // for a full chart is a huge dead gap, not a fix.
    onDash({ ...dash, tiles: dash.tiles.map((t) => t.id !== hit.tileId ? t : {
      ...t, dimensions: [], chart: undefined,
      layout: { ...t.layout, h: Math.min(t.layout.h, KPI_HEIGHT) } }) });
    dropHit(hit.tileId);
  };

  const applyShowOverTime = (hit: DegenerateHit) => {
    if (!hit.timeDimension) return;
    onDash({ ...dash, tiles: dash.tiles.map((t) => t.id !== hit.tileId ? t : {
      ...t, dimensions: [`month:${hit.timeDimension}`], chart: undefined,
      layout: { ...t.layout, h: Math.max(t.layout.h, CHART_MIN_HEIGHT) } }) });
    dropHit(hit.tileId);
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
      <button className="tgl" onClick={run} disabled={!dash.tiles.length}
              title="Suggest a title and a top-to-bottom reading order for the whole dashboard, and flag any tile that's hard to read at its current grain. Review the current results and composition. Changes are applied only when you choose a suggestion.">
        <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M3 17l7-7" strokeLinecap="round" />
          <path d="M13 3v3M11.5 4.5h3" strokeLinecap="round" />
          <path d="M16.5 8.5v2M15.5 9.5h2" strokeLinecap="round" />
        </svg>
        Design review
      </button>
      {open && (
        <div className="dash-beautify-pop">
          <div className="explain-head">
            <span>Design review</span>
            <button className="icon" onClick={() => setOpen(false)} aria-label="Close">✕</button>
          </div>
          <div className="beautify-body">
            {hits === "checking" && <p className="explain-body loading">Checking every tile for hard-to-read or pointless charts…</p>}
            {Array.isArray(hits) && hits.length > 0 && (
              <div className="beautify-suggestion">
                {hits.map((h) => h.kind === "noise" ? (
                  <div key={h.tileId} className="noise-hit">
                    <span title={`${h.title} — noisy at the ${h.grain} grain`}>{h.title}</span>
                    <button className="primary small" onClick={() => applyCoarsen(h)}>Switch to {h.next}</button>
                  </div>
                ) : (
                  <div key={h.tileId} className="noise-hit">
                    <span title={`${h.title} — every value but "${h.finding.dominantValue}" is zero`}>{h.title}</span>
                    <div className="story-actions">
                      {h.timeDimension &&
                        <button className="primary small" onClick={() => applyShowOverTime(h)}>Show over time</button>}
                      <button className="primary small" onClick={() => applyRemoveBreakdown(h)}>Remove breakdown</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {scan && <div className="review-coverage" role="status"><b>{scan.failed.length ? "Review incomplete" : "Review complete"}</b><p>{scan.reviewed} charts reviewed{scan.limited ? ` · ${scan.limited} limited result windows` : ""}{scan.failed.length ? ` · ${scan.failed.length} unavailable` : ""}.</p>{scan.failed.map(message => <p key={message} className="err">{message}</p>)}</div>}
            {hits === null && <p className="explain-body">The dashboard changed. <button className="link" onClick={run}>Review this version</button></p>}
            {Array.isArray(hits) && hits.length === 0 &&
              <p className="explain-body">{scan?.failed.length ? "The readable tiles have no additional chart suggestions. The review is incomplete." : "No chart changes suggested for the results reviewed."}</p>}

            {!aiAvailable &&
              <p className="explain-body hint">Connect an AI provider in Connections for editorial suggestions. Chart checks work without AI.</p>}
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
