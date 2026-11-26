import { useEffect, useId, useState } from "react";
import type { SparkOptions, TileSpec } from "../compiler/spec.ts";
import { DEFAULT_SPARK } from "../compiler/spec.ts";
import { metricOf, semanticHints, type Model } from "../semantic/model.ts";
import { FONT_LABELS, FONT_STACKS, PALETTES, inferNumberStyle, mergeTextFormat,
         type FormatSpec, type NumberStyle } from "../format/format.ts";
import { recommend, type VizOption } from "../suggest/recommend.ts";
import { useFieldProfiles } from "./useFieldProfiles.ts";
import { resolvedChartKind } from "../suggest/chartRules.ts";
import { cardComparison, withCardComparison, CARD_COMPARISONS } from "../charts/cardComparison.ts";
import { pickImage } from "./imagePicker.ts";
import { TileLineageAndDriversSection } from "./TileLineageAndDrivers.tsx";

/**
 * Formatting happens after a tile is on the canvas, against the selection --
 * the same place you already are when you notice something is wrong. Everything
 * it writes lands on the tile spec, so it survives Copy spec and an agent can
 * set the same fields.
 */
export function Inspector({ model, tile, queryContext = "", onChange, onClose, onExplore, onSetupDetails, onSmartDetails }: {
  onExplore?: () => void;
  onSetupDetails?: () => void;
  onSmartDetails?: () => void;
  model: Model; tile: TileSpec; queryContext?: string;
  onChange: (t: TileSpec) => void; onClose: () => void;
}) {
  const f: FormatSpec = mergeTextFormat(tile.format);
  const inferred = inferNumberStyle(model, tile);
  const kind = resolvedChartKind(model, tile);
  const isKpi = kind === "kpi";
  const base = tile.metrics.length ? metricOf(model, tile.metrics[0])?.baseTable : null;
  const { profiles, error: profileError, retry } = useFieldProfiles(model, base, tile.dimensions ?? [], JSON.stringify([tile.id, tile.metrics, queryContext]));

  const options: VizOption[] = profiles
    ? recommend(tile.metrics, profiles, semanticHints(model, tile.metrics)) : [];
  const fmt = (p: Partial<FormatSpec>) => onChange({ ...tile, format: { ...tile.format, ...p } });
  const spark = (p: Partial<SparkOptions>) => onChange({ ...tile, spark: { ...tile.spark, ...p } });
  const sp: SparkOptions = { ...DEFAULT_SPARK, ...(tile.spark ?? {}) };

  return (
    <aside className="inspector">
      <div className="ins-head">
        <b>{tile.title ?? tile.metrics.map((m) => metricOf(model, m)?.label ?? m).join(", ")}</b>
        <button className="x" aria-label="Close inspector" onClick={onClose}>✕</button>
      </div>

      {(!tile.kind || tile.kind === "metric") && onExplore && <section className="ins-sec inspector-explore">
        <button className="primary" onClick={onExplore}>Open detail dashboard</button>
        <p className="muted sm">Open a centered dashboard of related charts using the details button. KPI values also open it.</p>
        <div className="inspector-detail-actions">
          {onSmartDetails && <button className="review-action" onClick={onSmartDetails}>✦ Smart-add story details</button>}
          {onSetupDetails && <button className="review-action" onClick={onSetupDetails}>{tile.detailDashboard ? "Edit detail dashboard" : "Set up detail dashboard"}</button>}
        </div>
      </section>}
      {tile.kind && tile.kind !== "metric" ? (
        <>
          <Section title={tile.kind === "divider" ? "Divider" : tile.kind === "image" ? "Image" : "Text"}>
            {tile.kind === "divider" ? (
              <p className="muted sm">A horizontal rule. Resize it to set its width.</p>
            ) : tile.kind === "image" ? (
              <>
                <button className="use" onClick={() => pickImage((data) => onChange({ ...tile, imageData: data }))}>
                  {tile.imageData ? "Replace image" : "Choose an image"}
                </button>
                <p className="muted sm">Stored in the dashboard itself (as a data URI) -- there's no
                  separate asset upload here, so keep it under 4MB.</p>
              </>
            ) : (
              <>
                <textarea className="txt area" rows={tile.kind === "heading" ? 2 : 5}
                          value={tile.text ?? tile.title ?? ""} placeholder="Type here…"
                          onChange={(e) => onChange({ ...tile, text: e.target.value })} />
                <p className="muted sm">You can also click into it on the canvas.</p>
              </>
            )}
          </Section>
          {tile.kind !== "divider" && tile.kind !== "image" && (
            <Section title="Style">
              <label className="mini-row">
                <span>Font</span>
                <select value={f.fontFamily} style={{ fontFamily: FONT_STACKS[f.fontFamily] }}
                        onChange={(e) => fmt({ fontFamily: e.target.value as FormatSpec["fontFamily"] })}>
                  {(Object.keys(FONT_LABELS) as FormatSpec["fontFamily"][]).map((k) => (
                    <option key={k} value={k} style={{ fontFamily: FONT_STACKS[k] }}>{FONT_LABELS[k]}</option>
                  ))}
                </select>
              </label>
              <TextSizeInput key={tile.id} value={f.textSize} onChange={textSize => fmt({ textSize })} />
              <Segs value={(tile.format?.textAlign ?? "left") as "left" | "center" | "right"}
                    onChange={(v) => onChange({ ...tile, format: { ...tile.format, textAlign: v } })}
                    opts={[["left", "left"], ["center", "centre"], ["right", "right"]]} />
              <div className="checks">
                <Check on={f.textItalic} onChange={(v) => fmt({ textItalic: v })}>Italic</Check>
                <Check on={f.textUnderline} onChange={(v) => fmt({ textUnderline: v })}>Underline</Check>
              </div>
            </Section>
          )}
          {tile.kind === "image" && (
            <Section title="Fit">
              <Segs value={f.imageFit} onChange={(v) => fmt({ imageFit: v })}
                    opts={[["contain", "fit inside"], ["cover", "fill (crops)"]] as [FormatSpec["imageFit"], string][]} />
            </Section>
          )}
          <Section title="Tile">
            <div className="checks">
              <Check on={f.background} onChange={(v) => fmt({ background: v })}>Background</Check>
              <Check on={f.border} onChange={(v) => fmt({ border: v })}>Border</Check>
            </div>
            {f.background && <BackgroundControls f={f} fmt={fmt} />}
          </Section>
        </>
      ) : (
        <>
          <Section title="Title">
            <input className="txt" value={tile.title ?? ""} placeholder="Tile title"
                   onChange={(e) => onChange({ ...tile, title: e.target.value })} />
          </Section>

          <Section title="Visualization">
            <p className="muted sm">Suggestions use field profiles for the current source and role. Dashboard and chart filters are not included in these profiles.</p>
            {profiles?.some(p => p.warning) && <><p className="sm" role="status">Some field evidence is unavailable. Suggestions use the available evidence and field types.</p><button className="review-action" onClick={retry}>Retry field profiles</button></>}
            {profileError ? <><p className="sm" role="alert">{profileError}</p><button className="review-action" onClick={retry}>Retry field profiles</button></>
              : !profiles ? <p className="muted sm" role="status">Profiling…</p> : (
              <div className="viz-list">
                {options.map((o) => (
                  <button key={o.kind} className={"viz-row " + o.fit + (kind === resolvedChartKind(model, { ...tile, chart: o.kind }) ? " on" : "")}
                          title={o.why}
                          onClick={() => onChange({ ...tile, chart: o.kind })}>
                    <span>{o.label}</span><em className={"fit " + o.fit}>{o.fit}</em>
                  </button>
                ))}
              </div>
            )}
          </Section>

          {(isKpi || (tile.dimensions ?? []).some((d) => d.includes(":"))) && (
            <Section title="Compare">
              {isKpi ? <Segs value={cardComparison(tile)} onChange={v => onChange(withCardComparison(tile, v))}
                opts={CARD_COMPARISONS.filter(([v]) => tile.dimensions.some(d => d.includes(":")) || v === "none" || v === "first")} />
              : <Segs value={(tile.compare ?? "none") as "none" | "prior" | "yoy"}
                    onChange={(v) => onChange({ ...tile, compare: v })}
                    opts={[["none", "none"], ["prior", "vs prior"], ["yoy", "vs last year"]]} />}
              {!isKpi && tile.compare && tile.compare !== "none" && (
                <Segs value={(tile.compareShow ?? "value") as "value" | "delta" | "percent"}
                      onChange={(v) => onChange({ ...tile, compareShow: v })}
                      opts={[["value", "value"], ["delta", "change"], ["percent", "% change"]]} />
              )}
              <p className="muted sm">
                {isKpi ? "Choose a comparison period. Missing comparisons stay blank."
                  : "Adds the prior period, the change and the % change alongside each measure."}
              </p>
            </Section>
          )}

          <Section title="Numbers">
            <Segs value={f.number} onChange={(v) => fmt({ number: v })}
                  opts={[["auto", `auto (${inferred})`], ["currency", "currency"],
                         ["percent", "percent"], ["compact", "compact"], ["plain", "plain"]] as [NumberStyle, string][]} />
            <label className="mini-row">
              <span>Decimals</span>
              <select value={f.decimals ?? ""} onChange={(e) => fmt({
                decimals: e.target.value === "" ? null : +e.target.value })}>
                <option value="">auto</option>
                {[0, 1, 2, 3].map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </label>
          </Section>

          {isKpi ? (
            <Section title="Sparkline">
              <Segs value={sp.shape} onChange={(v) => spark({ shape: v })}
                    opts={[["line", "line"], ["area", "area"], ["bar", "bar"]] as [SparkOptions["shape"], string][]} />
              <Segs value={sp.scale} onChange={(v) => spark({ scale: v })}
                    opts={[["fit", "fit"], ["zero", "from 0"]] as [SparkOptions["scale"], string][]} />
              <div className="checks">
                <Check on={sp.showRange} onChange={(v) => spark({ showRange: v })}>Range labels</Check>
                <Check on={sp.showMinMax} onChange={(v) => spark({ showMinMax: v })}>Min / max</Check>
              </div>
            </Section>
          ) : kind !== "stat" && kind !== "table" ? (
            <>
              <Section title="Axes">
                <div className="checks">
                  <Check on={f.showX} onChange={(v) => fmt({ showX: v })}>X axis</Check>
                  <Check on={f.showY} onChange={(v) => fmt({ showY: v })}>Y axis</Check>
                  <Check on={f.grid} onChange={(v) => fmt({ grid: v })}>Gridlines</Check>
                </div>
                <input className="txt" value={f.xTitle ?? ""} placeholder="X axis title"
                       onChange={(e) => fmt({ xTitle: e.target.value || null })} />
                {kind === "line" && <label className="mini-row"><span>Line Y-axis</span>
                  <select aria-label="Line Y-axis" value={f.lineScale} onChange={e => fmt({ lineScale: e.target.value as FormatSpec["lineScale"] })}>
                    <option value="zero">Include zero</option><option value="fit">Fit to data</option>
                  </select>
                </label>}
                {kind === "line" && f.lineScale === "fit" && <p className="muted sm">Shows variation within the observed range. The chart labels its fitted range; bars and areas keep their zero baseline.</p>}
                <input className="txt" value={f.yTitle ?? ""} placeholder="Y axis title"
                       onChange={(e) => fmt({ yTitle: e.target.value || null })} />
              </Section>

              <Section title="Colour">
                <div className="pals">
                  {Object.entries(PALETTES).map(([name, colors]) => (
                    <button key={name} className={"pal" + (f.palette === name ? " on" : "")}
                            title={name} onClick={() => fmt({ palette: name })}>
                      {colors.slice(0, 5).map((c) => (
                        <i key={c} style={{ background: c }} />
                      ))}
                    </button>
                  ))}
                </div>
                <Check on={f.legend !== "hide"}
                       onChange={(v) => fmt({ legend: v ? "auto" : "hide" })}>Legend</Check>
              </Section>
            </>
          ) : null}

          <Section title="Tile">
            <div className="checks">
              <Check on={f.background} onChange={(v) => fmt({ background: v })}>Background</Check>
              <Check on={f.border} onChange={(v) => fmt({ border: v })}>Border</Check>
            </div>
            {f.background && <BackgroundControls f={f} fmt={fmt} />}
            <label className="mini-row">
              <span>Padding</span>
              <input type="range" min={0} max={32} value={f.padding}
                     onChange={(e) => fmt({ padding: +e.target.value })} />
              <em>{f.padding}px</em>
            </label>
          </Section>

          <TileLineageAndDriversSection model={model} tile={tile} onChange={onChange} />
        </>
      )}
    </aside>
  );
}

/** Keep incomplete input out of the dashboard spec and its saved history. */
function TextSizeInput({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  const id = useId();
  useEffect(() => setDraft(String(value)), [value]);
  const number = Number(draft);
  const valid = draft.trim() !== "" && Number.isFinite(number) && number >= 1 && number <= 500;
  const commit = () => {
    if (valid && number !== value) onChange(number);
    setDraft(String(valid ? number : value));
  };
  return <>
    <label className="mini-row">
      <span>Size</span>
      <input type="number" min={1} max={500} step="any" list={`${id}-sizes`} value={draft}
        aria-invalid={!valid} aria-describedby={!valid ? `${id}-error` : undefined}
        onChange={e => setDraft(e.target.value)} onBlur={commit}
        onKeyDown={e => {
          if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); commit(); }
          if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setDraft(String(value)); }
        }} />
      <em>px</em>
      <datalist id={`${id}-sizes`}>
        {[12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 64, 96].map(s => <option key={s} value={s} />)}
      </datalist>
    </label>
    {!valid && <p id={`${id}-error`} role="status" className="muted sm">Enter a size from 1 to 500 px. The current size stays unchanged until the value is valid.</p>}
  </>;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="ins-sec"><h5>{title}</h5>{children}</section>;
}

