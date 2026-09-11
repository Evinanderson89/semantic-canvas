import type { DashboardSpec, TileSpec } from "../compiler/spec.ts";
import { timeColumnOf, metricsByTable, prettifyModelName, reviewedModel, isLineage, type Model, type Metric, type Table } from "../semantic/model.ts";
import type { Brief } from "./match.ts";

function categoricalDims(t: Table | undefined): string[] {
  return (t?.columns ?? []).filter(c => /^(string|varchar|text|bool)/i.test(c.type) && !/(_id$|^id$)/.test(c.name) && !isLineage(c)).map(c => c.name);
}

/** A useful first draft has a subject, a focal point and supporting sections. */
export function suggestDashboard(full: Model, opts: { table?: string | null; grain?: string; width?: number } & Brief = {}): DashboardSpec {
  // Ingested-but-unreviewed tables never make it into a proposal, whoever asks.
  const model = reviewedModel(full);
  const width = opts.width ?? 1440, available = width - 48, gap = 16;
  const byTable = metricsByTable(model);
  const subject = opts.table && byTable[opts.table] ? opts.table : Object.entries(byTable).sort((a,b) => b[1].length - a[1].length)[0]?.[0];
  if (!subject) return { title: prettifyModelName(model.name), tiles: [] };
  const metrics = [...byTable[subject]].sort((a,b) => (b.importance ?? 0) - (a.importance ?? 0));
  const selected = (opts.metrics ?? []).map(n => model.metrics[n]).filter(Boolean);
  const cap = opts.audience === "analyst" ? 6 : opts.audience === "operator" ? 4 : 3;
  const headline = (selected.length ? selected : metrics).slice(0, cap);
  const tiles: TileSpec[] = [];
  let y = 24, sequence = 0, section = "";
  const id = () => `t${++sequence}`;
  const begin = (text: string) => {
    section = id();
    tiles.push({ id: section, kind: "heading", title: text, text, metrics: [], dimensions: [],
      format: { textSize: 21, background: false, border: false }, layout: { x: 24, y, w: available, h: 44 } });
    y += 56;
  };
  const dimensions = (m: Metric) => {
    const time = m.timeDimension ?? timeColumnOf(model, m.baseTable);
    const requested = ["day", "week", "month", "quarter", "year"].includes(opts.grain ?? "") ? opts.grain! : "month";
    const grain = m.timeGrains ? m.timeGrains.find(g => g === requested) ?? m.timeGrains[0] : requested;
    return time ? [`${grain}:${time}`] : [];
  };
  begin("At a glance");
  const cols = Math.max(1, Math.min(headline.length, Math.floor((available + gap) / 196)));
  headline.forEach((m, i) => {
    const count = Math.min(cols, headline.length - Math.floor(i / cols) * cols);
    const w = Math.floor((available - gap * (count - 1)) / count);
    tiles.push({ id: id(), section, title: m.label, metrics: [m.name], dimensions: dimensions(m),
      chart: dimensions(m).length ? "kpi" : "stat", spark: opts.compare ? { compare: opts.compare } : undefined,
      layout: { x: 24 + (i % cols) * (w + gap), y: y + Math.floor(i / cols) * 172, w, h: 156 } });
  });
  y += Math.ceil(headline.length / cols) * 172 + 24;
  const primary = headline.find(m => dimensions(m).length);
  if (primary) {
    begin("How it's changing");
    tiles.push({ id: id(), section, title: `${primary.label} over time`, metrics: [primary.name], dimensions: dimensions(primary),
      chart: "line", layout: { x: 24, y, w: available, h: 320 } });
    y += 360;
  }
  const supporting = headline.filter(m => m !== primary && dimensions(m).length);
  if (supporting.length) {
    begin("Supporting context");
    const count = width < 960 ? 1 : 2;
    supporting.forEach((m, i) => {
      const rowCount = Math.min(count, supporting.length - Math.floor(i / count) * count);
      const w = Math.floor((available - gap * (rowCount - 1)) / rowCount);
      tiles.push({ id: id(), section, title: `${m.label} over time`, metrics: [m.name], dimensions: dimensions(m),
        chart: "line", layout: { x: 24 + (i % count) * (w + gap), y: y + Math.floor(i / count) * 316, w, h: 300 } });
    });
    y += Math.ceil(supporting.length / count) * 316 + 24;
  }
  // Snapshot metrics cannot be summed across all dates into a categorical total.
  const breakdownMetric = headline.find(m => !m.timeGrains);
  if (opts.includeBreakdowns !== false && breakdownMetric) {
    const base = breakdownMetric.baseTable;
    const cats = [...categoricalDims(model.tables[base]), ...model.joins.filter(j => j.left === base).flatMap(j => categoricalDims(model.tables[j.right]).map(c => `${j.right}.${c}`))].slice(0, 2);
    if (cats.length) begin("A closer look");
    for (const dim of cats) {
      tiles.push({ id: id(), section, title: `${breakdownMetric.label} by ${dim.split(".").at(-1)?.replace(/_/g, " ")}`, metrics: [breakdownMetric.name], dimensions: [dim],
        chart: "barH", layout: { x: 24, y, w: available, h: 280 } });
      y += 296;
    }
  }
  if (opts.includeTable) {
    begin("Behind the numbers");
    // Separate queries preserve each metric's native grain instead of forcing a mixed table.
    for (const m of headline) {
      tiles.push({ id: id(), section, title: `${m.label} detail`, metrics: [m.name], dimensions: dimensions(m), chart: "table", layout: { x: 24, y, w: available, h: 300 } });
      y += 316;
    }
  }
  return {
    title: opts.text?.trim() ? opts.text.trim().replace(/^\w/, c => c.toUpperCase()).slice(0, 70) : `${prettyTitle(subject)} Dashboard`,
    description: `A view of ${headline.map(m => m.label).join(", ")}. Each metric uses a supported reporting period.`, tiles,
  };
}
export function emptyDashboard(_model: Model): DashboardSpec { return { title: "Untitled dashboard", description: "", tiles: [] }; }
function prettyTitle(name: string) {
  return name.replace(/^(fct|dim)_/, "").replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()).replace(/\bSaas\b/g, "SaaS").replace(/\bMrr\b/g, "MRR");
}
