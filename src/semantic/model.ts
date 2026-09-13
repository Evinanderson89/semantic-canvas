/**
 * The internal shape every semantic layer is normalized into.
 *
 * Nothing downstream — compiler, suggestion engine, charts, canvas — knows
 * whether the model came from duckglue, Cube, MetricFlow or Malloy. Adding a
 * layer means writing one adapter, not touching anything else.
 */
export interface Column {
  name: string;
  type: string;
  description?: string;
}

export interface Table {
  name: string;
  description?: string;
  /** One row per what. The single most useful sentence in a semantic layer. */
  grain?: string;
  synonyms: string[];
  columns: Column[];
  partitionKeys: string[];
  primaryKey?: string | null;
  /** Days after a period ends before its rows are all in ("orders settle after 2 days"). Declared as reporting_lag; drives the data-honesty review. */
  reportingLagDays?: number;
  relation?: { database?: string; schema?: string; table: string };
  /** Set on tables registered by Ingest (docs/connected-canvas.md); absent on base-model tables. */
  connected?: ConnectedInfo;
  /** Set on tables the Modeler added over a base model. */
  origin?: Origin;
}

export interface ConnectedProvenance { source: string; loadedAt: string; loadedBy: string; rows: number; refreshEvery?: "15m" | "1h" | "6h" | "12h" | "1d" | "7d"; expectedBy?: string }
export interface ConnectedInfo { status: "unreviewed" | "published"; provenance: ConnectedProvenance; loadedAt: string }
/** Lineage columns Ingest stamps on every connected table; declared, never proposed as dimensions. */
export const LINEAGE_COLUMNS: Column[] = [
  { name: "_import_id", type: "varchar", description: "Ingest import that loaded this row" },
  { name: "_loaded_at", type: "timestamptz", description: "When Ingest loaded this row" },
  { name: "_source", type: "varchar", description: "Ingest source object" },
];
export const isLineage = (c: Column) => LINEAGE_COLUMNS.some((l) => l.name === c.name);

export type TimeGrain = "day" | "week" | "month" | "quarter" | "year";

/**
 * What kind of metric this is (docs/metric-types.md):
 *   simple      one aggregate expression over the base table (the default)
 *   ratio       numerator / denominator, two metrics; on the same table or across two
 *   derived     an expression over other metrics on the same table (revenue - cost)
 *   cumulative  a running total of a metric along the time axis, optionally trailing N periods
 */
export type MetricType = "simple" | "ratio" | "derived" | "cumulative";

export interface Metric {
  name: string;
  label: string;
  description?: string;
  baseTable: string;
  /** The SQL aggregate for a simple metric; for a derived metric, an expression over metric names. */
  expression: string;
  type?: MetricType;
  /** ratio: the two metrics. */
  numerator?: string;
  denominator?: string;
  /** cumulative: the metric summed along time, and how many periods the window trails (absent: since the start). */
  metric?: string;
  window?: number;
  /** Declared native reporting grains. Omitted means the expression owns rollup semantics. */
  importance?: number;
  direction?: "higher" | "lower" | "neutral";
  timeGrains?: TimeGrain[];
  timeDimension?: string;
  /** Always-on filter, e.g. status = 'active'. */
  filter?: string | null;
  synonyms: string[];
  /** false on a connected draft metric no admin has published yet; undefined (base model) counts as reviewed. */
  reviewed?: boolean;
  /** Set on what was added in Canvas rather than in the base model: by the Modeler, or proposed on the Metric Registry. */
  origin?: Origin;
}

/** Provenance of a table or metric that was added in Canvas. */
export interface Origin { kind: "modeler" | "proposal"; by: string; byId?: string; at: string; publishedBy?: string; publishedAt?: string }

/** How many rows of the right table one row of the left meets (docs/joins.md). Absent means many_to_one: the fact-to-dimension case, which never multiplies rows. */
export type JoinCardinality = "many_to_one" | "one_to_one" | "one_to_many" | "many_to_many";

export interface Join {
  left: string;
  leftOn: string;
  right: string;
  rightOn: string;
  type: "left" | "inner";
  columns?: { left: string; right: string }[];
  cardinality?: JoinCardinality;
}

