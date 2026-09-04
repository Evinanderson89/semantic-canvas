import { useEffect, useRef, useState } from "react";
import * as Plot from "@observablehq/plot";
import { sum as d3sum } from "d3-array";
import { COUNTRIES, toFeatureId } from "./geo.ts";
import { DEFAULT_FORMAT, makeFormatter, PALETTES } from "../format/format.ts";
import type { ChartKind } from "../compiler/spec.ts";

/**
 * One interface for every chart type. Observable Plot is D3 underneath and
 * covers the long tail immediately; any individual kind can later be replaced
 * with hand-built D3 primitives without the spec, compiler or canvas noticing.
 */
export function Chart({ kind, columns, rows, format, onPick }: {
  kind: ChartKind; columns: string[]; rows: unknown[][];
  format?: import("../format/format.ts").FormatSpec;
  /** Click-to-cross-filter. Receives the dimension column and clicked value. */
  onPick?: (column: string, value: string | number) => void;
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
      el.replaceChildren(render(kind, columns, data, box, format));
      // Plot stacks a legend ABOVE the svg, so a figure given height H is taller
      // than H and spills out of the tile. The legend's height is not knowable
      // before it exists, so measure once and redraw the plot that much shorter.
      attachPicker(el, dimColumn(columns, data), onPick);
      const fig = el.firstElementChild as HTMLElement | null;
      if (fig) {
        // offsetHeight, not getBoundingClientRect: the canvas is CSS-scaled, so
        // the rect is in screen pixels while box.h is in layout pixels. Mixing
        // them makes the correction wrong at every zoom except 100%.
        const spill = Math.round(fig.offsetHeight - box.h);
        if (spill > 1) {
          el.replaceChildren(render(kind, columns, data,
            { w: box.w, h: Math.max(60, box.h - spill) }, format));
          attachPicker(el, dimColumn(columns, data), onPick);
        }
      }
    } catch (e: any) {
      const msg = document.createElement("div");
      msg.className = "chart-err";
      msg.textContent = `Could not draw this as a ${kind}: ${e?.message ?? e}`;
      host.current.replaceChildren(msg);
    }
  }, [kind, columns, rows, box.w, box.h, JSON.stringify(format), !!onPick]);

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

function render(kind: ChartKind, columns: string[], data: any[], box: { w: number; h: number },
                fmt?: import("../format/format.ts").FormatSpec) {
  const f = fmt ?? DEFAULT_FORMAT;
  const tick = makeFormatter(f);
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
    color: { range: palette },
  };
  const legend = f.legend !== "hide";

  // Long/tidy form lets one mark serve any number of measures.
  const tidy = data.flatMap((d) => measures.map((m) => ({ x: d[x], series: m, value: d[m] })));

  switch (kind) {
    case "line":
      return Plot.plot({ ...common, color: { ...common.color, legend: legend && measures.length > 1 },
        marks: [Plot.ruleY([0]),
          Plot.line(tidy, { x: "x", y: "value", stroke: "series", curve: "monotone-x" }),
          Plot.dot(tidy, { x: "x", y: "value", stroke: "series", r: 1.6 })] });
    case "area":
      return Plot.plot({ ...common,
        marks: [Plot.areaY(data, { x, y, fillOpacity: 0.15 }),
          Plot.line(data, { x, y, curve: "monotone-x" }), Plot.ruleY([0])] });
    case "areaStacked":
      return Plot.plot({ ...common, color: { ...common.color, legend },
        marks: [Plot.areaY(tidy, { x: "x", y: "value", fill: "series", fillOpacity: 0.85 }), Plot.ruleY([0])] });
    case "bar":
      return Plot.plot({ ...common,
        marks: [Plot.barY(data, { x, y, fill: "currentColor", fillOpacity: 0.75 }), Plot.ruleY([0])] });
    case "barGrouped":
      return Plot.plot({ ...common, color: { ...common.color, legend },
        marks: [Plot.barY(tidy, { x: "x", y: "value", fill: "series", fx: "x" } as any),
                Plot.ruleY([0])] });
    case "barStacked":
      return Plot.plot({ ...common, color: { ...common.color, legend },
        marks: [Plot.barY(tidy, { x: "x", y: "value", fill: "series" }), Plot.ruleY([0])] });
    case "barH":
    case "barHorizontal":
      return Plot.plot({ ...common, marginLeft: 130,
        marks: [Plot.barX(data, { y: x, x: y, fill: "currentColor", fillOpacity: 0.75,
                                  sort: { y: "-x" } }), Plot.ruleX([0])] });
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
 * Click-to-cross-filter.
 *
 * Plot does not attach data to its marks, so the clicked category is recovered
 * from the band scale instead: Plot exposes the resolved scales on the returned
 * figure, and a band scale's domain plus range is enough to invert a pixel back
 * to a category. Time axes are deliberately excluded -- filtering a dashboard
 * to a single month by mis-clicking a line chart is not a useful interaction.
 */
function attachPicker(host: HTMLElement, column: string | null,
                      onPick?: (column: string, value: string | number) => void) {
  if (!onPick || !column) return;
  const fig: any = host.firstElementChild;
  const svg = fig?.tagName === "FIGURE" ? fig.querySelector("svg") : fig;
  if (!svg || typeof fig?.scale !== "function") return;

  let xs: any;
  try { xs = fig.scale("x"); } catch { return; }
  if (!xs || (xs.type !== "band" && xs.type !== "point")) return;

  svg.style.cursor = "pointer";
  svg.addEventListener("click", (e: MouseEvent) => {
    const r = svg.getBoundingClientRect();
    // Rect is in screen px under a scaled canvas; convert back to plot px.
    const scale = r.width / (svg.viewBox?.baseVal?.width || svg.clientWidth || r.width) || 1;
    const px = (e.clientX - r.left) / (scale || 1);
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
