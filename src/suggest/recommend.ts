import type { ChartKind } from "../compiler/spec.ts";

export interface FieldProfile {
  field: string;
  type: string;
  cardinality: number | null;
  sample: string[];
  role: "temporal" | "geo" | "categorical" | "numeric";
  isoLike?: boolean;
}

export type Fit = "ideal" | "good" | "possible" | "poor";

export interface VizOption {
  kind: ChartKind;
  label: string;
  fit: Fit;
  score: number;
  /** Written for a person, and specific to THIS selection, never generic. */
  why: string;
  emphasis: string;
}

const RANK: Record<Fit, number> = { ideal: 3, good: 2, possible: 1, poor: 0 };

/**
 * Recommend visualizations for a selection.
 *
 * The insight the user had: "country" is not one chart, it is a map, a bar and a
 * table depending on what you are asking. So the recommender reasons about the
 * SHAPE of the selection -- how many measures, and what role each dimension
 * plays -- rather than mapping a column type to a single chart. Cardinality and
 * geo-ness come from profiling real data, because neither is in the schema.
 */
export function recommend(measures: string[], dims: FieldProfile[]): VizOption[] {
  const m = measures.length;
  const out: VizOption[] = [];
  const add = (kind: ChartKind, label: string, fit: Fit, why: string, emphasis: string, bump = 0) =>
    out.push({ kind, label, fit, why, emphasis, score: RANK[fit] + bump });

  const card = (d: FieldProfile) => d.cardinality ?? 999;
  const temporal = dims.filter((d) => d.role === "temporal");
  const geo = dims.filter((d) => d.role === "geo");
  const cats = dims.filter((d) => d.role === "categorical" || d.role === "numeric");

  // ---- no dimensions: a single number, or a small comparison ----------------
  if (dims.length === 0) {
    if (m === 1) add("kpi", "KPI card", "ideal", "One number with no breakdown — show it big, with its trend.", "magnitude", 1);
    if (m > 1) add("bar", "Bar", "good", `Compares ${m} measures side by side.`, "comparison");
    add("table", "Table", "possible", "Exact values, no visual encoding.", "precision");
    return sort(out);
  }

  // ---- one dimension --------------------------------------------------------
  if (dims.length === 1) {
    const d = dims[0];
    const n = card(d);

    if (d.role === "temporal") {
      add("line", "Line", "ideal", m > 1 ? `${m} measures over time — position shows the trend, colour separates them.`
        : "A measure over time. Position on a common axis is the clearest read of change.", "trend", 1);
      // A single measure over time is exactly the shape a KPI card wants --
      // it's what a headline metric on a suggested dashboard already is.
      // Without this, a tile that starts as a KPI card (which needs the time
      // dimension for its sparkline) can never be chosen back once you've
      // clicked to another chart type -- "KPI card" simply never appears in
      // this list for a tile carrying a dimension, only for one with none.
      if (m === 1) add("kpi", "KPI card", "good",
        "One number with its trend as a small sparkline, plus the period-over-period change.", "magnitude");
      if (m === 1) add("area", "Area", "good", "Same trend, with the filled region emphasising magnitude.", "trend + volume");
      if (m > 1) add("areaStacked", "Stacked area", "good", `Shows the total across ${m} measures and each part's share of it.`, "part-to-whole over time");
      add("bar", "Bar", n <= 40 ? "good" : "possible", n <= 40
        ? `${n} periods — discrete bars read well at this count.`
        : `${n} periods is a lot of bars; a line will be easier to follow.`, "comparison");
      add("table", "Table", "possible", "Every period as a row.", "precision");
      return sort(out);
    }

    if (d.role === "geo") {
      add("map", "Map", m === 1 ? "ideal" : "good", d.isoLike
        ? `Values look like country codes (${d.sample.slice(0, 3).join(", ")}) — geography is the natural encoding.`
        : "This field looks geographic, so place carries meaning here.", "geography", m === 1 ? 1 : 0);
      add("barH", "Horizontal bar", n <= 30 ? "ideal" : "good",
        `${n} places — a ranked bar answers "which is biggest" faster than a map does.`, "ranking", 0.5);
      add("bar", "Bar", n <= 15 ? "good" : "possible", `${n} categories.`, "comparison");
      add("table", "Table", "possible", "Exact values per place.", "precision");
      return sort(out);
    }

    // categorical / numeric
    if (n > 50) {
      add("table", "Table", "ideal", `${n} distinct values — too many for any chart to read; a table is honest about that.`, "precision", 1);
      add("barH", "Horizontal bar", "poor", `${n} bars will be unreadable. Filter or group first.`, "ranking");
      return sort(out);
    }
    if (m === 1) {
      add("bar", "Bar", n <= 12 ? "ideal" : "good", `${n} categories, one measure — length is the easiest visual comparison.`, "comparison", n <= 12 ? 1 : 0);
      add("barH", "Horizontal bar", n > 8 ? "ideal" : "good", n > 8
        ? `${n} categories — horizontal keeps the labels readable.` : "Same comparison, labels on the left.", "ranking", n > 8 ? 0.5 : 0);
      add("donut", "Donut", n <= 6 ? "good" : "poor", n <= 6
        ? `${n} slices — works only because the parts sum to a meaningful whole.`
        : `${n} slices is too many to compare by angle.`, "part-to-whole");
    } else {
      add("barGrouped", "Grouped bar", "ideal", `${m} measures across ${n} categories, compared directly.`, "comparison", 1);
      add("barStacked", "Stacked bar", "good", "Totals per category, with each measure's contribution.", "part-to-whole");
      add("scatter", "Scatter", m === 2 ? "good" : "possible", m === 2
        ? `Two measures — position on both axes shows whether they move together.` : "Uses the first two measures.", "correlation");
    }
    add("table", "Table", "possible", "Exact values.", "precision");
    return sort(out);
  }

  // ---- two dimensions -------------------------------------------------------
  const t = temporal[0], c = cats[0] ?? geo[0];
  if (t && c) {
    const n = card(c);
    add("line", "Multi-series line", n <= 8 ? "ideal" : "good", n <= 8
      ? `One line per ${short(c.field)} (${n} of them) over time.`
      : `${n} lines will tangle — consider filtering to the top few.`, "trend by category", n <= 8 ? 1 : 0);
    add("areaStacked", "Stacked area", n <= 8 ? "good" : "possible", "Total over time, split by category.", "part-to-whole over time");
    add("heatmap", "Heatmap", "good", `Time on one axis, ${short(c.field)} on the other — good for spotting patterns rather than exact values.`, "density");
    add("table", "Table", "possible", "Every combination as a row.", "precision");
    return sort(out);
  }
  if (dims.length === 2) {
    const [a, b] = dims;
    add("heatmap", "Heatmap", "ideal", `${short(a.field)} × ${short(b.field)} — colour shows the measure at each intersection.`, "density", 1);
    add("barStacked", "Stacked bar", card(b) <= 8 ? "good" : "possible", `Grouped by ${short(a.field)}, split by ${short(b.field)}.`, "part-to-whole");
    add("table", "Table", "good", "Two dimensions is where tables start to win.", "precision");
    return sort(out);
  }

  add("table", "Table", "ideal", `${dims.length} dimensions — beyond what a chart can encode.`, "precision", 1);
  return sort(out);
}

const short = (f: string) => f.split(".").pop() ?? f;
const sort = (o: VizOption[]) => o.sort((a, b) => b.score - a.score);