/**
 * The calendar every period is cut on (docs/calendar.md): which day a week
 * starts, which month a fiscal year starts, and the timezone timestamps are
 * read in. One declaration; the compiler, the edge-completeness flags, the
 * date presets and the honesty rules all follow it.
 */
export interface Calendar { weekStart: "monday" | "sunday"; fiscalYearStartMonth: number; timezone?: string }
export const DEFAULT_CALENDAR: Calendar = { weekStart: "monday", fiscalYearStartMonth: 1 };
export const calendarOf = (model: Pick<Model, "calendar"> | null | undefined): Calendar => model?.calendar ?? DEFAULT_CALENDAR;

export interface Model {
  /** Which adapter produced this, for provenance in the UI. */
  source: string;
  name: string;
  description?: string;
  tables: Record<string, Table>;
  metrics: Record<string, Metric>;
  joins: Join[];
  calendar?: Calendar;
}

export interface SemanticAdapter {
  id: string;
  label: string;
  /** Returns null when this adapter does not recognise the source. */
  load(source: string): Promise<Model | null>;
}

// ---------------------------------------------------------------- helpers --

export const isUnreviewedTable = (t: Table | undefined) => t?.connected?.status === "unreviewed";
export const isUnreviewed = (model: Model, m: Metric) => m.reviewed === false || isUnreviewedTable(model.tables[m.baseTable]);

/** The governed catalogue only: connected tables and draft metrics no admin has published are dropped.
 *  Suggestions, the agent's catalogue and viewer sessions all see this; editors and admins see the full model. */
export function reviewedModel(model: Model): Model {
  if (!Object.values(model.tables).some((t) => t.connected) && !Object.values(model.metrics).some((m) => m.reviewed === false)) return model;
  const tables = Object.fromEntries(Object.entries(model.tables).filter(([, t]) => !isUnreviewedTable(t)));
  const metrics = Object.fromEntries(Object.entries(model.metrics).filter(([, m]) => m.reviewed !== false && tables[m.baseTable]));
  return { ...model, tables, metrics, joins: model.joins.filter((j) => tables[j.left] && tables[j.right]) };
}
export const visibleModel = (model: Model, role: string | undefined) => role === "viewer" ? reviewedModel(model) : model;

export function metricsByTable(model: Model): Record<string, Metric[]> {
  const out: Record<string, Metric[]> = {};
  for (const m of Object.values(model.metrics)) {
    (out[m.baseTable] ??= []).push(m);
  }
  return out;
}

export function findJoin(model: Model, left: string, right: string): Join | null {
  const matches = model.joins.filter((j) => j.left === left && j.right === right);
  return matches.length === 1 ? matches[0] : null;
}

/** A join that multiplies the left table's rows: an aggregate over it would double count. */
export const fansOut = (j: Join) => j.cardinality === "one_to_many" || j.cardinality === "many_to_many";

/**
 * The joins from `from` to `to`, following declared joins left to right
 * (docs/joins.md). The shortest path wins; two shortest paths are ambiguous
 * and refused with both named, as is a path through a join that fans out,
 * because a chart cannot be right on a guess.
 */
export function joinPath(model: Model, from: string, to: string): { joins: Join[] } | { error: string } {
  if (from === to) return { joins: [] };
  const paths: Join[][] = [];
  let frontier: { at: string; via: Join[] }[] = [{ at: from, via: [] }];
  const seen = new Set([from]);
  while (frontier.length && !paths.length) {
    const next: { at: string; via: Join[] }[] = [];
    const reached = new Set<string>();
    for (const f of frontier) for (const j of model.joins) {
      if (j.left !== f.at || seen.has(j.right) && !reached.has(j.right)) continue;
      const via = [...f.via, j];
      if (j.right === to) paths.push(via);
      else { reached.add(j.right); next.push({ at: j.right, via }); }
    }
    for (const r of reached) seen.add(r);
    frontier = next;
  }
  if (!paths.length) return { error: `no join from ${from} to ${to}` };
  if (paths.length > 1) return { error: `${from} reaches ${to} two ways (${paths.map((p) => p.map((j) => j.right).join(" → ")).join(", or ")}); the model must say which` };
  const fan = paths[0].find(fansOut);
  if (fan) return { error: `joining ${fan.left} to ${fan.right} multiplies ${fan.left}'s rows (${fan.cardinality}); an aggregate over it would double count` };
  return { joins: paths[0] };
}

