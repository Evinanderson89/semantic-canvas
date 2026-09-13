/**
 * The Modeler's proposal: from what a warehouse says about itself (tables,
 * columns, counts, uniqueness, key resolution) to a semantic model a person
 * reviews and publishes. Every line of the proposal carries its evidence,
 * the way a data-honesty finding does; nothing is asserted that the numbers
 * do not support. Deterministic and pure: the profile comes in, the
 * proposal comes out, the AI (optional, elsewhere) only writes prose.
 *
 * docs/modeler.md explains the rules to people; this file is the rules.
 */

/** One column, as profiled. */
export interface ColumnProfile {
  name: string;
  /** Normalised: string, integer, double, boolean, date, timestamp, other. */
  type: string;
  /** The warehouse's own type name, kept for the model file. */
  rawType: string;
  nonNull: number;
  distinct: number;
  min?: string | number | null;
  max?: string | number | null;
}

export interface TableProfile {
  name: string;
  rows: number;
  columns: ColumnProfile[];
  /** The physical location, for warehouses that qualify names. */
  relation?: { database?: string; schema?: string; table: string };
}

/** A join the profiler checked: of the left column's non-null values, how many resolve on the right. */
export interface JoinProbe { left: string; leftOn: string; right: string; rightOn: string; leftRows: number; matched: number }

/** In an extension draft: what the base model already has (`existing`, never written), what it lacks (`new`), a metric the data suggests for a modelled table (`gap`). */
export type ItemStatus = "new" | "existing" | "gap";

export interface ProposedTable {
  name: string;
  include: boolean;
  status?: ItemStatus;
  kind: "fact" | "dimension" | "unknown";
  grain: string;
  /** Why the grain says what it says. */
  evidence: string;
  primaryKey: string | null;
  description: string;
  synonyms: string[];
  timeColumn: string | null;
  /** Days after a period before its rows are all in; a person fills this in. */
  reportingLag?: number;
  columns: { name: string; type: string; description: string }[];
  rows: number;
}

export interface ProposedJoin {
  left: string; leftOn: string; right: string; rightOn: string;
  type: "left" | "inner";
  include: boolean;
  status?: ItemStatus;
  evidence: string;
  /** Share of left keys that resolve, when probed. */
  resolution: number | null;
}

export interface ProposedMetric {
  name: string;
  label: string;
  baseTable: string;
  expression: string;
  description: string;
  include: boolean;
  status?: ItemStatus;
  /** Why it was proposed. */
  evidence: string;
}

export interface Proposal {
  model: { name: string; description: string };
  tables: ProposedTable[];
  joins: ProposedJoin[];
  metrics: ProposedMetric[];
  warnings: string[];
  /** Set when the proposal extends a source's existing model rather than making a new one. */
  extends?: string;
}

const ID_LIKE = /(^|_)(id|key|code|uuid)$/i;
const MEASURE_LIKE = /amount|revenue|price|total|cost|value|qty|quantity|spend|fee|mrr|arr|sales|units|count|duration|seconds|minutes|hours|score|weight|size|bytes|volume|balance|margin|profit|discount|tax/i;
const TIME_LIKE = /date|_at$|_on$|time|day|month|week/i;
const TIME_TYPES = new Set(["date", "timestamp"]);
const NUMERIC_TYPES = new Set(["integer", "double"]);

/** fct_web_sessions -> "Web sessions"; dim_users -> "Users". */
export function prettyName(table: string): string {
  const stem = table.replace(/^(fct|fact|dim|stg|raw|src|int|mart|rpt)_/i, "").replace(/_/g, " ").trim();
  return stem ? stem[0].toUpperCase() + stem.slice(1) : table;
}

const singular = (word: string) => word.endsWith("ies") ? word.slice(0, -3) + "y" : word.endsWith("ses") || word.endsWith("xes") ? word.slice(0, -2) : word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word;
const stemOf = (table: string) => table.replace(/^(fct|fact|dim|stg|raw|src|int|mart|rpt)_/i, "");

