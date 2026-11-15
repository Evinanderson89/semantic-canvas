import { useEffect, useRef, useState, type ReactNode } from "react";
import * as d3 from "d3";
import { sparklineTimeline, sparklineHover, type SparkPoint } from "./sparkline.ts";
import { kpiSummary } from "./kpiSummary.ts";
import { DEFAULT_SPARK, type SparkOptions } from "../compiler/spec.ts";
import { CARD_COMPARISONS, type CardComparison } from "../charts/cardComparison.ts";

type Point = { x: unknown; y: number };

/**
 * A KPI card: value, movement, and a sparkline built directly from d3-scale and
 * d3-shape. Every visual decision here is exposed as an option rather than
 * hard-coded, because the right choice differs per metric -- a currency series
 * wants a zero baseline, a retention ratio wants a tight domain or it reads as
 * a flat line.
 */
export function Kpi({ label, series, options, onOptions, format, grain, previous, comparison, onComparison, direction = "neutral", percent = false, actions, precisionLimited = false, partialWindow, unverifiedPeriods }: {
  comparison?: CardComparison; onComparison?: (comparison: CardComparison) => void;
  precisionLimited?: boolean;
  partialWindow?: { start: boolean; end: boolean };
  unverifiedPeriods?: string[];
  actions?: ReactNode;
  percent?: boolean;
  direction?: "higher" | "lower" | "neutral";
  label: string; series: Point[]; grain?: string | null; previous?: number | null;
  options?: Partial<SparkOptions>;
  onOptions?: (o: Partial<SparkOptions>) => void;
  format?: (n: number) => string;
}) {
  const o: SparkOptions = { ...DEFAULT_SPARK, ...(options ?? {}) };
  const mode = comparison ?? o.compare;
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<{ ratio: number; left: number } | null>(null);
  const [box, setBox] = useState({ width: 240, height: 38 });
  const [open, setOpen] = useState(false);

  const timeline = sparklineTimeline(series, grain);
  const { points, valid, segments, gaps, domain } = timeline;
  const pad = 3;
  const hovered = hover ? sparklineHover(timeline, domain[0] + Math.max(0, Math.min(1, (hover.ratio * box.width - pad) / Math.max(1, box.width - 2 * pad))) * (domain[1] - domain[0])) : null;
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const read = () => setBox({ width: element.clientWidth || 240, height: element.clientHeight || 38 });
    read(); const observer = new ResizeObserver(read); observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const summary = kpiSummary(series, mode, grain, previous, percent);
  const partialComparison = partialWindow?.end || mode === "first" && partialWindow?.start;
  const periodOf = (value: unknown) => (value instanceof Date ? value.toISOString() : String(value)).slice(0, 10);
  const coverageLimited = unverifiedPeriods?.includes(periodOf(series.at(-1)?.x)) || mode === "first" && unverifiedPeriods?.includes(periodOf(series[0]?.x));
  const { latest } = summary, delta = precisionLimited || partialComparison || coverageLimited ? null : summary.delta;
  const up = delta != null && delta >= 0;
  // A displayed zero must mean unchanged, not a small movement rounded away.
  const displayedMagnitude = delta == null ? 0 : Math.abs(delta) * (percent ? 1 : 100);
  const belowDisplayPrecision = displayedMagnitude > 0 && displayedMagnitude < 0.05;
  const changeLabel = delta == null ? "" : belowDisplayPrecision
    ? `${up ? "Up" : "Down"} <0.1${percent ? " pp" : "%"}`
    : `${up ? "+" : "−"}${percent ? `${d3.format(".1f")(Math.abs(delta))} pp` : d3.format(".1%")(Math.abs(delta))}`;
  const sentiment = direction === "neutral" || delta == null || delta === 0 ? "flat" : up === (direction === "higher") ? "pos" : "neg";

  // The sparkline describes the whole visible series; its colour must not
  // inherit the latest period's reversal. The delta retains its own sentiment.
  const seriesChange = valid.length > 1 ? valid.at(-1)!.y - valid[0].y : 0;
  const seriesSentiment = precisionLimited || partialWindow?.start || partialWindow?.end || unverifiedPeriods?.length || direction === "neutral" || seriesChange === 0 ? "flat" : (seriesChange > 0) === (direction === "higher") ? "pos" : "neg";
  const stroke = o.color === "accent" ? "var(--accent)"
    : o.color === "neutral" ? "var(--ink-3)"
    : seriesSentiment === "flat" ? "var(--ink-3)" : seriesSentiment === "pos" ? "var(--pos)" : "var(--neg)";

  useEffect(() => {
    const svg = d3.select(ref.current);
    svg.selectAll("*").remove();
    if (!ref.current || !points.length) return;
    const { width: w, height: h } = box;
    const x = d3.scaleLinear().domain(domain).range([pad, w - pad]);
    // A quiet dashed interval makes gaps visible even when all values are absent.
    for (const gap of gaps) svg.append("line").attr("class", "spark-gap")
      .attr("x1", x(Math.max(domain[0], gap.from))).attr("x2", x(Math.min(domain[1], gap.to)))
      .attr("y1", h / 2).attr("y2", h / 2).attr("stroke", "var(--line-2)").attr("stroke-dasharray", "2,3");
    if (!valid.length) return;
    const ext = d3.extent(valid, d => d.y) as [number, number];
    const dom: [number, number] = o.scale === "zero" || o.shape === "bar"
      ? [Math.min(0, ext[0]), Math.max(0, ext[1])]
      : ext[0] === ext[1] ? [ext[0] - 1, ext[1] + 1] : ext;
    const y = d3.scaleLinear().domain(dom).nice().range([h - pad, pad]);
    if (o.shape === "bar") {
      const periodWidth = domain[0] === domain[1] ? w - 2 * pad : Math.abs(x(domain[0] + timeline.step) - x(domain[0]));
      const bw = Math.max(1, Math.min(w - 2 * pad, periodWidth) * .75);
      svg.append("g").selectAll("rect").data(valid).join("rect")
        .attr("x", d => Math.max(pad, Math.min(w - pad - bw, x(d.position) - bw / 2)))
        .attr("y", d => Math.min(y(d.y), y(dom[0] > 0 ? dom[0] : 0)))
        .attr("width", bw).attr("height", d => Math.abs(y(d.y) - y(dom[0] > 0 ? dom[0] : 0)))
        .attr("fill", stroke).attr("opacity", .8);
    } else {
      const line = d3.line<SparkPoint>().x(d => x(d.position)).y(d => y(d.y)).curve(d3.curveMonotoneX);
      const area = d3.area<SparkPoint>().x(d => x(d.position)).y0(h - pad).y1(d => y(d.y)).curve(d3.curveMonotoneX);
      for (const segment of segments) {
        if (o.shape === "area") svg.append("path").attr("class", "spark-area").attr("d", area(segment))
          .attr("fill", stroke).attr("opacity", .14);
        svg.append("path").attr("class", "spark-line").attr("d", line(segment))
          .attr("fill", "none").attr("stroke", stroke).attr("stroke-width", 1.7);
      }
    }
    if (o.showMinMax) for (const p of [d3.least(valid, d => d.y)!, d3.greatest(valid, d => d.y)!])
      svg.append("circle").attr("cx", x(p.position)).attr("cy", y(p.y))
        .attr("r", 2).attr("fill", "none").attr("stroke", "var(--ink-3)").attr("stroke-width", 1.2);
    // Isolated observations remain visible; a missing latest value gets no endpoint dot.
    const dots = new Set(segments.filter(s => s.length === 1).map(s => s[0]));
    if (Number.isFinite(points.at(-1)?.y)) dots.add(points.at(-1)!);
    for (const p of dots) svg.append("circle").attr("class", "spark-observation").attr("cx", x(p.position))
      .attr("cy", y(p.y)).attr("r", 2.6).attr("fill", stroke);
    if (hovered) {
      svg.append("line").attr("x1", x(hovered.position)).attr("x2", x(hovered.position))
        .attr("y1", pad).attr("y2", h - pad).attr("stroke", "var(--line-2)");
      if (hovered.point && Number.isFinite(hovered.point.y)) svg.append("circle")
        .attr("cx", x(hovered.point.position)).attr("cy", y(hovered.point.y)).attr("r", 3)
        .attr("fill", "var(--surface)").attr("stroke", stroke).attr("stroke-width", 1.6);
    }
  }, [JSON.stringify(points), grain, stroke, o.shape, o.scale, o.showMinMax, hover?.ratio, box.width, box.height]);

  const fmt = format ?? ((n: number) =>
    Math.abs(n) >= 1000 ? d3.format(".3~s")(n).replace("G", "B") : d3.format(",.3~f")(n));
  const period = (v: unknown) => v instanceof Date && Number.isFinite(+v) ? v.toISOString().slice(0, 10) : String(v ?? "").slice(0, 10);

  return (
    <div className="kpi">
      <div className="kpi-head">
        <span className="kpi-label" title={label}>{label}</span>
        {onOptions && (
          <button className="gear" title="Sparkline options"
                  onClick={() => setOpen((v) => !v)}>
            <svg viewBox="0 0 20 20" width="13" height="13" fill="none"
                 stroke="currentColor" strokeWidth="1.6">
              <circle cx="10" cy="10" r="2.6" />
              <path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4" />
            </svg>
          </button>
        )}
        {actions}
      </div>

      <div className="kpi-asof">{grain === "month" ? "Period " : "As of "}{grain === "month" && series.at(-1)?.x ? new Date(String(series.at(-1)?.x).slice(0, 10) + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" }) : period(series.at(-1)?.x) || "—"}</div>
      <div className="kpi-value">{latest == null ? "—" : fmt(latest)}</div>
      <div className="kpi-delta">
        {mode === "none" ? <span className="flat">comparison off</span> : coverageLimited ? <span className="flat" title="Review the ratio's input dates before comparing these periods.">input coverage · no comparison</span> : partialComparison ? <span className="flat" title="Use complete reporting periods or a finer grain before comparing this selected window.">partial period · no comparison</span> : precisionLimited ? <span className="flat" title="Displayed values may round together. Inspect the data check and compare the exact returned values in the warehouse.">precision limited</span> : delta == null ? <span className="flat" title={mode === "first" && series.length < 2 ? "At least two shown periods are needed to compare with the first." : "A valid comparison value is unavailable."}>no comparison</span> : (
          <>
            <span className={sentiment} title={belowDisplayPrecision ? "A nonzero change below the card’s display precision. Inspect the metric evidence for the detailed comparison." : undefined}>{changeLabel}</span>
            <span className="vs">vs {mode === "first" ? "first shown period" : mode === "yoy" ? "same period last year" : "prior period"}</span>
          </>
        )}
      </div>

      <div className="spark-wrap">
        <svg ref={ref} className="spark" preserveAspectRatio="none" role="img" aria-label={`${label} trend${gaps.length ? "; missing periods are shown as gaps" : ""}`}
             onMouseMove={(e) => {
               const r = (e.target as SVGElement).closest("svg")!.getBoundingClientRect();
               if (r.width) setHover({ ratio: (e.clientX - r.left) / r.width, left: e.clientX - r.left });
             }}
             onMouseLeave={() => setHover(null)} />
        {hover && hovered && (hovered.gap || hovered.point) && (
          <div className="spark-tip" style={{ left: Math.min(Math.max(hover.left, 4), box.width - 4) }}>
            <b>{hovered.gap || !Number.isFinite(hovered.point?.y) ? "No data" : fmt(hovered.point!.y)}</b>
            <span>{hovered.gap && timeline.temporal ? `${period(new Date(hovered.gap.from))} – ${period(new Date(Math.max(hovered.gap.from, hovered.gap.to - 86400000)))}` : period(hovered.point?.x)}</span>
          </div>
        )}
      </div>

      {!!gaps.length && <span className="spark-missing">Missing periods</span>}
      {o.showRange && points.length > 1 && (
        <div className="spark-range" title={`${valid.length} observations. ${gaps.length ? "Missing periods remain gaps. " : ""}Period completeness is not declared by the source.`}>
          <span>{period(points[0].x)}</span>
          <span>{period(points.at(-1)!.x)}</span>
        </div>
      )}

      {open && onOptions && (
        <SparkMenu o={o} onChange={(patch) => onOptions({ ...options, ...patch })}
                   comparison={mode} onComparison={onComparison} grain={grain}
                   onClose={() => setOpen(false)} />
      )}
    </div>
  );
}

function SparkMenu({ o, onChange, onClose, comparison, onComparison, grain }: {
  comparison: CardComparison; onComparison?: (mode: CardComparison) => void; grain?: string | null;
  o: SparkOptions; onChange: (p: Partial<SparkOptions>) => void; onClose: () => void;
}) {
  return (
    <>
      <div className="menu-scrim" onClick={onClose} />
      <div className="spark-menu" onClick={(e) => e.stopPropagation()}>
        <Row label="Shape">
          {(["line", "area", "bar"] as const).map((v) => (
            <Seg key={v} on={o.shape === v} onClick={() => onChange({ shape: v })}>{v}</Seg>
          ))}
        </Row>
        <Row label="Y axis">
          <Seg disabled={o.shape === "bar"} on={o.scale === "fit" && o.shape !== "bar"} onClick={() => onChange({ scale: "fit" })}>fit</Seg>
          <Seg on={o.scale === "zero" || o.shape === "bar"} onClick={() => onChange({ scale: "zero" })}>from 0</Seg>
        </Row>
        {o.shape === "bar" && <small>Bars start at zero so their lengths stay comparable.</small>}
        {onComparison && <Row label="Compare to">
          {CARD_COMPARISONS.filter(([v]) => grain || v === "none" || v === "first").map(([value, label]) =>
            <Seg key={value} on={comparison === value} onClick={() => onComparison(value)}>{label}</Seg>)}
        </Row>}
        <Row label="Colour">
          {(["auto", "accent", "neutral"] as const).map((v) => (
            <Seg key={v} on={o.color === v} onClick={() => onChange({ color: v })}>{v}</Seg>
          ))}
        </Row>
        <Row label="Show">
          <Seg on={o.showRange} onClick={() => onChange({ showRange: !o.showRange })}>range</Seg>
          <Seg on={o.showMinMax} onClick={() => onChange({ showMinMax: !o.showMinMax })}>min/max</Seg>
        </Row>
      </div>
    </>
  );
}

const Row = ({ label, children }: any) => (
  <div className="menu-row"><span>{label}</span><div className="segs">{children}</div></div>
);
const Seg = ({ on, onClick, children, disabled }: any) => (
  <button disabled={disabled} className={"seg" + (on ? " on" : "")} onClick={onClick}>{children}</button>
);
