import { useEffect, useRef, useState } from "react";
import * as Plot from "@observablehq/plot";
import { sum as d3sum } from "d3-array";
import { scaleLinear } from "d3-scale";
import { axisRight } from "d3-axis";
import { select } from "d3-selection";
import { format as d3format } from "d3-format";
import { COUNTRIES, toFeatureId } from "./geo.ts";
import { DEFAULT_FORMAT, makeFormatter, PALETTES } from "../format/format.ts";
import type { ChartKind } from "../compiler/spec.ts";

/**
 * One interface for every chart type. Observable Plot is D3 underneath and
 * covers the long tail immediately; any individual kind can later be replaced
 * with hand-built D3 primitives without the spec, compiler or canvas noticing.
 */
export function Chart({ kind, columns, rows, format, secondaryFormat, labels = {}, onPick }: {
  kind: ChartKind; columns: string[]; rows: unknown[][]; labels?: Record<string, string>;
  format?: import("../format/format.ts").FormatSpec;
  /** A combo chart's bar and line are two different metrics by fixed
   *  position, each potentially needing its own number style (spend as
   *  currency, click-through rate as a percent) -- computed by the caller,
   *  which has the model to infer a style from and this component doesn't.
   *  Unused by every other chart kind. */
  secondaryFormat?: import("../format/format.ts").FormatSpec;
  /** Click-to-cross-filter (categorical axis) or click-to-drill (temporal
   *  axis). Receives the dimension column and the clicked value -- a string
   *  or number for a category, a Date for a time bucket. */
  onPick?: (column: string, value: string | number | Date) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    // Measure immediately rather than waiting for the observer's first callback.
    // If that callback arrives while the element is still 0x0 -- which happens
    // when the tile mounts inside a transformed canvas -- the draw effect bails,
    // and because a CSS transform does not change layout size, no later resize
    // ever fires to retry. The chart then stays blank until something unrelated
    // forces a reflow.
    const read = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!host.current || box.w < 40 || box.h < 40) return;
    const data = rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, coerce(r[i])])));
    try {
      const el = host.current;
      const mount = (chart: Element) => {
        const figure = chart.tagName.toLowerCase() === "figure" ? chart : document.createElement("figure");
        if (figure !== chart) figure.appendChild(chart);
        el.replaceChildren(figure);
      };
      mount(render(kind, columns, data, box, format, secondaryFormat, labels));
      // Plot stacks a legend ABOVE the svg, so a figure given height H is taller
      // than H and spills out of the tile. The legend's height is not knowable
      // before it exists, so measure once and redraw the plot that much shorter.
      attachPicker(el, dimColumn(columns, data), data, onPick);
      const fig = el.firstElementChild as HTMLElement | null;
      if (fig) {
        // offsetHeight, not getBoundingClientRect: the canvas is CSS-scaled, so
        // the rect is in screen pixels while box.h is in layout pixels. Mixing
        // them makes the correction wrong at every zoom except 100%.
        const spill = Math.round(fig.offsetHeight - box.h);
        if (spill > 1) {
          mount(render(kind, columns, data,
            { w: box.w, h: Math.max(60, box.h - spill) }, format, secondaryFormat, labels));
          attachPicker(el, dimColumn(columns, data), data, onPick);
        }
      }
    } catch (e: any) {
      const msg = document.createElement("div");
      msg.className = "chart-err";
      msg.textContent = `Could not draw this as a ${kind}: ${e?.message ?? e}`;
      host.current.replaceChildren(msg);
    }
  }, [kind, columns, rows, box.w, box.h, JSON.stringify(format), JSON.stringify(secondaryFormat), JSON.stringify(labels), !!onPick]);

  return <div ref={host} style={{ width: "100%", height: "100%" }} />;
}

const ISO = /^\d{4}-\d{2}-\d{2}([T ]|$)/;
/**
 * Dates arrive from the warehouse as strings. Left alone, Plot treats them as
 * ordinal categories and prints every one of them -- 24 overlapping ISO dates
 * where an axis should be. Coercing to Date lets Plot use a time scale, which
 * chooses readable ticks on its own.
 */
function coerce(v: unknown) {
  if (typeof v === "string" && ISO.test(v)) {
    const d = new Date(v.length === 10 ? `${v}T00:00:00Z` : v);
    if (!Number.isNaN(+d)) return d;
  }
  return v;
}

/**
 * Two measures can be the same unit CLASS (both currency) and still be
 * unreadable on one axis -- marketing spend in the hundreds of thousands
 * against cost-per-click in single dollars draws as a flat line at zero,
 * which reads as "this metric is always zero" rather than "this axis is
 * wrong for it." suggest.ts already keeps different unit classes apart;
 * this catches the mismatch *within* a class, from the actual values on
 * screen -- so it works for any measure pairing on any dataset, not just
 * ones this app was written against.
 */
