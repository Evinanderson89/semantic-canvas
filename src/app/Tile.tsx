import { memo, useEffect, useState } from "react";
import { Chart, DataTable, Stat } from "../charts/Chart.tsx";
import { Kpi } from "./Kpi.tsx";
import { TileActions } from "./TileChrome.tsx";
import { FONT_STACKS, makeFormatter, mergeTextFormat, resolveFormat, tileFill } from "../format/format.ts";
import { pickImage } from "./imagePicker.ts";
import { inferChart } from "../suggest/chartRules.ts";
import type { TileSpec } from "../compiler/spec.ts";
import type { Model } from "../semantic/model.ts";
import { fieldReachable } from "../semantic/model.ts";
import type { FilterSpec } from "../compiler/spec.ts";

function TileInner({ model, spec, onRemove, onUpdate, locked, crossFilters, onCrossFilter }: {
  model: Model; spec: TileSpec; onRemove: (id: string) => void;
  onUpdate?: (t: TileSpec) => void; locked?: boolean;
  crossFilters?: FilterSpec[];
  onCrossFilter?: (f: FilterSpec) => void;
}) {
  const [state, setState] = useState<any>({ status: "loading" });
  const kindOf = spec.kind ?? "metric";

  // One key covering everything the query depends on. `where` and `limit` were
  // missing before, so changing a filter left the tile showing the previous
  // result with no sign it was stale.
  const base = spec.metrics.length ? model.metrics[spec.metrics[0]]?.baseTable : null;
  // Only cross-filters this tile's join graph can actually reach.
  const applicable = (crossFilters ?? []).filter(
    (f) => base != null && f.source === "dimension" && fieldReachable(model, base, f.field));
  const where = [...(spec.where ?? []), ...applicable];

  const queryKey = JSON.stringify({
    m: spec.metrics, d: spec.dimensions, w: where, l: spec.limit,
    c: spec.compare,
  });

  useEffect(() => {
    if (kindOf !== "metric") return;
    const ac = new AbortController();
    setState({ status: "loading" });
    // Send the QUERY, not the tile. Layout, format and spark are presentation;
    // including them meant moving a tile changed the body of a data request,
    // which makes caching and de-duping impossible.
    const query = {
      id: spec.id, metrics: spec.metrics, dimensions: spec.dimensions,
      where, limit: spec.limit, compare: spec.compare,
    };
    fetch("/api/query", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(query), signal: ac.signal,
    })
      .then(async (r) => ({ ok: r.ok, body: await r.json() }))
      .then(({ ok, body }) => {
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
  const title = spec.title ?? spec.metrics.map((m) => model.metrics[m]?.label ?? m).join(", ");

  return (
    <div className="tile" style={{ background: tileFill(fmt),
                                   borderColor: fmt.border ? undefined : "transparent" }}>
      {kind !== "kpi" && (
        <header>
          <h4>{title}</h4>
          {state.status === "ok" &&
            <span className="ms mono">{state.ms}ms</span>}
          <span className="spacer" />
          {!locked && <TileActions sql={state.sql} onRemove={() => onRemove(spec.id)} />}
        </header>
      )}
      <div className={"body" + (kind === "kpi" ? " kpi-body" : "")}
           style={{ padding: fmt.padding }}>
        {state.status === "loading" && <span style={{ color: "var(--ink-3)" }}>Running…</span>}
        {state.status === "error" && <div className="err">{state.message}</div>}
        {state.status === "ok" && (
          kind === "kpi"
            ? <Kpi label={title}
                   series={(state.rows ?? []).map((r: any[]) =>
                     ({ x: r[0], y: Number(r[r.length - 1]) }))}
                   options={spec.spark} format={makeFormatter(fmt)}
                   onOptions={onUpdate && !locked ? (spark) => onUpdate({ ...spec, spark }) : undefined} />
          : kind === "stat"
            ? <Stat label={title} value={state.rows?.[0]?.[state.columns.length - 1]} />
            : kind === "table"
              ? <DataTable columns={state.columns} rows={state.rows} />
              : <Chart kind={kind} {...projectCompare(spec, state)} format={fmt}
                       onPick={onCrossFilter && spec.dimensions?.length
                         ? (col, value) => {
                             const dim = (spec.dimensions ?? []).find(
                               (d) => (d.includes(":") ? d.split(":")[1] : d).split(".").pop() === col);
                             if (!dim || dim.includes(":")) return;   // time is not a cross-filter
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
  a.crossFilters === b.crossFilters);

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
