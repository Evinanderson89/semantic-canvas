import type { DashboardSpec, TileSpec } from "../compiler/spec.ts";
import { isTemporal, metricsByTable, prettifyModelName, type Model, type Table } from "../semantic/model.ts";
import type { Brief } from "./match.ts";

/**
 * Propose a dashboard from the model alone -- no LLM, no prompt, no network.
 *
 * This is the "suggest a dashboard" entry point, and doing it with rules first
 * is deliberate: it is deterministic, testable, works offline, and gives the
 * natural-language path something to be measured against later. The LLM seam is
 * `requestDashboard` below, which produces the same DashboardSpec.
 */

/** A column worth grouping by: low cardinality, not an identifier, not a measure. */
function categoricalDims(t: Table): string[] {
  return t.columns
    .filter((c) => /^(string|varchar|text|bool)/i.test(c.type))
    .filter((c) => !/_id$/.test(c.name) && c.name !== "id")
    .map((c) => c.name);
}

/**
 * What KIND of number a metric produces. Metrics of different unit classes must
 * not share a y-axis: a retention ratio of 1.01 plotted against MRR of 200,000
 * is a flat line at zero, which looks like a bug and hides the real signal.
 * Inferred from the model's own labels and expressions -- no extra config.
 */
type UnitClass = "currency" | "ratio" | "duration" | "count";

function unitOf(m: { name: string; label: string; expression: string }): UnitClass {
  const t = `${m.name} ${m.label}`.toLowerCase();
  if (/\brate\b|retention|ratio|churn_rate|\bnrr\b|\bgrr\b|percent|share/.test(t)) return "ratio";
  if (/usd|\$|revenue|mrr|arr|spend|cost|price|cac|ltv|arpa|arpu/.test(t)) return "currency";
  if (/months?|days?|seconds?|payback|duration/.test(t)) return "duration";
  return "count";
}

function timeColumn(t: Table): string | null {
  const part = t.partitionKeys.find((k) => {
    const c = t.columns.find((x) => x.name === k);
    return c && isTemporal(c);
  });
  if (part) return part;
  const anyDate = t.columns.find(isTemporal);
  return anyDate?.name ?? null;
}

