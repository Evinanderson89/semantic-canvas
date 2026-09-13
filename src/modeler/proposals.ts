import type { Model } from "../semantic/model.ts";

/**
 * A proposed metric (docs/modeler.md, "Proposed metrics"): an editor names
 * an aggregate over one table's own columns; it becomes a metric at once
 * for editors, badged and unreviewed, and reaches viewers only when an
 * administrator publishes it. Nothing runs when it is defined: a metric
 * is a named expression, compiled per query, only when a tile asks for it.
 *
 * The checks here are the closed vocabulary that keeps a chart honest:
 * one aggregate over the base table's columns, no other table, no
 * statement, no subquery. What passes is then probed once against the
 * warehouse (LIMIT 1) before it is stored.
 */
export interface MetricProposal { name: string; label: string; baseTable: string; expression: string; description?: string; filter?: string | null }

const NAME = /^[a-z][a-z0-9_]{0,63}$/;
const AGGREGATE = /\b(sum|count|avg|min|max|median|stddev|stddev_samp|stddev_pop|var_samp|var_pop|approx_count_distinct|count_distinct|any_value|bool_or|bool_and|percentile_cont|percentile_disc|quantile_cont)\s*\(/i;
const FORBIDDEN = /;|--|\/\*|\bselect\b|\bfrom\b|\bjoin\b|\bunion\b|\binsert\b|\bupdate\b|\bdelete\b|\bdrop\b|\bcreate\b|\balter\b|\bcall\b|\bexec\b/i;
/**
 * The only functions a proposal may call. A closed list, not a denylist:
 * DuckDB and Snowflake both have functions that read files, environment
 * variables and secrets, and a metric has no business calling any of them.
 */
export const FUNCTIONS = new Set([
  // aggregates
  "sum", "count", "avg", "min", "max", "median", "stddev", "stddev_samp", "stddev_pop", "var_samp", "var_pop", "variance", "approx_count_distinct", "count_distinct", "any_value", "bool_or", "bool_and", "percentile_cont", "percentile_disc", "quantile_cont", "quantile_disc", "mode", "sum_distinct", "avg_distinct", "count_if", "sum_if",
  // arithmetic and null handling
  "coalesce", "nullif", "ifnull", "nvl", "zeroifnull", "greatest", "least", "abs", "round", "floor", "ceil", "ceiling", "sqrt", "ln", "log", "log10", "exp", "power", "pow", "sign", "trunc", "truncate", "cast", "try_cast", "iff", "if",
  // dates
  "date_trunc", "date_part", "extract", "datediff", "date_diff", "dateadd", "date_add", "day", "month", "year", "week", "quarter", "dayofweek", "day_of_week", "epoch", "to_date", "to_timestamp", "current_date", "now", "last_day", "date",
  // text
  "lower", "upper", "trim", "ltrim", "rtrim", "length", "len", "substr", "substring", "concat", "replace", "left", "right", "split_part", "regexp_matches", "regexp_replace", "starts_with", "ends_with", "contains", "to_number", "to_varchar", "to_char",
]);
const SQL_WORDS = new Set(["and", "or", "not", "case", "when", "then", "else", "end", "as", "is", "null", "true", "false", "distinct", "in", "like", "ilike", "between", "interval", "date", "timestamp", "integer", "double", "varchar", "boolean", "cast", "try_cast", "coalesce", "nullif", "greatest", "least", "abs", "round", "floor", "ceil", "ceiling", "sqrt", "ln", "log", "exp", "power", "date_trunc", "date_part", "extract", "year", "month", "day", "week", "quarter", "epoch", "current_date", "now", "lower", "upper", "trim", "length", "substr", "substring", "concat", "regexp_matches", "filter", "where", "over", "if", "iff", "zeroifnull", "nvl", "to_number", "to_date", "datediff", "dateadd", "day_of_week", "dayofweek"]);

/** Problems with a proposal, in plain words; empty when it may be probed. */
export function proposalProblems(model: Model, p: MetricProposal): string[] {
  const out: string[] = [];
  if (!NAME.test(p.name)) out.push("Name: lowercase letters, digits and underscores, starting with a letter (up to 64).");
  if (model.metrics[p.name]) out.push(`There is already a metric called ${p.name}.`);
  if (!p.label.trim() || p.label.length > 200) out.push("Label: one to 200 characters.");
  const table = model.tables[p.baseTable];
  if (!table) { out.push(`No table called ${p.baseTable}.`); return out; }
  const columns = new Set(table.columns.map((c) => c.name.toLowerCase()));
  const check = (text: string, what: string) => {
    if (!text.trim()) { if (what === "Expression") out.push("Expression: say what to compute, for example SUM(fct_orders.amount)."); return; }
    if (text.length > 4000) out.push(`${what}: too long.`);
    if (FORBIDDEN.test(text)) out.push(`${what}: one aggregate over ${table.name}'s columns; no statements, subqueries, other tables or file reads.`);
    // Every table.column must be this table's own column; every bare identifier must be a column or a SQL word.
    const stripped = text.replace(/'(?:[^']|'')*'/g, "''");
    for (const m of stripped.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
      const fn = m[1].toLowerCase();
      if (!FUNCTIONS.has(fn) && !SQL_WORDS.has(fn)) out.push(`${what}: ${m[1]}() is not a function a metric may use. Aggregates (SUM, COUNT, AVG, MIN, MAX, COUNT(DISTINCT …), …), arithmetic, CASE, NULLIF, COALESCE, date and text functions are.`);
    }
    for (const m of stripped.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
      if (m[1].toLowerCase() !== table.name.toLowerCase()) out.push(`${what}: ${m[1]}.${m[2]} is not on ${table.name}; a metric aggregates one table, joins come from the model.`);
      else if (!columns.has(m[2].toLowerCase())) out.push(`${what}: ${table.name} has no column ${m[2]}.`);
    }
    const bare = stripped.replace(/[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*/g, " ");
    for (const m of bare.matchAll(/(?<![A-Za-z0-9_.])([A-Za-z_][A-Za-z0-9_]*)(?![A-Za-z0-9_]|\s*\()/g)) {
      const w = m[1].toLowerCase();
      if (SQL_WORDS.has(w) || columns.has(w) || /^\d/.test(w)) continue;
      out.push(`${what}: "${m[1]}" is not a column of ${table.name} (columns: ${table.columns.slice(0, 8).map((c) => c.name).join(", ")}${table.columns.length > 8 ? ", …" : ""}).`);
    }
  };
  check(p.expression, "Expression");
  if (p.expression.trim() && !AGGREGATE.test(p.expression)) out.push("Expression: a metric is an aggregate (SUM, COUNT, AVG, MIN, MAX, COUNT(DISTINCT …), …) over the table's columns.");
  if (p.filter) { check(p.filter, "Filter"); if (AGGREGATE.test(p.filter)) out.push("Filter: a row condition, not an aggregate (the aggregate goes in the expression)."); }
  if (p.description && p.description.length > 2000) out.push("Description: up to 2000 characters.");
  return [...new Set(out)];
}
