import { memo, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Chart, DataTable, Stat } from "../charts/Chart.tsx";
import { Kpi } from "./Kpi.tsx";
import { TileActions } from "./TileChrome.tsx";
import { FONT_STACKS, makeFormatter, mergeTextFormat, resolveFormat, tileFill } from "../format/format.ts";
import { pickImage } from "./imagePicker.ts";
import { inferChart } from "../suggest/chartRules.ts";
import type { TileSpec } from "../compiler/spec.ts";
import type { Model } from "../semantic/model.ts";
import { fieldReachable, semanticHints, timeColumnOf } from "../semantic/model.ts";
import type { FilterSpec } from "../compiler/spec.ts";
import { drillInto, type DrillEntry, type DrillGrain } from "./drill.ts";
import { downloadCsv, downloadPng, slugForFilename } from "./export.ts";
import { renderMarkdown } from "./markdown.tsx";
import { betterKind, coarserGrain, detectDegenerate, detectNoisy, recommend,
         type DegenerateFinding, type FieldProfile, type VizOption } from "../suggest/recommend.ts";

/** The column alias a dimension resolves to in query results, matching the
 *  compiler's own convention exactly (compile.ts: `${column}_${grain}` for
 *  a time bucket, else the bare column) -- needed to map a chart's clicked
 *  column name back to the dimension string that produced it. */
function dimAlias(d: string): string {
  if (d.includes(":")) {
    const [grain, rest] = d.split(":", 2);
    return `${rest.includes(".") ? rest.split(".")[1] : rest}_${grain}`;
  }
  return d.includes(".") ? d.split(".")[1] : d;
}

/** A KPI card's natural height -- matches the headline tiles Exec Summary
 *  already packs at this height (layouts.ts: layoutExecSummary). A chart
 *  needs enough room for axis labels and a legend to not read as cramped. */
const KPI_HEIGHT = 156;
const CHART_MIN_HEIGHT = 300;