// Originally 20x, calibrated only against the bug that motivated this
// feature (marketing spend vs. cost-per-click, ~50,000x apart) -- far
// louder than what "unreadable" actually requires. Real dashboards surfaced
// two governed-metric pairings that read just as squashed and never crossed
// it: logo_churn_rate next to nrr/grr (~8.6x -- churn hugs the bottom of a
// 0-104% axis dominated by two retention rates near 100%) and
// cac_payback_months next to ltv_cac_ratio (~7.7x). Lowered to 6, below
// both real failures with some margin, while still comfortably above
// same-scale pairs that belong together (nrr vs. grr, ~1.04x).
const MAGNITUDE_THRESHOLD = 6;

interface DualAxisPlan {
  primary: string[];
  secondary: string[];
  secondaryDomain: { min: number; max: number };
  /** Maps a raw secondary-axis value into the primary axis's numeric range,
   *  so both series can be plotted through the SAME Plot y-scale. */
  remap: (v: number) => number;
}

export function magnitudeSplit(data: any[], measures: string[]): DualAxisPlan | null {
  if (measures.length < 2) return null;
  // Each series' OWN natural range, not forced through zero: a metric that
  // never gets near zero (cost-per-click hovering at $0.84) needs that
  // narrow band to fill its axis, or its real movement is exactly as
  // invisible as the original bug this whole feature exists to fix --
  // just self-inflicted on the secondary axis instead of shared with the
  // primary one. Plot's own ruleY(0) mark still anchors the PRIMARY axis
  // at zero on its own, matching every other chart in the app; this only
  // controls the secondary axis, which is drawn by hand and owes Plot's
  // convention nothing.
  const extent = (m: string) => {
    const vals = data.map((d) => Number(d[m])).filter(Number.isFinite);
    return vals.length ? { min: Math.min(...vals), max: Math.max(...vals) } : null;
  };
  const withExtent = measures.map((m) => ({ m, e: extent(m) }))
    .filter((x): x is { m: string; e: { min: number; max: number } } => !!x.e);
  if (withExtent.length < 2) return null;

  const span = (e: { min: number; max: number }) => Math.max(Math.abs(e.max), Math.abs(e.min));
  const byMax = [...withExtent].sort((a, b) => span(b.e) - span(a.e));
  const top = byMax[0];
  if (span(top.e) <= 0) return null;
  const secondary = byMax.slice(1).filter((x) => span(top.e) / Math.max(span(x.e), 1e-9) > MAGNITUDE_THRESHOLD);
  if (!secondary.length) return null;

  const secondarySet = new Set(secondary.map((x) => x.m));
  const primary = withExtent.filter((x) => !secondarySet.has(x.m));
  const primaryDomain = {
    min: Math.min(...primary.map((x) => x.e.min)),
    max: Math.max(...primary.map((x) => x.e.max)),
  };
  const secondaryDomain = {
    min: Math.min(...secondary.map((x) => x.e.min)),
    max: Math.max(...secondary.map((x) => x.e.max)),
  };
  const scale = scaleLinear()
    .domain([secondaryDomain.min, secondaryDomain.max])
    .range([primaryDomain.min, primaryDomain.max]);

  return {
    primary: primary.map((x) => x.m), secondary: secondary.map((x) => x.m),
    secondaryDomain, remap: (v: number) => scale(v),
  };
}

/**
 * A tile's own tick formatter is tuned for its usual range (currency at 2
 * decimals, say) -- fine for $200k vs $150k, useless for a secondary axis
 * whose whole span is $0.8403 to $0.8407, where every tick rounds to the
 * same "$0.84" and the axis stops meaning anything. Falls back to just
 * enough decimal precision to tell the actual ticks apart, keeping
 * whatever prefix/suffix (currency sign, percent) the base formatter uses.
 */
export function preciseTickFormat(ticks: number[], base: (v: number) => string): (v: number) => string {
  const labels = ticks.map(base);
  if (new Set(labels).size === labels.length) return base;
  const step = Math.abs((ticks[1] ?? ticks[0] + 1) - ticks[0]) || 1;
  const decimals = Math.max(2, Math.ceil(-Math.log10(step)) + 1);
  const sample = base(ticks[0] ?? 0);
  // Percent isn't just a suffix -- format.ts's "%" formatter multiplies by
  // 100 first (d3-format's own "%" type does that internally). Slapping a
  // literal "%" after the raw value would print 0.1 as "0.1%" instead of
  // "10.0%", a fake hundred-fold error, not just a cosmetic miss.
  if (/%$/.test(sample)) return d3format(`,.${decimals}%`);
  const prefix = sample.match(/^[^\d.-]*/)?.[0] ?? "";
  const suffix = sample.match(/[^\d.-]*$/)?.[0] ?? "";
  const fmt = d3format(`,.${decimals}f`);
  return (v: number) => `${prefix}${fmt(v)}${suffix}`;
}

