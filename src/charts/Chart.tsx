import { metricColorScale, useMetricOrder } from "./MetricColors.tsx";
import { funnelStages } from "./funnel.ts";
import { compareTableNumbers, tableCell, tableNumber, type TableColumnDisplay } from "../format/tableDisplay.ts";
import { hasPrecisionRisk } from "./precision.ts";
import { prepareHeatmap } from "./heatmap.ts";
import { useEffect, useRef, useState } from "react";
import * as Plot from "@observablehq/plot";
import { arc as d3arc } from "d3-shape";
import { coerceDate, componentValue, donutSegments, numericValue } from "./values.ts";
import { scaleLinear } from "d3-scale";
import { rgb } from "d3-color";
import { axisRight } from "d3-axis";
import { select } from "d3-selection";
import { format as d3format } from "d3-format";
import { COUNTRIES, prepareMap } from "./geo.ts";
import { DEFAULT_FORMAT, makeAxisFormatter, makeFormatter, PALETTES, type NumberFormatter } from "../format/format.ts";
import type { ChartKind } from "../compiler/spec.ts";
import { chartShapeIssue } from "./capabilities.ts";
import { breakTemporalGaps, categoryPanels, categorySeries } from "./series.ts";
import type { TimeGrain } from "../semantic/model.ts";

type PickValue = string | number | boolean | null | Date;
const isPickValue = (value: unknown): value is PickValue => value === null || typeof value === "string" || typeof value === "boolean"
  || typeof value === "number" && Number.isFinite(value) || value instanceof Date && Number.isFinite(+value);

/**
 * One interface for every chart type. Observable Plot is D3 underneath and
 * covers the long tail immediately; any individual kind can later be replaced
 * with hand-built D3 primitives without the spec, compiler or canvas noticing.
 */
export function Chart({ kind, columns, rows, measureColumns, temporalColumns, timeGrains, pickableColumns, explorationFocus, separateAxes = false, format, secondaryFormat, metricFormats, labels = {}, onPick, onStatus }: {
  onStatus?: (error: string | null) => void;
  kind: ChartKind; columns: string[]; rows: unknown[][]; labels?: Record<string, string>;
  measureColumns?: string[];
  /** Declared semantic roles take precedence over date-like category strings. */
  temporalColumns?: string[];
  timeGrains?: Record<string, TimeGrain>;
  /** Columns with an available filter/drill action (daily buckets cannot drill further). */
  pickableColumns?: string[];
  /** Kept by the tile while a query temporarily unmounts its chart. */
  explorationFocus?: { current: boolean };
  separateAxes?: boolean;
  format?: import("../format/format.ts").FormatSpec;
  /** A combo chart's bar and line are two different metrics by fixed
   *  position, each potentially needing its own number style (spend as
   *  currency, click-through rate as a percent) -- computed by the caller,
   *  which has the model to infer a style from and this component doesn't.
   *  Also supplies the second metric's units for a dual-axis line chart. */
  secondaryFormat?: import("../format/format.ts").FormatSpec;
  /** Per-metric display units for independent heatmap rows and scatter axes. */
  metricFormats?: Record<string, import("../format/format.ts").FormatSpec>;
  /** Click-to-cross-filter (categorical axis) or click-to-drill (temporal
   *  axis). Receives the dimension column and the clicked value -- a string
   *  or number for a category, a Date for a time bucket. */
  onPick?: (column: string, value: PickValue) => void;
}) {
  const metricOrder = useMetricOrder();
  const status = useRef(onStatus); status.current = onStatus;
  const picker = useRef(onPick); picker.current = onPick;
  const dataKey = JSON.stringify([columns, rows]);
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
    const data = rows.map((r) => Object.fromEntries(columns.map((c, i) => [c,
      temporalColumns && !temporalColumns.includes(c) ? r[i] : coerceDate(r[i])])));
    const restoreExplorationFocus = !!host.current.querySelector(".chart-explore")?.contains(document.activeElement);
    try {
      const el = host.current;
      const mount = (chart: Element) => {
        const figure = chart.tagName.toLowerCase() === "figure" ? chart : document.createElement("figure");
        if (figure !== chart) figure.appendChild(chart);
        (figure as HTMLElement).style.margin = "0";
        el.replaceChildren(figure);
      };
      mount(render(kind, columns, data, box, format, secondaryFormat, labels, measureColumns, separateAxes, temporalColumns, metricFormats, timeGrains, metricOrder));
      // Plot stacks a legend ABOVE the svg. Exploration also needs its own
      // row, so neither its trigger nor the legend covers chart content.
      // Measure both after mounting and reserve that space on the redraw.
      const pickColumn = chartAxis(kind, chartRoles(columns, data, measureColumns).dims, data, temporalColumns);
      // Small multiples act on their panel category, never their time axis.
      const pick = onPick && pickColumn && (kind === "smallMultiples" || !pickableColumns || pickableColumns.includes(pickColumn)) ? (column: string, value: PickValue) => {
        if (explorationFocus && el.querySelector(".chart-explore")?.contains(document.activeElement)) explorationFocus.current = true;
        picker.current?.(column, value);
      } : undefined;
      attachPicker(el, pickColumn, data, kind, pick);
      const fig = el.firstElementChild as HTMLElement | null;
      if (fig) {
        // offsetHeight, not getBoundingClientRect: the canvas is CSS-scaled, so
        // the rect is in screen pixels while box.h is in layout pixels. Mixing
        // them makes the correction wrong at every zoom except 100%.
        const explorer = el.querySelector<HTMLElement>(".chart-explore");
        const controlsHeight = explorer ? explorer.offsetHeight + (parseFloat(getComputedStyle(el).rowGap) || 0) : 0;
        const spill = Math.round(fig.offsetHeight + controlsHeight - box.h);
        if (spill > 1) {
          if (box.h - spill < 60) throw new Error("Enlarge this chart to make room for its legend and exploration controls.");
          mount(render(kind, columns, data,
            { w: box.w, h: box.h - spill }, format, secondaryFormat, labels, measureColumns, separateAxes, temporalColumns, metricFormats, timeGrains, metricOrder));
          attachPicker(el, pickColumn, data, kind, pick);
        }
      }
      if (restoreExplorationFocus || explorationFocus?.current && document.activeElement === document.body) {
        (el.querySelector<HTMLElement>(".chart-explore summary") ?? el).focus({ preventScroll: true });
      }
      if (explorationFocus) explorationFocus.current = false;
      status.current?.(null);
    } catch (e: any) {
      status.current?.(e?.message ?? "Chart could not render");
      const msg = document.createElement("div");
      msg.className = "chart-err";
      msg.textContent = `Could not draw this as a ${kind}: ${e?.message ?? e}`;
      host.current.replaceChildren(msg);
    }
  }, [kind, dataKey, separateAxes, box.w, box.h, JSON.stringify(measureColumns), JSON.stringify(temporalColumns), JSON.stringify(timeGrains), JSON.stringify(pickableColumns), JSON.stringify(format), JSON.stringify(secondaryFormat), JSON.stringify(metricFormats), JSON.stringify(labels), JSON.stringify(metricOrder), !!onPick]);

  return <div ref={host} className="chart-host" tabIndex={-1} aria-label="Chart" style={{ width: "100%", height: "100%", position: "relative" }} />;
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

export function magnitudeSplit(data: any[], measures: string[], separateUnits = false, zeroAnchored = false): DualAxisPlan | null {
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
    const vals = data.map(d => numericValue(d[m])).filter((v): v is number => v !== null);
    return vals.length ? { min: Math.min(...vals), max: Math.max(...vals) } : null;
  };
  const withExtent = measures.map((m) => ({ m, e: extent(m) }))
    .filter((x): x is { m: string; e: { min: number; max: number } } => !!x.e);
  if (withExtent.length < 2) return null;

  const span = (e: { min: number; max: number }) => Math.max(Math.abs(e.max), Math.abs(e.min));
  const byMax = separateUnits ? withExtent : [...withExtent].sort((a, b) => span(b.e) - span(a.e));
  const top = byMax[0];
  if (!separateUnits && span(top.e) <= 0) return null;
  const secondary = byMax.slice(1).filter((x) => separateUnits || span(top.e) / Math.max(span(x.e), 1e-9) > MAGNITUDE_THRESHOLD);
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
  // A bar/line composition needs honest zero baselines on both axes.
  // Otherwise nearly constant rates acquire dramatic slopes and the right
  // axis is squeezed into the bars' small min/max band.
  if (zeroAnchored) {
    primaryDomain.min = Math.min(0, primaryDomain.min);
    primaryDomain.max = Math.max(0, primaryDomain.max) || 1;
    secondaryDomain.min = Math.min(0, secondaryDomain.min);
    secondaryDomain.max = Math.max(0, secondaryDomain.max) || 1;
  }
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
export function preciseTickFormat(ticks: number[], base: NumberFormatter): (v: number) => string {
  ticks = [...new Set(ticks.filter(Number.isFinite))];
  const labels = ticks.map(base);
  if (new Set(labels).size === labels.length) return base;
  if (base.withPrecision) {
    for (let digits = 1; digits <= 20; digits++) {
      const format = base.withPrecision(digits);
      if (new Set(ticks.map(format)).size === ticks.length) return format;
    }
    // Fixed decimals may not separate extremely small values. Preserve the
    // declared multiplier even when scientific notation becomes necessary.
    if (base.exact) return base.exact;
  }
  const step = Math.abs((ticks[1] ?? ticks[0] + 1) - ticks[0]) || 1;
  const decimals = Math.max(2, Math.ceil(-Math.log10(step)) + 1);
  const sample = base(ticks[0] ?? 0);
  // Percent isn't just a suffix -- format.ts's "%" formatter multiplies by
  // 100 first (d3-format's own "%" type does that internally). Slapping a
  // literal "%" after the raw value would print 0.1 as "0.1%" instead of
  // "10.0%", a fake hundred-fold error, not just a cosmetic miss.
  if (/%$/.test(sample)) return d3format(`,.${decimals}%`);
  const prefix = sample.match(/^[^\d.−-]*/)?.[0] ?? "";
  const suffix = sample.match(/[^\d.−-]*$/)?.[0] ?? "";
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
  // Legends contain their own tiny SVG swatches before the plot. The axis
  // must share the marks' coordinate space, never a legend swatch's.
  const svg: SVGSVGElement | null = fig.tagName === "FIGURE" ? fig.querySelector(":scope > svg") : fig;
  if (!svg) return fig;

  const pixelFor = (v: number) => ys.apply(plan.remap(v));
  const axisScale = scaleLinear()
    .domain([plan.secondaryDomain.min, plan.secondaryDomain.max])
    .range([pixelFor(plan.secondaryDomain.min), pixelFor(plan.secondaryDomain.max)]);

  const axis = axisRight(axisScale).ticks(5);
  const tickValues = axisScale.ticks(5);
  const g = select(document.createElementNS("http://www.w3.org/2000/svg", "g"))
    .attr("class", "secondary-axis")
    .attr("aria-label", "Secondary y-axis")
    .attr("transform", `translate(${width - marginRight + 6},0)`)
    .attr("font-size", "11px")
    .call(axis.tickFormat(preciseTickFormat(tickValues, tick) as any));
  g.selectAll("path,line").attr("stroke", "var(--ink-3)");
  g.selectAll("text").attr("fill", "var(--ink-3)");
  svg.appendChild(g.node()!);
  return fig;
}