/**
 * Free-text context for a metric selection: the base table's own
 * `description`/`synonyms` plus each selected metric's -- whatever the
 * model's author actually wrote, in their words. Structural logic
 * (cardinality, dimension role) can't see this; it's not in the schema,
 * it's in the prose someone wrote around it. Feeds recommend()'s optional
 * `hints` parameter so chart suggestions can react to it -- e.g. a table
 * whose synonyms include "mrr waterfall" nudging toward a waterfall chart,
 * for ANY model documented this way, not just this app's sample warehouse.
 */
export function semanticHints(model: Model, measures: string[]): string {
  const parts: string[] = [];
  const base = measures.length ? model.metrics[measures[0]]?.baseTable : null;
  const table = base ? model.tables[base] : null;
  if (table) { if (table.description) parts.push(table.description); parts.push(...table.synonyms); }
  for (const name of measures) {
    const metric = model.metrics[name];
    if (!metric) continue;
    if (metric.description) parts.push(metric.description);
    parts.push(...metric.synonyms);
  }
  return parts.join(" ");
}

/** Columns of a table that make sensible group-by keys. */
export function dimensionsOf(t: Table): Column[] {
  return t.columns.filter((c) => !isLineage(c) && (!/^(id|.*_id)$/.test(c.name) || t.partitionKeys.includes(c.name)));
}

/** "sample_warehouse" -> "Sample Warehouse". model.name is whatever
 *  identifier the source's own file happens to use -- shown raw, it reads as
 *  unfinished rather than as a product a stranger would trust. */
export function prettifyModelName(name: string): string {
  return name.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}

export function isTemporal(c: Column): boolean {
  return /^(date|timestamp|datetime)/i.test(c.type);
}

export function isNumeric(c: Column): boolean {
  return /^(double|float|decimal|numeric|int|bigint|smallint|real)/i.test(c.type);
}

/**
 * The natural time axis for a table, if it has one -- "table.column", ready
 * to prefix with a grain and use as a dimension string. Used by Beautify's
 * degenerate-breakdown fix and by "add a tile" suggestions: a metric is
 * better shown as a trend over its own base table's date column than
 * collapsed to a bare number or left off entirely, when that column
 * exists.
 *
 * NOT just "the first date-typed column" -- a table can have a date column
 * that's a lifecycle attribute of the ENTITY, not a period the table is
 * grained by (fct_subscriptions has started_on/ended_on, but no row
 * represents "the state of things as of that date," only "when this one
 * subscription happened to start"). Grouping a CURRENT-STATE metric like
 * active MRR by started_on produces a cohort breakdown that looks like a
 * trend but isn't one -- each bucket only holds currently-active rows that
 * happen to share a start date, not the state of the world at that time.
 * Only two things are trustworthy here, both things the model's own author
 * declared on purpose: the table's partition key (a real periodic fact
 * date -- event_date, movement_date, spend_date), or a date-typed primary
 * key on a table whose own grain is "one row per period" (fct_saas_monthly:
 * primary_key month, grain "one row per calendar month"). A table with
 * neither -- fct_subscriptions -- genuinely has no column safe for this.
 */
export function timeColumnOf(model: Model, tableName: string | null): string | null {
  if (!tableName) return null;
  const table = model.tables[tableName];
  if (!table) return null;
  const byName = (name: string | undefined) => name ? table.columns.find((c) => c.name === name) : undefined;
  const col = byName(table.partitionKeys[0]) ?? (() => {
    const pk = byName(table.primaryKey ?? undefined);
    return pk && isTemporal(pk) ? pk : undefined;
  })();
  return col ? `${tableName}.${col.name}` : null;
}

/** Can a filter on `field` be applied to a tile based on `baseTable`? */
export function fieldReachable(model: Model, baseTable: string, field: string): boolean {
  const [t, c] = field.includes(".") ? field.split(".", 2) : [baseTable, field];
  const table = model.tables[t];
  if (!table || !table.columns.some((x) => x.name === c)) return false;
  if (t === baseTable) return true;
  return "joins" in joinPath(model, baseTable, t);
}