function TileInner({ model, spec, onRemove, onUpdate, locked, crossFilters, onCrossFilter,
                     drill, onDrill, onDrillUp, aiAvailable, queryContext }: {
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
  const [explain, setExplain] = useState<{ status: "loading" | "ok" | "error"; text: string } | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [beautifyOpen, setBeautifyOpen] = useState(false);
  const [ruleSuggestion, setRuleSuggestion] = useState<VizOption | null | "checking">(null);
  const [noiseSuggestion, setNoiseSuggestion] = useState<{ measure: string; grain: string; next: string } | null>(null);
  const [degenerateSuggestion, setDegenerateSuggestion] =
    useState<(DegenerateFinding & { timeDimension: string | null }) | null>(null);
  const [agentTips, setAgentTips] = useState<{ status: "loading" | "ok" | "error"; text: string } | null>(null);
  const tileRef = useRef<HTMLDivElement>(null);
  const kindOf = spec.kind ?? "metric";

  // One key covering everything the query depends on. `where` and `limit` were
  // missing before, so changing a filter left the tile showing the previous
  // result with no sign it was stale.
  const base = spec.metrics.length ? model.metrics[spec.metrics[0]]?.baseTable : null;
  // Only cross-filters this tile's join graph can actually reach.
  const applicable = (crossFilters ?? []).filter(
    (f) => base != null && f.source === "dimension" && fieldReachable(model, base, f.field));

  // The active drill (if any) swaps the time dimension's grain for the next
  // finer one and scopes the query to the clicked bucket's exact range --
  // this is what "zoom into March" actually means: a finer grain AND a
  // narrower window, not just one or the other.
  const activeDrill = drill && drill.length ? drill[drill.length - 1] : null;
  const timeDimIndex = (spec.dimensions ?? []).findIndex((d) => d.includes(":"));
  const dimensions = activeDrill && timeDimIndex !== -1
    ? spec.dimensions.map((d, i) => i === timeDimIndex ? `${activeDrill.grain}:${d.split(":")[1]}` : d)
    : spec.dimensions;
  const grain = timeDimIndex !== -1 ? dimensions[timeDimIndex].split(":")[0] : null;
  const where = [
    ...(spec.where ?? []), ...applicable,
    ...(activeDrill ? [{
      id: `drill:${spec.id}`, field: activeDrill.column, source: "dimension" as const,
      mode: "range" as const, min: activeDrill.min, max: activeDrill.max,
    }] : []),
  ];

  const queryKey = JSON.stringify({
    m: spec.metrics, d: dimensions, w: where, l: spec.limit,
    c: spec.compare, queryContext,
  });

  useEffect(() => {
    if (kindOf !== "metric") return;
    const ac = new AbortController();
    setState({ status: "loading" });
    // Send the QUERY, not the tile. Layout, format and spark are presentation;
    // including them meant moving a tile changed the body of a data request,
    // which makes caching and de-duping impossible.
    const query = {
      id: spec.id, metrics: spec.metrics, dimensions,
      where, limit: spec.limit, compare: spec.compare,
    };
    fetch("/api/query", {
      method: "POST", headers: { "content-type": "application/json", "x-sc-refresh": queryContext ?? "" },
      body: JSON.stringify(query), signal: ac.signal,
    })
      .then(async (r) => ({ ok: r.ok, body: await r.json() }))
      .then(({ ok, body }) => {
        if (ac.signal.aborted) return;
        setState(ok ? { status: "ok", ...body }
          : { status: "error", message: body.issues
              ? body.issues.map((i: any) => i.problem).join("; ") : body.error });
      })
      .catch((e) => {
        // An aborted request is a superseded one, not a failure to report.
        if (e?.name !== "AbortError") setState({ status: "error", message: String(e) });
      });
    return () => ac.abort();
  }, [queryKey, kindOf]);

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
          {spec.text}
        </div>
        {!locked && <TileActions onRemove={() => onRemove(spec.id)} />}
      </div>
    );
  }

  const kind = spec.chart ?? inferChart(model, spec);
  const fmt = resolveFormat(model, spec);
  // A combo tile's bar and line are two DIFFERENT metrics by fixed position
  // (see Chart.tsx), and each can need its own number style -- spend as
  // currency, click-through rate as a percent. `fmt` above already answers
  // "what style for the first metric"; this is the same question asked of
  // the second one, only computed here (not in Chart.tsx, which has no
  // model to infer a style from) and handed down for the secondary axis.
  const secondaryFmt = kind === "combo" && spec.metrics.length > 1
    ? resolveFormat(model, { ...spec, metrics: [spec.metrics[1]] }) : undefined;
  const title = spec.title ?? spec.metrics.map((m) => model.metrics[m]?.label ?? m).join(", ");

  const runExplain = () => {
    setExplain({ status: "loading", text: "" });
    fetch("/api/agent/explain", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title, metrics: spec.metrics, dimensions, where, compare: spec.compare,
        columns: state.columns, rows: state.rows,
      }),
    }).then((r) => r.json()).then((d) => {
      setExplain(d.error ? { status: "error", text: d.error } : { status: "ok", text: d.text || "(no explanation)" });
    }).catch((e) => setExplain({ status: "error", text: String(e?.message ?? e) }));
  };

  const exportCsv = () => {
    if (state.status !== "ok") return;
    downloadCsv(`${slugForFilename(title)}.csv`, state.columns, state.rows);
    setExportOpen(false);
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
    setBeautifyOpen(true);
    setAgentTips(null);
    setRuleSuggestion("checking");
    // The noise check is local (already-fetched rows, no fetch of its own)
    // and orthogonal to the chart-KIND check above -- a chart can be the
    // structurally right kind and still be an unreadable zigzag at its
    // current grain. Skipped mid-drill: the grain a drilled-in tile is
    // showing isn't the tile's own configured grain, so "coarsen it" would
    // mean something different from what the button would actually change.
    setNoiseSuggestion(() => {
      if (activeDrill || timeDimIndex === -1) return null;
      const grain = spec.dimensions[timeDimIndex].split(":")[0];
      const next = coarserGrain(grain);
      if (!next) return null;
      const found = detectNoisy(state.rows ?? [], state.columns ?? [], spec.metrics);
      return found.length ? { measure: found[0].measure, grain, next } : null;
    });
    // A THIRD rules check, also local: a single-dimension, single-measure
    // breakdown where only one category actually carries a value -- the
    // classic cause being a metric already filtered to one value of the
    // exact dimension it's cut by (New MRR broken down by movement_type,
    // when New MRR is already `movement_type = 'new'`). Scoped to exactly
    // this shape and a non-temporal dimension, same reasoning as the noise
    // check above: a time series legitimately having one active period
    // among empty ones is a real finding, not a pointless chart.
    setDegenerateSuggestion(() => {
      if (spec.dimensions.length !== 1 || spec.metrics.length !== 1 || spec.dimensions[0].includes(":")) return null;
      const finding = detectDegenerate(state.rows ?? [], state.columns ?? [], dimAlias(spec.dimensions[0]), spec.metrics[0]);
      // A dead breakdown is better rescued as a trend over the base table's
      // own date column, when it has one, than collapsed to a bare number --
      // "removed" throws away an axis this data actually has something to
      // say on.
      return finding ? { ...finding, timeDimension: timeColumnOf(model, base) } : null;
    });
    try {
      const bare = dimensions.map((d) => (d.includes(":") ? d.split(":")[1] : d));
      let profiles: FieldProfile[] = [];
      if (base && bare.length) {
        const r = await fetch(`/api/profile?base=${base}&fields=${encodeURIComponent(bare.join(","))}`)
          .then((x) => x.json());
        profiles = (r.fields ?? []).map((p: FieldProfile, i: number) =>
          dimensions[i]?.includes(":") ? { ...p, role: "temporal" } : p);
      }
      const options = recommend(spec.metrics, profiles, semanticHints(model, spec.metrics));
      setRuleSuggestion(betterKind(kind, options));
    } catch (e: any) {
      console.error("beautify rules check failed:", e);
      setRuleSuggestion(null);
    }
  };
  const applySuggestion = (opt: VizOption) => {
    onUpdate?.({ ...spec, chart: opt.kind });
    setRuleSuggestion(null);
  };
  const applyCoarsen = () => {
    if (!noiseSuggestion) return;
    onUpdate?.({ ...spec, dimensions: spec.dimensions.map((d, i) =>
      i === timeDimIndex ? `${noiseSuggestion.next}:${d.split(":")[1]}` : d) });
    setNoiseSuggestion(null);
  };
  const applyRemoveBreakdown = () => {
    if (!degenerateSuggestion) return;
    // The tile's height was sized for whatever chart it was before --
    // collapsing to a bare KPI without also shrinking it left a huge dead
    // gap below a single line of text. Only ever caps down, never grows a
    // tile that was already this short or shorter.
    onUpdate?.({ ...spec, dimensions: [], chart: undefined,
      layout: { ...spec.layout, h: Math.min(spec.layout.h, KPI_HEIGHT) } });
    setDegenerateSuggestion(null);
  };
  const applyShowOverTime = () => {
    if (!degenerateSuggestion?.timeDimension) return;
    // The reverse case: a tile that's currently KPI-height doesn't have
    // room for a real chart's axis labels once it becomes one.
    onUpdate?.({ ...spec, dimensions: [`month:${degenerateSuggestion.timeDimension}`], chart: undefined,
      layout: { ...spec.layout, h: Math.max(spec.layout.h, CHART_MIN_HEIGHT) } });
    setDegenerateSuggestion(null);
  };
  const runAgentTips = () => {
    setAgentTips({ status: "loading", text: "" });
    fetch("/api/agent/beautify", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title, metrics: spec.metrics, dimensions, where, compare: spec.compare,
        columns: state.columns, rows: state.rows,
      }),
    }).then((r) => r.json()).then((d) => {
      setAgentTips(d.error ? { status: "error", text: d.error } : { status: "ok", text: d.text || "(no suggestions)" });
    }).catch((e) => setAgentTips({ status: "error", text: String(e?.message ?? e) }));
  };

  return (
    <div className="tile" ref={tileRef} style={{ background: tileFill(fmt),
                                   borderColor: fmt.border ? undefined : "transparent" }}>
      {kind !== "kpi" && (
        <header>
          <h4 title={title}>{title}</h4>
          {state.status === "ok" &&
            <span className="ms mono">{state.ms}ms</span>}
          {state.status === "ok" && state.coverage === "unknown" && <span className="ms mono" title="The source has not declared period completeness. All observed buckets are shown, including possibly incomplete periods.">Coverage unverified</span>}
          {state.status === "ok" && (state.partial?.start || state.partial?.end) && (
            <span className="ms mono partial-note"
                  title={`This ${grain ?? "period"}'s data doesn't cover the whole ${grain ?? "period"} yet, ` +
                         `so it's left out rather than shown as a misleading low point.`}>
              partial {state.partial.start && state.partial.end ? "start & end" : state.partial.start ? "start" : "end"} excluded
            </span>
          )}
          <span className="spacer" />
          <TileActions sql={!locked ? state.sql : undefined}
                       onRemove={!locked ? () => onRemove(spec.id) : undefined}
                       onExplain={aiAvailable && state.status === "ok" ? runExplain : undefined}
                       onBeautify={!locked && state.status === "ok" ? runBeautify : undefined}
                       onExport={state.status === "ok" ? () => setExportOpen((v) => !v) : undefined} />
        </header>
      )}
      {beautifyOpen && (
        <div className="explain-pop beautify-pop">
          <div className="explain-head">
            <span>Beautify</span>
            <button className="icon" onClick={() => setBeautifyOpen(false)} aria-label="Close">✕</button>
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
                  <b>{model.metrics[noiseSuggestion.measure]?.label ?? noiseSuggestion.measure}</b> swings
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
                  Every {degenerateSuggestion.dimension.split(".").pop()} except <b>{degenerateSuggestion.dominantValue}</b> reads
                  zero here — this breakdown doesn't actually vary for this measure.
                  {degenerateSuggestion.timeDimension && " Try it as a trend over time instead."}
                </p>
                <div className="story-actions">
                  {degenerateSuggestion.timeDimension &&
                    <button className="primary small" onClick={applyShowOverTime}>Show over time</button>}
                  <button className="primary small" onClick={applyRemoveBreakdown}>Remove breakdown</button>
                </div>
              </div>
            )}
            {ruleSuggestion === null && !noiseSuggestion && !degenerateSuggestion &&
              <p className="explain-body">This already reads well.</p>}
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
        </div>
      )}
      {exportOpen && (
        <div className="explain-pop export-pop">
          <div className="explain-head">
            <span>Export</span>
            <button className="icon" onClick={() => setExportOpen(false)} aria-label="Close">✕</button>
          </div>
          <div className="export-opts">
            <button onClick={exportCsv}>Download CSV</button>
            <button onClick={exportPng}>Download PNG</button>
          </div>
        </div>
      )}
      {explain && (
        <div className="explain-pop">
          <div className="explain-head">
            <span>Explain</span>
            <button className="icon" onClick={() => setExplain(null)} aria-label="Close">✕</button>
          </div>
          {explain.status === "loading" && <p className="explain-body loading">Thinking…</p>}
          {explain.status === "error" && <p className="explain-body error">{explain.text}</p>}
          {explain.status === "ok" && <div className="explain-body">{renderMarkdown(explain.text)}</div>}
        </div>
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
      <div className={"body" + (kind === "kpi" ? " kpi-body" : "")}
           style={{ padding: fmt.padding }}>
        {state.status === "loading" && <span style={{ color: "var(--ink-3)" }}>Running…</span>}
        {state.status === "error" && <div className="err">{state.message}</div>}
        {state.status === "ok" && (state.rows?.length ?? 0) === 0 && (state.partial?.start || state.partial?.end) && (
          // Distinct from a plain "no data" empty tile: there IS data here,
          // it just doesn't span one full period at this grain yet -- e.g.
          // a source only a few days old, viewed at month grain. Naming
          // that beats a bare empty chart, which reads as broken rather
          // than "too early".
          <span style={{ color: "var(--ink-3)" }}>Not enough data yet for a full {grain}.</span>
        )}
        {state.status === "ok" && !((state.rows?.length ?? 0) === 0 && (state.partial?.start || state.partial?.end)) && (
          kind === "kpi"
            ? <Kpi label={title} grain={grain}
                   previous={spec.compare && spec.compare !== "none" ? state.rows?.at(-1)?.[state.columns.indexOf(`${spec.metrics[0]}__prev`)] ?? null : undefined}
                   comparisonLabel={spec.compare === "yoy" ? "same period last year" : "prior period"}
                   series={(state.rows ?? []).map((r: any[]) =>
                     ({ x: r[0], y: r[state.columns.indexOf(spec.metrics[0])] == null ? NaN : Number(r[state.columns.indexOf(spec.metrics[0])]) }))}
                   options={spec.spark} format={makeFormatter(fmt)}
                   onOptions={onUpdate && !locked ? (spark) => onUpdate({ ...spec, spark }) : undefined} />
          : kind === "stat"
            ? <Stat label={title} value={state.rows?.[0]?.[state.columns.length - 1]} />
            : kind === "table"
              ? <DataTable columns={state.columns} rows={state.rows} />
              : <Chart kind={kind} {...projectCompare(spec, state)} format={fmt} secondaryFormat={secondaryFmt}
                       onPick={(onCrossFilter || onDrill) && dimensions?.length
                         ? (col, value) => {
                             const dim = dimensions.find((d) => dimAlias(d) === col);
                             if (!dim) return;
                             if (dim.includes(":")) {
                               if (!onDrill) return;
                               const grain = dim.split(":")[0] as DrillGrain;
                               const column = dim.split(":")[1];
                               const date = value instanceof Date ? value : new Date(String(value));
                               if (Number.isNaN(+date)) return;
                               const entry = drillInto(grain, column, date);
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

/**
 * A drag emits a new tiles array on every pointermove. Without this, all twelve
 * tiles re-render hundreds of times per gesture; with it only the dragged one
 * does, and even that skips the chart because its geometry-independent props
 * are unchanged.
 */
export const Tile = memo(TileInner, (a, b) =>
  a.locked === b.locked &&
  a.model === b.model &&
  a.spec === b.spec &&
  a.crossFilters === b.crossFilters &&
  a.drill === b.drill &&
  a.aiAvailable === b.aiAvailable);

/**
 * When a comparison is active and the user wants to see change rather than
 * level, plot the derived columns instead of the raw measure -- otherwise the
 * chart shows six series where the user asked for two.
 */
function projectCompare(spec: TileSpec, state: any): { columns: string[]; rows: unknown[][] } {
  const cols: string[] = state.columns ?? [];
  const rows: unknown[][] = state.rows ?? [];
  const show = spec.compareShow ?? "value";
  if (!spec.compare || spec.compare === "none") return { columns: cols, rows };

  const suffix = show === "delta" ? "__delta" : show === "percent" ? "__pct" : null;
  const keep = cols.filter((c) =>
    suffix ? !c.includes("__") || c.endsWith(suffix)
           : !c.includes("__"));
  const idx = keep.map((c) => cols.indexOf(c));
  return { columns: keep, rows: rows.map((r) => idx.map((i) => r[i])) };
}