/**
 * Draws Broadside editorial annotations onto a rendered Plot figure:
 * - Horizontal dashed target benchmark line + amber pill (`f.targetValue`, `f.targetLabel`)
 * - Vertical dashed policy/event cutover rule + dark pill badge (`f.annotations`)
 * - Partial-period diagonal amber settlement-lag hatch over the final temporal interval on area charts
 */
function addBroadsideMarks(
  fig: any,
  f: import("../format/format.ts").FormatSpec,
  data: any[],
  x: string,
  y: string,
  temporalX: boolean,
  kind: ChartKind,
  box: { w: number; h: number },
  marginLeft: number,
  marginRight: number,
) {
  if (typeof fig?.scale !== "function") return fig;
  const xs = fig.scale("x");
  const ys = fig.scale("y");
  if (!xs || !ys || typeof xs.apply !== "function" || typeof ys.apply !== "function") return fig;
  const svg: SVGSVGElement | null = fig.tagName === "FIGURE" ? fig.querySelector(":scope > svg") : fig;
  if (!svg) return fig;

  const ns = "http://www.w3.org/2000/svg";
  const xRange = Array.isArray(xs.range) && xs.range.length >= 2 ? xs.range : [marginLeft, box.w - marginRight];
  const yRange = Array.isArray(ys.range) && ys.range.length >= 2 ? ys.range : [12, box.h - 34];
  const xLeft = Math.min(...xRange);
  const xRight = Math.max(...xRange);
  const yTop = Math.min(...yRange);
  const yBottom = Math.max(...yRange);

  const layer = document.createElementNS(ns, "g");
  layer.setAttribute("class", "broadside-annotations");
  layer.setAttribute("pointer-events", "none");

  // 1. Partial-period diagonal settlement-lag hatch on temporal area charts
  if (kind === "area" && temporalX) {
    const valid = data
      .filter((d) => d[x] instanceof Date && Number.isFinite(+d[x]) && typeof d[y] === "number" && Number.isFinite(d[y]))
      .sort((a, b) => +a[x] - +b[x]);
    if (valid.length >= 4) {
      const prev = valid[valid.length - 2];
      const last = valid[valid.length - 1];
      const hx1 = xs.apply(prev[x]);
      const hx2 = xs.apply(last[x]);
      const hy1 = ys.apply(prev[y]);
      const hy2 = ys.apply(last[y]);
      const rawY0 = ys.apply(0);
      const hy0 = Number.isFinite(rawY0) ? Math.min(yBottom, Math.max(yTop, rawY0)) : yBottom;
      if (Number.isFinite(hx1) && Number.isFinite(hx2) && hx2 > hx1 + 6 && Number.isFinite(hy1) && Number.isFinite(hy2)) {
        const patternId = `broadside-lag-hatch-${Math.round(box.w)}-${Math.round(box.h)}`;
        let defs = svg.querySelector("defs");
        if (!defs) {
          defs = document.createElementNS(ns, "defs");
          svg.insertBefore(defs, svg.firstChild);
        }
        if (!defs.querySelector(`#${patternId}`)) {
          const pat = document.createElementNS(ns, "pattern");
          pat.setAttribute("id", patternId);
          pat.setAttribute("width", "8");
          pat.setAttribute("height", "8");
          pat.setAttribute("patternUnits", "userSpaceOnUse");
          pat.setAttribute("patternTransform", "rotate(45)");
          const bg = document.createElementNS(ns, "rect");
          bg.setAttribute("width", "8");
          bg.setAttribute("height", "8");
          bg.setAttribute("fill", "#fef3c7");
          bg.setAttribute("fill-opacity", "0.24");
          const stripe = document.createElementNS(ns, "line");
          stripe.setAttribute("x1", "0");
          stripe.setAttribute("y1", "0");
          stripe.setAttribute("x2", "0");
          stripe.setAttribute("y2", "8");
          stripe.setAttribute("stroke", "#d97706");
          stripe.setAttribute("stroke-width", "1.6");
          stripe.setAttribute("stroke-opacity", "0.48");
          pat.append(bg, stripe);
          defs.appendChild(pat);
        }

        const poly = document.createElementNS(ns, "polygon");
        poly.setAttribute("class", "broadside-hatch-zone");
        poly.setAttribute("points", `${hx1},${hy1} ${hx2},${hy2} ${hx2},${hy0} ${hx1},${hy0}`);
        poly.setAttribute("fill", `url(#${patternId})`);
        const title = document.createElementNS(ns, "title");
        title.textContent = "Late settlement hatched";
        poly.appendChild(title);
        layer.appendChild(poly);

        const sep = document.createElementNS(ns, "line");
        sep.setAttribute("x1", String(hx1));
        sep.setAttribute("y1", String(yTop));
        sep.setAttribute("x2", String(hx1));
        sep.setAttribute("y2", String(hy0));
        sep.setAttribute("stroke", "#d97706");
        sep.setAttribute("stroke-width", "1.1");
        sep.setAttribute("stroke-dasharray", "3,3");
        sep.setAttribute("stroke-opacity", "0.75");
        layer.appendChild(sep);

        const tag = document.createElementNS(ns, "text");
        tag.setAttribute("x", String(Math.min(xRight - 4, (hx1 + hx2) / 2)));
        tag.setAttribute("y", String(Math.max(10, yTop + 9)));
        tag.setAttribute("text-anchor", "middle");
        tag.setAttribute("fill", "#b45309");
        tag.setAttribute("font-family", "JetBrains Mono, ui-monospace, monospace");
        tag.setAttribute("font-size", "8.5");
        tag.setAttribute("font-weight", "700");
        tag.setAttribute("letter-spacing", "0.05em");
        tag.textContent = "LAG HATCHED";
        layer.appendChild(tag);
      }
    }
  }

  // 2. Horizontal target benchmark line + pill
  if (typeof f.targetValue === "number" && Number.isFinite(f.targetValue)) {
    const ty = ys.apply(f.targetValue);
    if (Number.isFinite(ty) && ty >= yTop - 4 && ty <= yBottom + 4) {
      const line = document.createElementNS(ns, "line");
      line.setAttribute("class", "broadside-target-line");
      line.setAttribute("x1", String(xLeft));
      line.setAttribute("y1", String(ty));
      line.setAttribute("x2", String(xRight));
      line.setAttribute("y2", String(ty));
      line.setAttribute("stroke", "#d97706");
      line.setAttribute("stroke-width", "1.5");
      line.setAttribute("stroke-dasharray", "5,4");
      layer.appendChild(line);

      const labelText = (f.targetLabel && f.targetLabel.trim() ? f.targetLabel.trim() : "Target").toUpperCase();
      const pillW = Math.max(66, Math.round(labelText.length * 6.0 + 16));
      const pillH = 17;
      const pillX = xLeft + 8;
      const pillY = Math.max(yTop + 2, Math.min(yBottom - pillH - 2, ty - pillH - 3));
      const rect = document.createElementNS(ns, "rect");
      rect.setAttribute("x", String(pillX));
      rect.setAttribute("y", String(pillY));
      rect.setAttribute("width", String(pillW));
      rect.setAttribute("height", String(pillH));
      rect.setAttribute("rx", "3.5");
      rect.setAttribute("fill", "#fef3c7");
      rect.setAttribute("stroke", "#d97706");
      rect.setAttribute("stroke-width", "1");
      const text = document.createElementNS(ns, "text");
      text.setAttribute("x", String(pillX + pillW / 2));
      text.setAttribute("y", String(pillY + 11.5));
      text.setAttribute("text-anchor", "middle");
      text.setAttribute("fill", "#92400e");
      text.setAttribute("font-family", "JetBrains Mono, ui-monospace, monospace");
      text.setAttribute("font-size", "9");
      text.setAttribute("font-weight", "700");
      text.setAttribute("letter-spacing", "0.04em");
      text.textContent = labelText;
      layer.append(rect, text);
    }
  }

  // 3. Vertical policy-cut / event annotations on temporal axis
  if (temporalX && Array.isArray(f.annotations) && f.annotations.length > 0) {
    for (const ann of f.annotations) {
      if (!ann?.at || !ann?.label) continue;
      const dt = coerceDate(ann.at);
      if (!(dt instanceof Date) || Number.isNaN(+dt)) continue;
      const ax = xs.apply(dt);
      if (!Number.isFinite(ax) || ax < xLeft - 2 || ax > xRight + 2) continue;

      const vline = document.createElementNS(ns, "line");
      vline.setAttribute("class", "broadside-policy-line");
      vline.setAttribute("x1", String(ax));
      vline.setAttribute("y1", String(yTop + 18));
      vline.setAttribute("x2", String(ax));
      vline.setAttribute("y2", String(yBottom));
      vline.setAttribute("stroke", "#090d16");
      vline.setAttribute("stroke-width", "1.5");
      vline.setAttribute("stroke-dasharray", "4,3");
      vline.setAttribute("stroke-opacity", "0.78");
      layer.appendChild(vline);

      const matched = data.find((d) => d[x] instanceof Date && Math.abs(+d[x] - +dt) < 86400000 * 3 && typeof d[y] === "number" && Number.isFinite(d[y]));
      if (matched) {
        const cy = ys.apply(matched[y]);
        if (Number.isFinite(cy)) {
          const dot = document.createElementNS(ns, "circle");
          dot.setAttribute("cx", String(ax));
          dot.setAttribute("cy", String(cy));
          dot.setAttribute("r", "4");
          dot.setAttribute("fill", "#1d4ed8");
          dot.setAttribute("stroke", "#ffffff");
          dot.setAttribute("stroke-width", "1.75");
          layer.appendChild(dot);
        }
      }

      const badgeText = ann.label.trim().toUpperCase();
      const badgeW = Math.max(84, Math.round(badgeText.length * 5.6 + 16));
      const badgeH = 18;
      const badgeX = Math.max(xLeft + 4, Math.min(xRight - badgeW - 4, ax - badgeW / 2));
      const badgeY = yTop + 1;
      const badgeRect = document.createElementNS(ns, "rect");
      badgeRect.setAttribute("x", String(badgeX));
      badgeRect.setAttribute("y", String(badgeY));
      badgeRect.setAttribute("width", String(badgeW));
      badgeRect.setAttribute("height", String(badgeH));
      badgeRect.setAttribute("rx", "3.5");
      badgeRect.setAttribute("fill", "#090d16");
      const badgeLabel = document.createElementNS(ns, "text");
      badgeLabel.setAttribute("x", String(badgeX + badgeW / 2));
      badgeLabel.setAttribute("y", String(badgeY + 12));
      badgeLabel.setAttribute("text-anchor", "middle");
      badgeLabel.setAttribute("fill", "#ffffff");
      badgeLabel.setAttribute("font-family", "JetBrains Mono, ui-monospace, monospace");
      badgeLabel.setAttribute("font-size", "8.8");
      badgeLabel.setAttribute("font-weight", "700");
      badgeLabel.setAttribute("letter-spacing", "0.04em");
      badgeLabel.textContent = badgeText;
      layer.append(badgeRect, badgeLabel);
    }
  }

  if (layer.childNodes.length > 0) {
    svg.appendChild(layer);
  }
  return fig;
}

