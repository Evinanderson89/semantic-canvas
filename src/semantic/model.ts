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

/** Can a filter on `field` be applied to a tile based on `baseTable`? */
export function fieldReachable(model: Model, baseTable: string, field: string): boolean {
  const [t, c] = field.includes(".") ? field.split(".", 2) : [baseTable, field];
  const table = model.tables[t];
  if (!table || !table.columns.some((x) => x.name === c)) return false;
  if (t === baseTable) return true;
  return model.joins.some((j) => j.left === baseTable && j.right === t);
}
