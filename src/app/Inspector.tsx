import { useEffect, useState } from "react";
import type { SparkOptions, TileSpec } from "../compiler/spec.ts";
import { DEFAULT_SPARK } from "../compiler/spec.ts";
import type { Model } from "../semantic/model.ts";
import { FONT_LABELS, FONT_STACKS, PALETTES, inferNumberStyle, mergeTextFormat,
         type FormatSpec, type NumberStyle } from "../format/format.ts";
import { recommend, type FieldProfile, type VizOption } from "../suggest/recommend.ts";
import { inferChart } from "../suggest/chartRules.ts";
import { pickImage } from "./imagePicker.ts";

/**
 * Formatting happens after a tile is on the canvas, against the selection --
 * the same place you already are when you notice something is wrong. Everything
 * it writes lands on the tile spec, so it survives Copy spec and an agent can
 * set the same fields.
 */
export function Inspector({ model, tile, onChange, onClose }: {
  model: Model; tile: TileSpec;
  onChange: (t: TileSpec) => void; onClose: () => void;
}) {
  const [profiles, setProfiles] = useState<FieldProfile[] | null>(null);
  const f: FormatSpec = mergeTextFormat(tile.format);
  const inferred = inferNumberStyle(model, tile);
  const kind = tile.chart ?? inferChart(model, tile);
  const isKpi = kind === "kpi";
  const bare = (tile.dimensions ?? []).map((d) => (d.includes(":") ? d.split(":")[1] : d));
  const base = tile.metrics.length ? model.metrics[tile.metrics[0]]?.baseTable : null;

  useEffect(() => {
    if (!base || !bare.length) { setProfiles([]); return; }
    fetch(`/api/profile?base=${base}&fields=${encodeURIComponent(bare.join(","))}`)
      .then((r) => r.json())
      .then((d) => setProfiles((d.fields ?? []).map((p: FieldProfile, i: number) =>
        tile.dimensions[i]?.includes(":") ? { ...p, role: "temporal" } : p)));
  }, [tile.id, JSON.stringify(tile.dimensions)]);

  const options: VizOption[] = profiles ? recommend(tile.metrics, profiles) : [];
  const fmt = (p: Partial<FormatSpec>) => onChange({ ...tile, format: { ...tile.format, ...p } });
  const spark = (p: Partial<SparkOptions>) => onChange({ ...tile, spark: { ...tile.spark, ...p } });
  const sp: SparkOptions = { ...DEFAULT_SPARK, ...(tile.spark ?? {}) };

  return (
    <aside className="inspector">
      <div className="ins-head">
        <b>{tile.title ?? tile.metrics.join(", ")}</b>
        <button className="x" onClick={onClose}>✕</button>
      </div>

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
                          value={tile.text ?? ""} placeholder="Type here…"
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
              <label className="mini-row">
                <span>Size</span>
                <input type="number" min={8} max={200} list="text-size-opts" value={f.textSize}
                       onChange={(e) => fmt({ textSize: +e.target.value || 16 })} />
                <em>px</em>
                <datalist id="text-size-opts">
                  {[12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 64, 96].map((s) => <option key={s} value={s} />)}
                </datalist>
              </label>
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
            {!profiles ? <p className="muted sm">Profiling…</p> : (
              <div className="viz-list">
                {options.map((o) => (
                  <button key={o.kind} className={"viz-row " + o.fit + (kind === o.kind ? " on" : "")}
                          title={o.why}
                          onClick={() => onChange({ ...tile, chart: o.kind })}>
                    <span>{o.label}</span><em className={"fit " + o.fit}>{o.fit}</em>
                  </button>
                ))}
              </div>
            )}
          </Section>

          {(tile.dimensions ?? []).some((d) => d.includes(":")) && (
            <Section title="Compare">
              <Segs value={(tile.compare ?? "none") as "none" | "prior" | "yoy"}
                    onChange={(v) => onChange({ ...tile, compare: v })}
                    opts={[["none", "none"], ["prior", "vs prior"], ["yoy", "vs last year"]]} />
              {tile.compare && tile.compare !== "none" && (
                <Segs value={(tile.compareShow ?? "value") as "value" | "delta" | "percent"}
                      onChange={(v) => onChange({ ...tile, compareShow: v })}
                      opts={[["value", "value"], ["delta", "change"], ["percent", "% change"]]} />
              )}
              <p className="muted sm">
                Adds the prior period, the change and the % change alongside each measure.
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
              <Segs value={sp.compare} onChange={(v) => spark({ compare: v })}
                    opts={[["prior", "vs prior"], ["first", "vs first"]] as [SparkOptions["compare"], string][]} />
              <div className="checks">
                <Check on={sp.showRange} onChange={(v) => spark({ showRange: v })}>Range labels</Check>
                <Check on={sp.showMinMax} onChange={(v) => spark({ showMinMax: v })}>Min / max</Check>
              </div>
            </Section>
          ) : (
            <>
              <Section title="Axes">
                <div className="checks">
                  <Check on={f.showX} onChange={(v) => fmt({ showX: v })}>X axis</Check>
                  <Check on={f.showY} onChange={(v) => fmt({ showY: v })}>Y axis</Check>
                  <Check on={f.grid} onChange={(v) => fmt({ grid: v })}>Gridlines</Check>
                </div>
                <input className="txt" value={f.xTitle ?? ""} placeholder="X axis title"
                       onChange={(e) => fmt({ xTitle: e.target.value || null })} />
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
          )}

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
        </>
      )}
    </aside>
  );
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
