import YAML from "yaml";
import type { Proposal } from "./propose.ts";

/**
 * A reviewed proposal as a duckglue model file: the same format the sample
 * warehouse and every hand-written model use, so nothing downstream learns
 * the model was authored by a tool. Excluded tables, and joins or metrics
 * that name them, are left out.
 */
export function proposalToYaml(p: Proposal): string {
  const included = new Set(p.tables.filter((t) => t.include).map((t) => t.name));
  const tables: Record<string, unknown> = {};
  for (const t of p.tables) {
    if (!t.include) continue;
    tables[t.name] = {
      ...(t.description ? { description: t.description } : {}),
      grain: t.grain || "one row per (say what)",
      synonyms: t.synonyms,
      partition_keys: [],
      ...(t.primaryKey ? { primary_key: t.primaryKey } : {}),
      ...(t.reportingLag ? { reporting_lag: t.reportingLag } : {}),
      ...(t.timeColumn ? { default_date_column: t.timeColumn } : {}),
      columns: t.columns.map((c) => ({ name: c.name, type: c.type, ...(c.description ? { description: c.description } : {}) })),
    };
  }
  const joins = p.joins.filter((j) => j.include && included.has(j.left) && included.has(j.right))
    .map((j) => ({ left: j.left, left_on: j.leftOn, right: j.right, right_on: j.rightOn, type: j.type }));
  const metrics: Record<string, unknown> = {};
  for (const m of p.metrics) {
    if (!m.include || !included.has(m.baseTable)) continue;
    metrics[m.name] = { label: m.label, base_table: m.baseTable, expression: m.expression, ...(m.description ? { description: m.description } : {}) };
  }
  const doc = { model: { name: p.model.name, description: p.model.description }, tables, joins, metrics };
  return "# Authored in Semantic Canvas's Modeler from the warehouse catalogue. Edit freely; the Modeler never overwrites a published file without asking.\n" + YAML.stringify(doc, { lineWidth: 0 });
}

/** Problems that would make the file unloadable or the model dishonest; checked before publish. */
export function proposalIssues(p: Proposal): string[] {
  const issues: string[] = [];
  const included = p.tables.filter((t) => t.include);
  if (!included.length) issues.push("Include at least one table.");
  for (const t of included) {
    if (!t.grain.trim()) issues.push(`${t.name}: say what one row is (its grain).`);
    if (!/^[a-z][a-z0-9_]*$/i.test(t.name)) issues.push(`${t.name}: table names must be identifiers.`);
  }
  const names = new Set(included.map((t) => t.name));
  const metricNames = new Set<string>();
  for (const m of p.metrics.filter((m) => m.include && names.has(m.baseTable))) {
    if (!/^[a-z][a-z0-9_]*$/.test(m.name)) issues.push(`Metric "${m.name}": names are lowercase identifiers.`);
    if (metricNames.has(m.name)) issues.push(`Metric "${m.name}" is defined twice.`);
    metricNames.add(m.name);
    if (!m.label.trim()) issues.push(`Metric ${m.name}: needs a label.`);
    if (!m.expression.trim()) issues.push(`Metric ${m.name}: needs an expression.`);
    if (/;|--|\/\*/.test(m.expression)) issues.push(`Metric ${m.name}: the expression may not contain ; or comments.`);
  }
  if (!metricNames.size) issues.push("Include at least one metric.");
  return issues;
}
