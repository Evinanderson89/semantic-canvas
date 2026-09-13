import type { CatalogTable } from "../connectors/types.ts";
import type { Model } from "../semantic/model.ts";
import { normalizeType, type Proposal, type ProposedMetric } from "./propose.ts";

/**
 * Extending a model that already exists (docs/modeler.md, "Extend"): the
 * warehouse is read exactly as for a new model, then the proposal is
 * diffed against the loaded model. What the model already declares is
 * marked `existing` and never written; what it lacks is marked `new`;
 * metrics the data suggests for a modelled table are `gap` suggestions,
 * off by default unless the table has no metric at all. Publishing writes
 * an extension file beside the base model, so a dbt project or a
 * Snowflake semantic view is never edited.
 *
 * Drift is the other half: what the model declares that the warehouse no
 * longer has, or has with another type, and which metrics and dashboards
 * that breaks. It needs only the catalogue, so it runs any time.
 */
export type ItemStatus = "new" | "existing" | "gap";

export interface DriftFinding {
  table: string;
  column: string | null;
  kind: "table_missing" | "column_missing" | "type_changed";
  declared: string | null;
  actual: string | null;
  /** Metrics whose expression or filter names the column (or any metric on a missing table). */
  metrics: string[];
  text: string;
}

const ident = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Metrics that touch `table.column`, or `column` unqualified on their own base table. */
export function metricsUsing(model: Model, table: string, column: string | null): string[] {
  return Object.values(model.metrics).filter((m) => {
    if (column === null) return m.baseTable === table;
    const text = `${m.expression} ${m.filter ?? ""}`;
    const qualified = new RegExp(`\\b${ident(table)}\\.${ident(column)}\\b`);
    const bare = new RegExp(`(^|[^.\\w])${ident(column)}\\b`);
    return qualified.test(text) || (m.baseTable === table && bare.test(text));
  }).map((m) => m.name).sort();
}

/** Compare what the model declares with what the warehouse has. Base-model and extension tables only; Ingest's connected tables have their own lifecycle. */
export function driftOf(model: Model, catalog: CatalogTable[]): DriftFinding[] {
  const byName = new Map(catalog.map((t) => [t.name.toLowerCase(), t]));
  const out: DriftFinding[] = [];
  for (const t of Object.values(model.tables)) {
    if (t.connected) continue;
    const physical = (t.relation?.table ?? t.name).toLowerCase();
    const live = byName.get(physical);
    if (!live) {
      const metrics = metricsUsing(model, t.name, null);
      out.push({ table: t.name, column: null, kind: "table_missing", declared: null, actual: null, metrics, text: `${t.name} is in the model but not in the warehouse${metrics.length ? `; ${metrics.length} metric${metrics.length === 1 ? "" : "s"} (${metrics.join(", ")}) cannot run` : ""}.` });
      continue;
    }
    const liveCols = new Map(live.columns.map((c) => [c.name.toLowerCase(), c]));
    for (const c of t.columns) {
      if (c.name.startsWith("_")) continue;
      const lc = liveCols.get(c.name.toLowerCase());
      const metrics = metricsUsing(model, t.name, c.name);
      if (!lc) {
        out.push({ table: t.name, column: c.name, kind: "column_missing", declared: c.type, actual: null, metrics, text: `${t.name}.${c.name} is gone from the warehouse${metrics.length ? `; ${metrics.join(", ")} break${metrics.length === 1 ? "s" : ""}` : ""}.` });
        continue;
      }
      const declared = normalizeType(c.type), actual = normalizeType(lc.type);
      if (declared !== actual && declared !== "other" && actual !== "other" && !(declared === "integer" && actual === "double")) {
        out.push({ table: t.name, column: c.name, kind: "type_changed", declared: c.type, actual: lc.type, metrics, text: `${t.name}.${c.name} is ${lc.type} in the warehouse, ${c.type} in the model${metrics.length ? `; check ${metrics.join(", ")}` : ""}.` });
      }
    }
  }
  return out;
}