/** Rows with a present value. This helper is for independent marks only:
 * connected line/area paths must retain missing rows so they break at gaps. */
export function definedRows<T extends Record<string, unknown>>(rows: T[], key: string): T[] {
  return rows.filter((r) => r[key] != null);
}

function temporalColumn(data: Record<string, unknown>[], column: string) {
  return data.some(d => d[column] instanceof Date) && data.every(d => d[column] == null || d[column] instanceof Date);
}

/** A category may precede time in SQL. Plot and click-to-drill must agree on
 * the actual time axis rather than assuming the first selected breakdown. */
function chartAxis(kind: ChartKind, dims: string[], data: Record<string, unknown>[], temporalColumns?: string[]) {
  return (["line", "areaStacked", "smallMultiples"].includes(kind)
    ? dims.find(d => temporalColumns ? temporalColumns.includes(d) : temporalColumn(data, d)) : undefined) ?? dims[0] ?? null;
}

function render(kind: ChartKind, columns: string[], data: any[], box: { w: number; h: number },
                fmt?: import("../format/format.ts").FormatSpec,
                secondaryFmt?: import("../format/format.ts").FormatSpec, labels: Record<string, string> = {}, measureColumns?: string[], separateAxes = false, temporalColumns?: string[], metricFormats?: Record<string, import("../format/format.ts").FormatSpec>, timeGrains?: Record<string, TimeGrain>, metricOrder: string[] = []) {
  const f = fmt ?? DEFAULT_FORMAT;
  const palette = PALETTES[f.palette] ?? PALETTES.default;
  // Convention from the compiler: dimensions are selected first, metrics last.
  const { measures, dims } = chartRoles(columns, data, measureColumns);
  // A magnitude split can put either selected metric on the right. Each
  // axis chooses units from its own original values, never remapped pixels.
  const dualTick = (names: string[]) => makeAxisFormatter(
    names[0] === measures[1] && secondaryFmt ? secondaryFmt : f,
    data.flatMap(row => names.map(name => row[name])),
  );
  const dualCaption = (plan: DualAxisPlan) => {
    const name = (m: string) => `${labels[m] ?? m}${kind === "combo" ? m === measures[0] ? " (bars)" : " (line)" : ""}`;
    return `Independent scales · Left: ${plan.primary.map(name).join(", ")} · Right: ${plan.secondary.map(name).join(", ")}`;
  };
  const shapeIssue = chartShapeIssue(kind, { measures: measures.length, dimensions: dims.map(d => ({
    temporal: temporalColumns ? temporalColumns.includes(d) : temporalColumn(data, d), numeric: data.some(row => typeof row[d] === "number"),
  })) });
  if (shapeIssue) throw new Error(shapeIssue);
  if (["waterfall", "funnel", "donut"].includes(kind) && data.some(d => measures.some(m => d[m] == null)))
    throw new Error("This chart needs a value for every component. Use a table to show the missing values.");
  if (["waterfall", "funnel", "donut"].includes(kind)) data.forEach(d => measures.forEach(m => componentValue(d[m])));
  // Preserve raw rows for evidence and table inspection. Plot receives only
  // measured numeric values; invalid results stay gaps, never coerced zeros.
  data = data.map(row => ({ ...row, ...Object.fromEntries(measures.map(m => [m, numericValue(row[m])])) }));
  const tick = makeAxisFormatter(f, data.flatMap(row => measures.filter((_, i) => !separateAxes || i === 0).map(m => row[m])));
  const x = chartAxis(kind, dims, data, temporalColumns) ?? columns[0];
  const y = measures[0] ?? columns[1];

  const temporalX = temporalColumns ? temporalColumns.includes(x) : temporalColumn(data, x);
  if (temporalX && ["line", "area", "areaStacked", "combo", "smallMultiples"].includes(kind))
    data = breakTemporalGaps(data, x, measures, timeGrains?.[x], dims.filter(d => d !== x));
  // Label the observed reporting buckets, not unrelated weekly boundaries on
  // a monthly chart. Intraday timestamps retain Plot's time-aware formatter.
  const maxTicks = Math.max(2, Math.floor(box.w / 90));
  const times = [...new Set(data.flatMap(d => d[x] instanceof Date ? [+d[x]] : []))].sort((a, b) => a - b).map(t => new Date(t));
  const dateOnly = times.length > 0 && times.every(d => +d % 86400000 === 0);
  const dateLabel = dateLabeler(times);
  const dateLabelWidth = Math.max(0, ...times.map(d => dateLabel(d).length * 6));
  const marginLeft = f.showY ? 62 : Math.max(12, dateLabelWidth / 2 + 8);
  const marginRight = temporalX && f.showX ? Math.max(20, dateLabelWidth / 2 + 8) : 20;
  const bandDates = (domain: unknown[], width = box.w - marginLeft - marginRight) => temporalX ? {
    ticks: spacedBandTicks(domain, width, dateLabelWidth + 16),
    tickFormat: (v: unknown) => dateLabel(new Date(String(v))), tickRotate: 0,
  } : {};
  const xScale: any = temporalX
    ? { type: "utc", ...(dateOnly
      ? { ticks: spacedDateTicks(times, box.w - marginLeft - marginRight, dateLabelWidth + 16), tickFormat: dateLabel }
      : { ticks: maxTicks }) }
    : { tickRotate: labelsAreLong(data, x) ? -35 : 0 };

  const common: any = {
    width: box.w, height: box.h,
    marginLeft, marginRight,
    marginBottom: f.showX ? (xScale.tickRotate ? 58 : 34) : 12, marginTop: 12,
    style: { background: "transparent", fontSize: "11px" },
    x: { label: f.xTitle, axis: f.showX ? "bottom" : null, ...xScale },
    y: { label: f.yTitle, axis: f.showY ? "left" : null,
         grid: f.grid, nice: true, tickFormat: tick },
    color: { range: palette, tickFormat: (value: string) => labels[value] ?? value },
  };
  const legend = f.legend !== "hide";
  const metricColors = { ...common.color, ...metricColorScale(measures, metricOrder, palette) };
  const metricColor = (metric: string) => metricColors.range[metricColors.domain.indexOf(metric)];

  // Long/tidy form lets one mark serve any number of measures.
  const category = dims.length === 2 ? dims.find(d => d !== x) : undefined;
  const segmented = category && ["line", "areaStacked", "barGrouped", "barStacked", "smallMultiples"].includes(kind)
    ? categorySeries(data, x, category, y, temporalX || kind === "barStacked") : undefined;
  const tidy = segmented?.points ?? data.flatMap((d) => measures.map((m) => ({ x: d[x], series: m, value: d[m] })));
  const seriesColor = { ...(segmented ? common.color : metricColors), ...(segmented ? {
    domain: [...segmented.labels.keys()], tickFormat: (v: string) => segmented.labels.get(v) ?? v,
  } : {}), legend: legend && (!!segmented || measures.length > 1) };
  const pointTitle = (d: typeof tidy[number]) => `${segmented?.labels.get(d.series) ?? labels[d.series] ?? d.series}\n${d.x instanceof Date ? d.x.toISOString().slice(0, 10) : d.x}\n${segmented ? `${labels[y] ?? y}: ` : ""}${d.value == null ? "No data" : d.value}`;

  switch (kind) {
    case "line": {
      const dual = magnitudeSplit(data, measures, separateAxes);
      const fitted = f.lineScale === "fit";
      const observed = tidy.map(d => numericValue(d.value)).filter((v): v is number => v !== null);
      const fitTicks = (values: number[], formatter: NumberFormatter) => fitted && values.length
        ? preciseTickFormat(scaleLinear().domain([Math.min(...values), Math.max(...values)]).nice().ticks(10), formatter) : formatter;
      const scaleCaption = (plot: any, formatter: (n: number) => string, existing = "") => {
        if (!fitted) return plot;
        const domain = plot.scale("y")?.domain as number[] | undefined;
        const caption = plot.querySelector("figcaption");
        if (caption && !observed.length) caption.textContent = "No observed measure values; no fitted range available.";
        else if (caption && domain?.length) {
          const lo = domain[0], hi = domain[domain.length - 1];
          const precise = preciseTickFormat([lo, hi], formatter);
          caption.textContent = `${dual ? "Left y-axis" : "Y-axis"} fitted to data: ${precise(lo)} – ${precise(hi)}${existing ? ` · ${existing}` : ""}`;
        }
        return plot;
      };
      if (!dual) {
        const fittedTick = fitTicks(observed, tick);
        const plot = scaleCaption(Plot.plot({ ...common, y: { ...common.y, tickFormat: fittedTick }, color: seriesColor, ...(fitted ? { caption: "Y-axis fitted to data" } : {}),
          marks: [...(fitted ? [] : [Plot.ruleY([0])]),
            Plot.line(tidy, { x: "x", y: "value", stroke: "series", curve: "monotone-x", strokeWidth: 2 }),
            Plot.dot(tidy, { x: "x", y: "value", stroke: "series", fill: "series", r: 2.5, title: pointTitle })] }), fittedTick);
        return addBroadsideMarks(plot, f, data, x, y, temporalX, kind, box, marginLeft, marginRight);
      }
      // Secondary-axis series are remapped into the primary axis's numeric
      // range so one Plot y-scale can position both, then a real axis in
      // the secondary series' own units is drawn on afterward -- each
      // series ends up shaped by its OWN range, not squashed by the other.
      const secondarySet = new Set(dual.secondary);
      const tidyDual = data.flatMap((d) => measures.map((m) => ({
        x: d[x], series: m,
        value: d[m] == null ? NaN : secondarySet.has(m) ? dual.remap(Number(d[m])) : Number(d[m]),
      })));
      const dualMarginRight = f.showY ? 54 : 12;
      const primaryTick = fitTicks(data.flatMap(d => dual.primary.map(m => numericValue(d[m])).filter((v): v is number => v !== null)), dualTick(dual.primary));
      const fig = Plot.plot({ ...common, y: { ...common.y, tickFormat: primaryTick }, marginRight: dualMarginRight, caption: dualCaption(dual),
        color: { ...metricColors, legend },
        marks: [...(fitted ? [] : [Plot.ruleY([0])]),
          Plot.line(tidyDual, { x: "x", y: "value", stroke: "series", curve: "monotone-x", strokeWidth: 2 }),
          Plot.dot(tidyDual, { x: "x", y: "value", stroke: "series", r: 1.6 })] });
      const withCaption = scaleCaption(fig, primaryTick, dualCaption(dual));
      const withAxis = f.showY ? addSecondaryAxis(withCaption, dual, dualTick(dual.secondary), dualMarginRight, box.w) : withCaption;
      return addBroadsideMarks(withAxis, f, data, x, y, temporalX, kind, box, marginLeft, dualMarginRight);
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
      const dual = magnitudeSplit(data, measures, separateAxes, true);
      const secondarySet = new Set(dual?.secondary ?? []);
      const valueFor = (m: string, d: any) => {
        if (d[m] == null) return NaN;
        const v = Number(d[m]);
        return secondarySet.has(m) && dual ? dual.remap(v) : v;
      };
      // barY needs a discrete (band) x-scale, but `common.x` forces a
      // continuous "utc" scale whenever the dimension is temporal -- Plot
      // rejects mixing the two ("scale incompatible with channel: utc !==
      // band"). A shared discrete axis is also how a bar+line combo
      // conventionally renders. Keep exact period keys on that scale and
      // format only the visible labels, so distinct timestamps never merge.
      const label = dateLabeler(data.map((d: any) => d[x]));
      const key = (v: unknown) => v instanceof Date ? v.toISOString() : v;
      const barRows = data.map((d: any) => ({ x: key(d[x]), label: label(d[x]), value: valueFor(barMeasure, d) }));
      const lineRows = data.map((d: any) => ({ x: key(d[x]), value: valueFor(lineMeasure, d) }));
      const axisLabel = (value: unknown) => temporalX ? label(new Date(String(value))) : String(value);
      // Plot's default ordinal scale sorts a string domain alphabetically --
      // fine for plain categories, wrong for "Apr 25, Aug 24, Dec 25, ...".
      // The rows already arrive in the query's own (chronological) order,
      // so an explicit domain in THAT order, not sorted, keeps it a time
      // axis in every way except its scale type.
      const xDomain = [...new Set(barRows.map((r) => r.x))];
      const rotated = labelsAreLong(barRows, "label");
      const labelWidth = Math.max(0, ...barRows.map(row => row.label.length * 6));
      const marginRight = dual ? (f.showY ? 54 : 12) : 12;
      const fig = Plot.plot({
        width: box.w, height: box.h,
        ...(dual ? { caption: dualCaption(dual) } : {}),
        marginLeft: Math.max(f.showY ? 62 : 12, f.showX && rotated ? Math.ceil(labelWidth * .82) + 8 : 12), marginRight,
        marginBottom: f.showX ? (rotated ? Math.ceil(labelWidth * .58) + 18 : 34) : 12, marginTop: 12,
        style: { background: "transparent", fontSize: "11px" },
        x: { label: f.xTitle, axis: f.showX ? "bottom" : null, domain: xDomain, tickFormat: axisLabel,
             tickRotate: rotated ? -35 : 0, ...bandDates(xDomain, box.w - Math.max(62, Math.ceil(labelWidth * .82) + 8) - marginRight) },
        y: { label: f.yTitle, axis: f.showY ? "left" : null, grid: f.grid, nice: true, tickFormat: dual ? dualTick(dual.primary) : tick },
        color: { ...metricColors, legend },
        marks: [
          Plot.ruleY([0]),
          Plot.barY(barRows, { x: "x", y: "value", fill: () => barMeasure, fillOpacity: 0.85 }),
          Plot.line(lineRows, { x: "x", y: "value", stroke: () => lineMeasure, strokeWidth: 2, curve: "monotone-x" }),
          Plot.dot(lineRows, { x: "x", y: "value", fill: () => lineMeasure, r: 2 }),
        ] });
      return dual && f.showY ? addSecondaryAxis(fig, dual, dualTick(dual.secondary), marginRight, box.w) : fig;
    }
    case "area": {
      const plot = Plot.plot({ ...common,
        // Explicit boundaries avoid areaY's default stacking, which treats
        // missing measures as empty layers. Retaining the rows breaks both
        // paths at unavailable observations instead of connecting over them.
        marks: [
          Plot.area(data, { x1: x, x2: x, y1: 0, y2: y, fill: metricColor(y), fillOpacity: 0.16 }),
          Plot.line(data, { x, y, stroke: metricColor(y), strokeWidth: 2.2, curve: "monotone-x" }),
          Plot.dot(definedRows(data, y), { x, y, fill: metricColor(y), stroke: "var(--surface)", r: 2.8 }),
          Plot.ruleY([0]),
        ] });
      return addBroadsideMarks(plot, f, data, x, y, temporalX, kind, box, marginLeft, marginRight);
    }
    case "areaStacked": {
      // A missing component is an unknown total, not an empty/zero layer.
      if (tidy.some(d => d.value == null)) throw new Error("A stacked area needs every component in each period. Use lines or a table to show the missing values.");
      return Plot.plot({ ...common, color: seriesColor,
        marks: [Plot.areaY(tidy, { x: "x", y: "value", fill: "series", fillOpacity: 0.85, tip: true, title: pointTitle }), Plot.ruleY([0])] });
    }
    case "bar": {
      if (!dims.length) {
        const values = measures.map(m => ({ series: m, value: data[0]?.[m] }));
        return Plot.plot({ ...common, color: metricColors, x: { type: "band", label: f.xTitle, axis: f.showX ? "bottom" : null,
          domain: measures, tickFormat: (m: string) => labels[m] ?? m },
          marks: [Plot.barY(values, { x: "series", y: "value", fill: "series", fillOpacity: 0.75 }), Plot.ruleY([0])] });
      }
      // Values remain unique even when abbreviated date labels coincide.
      const key = (v: any) => v instanceof Date ? v.toISOString() : v;
      const rows = data.map(d => ({ ...d, [x]: key(d[x]) }));
      if (measures.length > 1 && dims.length <= 1) {
        const grouped = rows.flatMap(d => measures.map(m => ({ bucket: d[x], series: m, value: d[m] })));
        return Plot.plot({ ...common,
          x: { type: "band", axis: null },
          fx: { label: f.xTitle, domain: [...new Set(rows.map(d => d[x]))], ...bandDates([...new Set(rows.map(d => d[x]))]), axis: f.showX ? "bottom" : null },
          marginBottom: f.showX ? 58 : 12,
          color: { ...metricColors, legend },
          marks: [Plot.barY(grouped, { x: "series", y: "value", fx: "bucket", fill: "series" }), Plot.ruleY([0])] });
      }
      const series = dims[1];
      if (series) return Plot.plot({ ...common,
        x: { type: "band", axis: null },
        fx: { type: "band", domain: [...new Set(rows.map(d => d[x]))], label: f.xTitle, axis: f.showX ? "bottom" : null,
          ...bandDates([...new Set(rows.map(d => d[x]))]) },
        color: { ...common.color, legend },
        marks: [Plot.barY(rows, { x: series, fx: x, y, fill: series }), Plot.ruleY([0])] });
      return Plot.plot({ ...common,
        x: { type: "band", label: f.xTitle, axis: f.showX ? "bottom" : null,
          domain: [...new Set(rows.map(d => d[x]))], ...bandDates([...new Set(rows.map(d => d[x]))]) },
        marginBottom: f.showX && temporalX ? 58 : common.marginBottom,
        color: { ...common.color, legend: legend && !!series },
        marks: [Plot.barY(rows, { x, y, fill: series ?? metricColor(y), fillOpacity: 0.75 }), Plot.ruleY([0])] });
    }
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
        ? measures.map((m) => ({ label: m, value: componentValue(data[0]?.[m]) }))
        : data.map((d: any) => ({ label: label(d[x]), value: componentValue(d[y]) }));
      let running = 0;
      const bars = named.map((r, index) => {
        const before = running;
        running += r.value;
        if (!Number.isFinite(running)) throw new Error("The waterfall total exceeds the supported numeric range. Use a table to inspect the components.");
        return { key: `component:${index}`, label: r.label, lo: Math.min(before, running), hi: Math.max(before, running),
                 after: running, value: r.value, kind: r.value >= 0 ? "pos" : "neg" as const };
      });
      bars.push({ key: "generated:total", label: "Net change", lo: Math.min(0, running), hi: Math.max(0, running),
                  after: running, value: running, kind: "total" as const });
      const barColor = (k: string) => k === "pos" ? "var(--pos)" : k === "neg" ? "var(--neg)" : "var(--ink-2)";
      const bridges = bars.slice(0, -1).map((b, i) => ({ y: b.after, x1: b.key, x2: bars[i + 1].key }));
      const plot = Plot.plot({ ...common,
        x: { label: f.xTitle, axis: f.showX ? "bottom" : null, domain: bars.map((b) => b.key), tickFormat: (key: string) => bars.find(b => b.key === key)?.label ?? key,
             tickRotate: labelsAreLong(bars, "label") ? -35 : 0 },
        marks: [
          Plot.ruleY([0]),
          Plot.ruleY(bridges, { x1: "x1", x2: "x2", y: "y", stroke: "var(--line-2)", strokeDasharray: "2,2" }),
          Plot.barY(bars, { x: "key", y1: "lo", y2: "hi", fill: (b: any) => barColor(b.kind), fillOpacity: 0.85 }),
          // dy is a constant pixel offset in Plot's types, not a per-datum
          // channel -- two marks (label above the bar, label below it)
          // instead of one text mark trying to flip sides by value.
          Plot.text(bars.filter((b) => b.kind !== "neg"), { x: "key", y: "hi",
                    text: (b: any) => tick(b.value), dy: -6, fontSize: 10, fill: "var(--ink-2)" }),
          Plot.text(bars.filter((b) => b.kind === "neg"), { x: "key", y: "hi",
                    text: (b: any) => tick(b.value), dy: 14, fontSize: 10, fill: "var(--ink-2)" }),
        ] });
      (plot as any).__sourceValues = new Map(data.map((d, i) => [`component:${i}`, d[x]]));
      return plot;
    }
    case "funnel": {
      const label = dateLabeler(data.map(d => d[x]));
      const prepared = funnelStages(dims.length === 0
        ? measures.map(m => ({ label: labels[m] ?? m, value: data[0]?.[m] }))
        : data.map(d => ({ label: d[x] == null ? "Missing stage" : label(d[x]), value: d[y] })));
      if (prepared.rows.length > Math.floor((box.h - 24) / 18))
        throw new Error("There are too many stages to label at this height. Enlarge the funnel or use a table to show every stage.");
      const valueFormat = makeFormatter(f);
      const valueText = (value: number) => preciseTickFormat([0, value], valueFormat)(value);
      const rows = prepared.rows.map(row => ({ ...row, x1: -row.value / 2, x2: row.value / 2,
        detail: `${valueText(row.value)} · ${row.relative}`,
        title: `${row.label}: ${valueText(row.value)}; ${row.relative} of first stage`,
      }));
      const halfDomain = Math.max(...rows.map(row => row.value / 2), 1);
      const nameWidth = Math.min(box.w * .34, Math.max(72, ...rows.map(row => row.label.length * 8 + 16)));
      const valueWidth = Math.min(box.w * .36, Math.max(90, ...rows.map(row => row.detail.length * 8 + 16)));
      return Plot.plot({
        width: box.w, height: box.h, caption: prepared.caption,
        marginLeft: nameWidth, marginRight: valueWidth, marginTop: 12, marginBottom: 12,
        style: { background: "transparent", fontSize: "11px" },
        x: { axis: null, domain: [-halfDomain * 1.05, halfDomain * 1.05] },
        y: { axis: null, domain: rows.map(row => row.key) },
        marks: [
          Plot.barX(rows, { y: "key", x1: "x1", x2: "x2", fill: "var(--accent)", fillOpacity: .8, title: "title" }),
          Plot.text(rows, { y: "key", frameAnchor: "left", dx: -8, textAnchor: "end", text: "label",
            lineWidth: Math.max(1, (nameWidth - 16) / 11), textOverflow: "ellipsis", fontSize: 11, fill: "var(--ink)" }),
          Plot.text(rows, { y: "key", frameAnchor: "right", dx: 8, textAnchor: "start", text: "detail",
            lineWidth: Math.max(1, (valueWidth - 16) / 11), textOverflow: "ellipsis", fontSize: 11, fill: "var(--ink)" }),
        ],
      });
    }
    case "barGrouped":
    case "barStacked": {
      if (kind === "barStacked" && tidy.some(d => d.value == null))
        throw new Error("A stacked bar needs every component in each group. Use grouped bars or a table to show the missing values.");
      const rows = tidy.map(d => ({ ...d, x: d.x instanceof Date ? d.x.toISOString() : d.x }));
      const axis = { type: "band" as const, label: f.xTitle, axis: f.showX ? "bottom" as const : null,
        domain: [...new Set(rows.map(d => d.x))], ...bandDates([...new Set(rows.map(d => d.x))]) };
      return Plot.plot({ ...common, marginBottom: f.showX && temporalX ? 58 : common.marginBottom,
        x: kind === "barGrouped" ? { type: "band", axis: null } : axis,
        ...(kind === "barGrouped" ? { fx: axis } : {}),
        color: seriesColor,
        marks: [Plot.barY(rows, kind === "barGrouped" ? { x: "series", fx: "x", y: "value", fill: "series", title: pointTitle } : { x: "x", y: "value", fill: "series", title: pointTitle }), Plot.ruleY([0])] });
    }
    case "barH":
    case "barHorizontal": {
      // Position here is (category, measure) = (y, x) -- the opposite of
      // every other case in this switch, which is why this can't just
      // spread `common` the way they do: common.y carries the MEASURE's
      // tickFormat (currency, percent, ...), and applying that to the
      // category axis formats channel names as numbers, producing "$NaN"
      // for every label instead of the channel name.
      const values = data.map(row => row[y]).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
      const low = Math.min(0, ...values), high = Math.max(0, ...values);
      const axis = scaleLinear().domain(low === high ? [0, 1] : [low, high]).nice();
      const [start, end] = axis.domain();
      // Numeric ticks are centered on their positions. Reserve both edge
      // halves and choose density from formatted labels, including signs and
      // authored precision. Seven pixels per character is conservative at 11px.
      const labelWidth = f.showX ? Math.max(...[...axis.ticks(), start, end].map(value => tick(value).length * 7)) : 0;
      const marginLeft = Math.max(f.showY ? 130 : 12, f.showX ? Math.ceil(labelWidth / 2) + 8 : 12);
      const marginRight = f.showX ? Math.max(12, Math.ceil(labelWidth / 2) + 8) : 12;
      const plotWidth = box.w - marginLeft - marginRight;
      if (f.showX && plotWidth < labelWidth + 12) throw new Error("Enlarge this chart to show its numeric axis labels, or reduce the displayed decimal places.");
      const ticks = [start];
      for (const value of axis.ticks(Math.max(1, Math.floor(plotWidth / (labelWidth + 16))))) {
        const gap = (value - ticks[ticks.length - 1]) / (end - start) * plotWidth;
        const remaining = (end - value) / (end - start) * plotWidth;
        if (value > start && value < end && gap >= labelWidth + 12 && remaining >= labelWidth + 12) ticks.push(value);
      }
      ticks.push(end);
      return Plot.plot({
        width: box.w, height: box.h,
        marginLeft, marginRight, marginTop: 12,
        marginBottom: f.showX ? 34 : 12,
        style: { background: "transparent", fontSize: "11px" },
        x: { label: f.xTitle, axis: f.showX ? "bottom" : null, grid: f.grid, domain: [start, end], ticks, tickFormat: tick },
        y: { label: f.yTitle, axis: f.showY ? "left" : null },
        marks: [Plot.barX(data, { y: x, x: y, fill: metricColor(y), fillOpacity: 0.85,
                                  sort: { y: "-x" } }), Plot.ruleX([0])],
      });
    }
    case "donut": {
      const arcs = donutSegments(data.map(d => d[y])).map((segment, i) => ({ ...segment, label: data[i][x] }));
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
        t.textContent = `${a.label}: ${tick(a.value)} (${d3format(".1%")(a.end - a.start)})`;
        p.appendChild(t); svg.appendChild(p);
      });
      svg.setAttribute("role", "img");
      svg.setAttribute("aria-label", `Share of ${labels[y] ?? y} by ${labels[x] ?? x}`);
      if (!legend) return svg;
      const figure = document.createElement("figure"), key = document.createElement("div");
      key.className = "donut-legend";
      key.setAttribute("aria-label", "Donut categories");
      arcs.forEach((item, i) => {
        const row = document.createElement("span"), swatch = document.createElement("i"), text = document.createElement("span");
        swatch.style.backgroundColor = palette[i % palette.length]; swatch.setAttribute("aria-hidden", "true");
        text.textContent = `${item.label}: ${tick(item.value)} (${d3format(".1%")(item.end - item.start)})`;
        row.append(swatch, text); key.appendChild(row);
      });
      figure.append(svg, key);
      return figure;
    }
    case "map": {
      const prepared = prepareMap(data.map(d => ({ place: d[x], value: d[y] })));
      if (prepared.issue) throw new Error(prepared.issue);
      const byId = prepared.values;
      const vals = [...byId.values()].filter(Number.isFinite);
      return Plot.plot({
        width: box.w, height: box.h,
        projection: { type: "equal-earth", domain: { type: "Sphere" } },
        caption: prepared.caption,
        style: { background: "transparent", fontSize: "11px" },
        color: {
          scheme: vals.some((v) => v < 0) ? "BuRd" : "YlGnBu",
          unknown: "var(--surface-2)", legend, label: f.yTitle ?? labels[y] ?? y, tickFormat: tick,
          ...(vals.some((v) => v < 0) ? { pivot: 0 } : {}),
        },
        marks: [
          Plot.sphere({ stroke: "var(--line)", strokeWidth: 0.6 }),
          Plot.geo(COUNTRIES.features, {
            fill: (f: any) => byId.get(String(f.id)) ?? undefined,
            stroke: "var(--line)", strokeWidth: 0.35,
            title: (f: any) => {
              const v = byId.get(String(f.id));
              const name = f.properties?.name ?? "";
              return v == null ? `${name}: no data`
                : `${name}: ${tick(v)}`;
            },
          }),
        ],
      });
    }
    case "scatter": {
      const xName = measures.length === 1 ? dims[0] : measures[0], yName = measures.at(-1)!;
      const xFormat = measures.length === 1 ? { ...f, number: "plain" as const, decimals: null } : metricFormats?.[xName] ?? f;
      const yFormat = metricFormats?.[yName] ?? secondaryFmt ?? f;
      const xTick = makeAxisFormatter(xFormat, data.map(d => tableNumber(d[xName])));
      const yTick = makeAxisFormatter(yFormat, data.map(d => tableNumber(d[yName])));
      const numeric = data.map(d => ({ ...d, [xName]: tableNumber(d[xName]), [yName]: tableNumber(d[yName]) }));
      const group = measures.length > 1 && dims.length === 1 ? dims[0] : undefined;
      // Reserve separate space for formatted ticks and the rotated axis title.
      // Currency ticks can be substantially wider than percentages or counts.
      const yExtent = numeric.map(d => d[yName]).filter(Number.isFinite);
      const yTicks = scaleLinear().domain(yExtent.length ? [Math.min(...yExtent), Math.max(...yExtent)] : [0, 1]).nice().ticks();
      const yLabelOffset = Math.max(64, 26 + Math.max(0, ...yTicks.map(v => yTick(v).length * 7)));
      return Plot.plot({ ...common,
        color: { ...common.color, type: "categorical", legend: legend && !!group, label: group ? labels[group] ?? group : null },
        x: { label: f.xTitle ?? labels[xName] ?? xName, axis: f.showX ? "bottom" : null, grid: f.grid, nice: true, tickFormat: xTick },
        y: { ...common.y, label: f.yTitle ?? labels[yName] ?? yName, labelAnchor: "center", labelOffset: yLabelOffset, tickFormat: yTick },
        marginLeft: f.showY ? yLabelOffset + 18 : 12, marginTop: 24, marginBottom: f.showX ? 48 : 12,
        marks: [Plot.dot(numeric, { x: xName, y: yName, r: 5, fill: group ?? palette[0], fillOpacity: 0.85,
          title: (d: Record<string, unknown>) => [...dims, ...measures].map(c => `${labels[c] ?? c}: ${d[c] == null ? "No data" : c === xName ? makeFormatter(xFormat)(Number(d[c])) : c === yName ? makeFormatter(yFormat)(Number(d[c])) : d[c]}`).join("\n") })] });
    }
    case "heatmap": {
      const prepared = prepareHeatmap(data, dims, measures);
      const metricLabel = (m: string) => {
        const name = labels[m] ?? m;
        return measures.some(other => other !== m && (labels[other] ?? other) === name) ? `${name} (${m})` : name;
      };
      const axis = (values: Map<string, unknown>, metricAxis = false) => {
        const temporal = [...values.values()].some(v => v instanceof Date);
        const date = dateLabeler([...values.values()]);
        const domain = [...values.keys()].sort((a, b) => temporal && values.get(a) instanceof Date && values.get(b) instanceof Date ? +(values.get(a) as Date) - +(values.get(b) as Date) : 0);
        const label = (key: string) => metricAxis ? metricLabel(key) : values.get(key) == null ? "Missing category" : date(values.get(key));
        return { temporal, domain, label };
      };
      const xa = axis(prepared.xValues), ya = axis(prepared.yValues, dims.length === 1);
      const valueFormat = new Map(measures.map(m => [m, makeFormatter(metricFormats?.[m] ?? f)]));
      const cells = prepared.cells.map(c => ({ ...c,
        text: c.raw === null ? "—" : valueFormat.get(c.metric)!(c.raw),
        title: [xa.label(c.x), dims.length > 1 ? ya.label(c.y) : null,
          `${metricLabel(c.metric)}: ${c.raw === null ? c.invalid ? "Invalid numeric value" : "No data" : valueFormat.get(c.metric)!(c.raw)}`,
        ].filter(Boolean).join("\n"),
      }));
      const { type: _xt, ticks: _xk, tickFormat: _xf, ...xBase } = common.x;
      const { tickFormat: _yf, nice: _yn, grid: _yg, ...yBase } = common.y;
      const xLabelWidth = Math.max(0, ...xa.domain.map(v => xa.label(v).length * 6.5));
      const tickRotate = xa.temporal ? 0 : xBase.tickRotate ?? 0;
      const yLabelWidth = 8 + 6.5 * Math.max(0, ...ya.domain.map(v => ya.label(v).length));
      const marginBottom = f.showX && tickRotate ? Math.max(common.marginBottom, Math.ceil(xLabelWidth * Math.abs(Math.sin(tickRotate * Math.PI / 180))) + 24) : common.marginBottom;
      const marginLeft = Math.max(common.marginLeft, f.showX && tickRotate ? Math.ceil(xLabelWidth * Math.abs(Math.cos(tickRotate * Math.PI / 180))) + 8 : 0,
        f.showY ? Math.min(Math.max(140, box.w * .4), yLabelWidth) : 0);
      const showValues = (box.w - marginLeft - common.marginRight) / Math.max(1, xa.domain.length) * .9 >= Math.max(0, ...cells.map(c => c.text.length * 6)) + 12
        && (box.h - marginBottom - common.marginTop) / Math.max(1, ya.domain.length) * .9 >= 22;
      const plot = Plot.plot({ ...common, caption: prepared.caption,
        color: { scheme: "YlGnBu", legend,
          ...(prepared.divergingDomain ? { type: "diverging", scheme: "RdBu", domain: prepared.divergingDomain,
            pivot: 0, symmetric: true, ticks: [prepared.divergingDomain[0], 0, prepared.divergingDomain[1]] } : {}),
          label: prepared.normalized ? "Within each metric" : metricLabel(measures[0]),
          ...(prepared.normalized ? { domain: [0, 1], ticks: [0, .5, 1], tickFormat: (v: number) => v === 0 ? "Low" : v === 1 ? "High" : "Middle" }
            : { tickFormat: makeAxisFormatter(f, prepared.cells.map(c => c.raw)) }),
        },
        x: { ...xBase, type: "band", domain: xa.domain, tickFormat: xa.label, tickRotate,
          ...(xa.temporal ? { ticks: spacedBandTicks(xa.domain, box.w - marginLeft - common.marginRight, xLabelWidth + 16) } : {}) },
        y: { ...yBase, type: "band", domain: ya.domain, tickFormat: ya.label },
        marginBottom, marginLeft,
        marks: [
          Plot.cell(cells.filter(c => c.raw === null), { x: "x", y: "y", fill: "var(--surface-2)", stroke: "var(--ink-3)", strokeDasharray: "2,2", title: "title" }),
          Plot.cell(cells.filter(c => c.raw !== null), { x: "x", y: "y", fill: "value", title: "title" }),
          ...(showValues ? [Plot.text(cells, { x: "x", y: "y", text: "text", ariaDescription: "Heatmap cell values", pointerEvents: "none",
            fontSize: 11, fill: "var(--ink)" })] : []),
        ] });
      // Choose text contrast from the actual rendered color scale. This
      // keeps values readable in both themes without thick text outlines.
      if (showValues) {
        const colors = (plot as any).scale("color");
        plot.querySelectorAll('g[aria-description="Heatmap cell values"] text').forEach((text, i) => {
          const value = cells[i]?.value;
          if (value == null || !colors) return;
          const color = rgb(colors.apply(value));
          const linear = (c: number) => c / 255 <= .04045 ? c / 255 / 12.92 : ((c / 255 + .055) / 1.055) ** 2.4;
          const luminance = .2126 * linear(color.r) + .7152 * linear(color.g) + .0722 * linear(color.b);
          text.setAttribute("fill", luminance < .179 ? "#fff" : "#000");
        });
      }
      (plot as any).__sourceValues = prepared.xValues;
      return plot;
    }
    case "smallMultiples": {
      // Same temporal + categorical shape a multi-series line uses, but
      // POSITION separates categories instead of colour: one mini time
      // series per value of the categorical dim, arranged in a roughly
      // square grid rather than guessed at as a single row (a dozen
      // categories in one row would leave each panel a sliver). Panels
      // share one y-scale (Plot's default under faceting) so a glance at
      // height is still a fair comparison across them.
      const panels = categoryPanels(segmented!);
      const cellOf = new Map(panels.map(panel => [panel.key, panel]));
      const rows = tidy.map((d) => {
        const cell = cellOf.get(d.series)!;
        return { ...d, __col: cell.col, __row: cell.row };
      });
      const plot = Plot.plot({
        width: box.w, height: box.h,
        caption: "Shared scales",
        marginLeft: 6, marginRight: 6, marginTop: 6, marginBottom: 6,
        style: { background: "transparent", fontSize: "10px" },
        x: { type: "utc", axis: null },
        y: { axis: null, nice: true, grid: true },
        fx: { padding: 0.08, axis: null }, fy: { padding: 0.1, axis: null },
        marks: [
          Plot.frame({ stroke: "var(--line)" }),
          Plot.lineY(rows, { x: "x", y: "value", fx: "__col", fy: "__row",
                             stroke: "var(--ink-2)", curve: "monotone-x" }),
          Plot.dot(rows, { x: "x", y: "value", fx: "__col", fy: "__row", fill: "var(--ink-2)", r: 2, title: pointTitle }),
          Plot.text(panels, { fx: "col", fy: "row", frameAnchor: "top-left", dx: 4, dy: 2,
                              text: "label", fontSize: 10, lineWidth: Math.max(1, (box.w / Math.max(1, Math.ceil(Math.sqrt(panels.length))) - 24) / 10),
                              textOverflow: "ellipsis", fill: "var(--ink-2)" }),
        ],
      });
      const domain = plot.scale("y")?.domain as number[] | undefined;
      const fx = plot.scale("fx"), fy = plot.scale("fy");
      if (panels.length && ((fx?.bandwidth ?? 0) < 80 || (fy?.bandwidth ?? 0) < 48))
        throw new Error("The panels are too small to read. Enlarge this chart or filter to fewer categories.");
      const observed = data.some(row => (typeof row[y] === "number" || typeof row[y] === "string" && row[y].trim() !== "") && Number.isFinite(Number(row[y])));
      const caption = plot.querySelector("figcaption");
      if (caption) caption.textContent = ["Shared scales", times.length ? `${dateLabel(times[0])} – ${dateLabel(times[times.length - 1])}` : "No observed dates",
        observed && domain?.length ? `${labels[y] ?? y}: ${tick(domain[0])} – ${tick(domain[domain.length - 1])}` : "No observed measure values"].join(" · ");
      (plot as any).__panelPicks = { column: category, panels };
      return plot;
    }
    default:
      return Plot.plot({ ...common, marks: [Plot.barY(data, { x, y })] });
  }
}