export function suggestDashboard(
  model: Model,
  opts: { table?: string | null; grain?: string; width?: number } & Brief = {},
): DashboardSpec {
  const grain = opts.grain ?? "month";
  // Pixel layout against the authored canvas width: the canvas is free
  // positioning, so a suggestion has to place things, not describe columns.
  const W = opts.width ?? 1440;
  const PAD = 24, GAP = 16;
  const span = (n: number, of: number) =>
    Math.round(((W - PAD * 2) - GAP * (of - 1)) / of * n + GAP * (n - 1));
  const colX = (i: number, of: number) => PAD + Math.round(((W - PAD * 2) + GAP) / of) * i;
  const byTable = metricsByTable(model);
  // Most-instrumented table first: the one someone bothered to define the most
  // metrics on is almost always the subject of the dashboard.
  let ranked = Object.entries(byTable).sort((a, b) => b[1].length - a[1].length);
  // A chosen category pins the subject; otherwise the most-instrumented table wins.
  if (opts.table && byTable[opts.table])
    ranked = [[opts.table, byTable[opts.table]], ...ranked.filter(([n]) => n !== opts.table)];

  const tiles: TileSpec[] = [];
  let y = PAD;
  let n = 0;
  const id = () => `t${++n}`;

  const [topTable, topMetrics] = ranked[0] ?? [null, []];
  if (!topTable) return { title: prettifyModelName(model.name), tiles: [] };

  // 1. Headline KPIs. Given over time rather than as a bare total, so each card
  //    can show movement against the prior period and its own sparkline -- a
  //    number with no trend beside it is the least useful tile on a dashboard.
  const t0 = model.tables[topTable];
  const tcol0 = t0 ? timeColumn(t0) : null;
  // The brief decides how much dashboard this is. An exec gets three numbers
  // and a trend; an analyst gets the cuts and the table underneath.
  const cap = opts.audience === "analyst" ? 6 : opts.audience === "operator" ? 4 : 3;
  const picked = (opts.metrics ?? []).map((n) => model.metrics[n]).filter(Boolean);
  const headline = (picked.length ? picked : topMetrics).slice(0, cap);
  headline.forEach((m, i) => {
    tiles.push({
      id: id(), title: m.label, metrics: [m.name],
      dimensions: tcol0 ? [`${grain}:${tcol0}`] : [],
      chart: "kpi", spark: opts.compare ? { compare: opts.compare } : undefined,
      layout: { x: colX(i, headline.length), y, w: span(1, headline.length), h: 156, z: 1 },
    });
  });
  if (headline.length) y += 156 + GAP;

  // 2. Trends over time -- one tile PER UNIT CLASS, so nothing shares an axis
  //    with a number of a different kind.
  const t = model.tables[topTable];
  const tcol = t ? timeColumn(t) : null;
  if (tcol) {
    const groups = new Map<UnitClass, typeof topMetrics>();
    for (const m of topMetrics) {
      const u = unitOf(m);
      if (!groups.has(u)) groups.set(u, []);
      groups.get(u)!.push(m);
    }
    const ordered = [...groups.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 3);
    ordered.forEach(([unit, ms], i) => {
      // An ODD count (3 unit-class groups, the common case) leaves the last
      // one alone in its row -- half-width with no partner, same dead
      // margin down the right half of the canvas that arrange()'s own
      // stretch cap exists to avoid elsewhere. Detected directly rather
      // than routed through arrange(): this hand-rolled layout interleaves
      // several DIFFERENT-height sections (KPIs, trends, breakdowns) back
      // to back, and repacking by width alone, the way arrange() does,
      // risks welding a shorter tile from the NEXT section into this row's
      // leftover space instead.
      const alone = i % 2 === 0 && i === ordered.length - 1;
      tiles.push({
        id: id(),
        title: `${ms.slice(0, 3).map((m) => m.label).join(", ")} over time`,
        metrics: ms.slice(0, 3).map((m) => m.name),
        dimensions: [`${grain}:${tcol}`],
        layout: {
          x: ordered.length === 1 || alone ? PAD : colX(i % 2, 2),
          y: y + Math.floor(i / 2) * (300 + GAP),
          w: ordered.length === 1 || alone ? span(1, 1) : span(1, 2),
          h: 300, z: 1,
        },
      });
    });
    y += Math.ceil(ordered.length / 2) * (300 + GAP);
  }

  // 3. A breakdown by something categorical, reached through a join if needed.
  const localCats = t ? categoricalDims(t) : [];
  const joined = model.joins
    .filter((j) => j.left === topTable)
    .flatMap((j) => categoricalDims(model.tables[j.right] ?? ({} as Table))
      .map((c) => `${j.right}.${c}`));
  const breakdown = opts.includeBreakdowns === false
    ? [] : [...localCats, ...joined].slice(0, 2);
  breakdown.forEach((dim, i) => {
    tiles.push({
      id: id(), title: `${topMetrics[0].label} by ${dim.split(".").pop()}`,
      metrics: [topMetrics[0].name], dimensions: [dim],
      layout: { x: colX(i, 2), y, w: span(1, 2), h: 280, z: 1 },
    });
  });
  if (breakdown.length) y += 280 + GAP;

  // 4. One tile from the next table, so the dashboard is not single-subject.
  const [second, secondMetrics] = ranked[1] ?? [null, []];
  if (second && secondMetrics.length) {
    const t2 = model.tables[second];
    const tc2 = t2 ? timeColumn(t2) : null;
    tiles.push({
      id: id(), title: `${secondMetrics[0].label} over time`,
      metrics: secondMetrics.slice(0, 2).map((m) => m.name),
      dimensions: tc2 ? [`${grain}:${tc2}`] : [],
      layout: { x: PAD, y, w: span(1, 1), h: 280, z: 1 },
    });
  }

  // The analyst cut gets the rows behind the numbers.
  if (opts.includeTable && topMetrics.length) {
    tiles.push({
      id: id(), title: `${prettyTitle(topTable)} detail`,
      metrics: topMetrics.slice(0, 4).map((m) => m.name),
      dimensions: tcol ? [`${grain}:${tcol}`] : [],
      chart: "table", layout: { x: PAD, y, w: span(1, 1), h: 300, z: 1 },
    });
    y += 300 + GAP;
  }

  return {
    // A picked table used to only steer which metrics get featured, not the
    // title -- the client papered over that by showing a synthetic
    // "${table} Dashboard" instead of this title whenever a table was
    // picked, which also meant a LATER edit to the real title (Beautify
    // dashboard's suggested title, say) had nowhere visible to land: the
    // override kept winning regardless of what this field actually held.
    title: opts.text?.trim()
      ? opts.text.trim().replace(/^\w/, (c) => c.toUpperCase()).slice(0, 70)
      : opts.table ? `${prettyTitle(opts.table)} Dashboard`
      : `${prettifyModelName(model.name)} overview`,
    description: `Suggested from ${Object.keys(model.metrics).length} metrics across ` +
      `${Object.keys(model.tables).length} tables in the ${model.source} semantic layer.`,
    tiles,
  };
}

export function emptyDashboard(model: Model): DashboardSpec {
  return { title: "Untitled dashboard", description: "", tiles: [] };
}

function prettyTitle(name: string) {
  return name.replace(/^(fct|dim)_/, "").replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