export const joinPairs = (join: Join) => join.columns ?? [{ left: join.leftOn, right: join.rightOn }];

export const metricType = (m: Metric): MetricType => m.type ?? "simple";

/** Metric names a derived expression refers to: every identifier that is a metric of the model. */
export function derivedReferences(model: Model, expression: string): string[] {
  const names = new Set<string>();
  for (const m of expression.replace(/'(?:[^']|'')*'/g, "''").matchAll(/(?<![A-Za-z0-9_.])([A-Za-z_][A-Za-z0-9_]*)(?!\s*\()/g)) if (model.metrics[m[1]]) names.add(m[1]);
  return [...names];
}

/** The simple metrics a metric is computed from (itself, when simple). One level deep: components are simple. */
export function metricComponents(model: Model, m: Metric): Metric[] {
  switch (metricType(m)) {
    case "ratio": return [model.metrics[m.numerator ?? ""], model.metrics[m.denominator ?? ""]].filter(Boolean);
    case "derived": return derivedReferences(model, m.expression).map((n) => model.metrics[n]).filter(Boolean);
    case "cumulative": return [model.metrics[m.metric ?? ""]].filter(Boolean);
    default: return [m];
  }
}

/** A ratio whose denominator lives on another table than its numerator: compiled as two grouped queries joined on the dimensions. */
export const isCrossTableRatio = (model: Model, m: Metric) =>
  metricType(m) === "ratio" && !!m.numerator && !!m.denominator && model.metrics[m.numerator]?.baseTable !== model.metrics[m.denominator]?.baseTable;

/** Problems with a computed metric's definition, in words; null when it is sound. */
export function computedMetricIssue(model: Model, m: Metric): string | null {
  const t = metricType(m);
  if (t === "simple") return null;
  const simple = (name: string | undefined, what: string) => {
    if (!name) return `${m.name}: ${what} is required.`;
    const c = model.metrics[name];
    if (!c) return `${m.name}: ${what} names an unknown metric "${name}".`;
    if (metricType(c) !== "simple") return `${m.name}: ${what} must be a simple metric; "${name}" is ${metricType(c)}.`;
    return null;
  };
  if (t === "ratio") {
    const issue = simple(m.numerator, "numerator") ?? simple(m.denominator, "denominator");
    if (issue) return issue;
    if (m.baseTable !== model.metrics[m.numerator!].baseTable) return `${m.name}: a ratio's base table is its numerator's (${model.metrics[m.numerator!].baseTable}).`;
    return null;
  }
  if (t === "cumulative") return simple(m.metric, "metric") ?? (m.window !== undefined && (!Number.isInteger(m.window) || m.window < 1) ? `${m.name}: window is a whole number of periods.` : null);
  const refs = derivedReferences(model, m.expression);
  if (!refs.length) return `${m.name}: a derived metric's expression names other metrics (revenue - cost).`;
  for (const r of refs) { const issue = simple(r, `"${r}"`); if (issue) return issue; if (model.metrics[r].baseTable !== m.baseTable) return `${m.name}: "${r}" is on ${model.metrics[r].baseTable}, not ${m.baseTable}; a derived metric stays on one table (a ratio may cross tables).`; }
  if (/;|--|\/\*|\bselect\b/i.test(m.expression)) return `${m.name}: a derived expression is arithmetic over metric names.`;
  return null;
}

/** Restricted metrics require their declared time dimension at a supported grain. */
export function metricGrainIssue(metric: Metric, dimensions: string[]): string | null {
  if (!metric.timeGrains) return null;
  const dimension = dimensions.find((d) => {
    const field = d.split(":")[1];
    return field && (field.includes(".") ? field : `${metric.baseTable}.${field}`) === metric.timeDimension;
  });
  return dimension && metric.timeGrains.includes(dimension.split(":")[0] as TimeGrain) ? null
    : `${metric.label} requires ${metric.timeGrains.join(" or ")} reporting on ${metric.timeDimension}. Other grains would change the metric's meaning.`;
}