export function Stat({ value, format }: { value: unknown; format?: (n: number) => string }) {
  const n = numericValue(value);
  const text = n !== null
    ? format ? format(n) : (Math.abs(n) >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 })
       : n.toLocaleString(undefined, { maximumFractionDigits: 3 }))
    : "—";
  return <div className="stat"><div className="v" title={text}>{text}</div></div>;
}

export function DataTable({ columns, rows, defaultSortColumn, presentation = false, display = Object.create(null) }: { columns: string[]; rows: unknown[][]; defaultSortColumn?: string; presentation?: boolean; display?: Record<string, TableColumnDisplay> }) {
  const scroll = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  const [sort, setSort] = useState<{ column: string; descending: boolean } | null>(null);
  const [limit, setLimit] = useState(200);
  useEffect(() => {
    const el = scroll.current;
    if (!el) return;
    const check = () => setOverflow(el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  }, [rows, columns, limit, presentation]);
  const selected = sort ?? (defaultSortColumn ? { column: defaultSortColumn, descending: true } : null);
  const index = selected ? columns.indexOf(selected.column) : -1;
  const sorted = index < 0 ? rows : [...rows].sort((a, b) => {
    if (a[index] == null) return b[index] == null ? 0 : 1;
    if (b[index] == null) return -1;
    const numeric = display[columns[index]]?.format || typeof a[index] === "number" && typeof b[index] === "number";
    const av = numeric ? tableNumber(a[index]) : null, bv = numeric ? tableNumber(b[index]) : null;
    if (numeric && av === null) return bv === null ? 0 : 1;
    if (numeric && bv === null) return -1;
    const cmp = numeric ? compareTableNumbers(a[index], b[index])! : String(a[index]).localeCompare(String(b[index]));
    return selected?.descending ? -cmp : cmp;
  });
  const shown = presentation ? Math.min(20, rows.length) : limit;
  const precisionLimited = rows.some(row => row.some((value, i) => display[columns[i]]?.format && hasPrecisionRisk(value)));
  return <div className="data-table-wrap">
    <div ref={scroll} className="data-table-scroll" role="region" aria-label="Chart data rows" tabIndex={0}>
      <table>
        <thead><tr>{columns.map(c => <th key={c} aria-sort={selected?.column === c ? selected.descending ? "descending" : "ascending" : "none"}><button onPointerDown={e => e.stopPropagation()} onClick={() => setSort({ column: c, descending: selected?.column !== c || !selected.descending })} title={c}>{display[c]?.label ?? c}{selected?.column === c ? selected.descending ? " ↓" : " ↑" : ""}</button></th>)}</tr></thead>
        <tbody>{sorted.slice(0, shown).map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j} data-value={!!display[columns[j]]?.format || typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) || undefined} title={display[columns[j]]?.format ? String(v ?? "No data") : undefined}>{tableCell(v, display[columns[j]])}</td>)}</tr>)}</tbody>
      </table>
    </div>
    <div className="data-table-count">{Math.min(rows.length, shown)} of {rows.length} returned rows{presentation ? rows.length > shown ? " · Table excerpt; export data from the live chart for all returned rows." : " · All returned rows shown." : overflow ? " · Scroll to see remaining rows or columns." : rows.length <= shown ? " · All returned rows shown." : " · More rows available."}{!presentation && rows.length > limit && <button onClick={() => setLimit(n => n + 200)}>Show {Math.min(200, rows.length - limit)} more</button>}</div>
    {precisionLimited && <p className="data-table-precision">High-precision values are shown as returned, without unit formatting. Percent values remain fractions. Numeric sorting preserves their decimal order.</p>}
  </div>;
}