/** Whether the model already declares this join, in either direction. */
function joinKnown(model: Model, j: { left: string; leftOn: string; right: string; rightOn: string }): boolean {
  return model.joins.some((k) =>
    (k.left === j.left && k.leftOn === j.leftOn && k.right === j.right && k.rightOn === j.rightOn) ||
    (k.left === j.right && k.leftOn === j.rightOn && k.right === j.left && k.rightOn === j.leftOn));
}

const columnsIn = (expression: string) => new Set([...expression.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => `${m[1]}.${m[2]}`));

/**
 * Annotate a fresh proposal with what the model already has. Tables and
 * joins the model declares become `existing` (kept for context, never
 * written); a modelled table's proposed metrics become `gap` suggestions
 * unless the model has no metric on that table at all.
 */
export function extendProposal(p: Proposal, model: Model, extendsSource: string): Proposal {
  const known = new Set(Object.keys(model.tables));
  const metricsByTable = new Map<string, Set<string>>();
  const norm = (e: string) => e.replace(/\s+/g, "").toLowerCase();
  for (const m of Object.values(model.metrics)) {
    const cols = columnsIn(`${m.expression} ${m.filter ?? ""}`);
    const set = metricsByTable.get(m.baseTable) ?? new Set<string>();
    for (const c of cols) set.add(c);
    set.add("*"); // the table has at least one metric
    set.add(`expr:${norm(m.expression)}`);
    metricsByTable.set(m.baseTable, set);
  }
  const tables = p.tables.map((t) => {
    if (!known.has(t.name)) return { ...t, status: "new" as const };
    const declared = model.tables[t.name];
    // An existing table keeps what the model says; only a reporting lag may be added to it here.
    return { ...t, status: "existing" as const, include: false, grain: declared.grain || t.grain, description: declared.description ?? "", primaryKey: declared.primaryKey ?? t.primaryKey,
      reportingLag: declared.reportingLagDays, evidence: declared.reportingLagDays === undefined && t.kind === "fact" ? `In the model. No reporting lag declared: the data-honesty review cannot tell a settling ${t.timeColumn ? "period" : "table"} from a stale one; say how many days after a period its rows are all in.` : "In the model." };
  });
  const included = new Set(tables.filter((t) => t.include || t.status === "existing").map((t) => t.name));
  const joins = p.joins.map((j) => {
    if (joinKnown(model, j)) return { ...j, status: "existing" as const, include: false, evidence: `In the model. ${j.evidence}` };
    const bothKnown = known.has(j.left) && known.has(j.right);
    return { ...j, status: "new" as const, include: j.include && included.has(j.left) && included.has(j.right), evidence: bothKnown ? `Not in the model, though both tables are: ${j.evidence}` : j.evidence };
  });
  const metrics: ProposedMetric[] = p.metrics.flatMap((m): ProposedMetric[] => {
    if (!known.has(m.baseTable)) return [{ ...m, status: "new" as const }];
    if (model.metrics[m.name]) return [];
    const used = metricsByTable.get(m.baseTable);
    const cols = [...columnsIn(m.expression)];
    if (used?.has(`expr:${norm(m.expression)}`)) return []; // the same aggregate exists under another name
    if (cols.length && used && cols.every((c) => used.has(c))) return []; // a metric on that column exists already
    const none = !used;
    return [{ ...m, status: "gap" as const, include: none && m.include, evidence: none ? `${m.baseTable} has no metric in the model. ${m.evidence}` : `The model has no metric on this column. ${m.evidence}` }];
  });
  const warnings = p.warnings.filter((w) => !tables.some((t) => t.status === "existing" && (w.startsWith(`${t.name}:`) || w.startsWith(`${t.name} `))));
  const counts = { tables: tables.filter((t) => t.status === "new").length, joins: joins.filter((j) => j.status === "new").length, metrics: metrics.filter((m) => m.status === "gap").length };
  return {
    ...p, tables, joins, metrics, warnings, extends: extendsSource,
    model: { ...p.model, description: `What ${extendsSource} is missing: ${counts.tables} table${counts.tables === 1 ? "" : "s"} not in the model, ${counts.joins} undeclared join${counts.joins === 1 ? "" : "s"}, ${counts.metrics} metric suggestion${counts.metrics === 1 ? "" : "s"}. Nothing the model already says is changed.` },
  };
}
