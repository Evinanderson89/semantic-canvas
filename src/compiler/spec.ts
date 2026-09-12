/**
 * A dashboard is a document of tiles. Both entry points produce one of these:
 * "suggest" generates it, "start from scratch" begins with an empty one.
 *
 * A tile names metrics and dimensions FROM THE MODEL. It never carries SQL, so
 * an invalid tile is caught by validation rather than rendering a wrong chart.
 */
/**
 * Per-card sparkline settings. They live on the tile spec rather than in
 * component state so they survive "Copy spec", round-trip through a saved
 * dashboard, and can be set by an agent the same way a human sets them.
 */
export interface SparkOptions {
  shape: "line" | "area" | "bar";
  /** "fit" reveals variation in a tight series; "zero" keeps magnitude honest. */
  scale: "fit" | "zero";
  compare: "prior" | "first";
  color: "auto" | "accent" | "neutral";
  showRange: boolean;
  showMinMax: boolean;
}

export const DEFAULT_SPARK: SparkOptions = {
  // Fit by default: a retention series sitting between 0.97 and 1.03 is a flat
  // line on a zero-based axis, which hides the only thing it has to say.
  shape: "line", scale: "fit", compare: "prior",
  color: "auto", showRange: true, showMinMax: false,
};

/**
 * Not every tile queries data. Headings, notes and dividers are what turn a
 * grid of charts into something with an argument, and they belong on the same
 * canvas with the same geometry rather than in a separate system.
 */
export type TileKind = "metric" | "heading" | "text" | "divider" | "image" | "filter";

export interface TileSpec {
  id: string;
  /** Omitted tiles belong to the first tab for backwards compatibility. */
  tabId?: string;
  filterId?: string;
  /** Heading tile that owns this content. */
  section?: string;
  /** Automatic composition preserves this tile and its section. */
  pinned?: boolean;
  kind?: TileKind;
  title?: string;
  /** Body copy for heading/text tiles. */
  text?: string;
  /** Image tiles only. A data: URI -- there's no upload/asset backend here,
   *  so the tile spec carries the image the same way it carries everything
   *  else: as a plain, self-contained JSON field that saves with the dashboard. */
  imageData?: string;
  metrics: string[];
  /** "month:event_date" for a time grain, "dim_users.country" for a join. */
  dimensions: string[];
  /**
   * Structured filters only. A raw-SQL escape hatch used to live here guarded
   * by a `;`/`--` denylist, which a subquery walks straight through -- and on
   * DuckDB that means read_parquet/read_text against any path the process can
   * reach. Denylists do not contain SQL; a closed vocabulary does.
   */
  where?: FilterSpec[];
  limit?: number;
  /** Omitted means "let the rules decide", which is the normal case. */
  chart?: ChartKind;
  /**
   * Period-over-period comparison. Requires a time dimension; the compiler
   * matches the aggregate to the previous calendar period ("prior") or
   * the same calendar date one year earlier ("yoy"), which is what "Month-over-Month
   * Revenue by Region" actually means.
   */
  compare?: "none" | "prior" | "yoy";
  /** What the chart plots when a comparison is active. */
  compareShow?: "value" | "delta" | "percent";
  spark?: Partial<SparkOptions>;
  /** Presentation only — never affects the query. */
  format?: Partial<import("../format/format.ts").FormatSpec>;
  /** Absolute pixels on the authored canvas, plus stacking order. */
  layout: { x: number; y: number; w: number; h: number; z?: number };
}

export type ChartKind =
  | "line" | "area" | "areaStacked"
  | "bar" | "barGrouped" | "barStacked" | "barH" | "barHorizontal"
  | "scatter" | "heatmap" | "map" | "donut" | "waterfall" | "funnel" | "smallMultiples" | "combo"
  | "stat" | "kpi" | "table";

export interface DashboardSpec {
  title: string;
  description?: string;
  tiles: TileSpec[];
  tabs?: { id: string; title: string }[];
  filters?: DashboardFilter[];
  /**
   * Dashboard-wide filters, set by clicking a mark in any chart. Applied to
   * every tile that can actually reach the field -- a cross-filter on
   * dim_users.country silently skips a tile with no join to dim_users rather
   * than erroring or, worse, being ignored while looking applied.
   */
  crossFilters?: FilterSpec[];
}

export type DatePreset = "last-7-days" | "last-30-days" | "last-90-days" | "this-month" | "this-quarter" | "year-to-date";
export type FilterPresentation = "dropdown" | "chips" | "segmented" | "range" | "presets";
export interface FilterValue {
  values?: (string | number | boolean | null)[];
  min?: number | string | null;
  max?: number | string | null;
  /** Relative window, resolved in the viewer's calendar at query time. Never stored alongside min/max. */
  preset?: DatePreset;
}
export interface DashboardFilter {
  id: string;
  label: string;
  field: string;
  control: "select" | "date" | "number";
  /** How the control looks. Omitted means the control's default; it never changes the query. */
  presentation?: FilterPresentation;
  scope: "tab" | "report";
  tabId?: string;
  bindings: { tileId: string; field: string }[];
  defaultValue?: FilterValue;
}

/**
 * Filters are structured, never SQL text. The UI can render them, the compiler
 * can quote values safely, and an agent can emit them without any chance of
 * writing a predicate that touches something outside the model.
 *
 * `source` decides WHERE vs HAVING: a dimension filters rows, a metric filters
 * the aggregate, and getting that wrong silently changes the answer.
 */
export interface FilterSpec {
  id: string;
  /** "country", "dim_plans.plan_tier", or a metric name. */
  field: string;
  source: "dimension" | "metric";
  /** discrete = pick from values; range = between bounds. */
  mode: "discrete" | "range";
  values?: (string | number | boolean | null)[];
  /** A date column's range bound is a string ("2026-03-01"), e.g. from a
   *  drill-down's clicked bucket -- not every range is numeric. */
  min?: number | string | null;
  max?: number | string | null;
  exclude?: boolean;
  /** Half-open upper bound, used for inclusive calendar-day controls and drill buckets. */
  maxExclusive?: boolean;
}

export interface ValidationIssue { tile: string; problem: string }