/** SVG path for one donut segment, angles as fractions of a turn. */
function donutArc(start: number, end: number, R: number, r: number) {
  return d3arc()({ startAngle: start * Math.PI * 2, endAngle: end * Math.PI * 2, innerRadius: r, outerRadius: R }) ?? "";
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
export function dateLabeler(values: unknown[]): (v: unknown) => string {
  // Multiple series repeat each date. Count unique buckets when detecting
  // the grain, or monthly labels lose their year and merge across years.
  const dates = [...new Set(values.filter((v): v is Date => v instanceof Date).map(Number))].sort((a, b) => a - b);
  const day = 86400000;
  const step = dates.length > 1 ? Math.min(...dates.slice(1).map((d, i) => d - dates[i])) : 0;
  const opts: Intl.DateTimeFormatOptions =
    step >= 300 * day ? { year: "numeric" } :
    step >= 25 * day ? { month: "short", year: "2-digit" } :
    { month: "short", day: "numeric", year: "2-digit" };
  const intraday = dates.some(t => t % day !== 0);
  const display = (v: Date) => intraday
    ? v.toLocaleString(undefined, { ...opts, hour: "2-digit", minute: "2-digit", ...(dates.some(t => t % 60000 !== 0) ? { second: "2-digit" } : {}), timeZone: "UTC" }) + " UTC"
    : v.toLocaleDateString(undefined, { ...opts, timeZone: "UTC" });
  const labels = new Map<string, number>();
  dates.forEach(t => { const text = display(new Date(t)); labels.set(text, (labels.get(text) ?? 0) + 1); });
  // Include exact timestamps if localization/abbreviation still collides
  // (for example two millisecond buckets or dates a century apart).
  return v => v instanceof Date ? (labels.get(display(v))! > 1 ? v.toISOString() : display(v)) : String(v);
}

/** Keep observed endpoint dates without squeezing an extra label beside the
 * final bucket. Space by elapsed time, so irregular series work as well. */
export function spacedDateTicks(dates: Date[], width: number, spacing: number): Date[] {
  if (dates.length < 2) return dates;
  const first = dates[0], last = dates[dates.length - 1], span = +last - +first;
  if (span <= 0 || width < spacing) return [last];
  const ticks = [first];
  for (const date of dates.slice(1, -1)) {
    if ((+date - +ticks[ticks.length - 1]) / span * width >= spacing &&
        (+last - +date) / span * width >= spacing) ticks.push(date);
  }
  return [...ticks, last];
}

/** Band positions are evenly spaced even when reporting dates have gaps.
 * Thin labels only; the full domain and every bar remain available. */
export function spacedBandTicks<T>(domain: T[], width: number, spacing: number): T[] {
  if (domain.length < 2) return domain;
  const step = Math.max(1, Math.ceil(spacing / (Math.max(1, width) / domain.length)));
  if (step >= domain.length) return [domain[domain.length - 1]];
  const ticks = [domain[0]];
  for (let i = step; i < domain.length - step; i += step) ticks.push(domain[i]);
  return [...ticks, domain[domain.length - 1]];
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
function attachPicker(host: HTMLElement, column: string | null, data: any[], kind: ChartKind,
                      onPick?: (column: string, value: PickValue) => void) {
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
  const plot = typeof fig?.scale === "function" ? fig : svg;
  if (!svg || typeof plot?.scale !== "function") return;

  if (kind === "smallMultiples") {
    const metadata = fig.__panelPicks ?? svg.__panelPicks;
    const fx = plot.scale("fx"), fy = plot.scale("fy");
    if (!metadata?.column || !fx || !fy) return;
    // Only the label is a category action. Plot coordinates, date marks and
    // gaps are not category values and never pass through the generic picker.
    for (const panel of metadata.panels as ReturnType<typeof categoryPanels>) {
      if (!isPickValue(panel.value) || panel.value instanceof Date) continue;
      const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
      const rect = document.createElementNS(group.namespaceURI, "rect");
      group.setAttribute("role", "button"); group.setAttribute("tabindex", "0");
      group.setAttribute("aria-label", `Filter ${metadata.column} to ${panel.label}`);
      group.classList.add("chart-panel-filter"); group.style.cursor = "pointer";
      rect.setAttribute("x", String(fx.apply(panel.col) + 6)); rect.setAttribute("y", String(fy.apply(panel.row) + 6));
      rect.setAttribute("width", String(Math.max(1, fx.bandwidth - 12))); rect.setAttribute("height", String(Math.max(1, Math.min(24, fy.bandwidth - 12))));
      rect.setAttribute("fill", "transparent"); rect.setAttribute("rx", "3");
      const pick = () => onPick(metadata.column, panel.value as PickValue);
      // Canvas selection can resize/redraw the chart between pointerdown and
      // click. Keep this control's gesture out of the tile drag/selection path.
      group.addEventListener("pointerdown", e => e.stopPropagation());
      group.addEventListener("click", e => { e.stopPropagation(); pick(); });
      group.addEventListener("keydown", e => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); pick(); }
      });
      const title = document.createElementNS(group.namespaceURI, "title"); title.textContent = `Filter ${metadata.column} to ${panel.label}`;
      group.append(rect, title); svg.appendChild(group);
    }
    fig.querySelector("figcaption")?.appendChild(document.createTextNode(" · Select a panel label to filter."));
    return;
  }

  let xs: any;
  const horizontal = kind === "barH" || kind === "barHorizontal";
  try { xs = horizontal ? plot.scale("y") : plot.scale("fx") ?? plot.scale("x"); } catch { return; }
  if (!xs) return;
  const temporal = xs.type === "utc" || xs.type === "time";
  if (!temporal && xs.type !== "band" && xs.type !== "point") return;

  const dateLabel = dateLabeler(data.map(row => row[column]));
  const sourceValue = (value: unknown): unknown => {
    if (plot.__sourceValues instanceof Map) return plot.__sourceValues.get(value);
    return data.find(row => row[column] instanceof Date && (dateLabel(row[column]) === value || row[column].toISOString() === value))?.[column] ?? value;
  };
  const values = temporal
    ? [...new Map(data.filter(row => row[column] instanceof Date && Number.isFinite(+row[column])).map(row => [+row[column], row[column] as Date])).values()].sort((a, b) => +a - +b)
    : xs.domain.map(sourceValue).filter(isPickValue);
  if (values.length) {
    const isPeriod = values.every((value: PickValue) => value instanceof Date);
    // Native controls retain typed source values and stay usable with a large
    // result set, without putting every plotted mark in the tab sequence.
    const choices = categoryPanels({ points: [], labels: new Map(values.map((value: PickValue, i: number) => [String(i), value instanceof Date ? dateLabel(value) : value === null ? "Missing category" : String(value)])),
      sourceValues: new Map(values.map((value: PickValue, i: number) => [String(i), value])) });
    const details = document.createElement("details"); details.className = "chart-explore"; details.setAttribute("data-export-ignore", "");
    const summary = document.createElement("summary"); summary.textContent = "Explore chart";
    const body = document.createElement("div"); body.className = "chart-explore-body";
    const label = document.createElement("label"); label.textContent = isPeriod ? "Reporting period" : "Category";
    const select = document.createElement("select"); select.setAttribute("aria-label", label.textContent);
    for (const choice of choices) {
      const option = document.createElement("option"); option.value = choice.key; option.textContent = choice.label; select.appendChild(option);
    }
    label.appendChild(select);
    const button = document.createElement("button"); button.type = "button"; button.textContent = isPeriod ? "Drill into period" : "Filter to category";
    button.addEventListener("click", () => {
      const choice = choices.find(candidate => candidate.key === select.value);
      if (!choice || !isPickValue(choice.value)) return;
      details.open = false; summary.focus({ preventScroll: true }); onPick(column, choice.value);
    });
    details.addEventListener("pointerdown", event => event.stopPropagation());
    details.addEventListener("click", event => event.stopPropagation());
    details.addEventListener("keydown", event => {
      event.stopPropagation();
      if (event.key === "Escape") { event.preventDefault(); details.open = false; summary.focus({ preventScroll: true }); }
    });
    body.append(label, button); details.append(summary, body); host.appendChild(details);
  }

  svg.style.cursor = "pointer";
  svg.addEventListener("click", (e: MouseEvent) => {
    const r = svg.getBoundingClientRect();
    // Rect is in screen px under a scaled canvas; convert back to plot px.
    const scaleX = r.width / (svg.viewBox?.baseVal?.width || svg.clientWidth || r.width) || 1;
    const scaleY = r.height / (svg.viewBox?.baseVal?.height || svg.clientHeight || r.height) || 1;
    const point = { x: (e.clientX - r.left) / scaleX, y: (e.clientY - r.top) / scaleY };
    // Axis labels, legends and margins are not observations. Check both
    // plot coordinates before snapping a click to any reporting bucket.
    for (const axis of ["x", "y"] as const) {
      const axisScale = plot.scale(axis === "x" ? "fx" : "fy") ?? plot.scale(axis);
      if (axisScale?.range?.length >= 2) {
        const lo = Math.min(...axisScale.range), hi = Math.max(...axisScale.range);
        if (point[axis] < lo || point[axis] > hi) return;
      }
    }
    const px = horizontal ? point.y : point.x;

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

    if (!xs.domain.length || typeof xs.apply !== "function") return;
    // Respect actual band padding and reversed ranges; equal subdivisions
    // of the outer range select the wrong category at band boundaries.
    const value = xs.type === "band"
      ? xs.domain.find((v: unknown) => { const start = xs.apply(v); return px >= start && px <= start + xs.bandwidth; })
      : [...xs.domain].sort((a: unknown, b: unknown) => Math.abs(xs.apply(a) - px) - Math.abs(xs.apply(b) - px))[0];
    if (value != null) {
      const source = sourceValue(value);
      if (isPickValue(source)) onPick(column, source);
    }
  });
}

/** Prefer the query's declared roles, including numeric categories and null measures. */
export function chartRoles(columns: string[], data: Record<string, unknown>[], measureColumns?: string[]) {
  const measures = measureColumns ? columns.filter(c => measureColumns.includes(c)) : columns.filter(c => data.some(d => typeof d[c] === "number"));
  return { measures, dims: columns.filter(c => !measures.includes(c)) };
}