/** Map a warehouse type to the model's vocabulary. */
export function normalizeType(raw: string): string {
  const t = raw.toLowerCase();
  if (/bool/.test(t)) return "boolean";
  if (/timestamp|datetime/.test(t)) return "timestamp";
  if (/^date$|date\b/.test(t) && !/timestamp/.test(t)) return "date";
  if (/int|serial/.test(t) && !/interval/.test(t)) return "integer";
  if (/decimal|numeric|number|double|float|real/.test(t)) return /number\(\d+,\s*0\)|numeric\(\d+,\s*0\)/.test(t) ? "integer" : "double";
  if (/char|text|string|varchar|uuid|enum/.test(t)) return "string";
  return "other";
}

/** A unique, never-null column: the table's key. Prefers id-like names and earlier columns. */
export function findKey(t: TableProfile): ColumnProfile | null {
  if (t.rows === 0) return null;
  const unique = t.columns.filter((c) => c.nonNull === t.rows && c.distinct === t.rows && !TIME_TYPES.has(c.type) && c.type !== "double" && c.type !== "boolean");
  if (!unique.length) return null;
  return unique.find((c) => ID_LIKE.test(c.name)) ?? unique[0];
}

/** Which table's key a foreign-key-looking column points at, by name. */
function keyTarget(column: string, own: TableProfile, tables: TableProfile[], keys: Map<string, ColumnProfile | null>): TableProfile | null {
  const candidates = tables.filter((t) => t.name !== own.name && keys.get(t.name));
  // Exact key-name match: fct_orders.user_id -> dim_users.user_id.
  const exact = candidates.filter((t) => keys.get(t.name)!.name === column);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return exact.find((t) => /^dim_/.test(t.name)) ?? null;
  // Stem match: plan_id -> dim_plans.id / plans.id.
  const stem = column.replace(/_?(id|key|code|uuid)$/i, "").toLowerCase();
  if (!stem) return null;
  const byStem = candidates.filter((t) => { const s = singular(stemOf(t.name).toLowerCase()); return s === stem || s === singular(stem); });
  return byStem.length === 1 ? byStem[0] : null;
}