/** Draws a real right-hand axis, in the secondary series' own units, onto
 *  an already-rendered Plot figure. Works because remap() and Plot's own y
 *  scale are both linear, so composing them at the domain's two endpoints
 *  is enough to derive the matching pixel range for the secondary scale.
 *  `width` must be the actual rendered box width, passed in rather than
 *  read from the SVG's own `width` attribute -- that attribute isn't
 *  reliably set to the CSS pixel size, and reading it wrong silently
 *  placed this axis at the LEFT edge instead of the right. */
function addSecondaryAxis(fig: any, plan: DualAxisPlan, tick: (v: number) => string,
                          marginRight: number, width: number) {
  if (typeof fig?.scale !== "function") return fig;
  const ys = fig.scale("y");
  if (!ys || typeof ys.apply !== "function") return fig;
  const svg: SVGSVGElement | null = fig.tagName === "FIGURE" ? fig.querySelector("svg") : fig;
  if (!svg) return fig;

  const pixelFor = (v: number) => ys.apply(plan.remap(v));
  const axisScale = scaleLinear()
    .domain([plan.secondaryDomain.min, plan.secondaryDomain.max])
    .range([pixelFor(plan.secondaryDomain.min), pixelFor(plan.secondaryDomain.max)]);

  const axis = axisRight(axisScale).ticks(5);
  const tickValues = axisScale.ticks(5);
  const g = select(document.createElementNS("http://www.w3.org/2000/svg", "g"))
    .attr("transform", `translate(${width - marginRight + 6},0)`)
    .attr("font-size", "11px")
    .call(axis.tickFormat(preciseTickFormat(tickValues, tick) as any));
  g.selectAll("path,line").attr("stroke", "var(--ink-3)");
  g.selectAll("text").attr("fill", "var(--ink-3)");
  svg.appendChild(g.node()!);
  return fig;
}

/**
 * Rows whose value at `key` is a genuine SQL NULL, not a computed 0 -- a
 * metric that needs trailing history (an annualized rate, say) has no real
 * value for its first period or two, and the row comes back with a real
 * NULL for it, not a zero. `Plot.line` already gaps a null y on its own
 * (skips the point, breaks the curve); `Plot.areaY` does not extend that
 * same "defined" test to its filled shape, so the fill still reaches back
 * to cover the missing point -- a wedge from an implicit zero up to the
 * first real value, reading as "this shot up from nothing" when the true
 * story is "no data yet." Filtering to defined rows before either mark
 * sees them keeps the fill and the line honest about where the series
 * actually starts. `!= null` specifically, not a numeric finiteness check
 * -- `Number(null)` is 0, not NaN, so a finiteness check alone would keep
 * the very null values this is meant to exclude.
 */
export function definedRows<T extends Record<string, unknown>>(rows: T[], key: string): T[] {
  return rows.filter((r) => r[key] != null);
}

