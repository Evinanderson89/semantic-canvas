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
}

export interface Metric {
  name: string;
  label: string;
  description?: string;
  baseTable: string;
  expression: string;
  /** Always-on filter, e.g. status = 'active'. */
  filter?: string | null;
  synonyms: string[];
}

export interface Join {
  left: string;
  leftOn: string;
  right: string;
  rightOn: string;
  type: "left" | "inner";
}

export interface Model {
  /** Which adapter produced this, for provenance in the UI. */
  source: string;
  name: string;
  description?: string;
  tables: Record<string, Table>;
  metrics: Record<string, Metric>;
  joins: Join[];
}

export interface SemanticAdapter {
  id: string;
  label: string;
  /** Returns null when this adapter does not recognise the source. */
  load(source: string): Promise<Model | null>;
}

// ---------------------------------------------------------------- helpers --

export function metricsByTable(model: Model): Record<string, Metric[]> {
  const out: Record<string, Metric[]> = {};
  for (const m of Object.values(model.metrics)) {
    (out[m.baseTable] ??= []).push(m);
  }
  return out;
}

export function findJoin(model: Model, left: string, right: string): Join | null {
  return model.joins.find((j) => j.left === left && j.right === right) ?? null;
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
  return t.columns.filter((c) => !/^(id|.*_id)$/.test(c.name) || t.partitionKeys.includes(c.name));
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
  return model.joins.some((j) => j.left === baseTable && j.right === t);
}