/** Generic so each caller's onChange receives its own union, not `string`. */
function Segs<T extends string>({ value, onChange, opts }: {
  value: T; onChange: (v: T) => void; opts: [T, string][];
}) {
  return (
    <div className="segs">{opts.map(([v, label]) => (
      <button key={v} className={"seg" + (value === v ? " on" : "")}
              onClick={() => onChange(v)}>{label}</button>
    ))}</div>
  );
}

/** Color + opacity, shared by every "Tile" section -- text, image and metric
 *  tiles all get the same transparency control, not just text tiles. */
function BackgroundControls({ f, fmt }: { f: FormatSpec; fmt: (p: Partial<FormatSpec>) => void }) {
  return (
    <>
      <label className="mini-row">
        <span>Colour</span>
        <input type="color" className="colorpick" value={f.backgroundColor ?? "#161b21"}
               onChange={(e) => fmt({ backgroundColor: e.target.value })} />
        {f.backgroundColor && (
          <button className="link" onClick={() => fmt({ backgroundColor: null })}>Reset</button>
        )}
      </label>
      <label className="mini-row">
        <span>Opacity</span>
        <input type="range" min={0} max={100} value={f.backgroundOpacity}
               onChange={(e) => fmt({ backgroundOpacity: +e.target.value })} />
        <em>{f.backgroundOpacity}%</em>
      </label>
    </>
  );
}

function Check({ on, onChange, children }: {
  on: boolean; onChange: (v: boolean) => void; children: React.ReactNode;
}) {
  return (
    <label className="check"><input type="checkbox" checked={on}
      onChange={(e) => onChange(e.target.checked)} />{children}</label>
  );
}
