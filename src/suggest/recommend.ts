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
 *
 * `hints` is optional free text -- the base table's and metrics' own
 * `description`/`synonyms` from whatever semantic model is actually
 * connected (see semanticHints() in semantic/model.ts). It never changes
 * what's STRUCTURALLY possible (fit stays exactly what the shape logic
 * below says), only nudges the ordering among options the shape already
 * allows: a table whose author wrote "mrr waterfall" in its synonyms
 * should have that count for something, the same way `fct_mrr_movements`
 * (this app's own sample data) already documents itself that way -- but
 * the mechanism is a keyword match against arbitrary author text, not
 * anything hardcoded to that one table, so it means the same thing for
 * any model that documents itself this way, not just this one.
 */
export function recommend(measures: string[], dims: FieldProfile[], hints?: string): VizOption[] {
  const out = recommendByShape(measures, dims);
  if (!hints) return out;
  const text = hints.toLowerCase();
  for (const hint of SEMANTIC_HINTS) {
    if (!hint.pattern.test(text)) continue;
    const match = out.find((o) => o.kind === hint.kind);
    if (match) { match.score += hint.bump; match.why = `${match.why} (${hint.note})`; }
  }
  return sort(out);
}

/**
 * Keyword -> chart kind, matched against the CONNECTED model's own text --
 * a model that never mentions any of these just never gets a bump. Only
 * kinds already offered for this shape can be bumped (see `recommend`
 * above). Bump size tracks how UNAMBIGUOUS the word is, not a single
 * shared constant: "trend" or "ranking" could describe several honest
 * chart choices, so they're a gentle tie-breaker (0.75 -- never enough to
 * outrank a structurally "ideal" option on its own). "Waterfall" and
 * "funnel" each name one specific chart and nothing else; someone who
 * wrote that word chose it on purpose, so they're allowed to actually
 * win -- including over an "ideal" bar chart that's only ideal in a
 * structure-blind sense (it has no way to know this data bridges to a
 * total, or narrows from one stage to the next).
 */
const SEMANTIC_HINTS: { pattern: RegExp; kind: ChartKind; note: string; bump: number }[] = [
  { pattern: /\bwaterfall\b/, kind: "waterfall", note: "the model describes this as a waterfall", bump: 3.5 },
  { pattern: /\bfunnel\b/, kind: "funnel", note: "the model describes this as a funnel", bump: 3.5 },
  { pattern: /\btrend/, kind: "line", note: "the model describes this as a trend", bump: 0.75 },
  { pattern: /\branking\b|\btop\b/, kind: "barH", note: "the model describes this as a ranking", bump: 0.75 },
  { pattern: /\bdistribution\b/, kind: "heatmap", note: "the model describes this as a distribution", bump: 0.75 },
  { pattern: /\bgeograph|\bmap\b/, kind: "map", note: "the model describes this as geographic", bump: 0.75 },
];

function recommendByShape(measures: string[], dims: FieldProfile[]): VizOption[] {
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
    if (m > 1) {
      add("bar", "Bar", "good", `Compares ${m} measures side by side.`, "comparison");
      // Several separately-governed measures selected together, no
      // breakdown dimension -- exactly how a model that never split one
      // raw signed column out as its own dimension still expresses "named
      // deltas" (fct_mrr_movements' new_mrr/expansion_mrr/contraction_mrr/
      // churned_mrr, each its own metric, not one metric x movement_type).
      add("waterfall", "Waterfall", "possible", `${m} measures as signed deltas, bridged to a running total.`, "bridge to a total");
      // Same shape, different story: several separately-governed measures
      // selected together read as a funnel's stages exactly as readily as
      // a waterfall's deltas -- which one is right is semantic, not
      // structural, so both stay "possible" until a hint picks a side.
      add("funnel", "Funnel", "possible", `${m} measures narrowing from a top stage to a bottom one.`, "step-down");
    }
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
      // Exactly two measures over time is also the shape a volume-and-a-rate
      // pairing wants -- spend as bars, click-through rate as a line, say --
      // where one measure is a total worth comparing period to period and
      // the other is better read as a trend than as its own bar. Kept to
      // exactly two: past that, which measure is "the line" stops being
      // unambiguous, the same reason scatter only ever uses the first two.
      if (m === 2) add("combo", "Bar + line", "good",
        `${short(measures[0])} as bars, ${short(measures[1])} as a line — a volume and a rate read differently side by side.`,
        "volume + rate");
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
      // Structurally indistinguishable from a bar chart -- one measure,
      // one category axis -- so it can never earn better than "possible"
      // from shape alone. What makes it the right call is semantic, not
      // structural: does this actually bridge named deltas to a total, the
      // way fct_mrr_movements' own synonyms say it does. That's exactly
      // what the `hints` bump in recommend() is for.
      if (n <= 10) add("waterfall", "Waterfall", "possible",
        `${n} categories as signed deltas, bridged to a running total.`, "bridge to a total");
      // Same "one measure over one small category axis" shape as waterfall
      // above -- structurally a bar chart either way. A funnel earns its
      // keep only when the model's own words say this is a sequence of
      // narrowing stages, not just categories (see `hints` in recommend()).
      if (n <= 10) add("funnel", "Funnel", "possible",
        `${n} categories narrowing from a top stage to a bottom one.`, "step-down");
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
    // The rescue for exactly the case "line" just warned about: past 8
    // series, position replaces colour as what tells one category from
    // another -- a small grid of mini panels sharing one y-scale, instead
    // of that many overlaid lines tangling on one axis. Only pulled ahead
    // of a plain multi-series line once there actually are that many.
    add("smallMultiples", "Small multiples", n > 8 ? "good" : "possible",
      n > 8 ? `${n} lines would tangle on one chart — a small grid, one panel per ${short(c.field)}, keeps each trend legible.`
            : `One mini chart per ${short(c.field)}, each easy to read on its own.`,
      "many trends, apart", n > 8 ? 0.5 : 0);
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

/**
 * The rules half of "Beautify": is the tile's CURRENT chart kind actually
 * the best-scored option for this selection's shape? Reuses recommend()
 * rather than any new heuristic -- "should this chart be something else"
 * is exactly what recommend() already answers, just not usually pointed
 * back at a chart that already exists. Returns null when the current kind
 * already IS the top pick (nothing to suggest) or `options` is empty.
 */
export function betterKind(current: ChartKind, options: VizOption[]): VizOption | null {
  const top = options[0];
  return top && top.kind !== current ? top : null;
}

/**
 * The OTHER half of "does this actually read well" that betterKind() can't
 * see: it only asks whether the chart KIND fits this selection's shape,
 * which line/area/bar over a daily grain always answers "yes" to -- a
 * structurally ideal line chart can still be an unreadable zigzag if the
 * underlying series swings wildly from one point to the next. That's a
 * property of the DATA at its current grain, not of the chart kind, so no
 * kind swap fixes it; a coarser grain (fewer, larger buckets, each
 * averaging out the day-to-day noise) is the actual remedy.
 *
 * Scored as the mean absolute point-to-point change relative to the
 * series' own range -- a smooth trend spends that range gradually (a low
 * score), a zigzag re-covers a large fraction of it every single step (a
 * high one). Deliberately magnitude-free: a series swinging between 0.01
 * and 0.02 scores the same as one swinging between 10,000 and 20,000, so
 * this reads as noisy or smooth the same way regardless of the metric's
 * own units.
 */
const NOISE_THRESHOLD = 0.08;
const MIN_POINTS_FOR_NOISE = 14;

export interface NoiseFinding {
  measure: string;
  score: number;
}

export function detectNoisy(rows: unknown[][], columns: string[], measures: string[]): NoiseFinding[] {
  const out: NoiseFinding[] = [];
  for (const m of measures) {
    const i = columns.indexOf(m);
    if (i < 0) continue;
    const vals = rows.map((r) => Number(r[i])).filter(Number.isFinite);
    if (vals.length < MIN_POINTS_FOR_NOISE) continue;
    const range = Math.max(...vals) - Math.min(...vals);
    if (range <= 0) continue;
    const diffs = vals.slice(1).map((v, idx) => Math.abs(v - vals[idx]));
    const meanAbsDiff = diffs.reduce((a, b) => a + b, 0) / diffs.length;
    const score = meanAbsDiff / range;
    if (score >= NOISE_THRESHOLD) out.push({ measure: m, score });
  }
  return out;
}

/**
 * A THIRD way a chart can be structurally the right kind and still be
 * pointless: broken down by a dimension that doesn't actually vary for
 * this measure. Two shapes of the same problem: several categories come
 * back but every one but one reads zero ("New MRR" is already
 * `movement_type = 'new'`, so cutting it BY movement_type can only ever
 * draw one real bar and four empty ones); or the GROUP BY itself only ever
 * returns one row, because the metric's own filter already pins the exact
 * dimension it's being cut by to one value ("MRR" is already `status =
 * 'active'`, so cutting it by status can only ever return the single row
 * "active" -- there are no empty bars to notice, just one bar with nothing
 * to compare it to). Both are read off the DATA, not the metric's filter
 * expression, so this catches the same shape for any reason it happens to
 * occur, not just that one. Only meaningful for a category-like breakdown:
 * a time series legitimately having one active period among many empty
 * ones is a real finding (a launch, a spike), not a pointless chart, so
 * callers should only run this against a non-temporal dimension.
 */
export interface DegenerateFinding {
  dimension: string;
  measure: string;
  /** The one category actually carrying a value, for the why-text. */
  dominantValue: string;
}

export function detectDegenerate(
  rows: unknown[][], columns: string[], dimension: string, measure: string,
): DegenerateFinding | null {
  const dimIdx = columns.indexOf(dimension);
  const mIdx = columns.indexOf(measure);
  if (dimIdx < 0 || mIdx < 0 || rows.length === 0) return null;
  if (rows.length === 1) return { dimension, measure, dominantValue: String(rows[0][dimIdx]) };
  const withValue = rows.filter((r) => { const v = Number(r[mIdx]); return Number.isFinite(v) && v !== 0; });
  if (withValue.length !== 1) return null;
  return { dimension, measure, dominantValue: String(withValue[0][dimIdx]) };
}

/** One step coarser than `grain` -- day and week both step to month rather
 *  than week always stepping to month too (unlike the drill chain, which
 *  skips week going FINER so a drill-up lands where it started; coarsening
 *  for readability has no such round-trip to preserve, so day -> week is
 *  offered as the lighter-touch fix before jumping all the way to month). */
const COARSER_GRAIN: Record<string, string | null> = {
  day: "week", week: "month", month: "quarter", quarter: "year", year: null,
};

export function coarserGrain(grain: string): string | null {
  return COARSER_GRAIN[grain] ?? null;
}
