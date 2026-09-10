import { useEffect, useRef, useState, type ReactNode } from "react";
import * as d3 from "d3";
import { kpiSummary } from "./kpiSummary.ts";
import { DEFAULT_SPARK, type SparkOptions } from "../compiler/spec.ts";

type Point = { x: unknown; y: number };

/**
 * A KPI card: value, movement, and a sparkline built directly from d3-scale and
 * d3-shape. Every visual decision here is exposed as an option rather than
 * hard-coded, because the right choice differs per metric -- a currency series
 * wants a zero baseline, a retention ratio wants a tight domain or it reads as
 * a flat line.
 */
export function Kpi({ label, series, options, onOptions, format, grain, previous, comparisonLabel, direction = "neutral", actions }: {
  actions?: ReactNode;
  direction?: "higher" | "lower" | "neutral";
  label: string; series: Point[]; grain?: string | null; previous?: number | null; comparisonLabel?: string;
  options?: Partial<SparkOptions>;
  onOptions?: (o: Partial<SparkOptions>) => void;
  format?: (n: number) => string;
}) {
  const o: SparkOptions = { ...DEFAULT_SPARK, ...(options ?? {}) };
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<{ i: number; left: number } | null>(null);
  const [open, setOpen] = useState(false);

  const clean = series.filter((p) => Number.isFinite(p.y));
  const { latest, delta } = kpiSummary(series, o.compare, grain, previous);
  const up = delta != null && delta >= 0;
  const sentiment = direction === "neutral" || delta == null || delta === 0 ? "flat" : up === (direction === "higher") ? "pos" : "neg";

  const stroke = o.color === "accent" ? "var(--accent)"
    : o.color === "neutral" ? "var(--ink-3)"
    : sentiment === "flat" ? "var(--ink-3)" : sentiment === "pos" ? "var(--pos)" : "var(--neg)";

  useEffect(() => {
    const svg = d3.select(ref.current);
    svg.selectAll("*").remove();
    if (clean.length < 2 || !ref.current) return;
    const w = ref.current.clientWidth || 240;
    const h = ref.current.clientHeight || 38;
    const pad = 3;

    const x = d3.scaleLinear().domain([0, clean.length - 1]).range([pad, w - pad]);
    const ext = d3.extent(clean, (d) => d.y) as [number, number];
    const dom: [number, number] = o.scale === "zero"
      ? [Math.min(0, ext[0]), Math.max(0, ext[1])]
      : ext[0] === ext[1] ? [ext[0] - 1, ext[1] + 1] : ext;
    const y = d3.scaleLinear().domain(dom).nice().range([h - pad, pad]);

    if (o.shape === "bar") {
      const bw = Math.max(1, (w - pad * 2) / clean.length - 1.5);
      svg.append("g").selectAll("rect").data(clean).join("rect")
        .attr("x", (_, i) => x(i) - bw / 2)
        .attr("y", (d) => Math.min(y(d.y), y(dom[0] > 0 ? dom[0] : 0)))
        .attr("width", bw)
        .attr("height", (d) => Math.abs(y(d.y) - y(dom[0] > 0 ? dom[0] : 0)))
        .attr("fill", stroke).attr("opacity", 0.8);
    } else {
      if (o.shape === "area") {
        const area = d3.area<Point>().x((_, i) => x(i)).y0(h - pad)
          .y1((d) => y(d.y)).curve(d3.curveMonotoneX);
        svg.append("path").attr("d", area(clean) as string)
          .attr("fill", stroke).attr("opacity", 0.14);
      }
      const line = d3.line<Point>().x((_, i) => x(i)).y((d) => y(d.y)).curve(d3.curveMonotoneX);
      svg.append("path").attr("d", line(clean) as string)
        .attr("fill", "none").attr("stroke", stroke).attr("stroke-width", 1.7);
    }

    if (o.showMinMax) {
      const lo = d3.least(clean, (d) => d.y)!, hi = d3.greatest(clean, (d) => d.y)!;
      for (const pt of [lo, hi])
        svg.append("circle").attr("cx", x(clean.indexOf(pt))).attr("cy", y(pt.y))
          .attr("r", 2).attr("fill", "none").attr("stroke", "var(--ink-3)").attr("stroke-width", 1.2);
    }
    svg.append("circle").attr("cx", x(clean.length - 1)).attr("cy", y(clean.at(-1)!.y))
      .attr("r", 2.6).attr("fill", stroke);

    if (hover) {
      svg.append("line").attr("x1", x(hover.i)).attr("x2", x(hover.i))
        .attr("y1", pad).attr("y2", h - pad)
        .attr("stroke", "var(--line-2)").attr("stroke-width", 1);
      svg.append("circle").attr("cx", x(hover.i)).attr("cy", y(clean[hover.i].y))
        .attr("r", 3).attr("fill", "var(--surface)").attr("stroke", stroke).attr("stroke-width", 1.6);
    }
  }, [JSON.stringify(clean), stroke, o.shape, o.scale, o.showMinMax, hover?.i, direction]);

  const fmt = format ?? ((n: number) =>
    Math.abs(n) >= 1000 ? d3.format(".3~s")(n).replace("G", "B") : d3.format(",.3~f")(n));
  const period = (v: unknown) => String(v ?? "").slice(0, 10);

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
        {delta == null ? <span className="flat">no comparison</span> : (
          <>
            <span className={sentiment}>{up ? "+" : "−"}{d3.format(".1%")(Math.abs(delta))}</span>
            <span className="vs">vs {o.compare === "first" ? "first shown period" : (comparisonLabel ?? "prior period")}</span>
          </>
        )}
      </div>

      <div className="spark-wrap">
        <svg ref={ref} className="spark" preserveAspectRatio="none"
             onMouseMove={(e) => {
               const r = (e.target as SVGElement).closest("svg")!.getBoundingClientRect();
               const i = Math.round(((e.clientX - r.left) / r.width) * (clean.length - 1));
               if (i >= 0 && i < clean.length) setHover({ i, left: e.clientX - r.left });
             }}
             onMouseLeave={() => setHover(null)} />
        {hover && clean[hover.i] && (
          <div className="spark-tip" style={{ left: Math.min(Math.max(hover.left, 4), 999) }}>
            <b>{fmt(clean[hover.i].y)}</b>
            <span>{period(clean[hover.i].x)}</span>
          </div>
        )}
      </div>

      {o.showRange && clean.length > 1 && (
        <div className="spark-range" title={`${clean.length} points. Period completeness is not declared by the source.`}>
          <span>{period(clean[0].x)}</span>
          <span>{period(clean.at(-1)!.x)}</span>
        </div>
      )}

      {open && onOptions && (
        <SparkMenu o={o} onChange={(patch) => onOptions({ ...options, ...patch })}
                   onClose={() => setOpen(false)} />
      )}
    </div>
  );
}

function SparkMenu({ o, onChange, onClose }: {
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
          <Seg on={o.scale === "fit"} onClick={() => onChange({ scale: "fit" })}>fit</Seg>
          <Seg on={o.scale === "zero"} onClick={() => onChange({ scale: "zero" })}>from 0</Seg>
        </Row>
        <Row label="Compare to">
          <Seg on={o.compare === "prior"} onClick={() => onChange({ compare: "prior" })}>prior</Seg>
          <Seg on={o.compare === "first"} onClick={() => onChange({ compare: "first" })}>first</Seg>
        </Row>
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
const Seg = ({ on, onClick, children }: any) => (
  <button className={"seg" + (on ? " on" : "")} onClick={onClick}>{children}</button>
);