export function propose(input: { id: string; label: string; tables: TableProfile[]; probes?: JoinProbe[] }): Proposal {
  const tables = [...input.tables].sort((a, b) => a.name.localeCompare(b.name));
  const keys = new Map(tables.map((t) => [t.name, findKey(t)]));
  const warnings: string[] = [];
  const probes = new Map((input.probes ?? []).map((p) => [`${p.left}.${p.leftOn}>${p.right}.${p.rightOn}`, p]));

  // Joins first: a table whose key other tables point at is a dimension.
  const joins: ProposedJoin[] = [];
  const referenced = new Set<string>();
  for (const t of tables) {
    const key = keys.get(t.name);
    for (const c of t.columns) {
      if (key && c.name === key.name) continue;
      if (!ID_LIKE.test(c.name)) continue;
      const target = keyTarget(c.name, t, tables, keys);
      if (!target) continue;
      const targetKey = keys.get(target.name)!;
      const probe = probes.get(`${t.name}.${c.name}>${target.name}.${targetKey.name}`);
      const resolution = probe && probe.leftRows > 0 ? probe.matched / probe.leftRows : null;
      const why = targetKey.name === c.name ? `${c.name} is ${target.name}'s key` : `${c.name} names ${target.name} (${targetKey.name} is its key)`;
      const measured = resolution === null ? "not checked" : `${(resolution * 100).toFixed(resolution < 0.999 && resolution > 0.99 ? 1 : 0)}% of ${t.name}.${c.name} values resolve`;
      const include = resolution === null ? true : resolution >= 0.5;
      if (resolution !== null && resolution < 0.95) warnings.push(`${t.name}.${c.name} → ${target.name}: only ${measured}; ${include ? "included, check it" : "left out"}.`);
      joins.push({ left: t.name, leftOn: c.name, right: target.name, rightOn: targetKey.name, type: "left", include, evidence: `${why}; ${measured}.`, resolution });
      if (include) referenced.add(target.name);
    }
  }

  const proposedTables: ProposedTable[] = tables.map((t) => {
    const key = keys.get(t.name);
    const timeCols = t.columns.filter((c) => TIME_TYPES.has(c.type) && c.nonNull > 0);
    const timeColumn = (timeCols.find((c) => TIME_LIKE.test(c.name) && c.nonNull === t.rows) ?? timeCols.sort((a, b) => b.nonNull - a.nonNull)[0])?.name ?? null;
    const measures = t.columns.filter((c) => NUMERIC_TYPES.has(c.type) && !ID_LIKE.test(c.name) && MEASURE_LIKE.test(c.name));
    const looksFact = /^(fct|fact)_/.test(t.name) || (timeColumn !== null && measures.length > 0 && !referenced.has(t.name));
    const looksDim = /^dim_/.test(t.name) || (referenced.has(t.name) && !looksFact);
    const kind: ProposedTable["kind"] = looksDim ? "dimension" : looksFact ? "fact" : key && !timeColumn ? "dimension" : timeColumn ? "fact" : "unknown";
    let grain: string, evidence: string;
    if (t.rows === 0) { grain = ""; evidence = "The table is empty; nothing to check."; warnings.push(`${t.name} has no rows; it is left out.`); }
    else if (key) { grain = `one row per ${key.name}`; evidence = `${key.name} is unique across ${t.rows.toLocaleString()} rows and never null.`; }
    else if (kind === "fact" && timeColumn) { grain = `one row per event on ${timeColumn}`; evidence = `No single column is unique; ${timeColumn} is present on every row. Say what one row is.`; }
    else { grain = ""; evidence = "No column is unique across the table. Say what one row is, or leave the table out."; }
    if (!key && t.rows > 0) warnings.push(`${t.name}: no unique column; write its grain before publishing.`);
    return {
      name: t.name, include: t.rows > 0, kind, grain, evidence, primaryKey: key?.name ?? null,
      description: "", synonyms: [singular(stemOf(t.name)).replace(/_/g, " "), stemOf(t.name).replace(/_/g, " ")].filter((s, i, a) => s && a.indexOf(s) === i),
      timeColumn, columns: t.columns.map((c) => ({ name: c.name, type: c.type === "other" ? c.rawType : c.type, description: "" })), rows: t.rows,
    };
  });

  const metrics: ProposedMetric[] = [];
  const seen = new Set<string>();
  const add = (m: ProposedMetric) => { if (seen.has(m.name)) return; seen.add(m.name); metrics.push(m); };
  for (const t of proposedTables) {
    if (!t.include) continue;
    const profile = tables.find((x) => x.name === t.name)!;
    const stem = stemOf(t.name);
    const rowsLabel = prettyName(t.name);
    if (t.kind === "fact" || t.kind === "unknown") {
      add({ name: `${stem}_count`, label: rowsLabel, baseTable: t.name, expression: "COUNT(*)", description: `Number of ${stem.replace(/_/g, " ")}.`, include: true, evidence: `${t.name} has ${t.rows.toLocaleString()} rows.` });
    } else {
      add({ name: `${stem}_count`, label: rowsLabel, baseTable: t.name, expression: "COUNT(*)", description: `Number of ${stem.replace(/_/g, " ")}.`, include: false, evidence: "A dimension's row count is rarely a metric; included off." });
    }
    for (const c of profile.columns) {
      if (metrics.filter((m) => m.baseTable === t.name).length >= 10) break;
      if (NUMERIC_TYPES.has(c.type) && !ID_LIKE.test(c.name) && MEASURE_LIKE.test(c.name)) {
        add({ name: `total_${c.name}`, label: `Total ${c.name.replace(/_/g, " ")}`, baseTable: t.name, expression: `SUM(${t.name}.${c.name})`, description: "", include: t.kind !== "dimension", evidence: `${c.name} is numeric and named like a measure (${c.nonNull.toLocaleString()} values).` });
      }
      if (ID_LIKE.test(c.name) && c.name !== t.primaryKey && c.distinct > 1 && t.kind !== "dimension") {
        const what = c.name.replace(/_?(id|key|code|uuid)$/i, "").replace(/_/g, " ") || c.name;
        add({ name: `distinct_${what.replace(/ /g, "_")}s`, label: `Distinct ${what}s`, baseTable: t.name, expression: `COUNT(DISTINCT ${t.name}.${c.name})`, description: "", include: true, evidence: `${c.name} has ${c.distinct.toLocaleString()} distinct values across ${t.rows.toLocaleString()} rows.` });
      }
    }
  }

  return {
    model: { name: input.id, description: `${input.label}: ${proposedTables.filter((t) => t.include).length} tables, proposed by the Modeler from the warehouse's own catalogue.` },
    tables: proposedTables, joins, metrics, warnings,
  };
}
