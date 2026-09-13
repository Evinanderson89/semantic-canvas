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

/**
 * A reviewed extension as the file merged over a base model (src/sources/extensions.ts):
 * only what is new (tables, joins between them or to base tables, gap metrics)
 * and, for base tables, a reporting lag. Nothing the base model owns is repeated.
 */
export function proposalToExtension(p: Proposal, origin?: { by: string; at: string }): string {
  const stamp = origin ? { origin: { kind: "modeler", by: origin.by, at: origin.at, published_by: origin.by, published_at: origin.at } } : {};
  const newTables = new Set(p.tables.filter((t) => t.include && t.status !== "existing").map((t) => t.name));
  const present = new Set([...newTables, ...p.tables.filter((t) => t.status === "existing").map((t) => t.name)]);
  const tables: Record<string, unknown> = {};
  for (const t of p.tables) {
    if (!newTables.has(t.name)) continue;
    tables[t.name] = {
      ...(t.description ? { description: t.description } : {}), grain: t.grain || "one row per (say what)", synonyms: t.synonyms,
      ...(t.primaryKey ? { primary_key: t.primaryKey } : {}), ...(t.reportingLag ? { reporting_lag: t.reportingLag } : {}), ...(t.timeColumn ? { default_date_column: t.timeColumn } : {}),
      columns: t.columns.map((c) => ({ name: c.name, type: c.type, ...(c.description ? { description: c.description } : {}) })),
      ...stamp,
    };
  }
  const patches: Record<string, unknown> = {};
  for (const t of p.tables) if (t.status === "existing" && t.reportingLag !== undefined && t.reportingLag !== null) patches[t.name] = { reporting_lag: t.reportingLag };
  const joins = p.joins.filter((j) => j.include && j.status !== "existing" && present.has(j.left) && present.has(j.right))
    .map((j) => ({ left: j.left, left_on: j.leftOn, right: j.right, right_on: j.rightOn, type: j.type }));
  const metrics: Record<string, unknown> = {};
  for (const m of p.metrics) if (m.include && present.has(m.baseTable)) metrics[m.name] = { label: m.label, base_table: m.baseTable, expression: m.expression, ...(m.description ? { description: m.description } : {}), ...stamp };
  return `# Added in Semantic Canvas's Modeler to the model of source ${p.extends ?? "?"}. The base model file is never edited; this file is merged over it.
` + YAML.stringify({ tables, joins, metrics, patches }, { lineWidth: 0 });
}

/** Problems that would make the file unloadable or the model dishonest; checked before publish. */
export function proposalIssues(p: Proposal): string[] {
  if (p.extends) return extensionIssues(p);
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

function extensionIssues(p: Proposal): string[] {
  const issues: string[] = [];
  const newTables = p.tables.filter((t) => t.include && t.status !== "existing");
  const present = new Set([...newTables.map((t) => t.name), ...p.tables.filter((t) => t.status === "existing").map((t) => t.name)]);
  for (const t of newTables) if (!t.grain.trim()) issues.push(`${t.name}: say what one row is (its grain).`);
  const names = new Set<string>();
  const metrics = p.metrics.filter((m) => m.include && present.has(m.baseTable));
  for (const m of metrics) {
    if (!/^[a-z][a-z0-9_]*$/.test(m.name)) issues.push(`Metric "${m.name}": names are lowercase identifiers.`);
    if (names.has(m.name)) issues.push(`Metric "${m.name}" is defined twice.`);
    names.add(m.name);
    if (!m.label.trim()) issues.push(`Metric ${m.name}: needs a label.`);
    if (/;|--|\/\*/.test(m.expression)) issues.push(`Metric ${m.name}: the expression may not contain ; or comments.`);
  }
  const joins = p.joins.filter((j) => j.include && j.status !== "existing");
  const patches = p.tables.filter((t) => t.status === "existing" && t.reportingLag !== undefined && t.reportingLag !== null);
  if (!newTables.length && !metrics.length && !joins.length && !patches.length) issues.push("Nothing to add: include a table, a join, a metric, or set a reporting lag on a modelled table.");
  return issues;
}