function render(kind: ChartKind, columns: string[], data: any[], box: { w: number; h: number },
                fmt?: import("../format/format.ts").FormatSpec,
                secondaryFmt?: import("../format/format.ts").FormatSpec, labels: Record<string, string> = {}) {
  const f = fmt ?? DEFAULT_FORMAT;
  const tick = makeFormatter(f);
  const secondaryTick = secondaryFmt ? makeFormatter(secondaryFmt) : tick;
  const palette = PALETTES[f.palette] ?? PALETTES.default;
  // Convention from the compiler: dimensions are selected first, metrics last.
  const measures = columns.filter((c) => data.some((d) => typeof d[c] === "number"));
  const dims = columns.filter((c) => !measures.includes(c));
  const x = dims[0] ?? columns[0];
  const y = measures[0] ?? columns[1];

  const temporalX = data.length > 0 && data.every((d) => d[x] instanceof Date || d[x] == null);
  // A time axis with room for ~one tick per 90px; Plot picks the boundaries.
  const xScale: any = temporalX
    ? { type: "utc", ticks: Math.max(2, Math.floor(box.w / 90)) }
    : { tickRotate: labelsAreLong(data, x) ? -35 : 0 };

  const common: any = {
    width: box.w, height: box.h,
    marginLeft: f.showY ? 62 : 12,
    marginBottom: f.showX ? (xScale.tickRotate ? 58 : 34) : 12, marginTop: 12,
    style: { background: "transparent", fontSize: "11px" },
    x: { label: f.xTitle, axis: f.showX ? "bottom" : null, ...xScale },
    y: { label: f.yTitle, axis: f.showY ? "left" : null,
         grid: f.grid, nice: true, tickFormat: tick },
    color: { range: palette, tickFormat: (value: string) => labels[value] ?? value },
  };
  const legend = f.legend !== "hide";

  // Long/tidy form lets one mark serve any number of measures.
  const tidy = data.flatMap((d) => measures.map((m) => ({ x: d[x], series: m, value: d[m] })));

  switch (kind) {
    case "line": {
      const dual = magnitudeSplit(data, measures);
      if (!dual) {
        return Plot.plot({ ...common, color: { ...common.color, legend: legend && measures.length > 1 },
          marks: [Plot.ruleY([0]),
            Plot.line(tidy, { x: "x", y: "value", stroke: "series", curve: "monotone-x" }),
            Plot.dot(tidy, { x: "x", y: "value", stroke: "series", r: 1.6 })] });
      }
      // Secondary-axis series are remapped into the primary axis's numeric
      // range so one Plot y-scale can position both, then a real axis in
      // the secondary series' own units is drawn on afterward -- each
      // series ends up shaped by its OWN range, not squashed by the other.
      const secondarySet = new Set(dual.secondary);
      const tidyDual = data.flatMap((d) => measures.map((m) => ({
        x: d[x], series: m,
        value: secondarySet.has(m) ? dual.remap(Number(d[m])) : Number(d[m]),
      })));
      const marginRight = f.showY ? 54 : 12;
      const fig = Plot.plot({ ...common, marginRight,
        color: { ...common.color, legend },
        marks: [Plot.ruleY([0]),
          Plot.line(tidyDual, { x: "x", y: "value", stroke: "series", curve: "monotone-x" }),
          Plot.dot(tidyDual, { x: "x", y: "value", stroke: "series", r: 1.6 })] });
      return addSecondaryAxis(fig, dual, tick, marginRight, box.w);
    }
    case "combo": {
      // Fixed roles, not magnitude-sorted like the plain multi-series line
      // above: the FIRST selected measure is always the bar, the SECOND is
      // always the line -- a user picking "spend, then click-through rate"
      // means spend as the volume and CTR as the trend, not whichever one
      // happens to be bigger. magnitudeSplit still decides whether the two
      // need separate axes at all; it just doesn't get to pick which one is
      // which mark.
      const barMeasure = measures[0];
      const lineMeasure = measures[1] ?? measures[0];
      const dual = magnitudeSplit(data, measures);
      const secondarySet = new Set(dual?.secondary ?? []);
      const valueFor = (m: string, d: any) => {
        const v = Number(d[m]);
        return secondarySet.has(m) && dual ? dual.remap(v) : v;
      };
      // barY needs a discrete (band) x-scale, but `common.x` forces a
      // continuous "utc" scale whenever the dimension is temporal -- Plot
      // rejects mixing the two ("scale incompatible with channel: utc !==
      // band"). A shared discrete axis is also how a bar+line combo
      // conventionally renders regardless: format each period into its own
      // label and let both marks sit on the same ordinal scale, rather than
      // reusing `common.x` wholesale the way every other case here does.
      const label = dateLabeler(data.map((d: any) => d[x]));
      const barRows = data.map((d: any) => ({ x: label(d[x]), value: valueFor(barMeasure, d) }));
      const lineRows = data.map((d: any) => ({ x: label(d[x]), value: valueFor(lineMeasure, d) }));
      // Plot's default ordinal scale sorts a string domain alphabetically --
      // fine for plain categories, wrong for "Apr 25, Aug 24, Dec 25, ...".
      // The rows already arrive in the query's own (chronological) order,
      // so an explicit domain in THAT order, not sorted, keeps it a time
      // axis in every way except its scale type.
      const xDomain = [...new Set(barRows.map((r) => r.x))];
      const marginRight = dual ? (f.showY ? 54 : 12) : 12;
      const fig = Plot.plot({
        width: box.w, height: box.h,
        marginLeft: f.showY ? 62 : 12, marginRight,
        marginBottom: f.showX ? (labelsAreLong(barRows, "x") ? 58 : 34) : 12, marginTop: 12,
        style: { background: "transparent", fontSize: "11px" },
        x: { label: f.xTitle, axis: f.showX ? "bottom" : null, domain: xDomain,
             tickRotate: labelsAreLong(barRows, "x") ? -35 : 0 },
        y: { label: f.yTitle, axis: f.showY ? "left" : null, grid: f.grid, nice: true, tickFormat: tick },
        marks: [
          Plot.ruleY([0]),
          Plot.barY(barRows, { x: "x", y: "value", fill: "currentColor", fillOpacity: 0.55 }),
          Plot.line(lineRows, { x: "x", y: "value", stroke: "var(--pos)", strokeWidth: 2, curve: "monotone-x" }),
          Plot.dot(lineRows, { x: "x", y: "value", fill: "var(--pos)", r: 2 }),
        ] });
      return dual ? addSecondaryAxis(fig, dual, secondaryTick, marginRight, box.w) : fig;
    }
    case "area": {
      const defined = definedRows(data, y);
      return Plot.plot({ ...common,
        marks: [Plot.areaY(defined, { x, y, fillOpacity: 0.15 }),
          Plot.line(defined, { x, y, curve: "monotone-x" }), Plot.ruleY([0])] });
    }
    case "areaStacked": {
      // Same fix as plain "area" above, for the tidy/multi-series shape.
      const definedTidy = definedRows(tidy, "value");
      return Plot.plot({ ...common, color: { ...common.color, legend },
        marks: [Plot.areaY(definedTidy, { x: "x", y: "value", fill: "series", fillOpacity: 0.85 }), Plot.ruleY([0])] });
    }
    case "bar":
      return Plot.plot({ ...common,
        marks: [Plot.barY(data, { x, y, fill: "currentColor", fillOpacity: 0.75 }), Plot.ruleY([0])] });
    case "waterfall": {
      // Bridges from 0 through a sequence of named, signed deltas to a
      // running total -- fct_mrr_movements documents itself this way
      // (synonyms: [..., "mrr waterfall"]): new/expansion/contraction/
      // churn/reactivation summing to the net change. A Total bar is
      // appended automatically so the bridge actually lands somewhere,
      // and thin dashed rules connect each bar to where the next one
      // starts, the one visual convention that makes a waterfall read as
      // a bridge rather than an ordinary bar chart.
      //
      // Two different tile shapes both mean "a sequence of named deltas":
      // one dimension + one measure (a real GROUP BY, one row per delta),
      // or no dimension + several measures (a single aggregate row, each
      // measure its own named delta -- how fct_mrr_movements actually
      // exposes this: new_mrr/expansion_mrr/contraction_mrr/churned_mrr
      // are separate governed metrics, not one metric broken out by a
      // movement_type dimension).
      // barY needs a discrete (band) x-scale -- same constraint as combo
      // above, and the same fix: don't spread `common.x` (forces "utc" for
      // a temporal dimension, which Plot rejects for a bar mark's x
      // channel: "scale incompatible with channel: utc !== band"), and
      // format any Date labels instead of falling through to their raw
      // String() form.
      const label = dateLabeler(data.map((d: any) => d[x]));
      const named: { label: string; value: number }[] = dims.length === 0 && measures.length > 1
        ? measures.map((m) => ({ label: m, value: Number(data[0]?.[m]) || 0 }))
        : data.map((d: any) => ({ label: label(d[x]), value: Number(d[y]) || 0 }));
      let running = 0;
      const bars = named.map((r) => {
        const before = running;
        running += r.value;
        return { label: r.label, lo: Math.min(before, running), hi: Math.max(before, running),
                 after: running, value: r.value, kind: r.value >= 0 ? "pos" : "neg" as const };
      });
      bars.push({ label: "Total", lo: Math.min(0, running), hi: Math.max(0, running),
                  after: running, value: running, kind: "total" as const });
      const barColor = (k: string) => k === "pos" ? "var(--pos)" : k === "neg" ? "var(--neg)" : "var(--ink-2)";
      const bridges = bars.slice(0, -1).map((b, i) => ({ y: b.after, x1: b.label, x2: bars[i + 1].label }));
      return Plot.plot({ ...common,
        x: { label: f.xTitle, axis: f.showX ? "bottom" : null, domain: bars.map((b) => b.label),
             tickRotate: labelsAreLong(bars, "label") ? -35 : 0 },
        marks: [
          Plot.ruleY([0]),
          Plot.ruleY(bridges, { x1: "x1", x2: "x2", y: "y", stroke: "var(--line-2)", strokeDasharray: "2,2" }),
          Plot.barY(bars, { x: "label", y1: "lo", y2: "hi", fill: (b: any) => barColor(b.kind), fillOpacity: 0.85 }),
          // dy is a constant pixel offset in Plot's types, not a per-datum
          // channel -- two marks (label above the bar, label below it)
          // instead of one text mark trying to flip sides by value.
          Plot.text(bars.filter((b) => b.kind !== "neg"), { x: "label", y: "hi",
                    text: (b: any) => tick(b.value), dy: -6, fontSize: 10, fill: "var(--ink-2)" }),
          Plot.text(bars.filter((b) => b.kind === "neg"), { x: "label", y: "hi",
                    text: (b: any) => tick(b.value), dy: 14, fontSize: 10, fill: "var(--ink-2)" }),
        ] });
    }
    case "funnel": {
      // Same two input shapes as waterfall (one dim + one measure, or no
      // dim + several measures) -- both mean "several named stages." A
      // funnel's story is a sequence narrowing top to bottom, so stages
      // are ordered by size (largest first) rather than by query-row
      // order, which is the reading a real funnel needs regardless of
      // which order the dimension's rows happened to come back in.
      const named: { label: string; value: number }[] = dims.length === 0 && measures.length > 1
        ? measures.map((m) => ({ label: m, value: Number(data[0]?.[m]) || 0 }))
        : data.map((d: any) => ({ label: String(d[x]), value: Number(d[y]) || 0 }));
      const stages = [...named].sort((a, b) => b.value - a.value);
      const top = stages[0]?.value || 0;
      const rows = stages.map((s) => ({
        ...s, x1: -s.value / 2, x2: s.value / 2,
        // One line, not two: every bar's BAND is the same height regardless
        // of how far the funnel has narrowed (only width encodes value), so
        // a label centered on the bar always has the same room to sit in --
        // stacking a name line above and a detail line below worked for
        // waterfall's handful of bars, but here a real funnel's stage count
        // (5-10 is normal) shrinks each band enough that two offset lines
        // spill into the neighbouring bar above and below it.
        label2: top ? `${tick(s.value)} · ${Math.round((s.value / top) * 100)}%` : tick(s.value),
      }));
      const halfDomain = Math.max(top / 2, 1);
      return Plot.plot({
        width: box.w, height: box.h,
        marginLeft: 12, marginRight: 12, marginTop: 12, marginBottom: 12,
        style: { background: "transparent", fontSize: "11px" },
        x: { axis: null, domain: [-halfDomain * 1.05, halfDomain * 1.05] },
        y: { axis: null, domain: rows.map((r) => r.label) },
        marks: [
          Plot.barX(rows, { y: "label", x1: "x1", x2: "x2", fill: "currentColor", fillOpacity: 0.75 }),
          Plot.text(rows, { y: "label", x: 0, dy: -6, text: (r: any) => r.label,
                            fontSize: 11, fill: "var(--surface)" }),
          Plot.text(rows, { y: "label", x: 0, dy: 8, text: (r: any) => r.label2,
                            fontSize: 10, fill: "var(--surface)" }),
        ],
      });
    }
    case "barGrouped":
      return Plot.plot({ ...common, color: { ...common.color, legend },
        marks: [Plot.barY(tidy, { x: "x", y: "value", fill: "series", fx: "x" } as any),
                Plot.ruleY([0])] });
    case "barStacked":
      return Plot.plot({ ...common, color: { ...common.color, legend },
        marks: [Plot.barY(tidy, { x: "x", y: "value", fill: "series" }), Plot.ruleY([0])] });
    case "barH":
    case "barHorizontal":
      // Position here is (category, measure) = (y, x) -- the opposite of
      // every other case in this switch, which is why this can't just
      // spread `common` the way they do: common.y carries the MEASURE's
      // tickFormat (currency, percent, ...), and applying that to the
      // category axis formats channel names as numbers, producing "$NaN"
      // for every label instead of the channel name.
      return Plot.plot({
        width: box.w, height: box.h,
        marginLeft: 130, marginRight: 12, marginTop: 12,
        marginBottom: f.showX ? 34 : 12,
        style: { background: "transparent", fontSize: "11px" },
        x: { label: f.xTitle, axis: f.showX ? "bottom" : null, grid: f.grid, nice: true, tickFormat: tick },
        y: { label: f.yTitle, axis: f.showY ? "left" : null },
        marks: [Plot.barX(data, { y: x, x: y, fill: "currentColor", fillOpacity: 0.75,
                                  sort: { y: "-x" } }), Plot.ruleX([0])],
      });
    case "donut": {
      // Plot has no pie mark; an arc is a rect on a polar-ish layout, so this is
      // hand-built. Kept because part-to-whole is a real question -- but only
      // ever recommended at low cardinality, where angle is still comparable.
      const total = d3sum(data, (d: any) => Number(d[y]) || 0);
      let acc = 0;
      const arcs = data.map((d: any) => {
        const start = acc / total, end = (acc += d[y]) / total;
        return { label: d[x], start, end, value: d[y] };
      });
      const size = Math.min(box.w, box.h) - 16;
      const R = size / 2, r = R * 0.58;
      const ns = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(ns, "svg");
      svg.setAttribute("viewBox", `${-box.w / 2} ${-box.h / 2} ${box.w} ${box.h}`);
      svg.setAttribute("width", String(box.w)); svg.setAttribute("height", String(box.h));
      
      arcs.forEach((a, i) => {
        const p = document.createElementNS(ns, "path");
        p.setAttribute("d", donutArc(a.start, a.end, R, r));
        p.setAttribute("fill", palette[i % palette.length]);
        p.setAttribute("opacity", "0.9");
        const t = document.createElementNS(ns, "title");
        t.textContent = `${a.label}: ${a.value}`;
        p.appendChild(t); svg.appendChild(p);
      });
      return svg;
    }
    case "map": {
      // Join the measure onto world-atlas features by resolved id. Countries
      // with no row stay unfilled rather than reading as zero -- absent data and
      // a value of zero are different claims.
      const byId = new Map<string, number>();
      const labelById = new Map<string, string>();
      for (const d of data) {
        const id = toFeatureId(d[x]);
        if (id == null) continue;
        byId.set(id, Number(d[y]));
        labelById.set(id, String(d[x]));
      }
      const vals = [...byId.values()].filter(Number.isFinite);
      return Plot.plot({
        width: box.w, height: box.h,
        projection: { type: "equal-earth", domain: { type: "Sphere" } },
        style: { background: "transparent", fontSize: "11px" },
        color: {
          scheme: vals.some((v) => v < 0) ? "BuRd" : "YlGnBu",
          unknown: "var(--surface-2)", legend, label: f.yTitle ?? y,
          ...(vals.some((v) => v < 0) ? { pivot: 0 } : {}),
        },
        marks: [
          Plot.sphere({ stroke: "var(--line)", strokeWidth: 0.6 }),
          Plot.geo(COUNTRIES.features, {
            fill: (f: any) => byId.get(String(f.id)) ?? undefined,
            stroke: "var(--line)", strokeWidth: 0.35,
            title: (f: any) => {
              const v = byId.get(String(f.id));
              const name = f.properties?.name ?? labelById.get(String(f.id)) ?? "";
              return v == null ? `${name}: no data`
                : `${name}: ${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
            },
          }),
        ],
      });
    }
    case "scatter":
      return Plot.plot({ ...common,
        marks: [Plot.dot(data, { x: measures[0], y: measures[1] ?? measures[0], r: 3, fillOpacity: 0.6 })] });
    case "heatmap":
      return Plot.plot({ ...common, color: { scheme: "YlGnBu", legend },
        marks: [Plot.cell(data, { x: dims[0], y: dims[1], fill: measures[0] })] });
    case "smallMultiples": {
      // Same temporal + categorical shape a multi-series line uses, but
      // POSITION separates categories instead of colour: one mini time
      // series per value of the categorical dim, arranged in a roughly
      // square grid rather than guessed at as a single row (a dozen
      // categories in one row would leave each panel a sliver). Panels
      // share one y-scale (Plot's default under faceting) so a glance at
      // height is still a fair comparison across them.
      const isTemporalCol = (col: string) =>
        data.length > 0 && data.every((d) => d[col] instanceof Date || d[col] == null);
      const timeDim = dims.find(isTemporalCol) ?? dims[0];
      const catDim = dims.find((d) => d !== timeDim) ?? dims[1];
      const cats = [...new Set(data.map((d) => String(d[catDim])))];
      const cols = Math.max(1, Math.ceil(Math.sqrt(cats.length)));
      const cellOf = new Map(cats.map((c, i) => [c, { col: i % cols, row: Math.floor(i / cols) }]));
      const rows = data.map((d) => {
        const cell = cellOf.get(String(d[catDim]))!;
        return { ...d, __panel: String(d[catDim]), __col: cell.col, __row: cell.row };
      });
      const panels = cats.map((c) => {
        const cell = cellOf.get(c)!;
        return { __panel: c, __col: cell.col, __row: cell.row };
      });
      const timeIsDate = data.length > 0 && data.every((d) => d[timeDim] instanceof Date || d[timeDim] == null);
      return Plot.plot({
        width: box.w, height: box.h,
        marginLeft: 6, marginRight: 6, marginTop: 6, marginBottom: 6,
        style: { background: "transparent", fontSize: "10px" },
        x: { type: timeIsDate ? "utc" : undefined, axis: null },
        y: { axis: null, nice: true, grid: true },
        fx: { padding: 0.08, axis: null }, fy: { padding: 0.1, axis: null },
        marks: [
          Plot.frame({ stroke: "var(--line)" }),
          Plot.lineY(rows, { x: timeDim, y: measures[0], fx: "__col", fy: "__row",
                             stroke: "var(--ink-2)", curve: "monotone-x" }),
          Plot.text(panels, { fx: "__col", fy: "__row", frameAnchor: "top-left", dx: 4, dy: 2,
                              text: "__panel", fontSize: 9, fill: "var(--ink-2)" }),
        ],
      });
    }
    default:
      return Plot.plot({ ...common, marks: [Plot.barY(data, { x, y })] });
  }
}

export function Stat({ label, value }: { label: string; value: unknown }) {
  const n = typeof value === "number" ? value : Number(value);
  const text = Number.isFinite(n)
    ? (Math.abs(n) >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 })
       : n.toLocaleString(undefined, { maximumFractionDigits: 3 }))
    : String(value ?? "—");
  return <div className="stat"><div className="v">{text}</div><div className="l">{label}</div></div>;
}

export function DataTable({ columns, rows }: { columns: string[]; rows: unknown[][] }) {
  return (
    <table>
      <thead><tr>{columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
      <tbody>{rows.slice(0, 200).map((r, i) => (
        <tr key={i}>{r.map((v, j) => (
          <td key={j}>{typeof v === "number"
            ? v.toLocaleString(undefined, { maximumFractionDigits: 3 }) : String(v ?? "")}</td>
        ))}</tr>))}
      </tbody>
    </table>
  );
}

/** SVG path for one donut segment, angles as fractions of a turn. */
function donutArc(start: number, end: number, R: number, r: number) {
  const a0 = start * Math.PI * 2 - Math.PI / 2;
  const a1 = end * Math.PI * 2 - Math.PI / 2;
  const large = end - start > 0.5 ? 1 : 0;
  const p = (rad: number, ang: number) => [rad * Math.cos(ang), rad * Math.sin(ang)];
  const [x0, y0] = p(R, a0), [x1, y1] = p(R, a1);
  const [x2, y2] = p(r, a1), [x3, y3] = p(r, a0);
  return `M${x0} ${y0} A${R} ${R} 0 ${large} 1 ${x1} ${y1} L${x2} ${y2} A${r} ${r} 0 ${large} 0 ${x3} ${y3} Z`;
}

/** Rotate category labels only when they would otherwise collide. */
function labelsAreLong(data: any[], x: string) {
  if (data.length > 8) return true;
  return data.some((d) => String(d[x] ?? "").length > 10);
}

/**
 * Formats a Date into a label sized to the actual gap between periods --
 * "2026" for yearly buckets, "Mar 26" for monthly, "Mar 5" for weekly or
 * daily -- rather than a fixed format that's wrong for whichever grain the
 * tile happens to be querying at. Non-Date values (a plain categorical
 * dimension run through the combo case) just stringify.
 */
function dateLabeler(values: unknown[]): (v: unknown) => string {
  const dates = values.filter((v): v is Date => v instanceof Date).sort((a, b) => +a - +b);
  const day = 86400000;
  const step = dates.length > 1 ? Math.abs(+dates[1] - +dates[0]) : Infinity;
  const opts: Intl.DateTimeFormatOptions =
    step >= 300 * day ? { year: "numeric" } :
    step >= 25 * day ? { month: "short", year: "2-digit" } :
    { month: "short", day: "numeric" };
  return (v) => (v instanceof Date ? v.toLocaleDateString(undefined, opts) : String(v));
}

/**
 * Click-to-cross-filter (categorical axis) or click-to-drill (temporal axis).
 *
 * Plot does not attach data to its marks, so the clicked value is recovered
 * from the scale instead: Plot exposes the resolved scales on the returned
 * figure. A band/point scale (bar charts) inverts a pixel to a category by
 * index. A utc scale (line/area charts) uses the scale's own `invert()` to
 * get a Date, then snaps to the nearest ACTUAL bucket in `data` -- the axis
 * is continuous but the underlying series is discrete points, and reporting
 * an interpolated date between two real buckets would drill into a range
 * that doesn't match anything the chart actually plotted.
 */
function attachPicker(host: HTMLElement, column: string | null, data: any[],
                      onPick?: (column: string, value: string | number | Date) => void) {
  if (!onPick || !column) return;
  const fig: any = host.firstElementChild;
  // Plot renders a legend's swatches as their own small <svg> elements
  // BEFORE the plot's own <svg> inside the figure when one is present
  // (any chart with 2+ series) -- querySelector("svg") grabbed whichever
  // came first in document order, which was silently the wrong element (a
  // ~15px swatch icon, no click ever registering) on exactly the charts
  // most likely to want cross-filter/drill: anything with a legend. The
  // actual plot is always the largest svg in the figure.
  const svg = fig?.tagName === "FIGURE"
    ? [...fig.querySelectorAll("svg")].sort((a, b) =>
        b.getBoundingClientRect().width * b.getBoundingClientRect().height -
        a.getBoundingClientRect().width * a.getBoundingClientRect().height)[0]
    : fig;
  if (!svg || typeof fig?.scale !== "function") return;

  let xs: any;
  try { xs = fig.scale("x"); } catch { return; }
  if (!xs) return;
  const temporal = xs.type === "utc" || xs.type === "time";
  if (!temporal && xs.type !== "band" && xs.type !== "point") return;

  svg.style.cursor = "pointer";
  svg.addEventListener("click", (e: MouseEvent) => {
    const r = svg.getBoundingClientRect();
    // Rect is in screen px under a scaled canvas; convert back to plot px.
    const scale = r.width / (svg.viewBox?.baseVal?.width || svg.clientWidth || r.width) || 1;
    const px = (e.clientX - r.left) / (scale || 1);

    if (temporal) {
      if (typeof xs.invert !== "function") return;
      const clicked = xs.invert(px);
      if (!(clicked instanceof Date) || Number.isNaN(+clicked)) return;
      let nearest: Date | null = null, best = Infinity;
      for (const row of data) {
        const v = row[column];
        if (!(v instanceof Date)) continue;
        const dist = Math.abs(+v - +clicked);
        if (dist < best) { best = dist; nearest = v; }
      }
      if (nearest) onPick(column, nearest);
      return;
    }

    const [lo, hi] = xs.range;
    const n = xs.domain.length;
    if (!n || hi === lo) return;
    const i = Math.floor(((px - lo) / (hi - lo)) * n);
    const value = xs.domain[Math.max(0, Math.min(n - 1, i))];
    if (value != null) onPick(column, value as any);
  });
}

/** The first column that is not a measure — the same rule `render` uses. */
function dimColumn(columns: string[], data: any[]): string | null {
  const measures = columns.filter((c) => data.some((d) => typeof d[c] === "number"));
  return columns.find((c) => !measures.includes(c)) ?? null;
}
