import { readFile } from "node:fs/promises";
import YAML from "yaml";
import type { Model, SemanticAdapter } from "./model.ts";

/**
 * Snowflake semantic model adapter.
 *
 * Reads the YAML spec Snowflake uses for both a standalone Cortex Analyst
 * semantic model file and a `CREATE SEMANTIC VIEW ... AS` definition --
 * they're the same shape (docs.snowflake.com/en/user-guide/views-semantic/
 * semantic-view-yaml-spec). Point `model` at that file; no live connection
 * is needed to read it; the Snowflake connector executes the resulting SQL.
 *
 * A dimension, time dimension or fact whose `expr` is not a bare column
 * reference is skipped, not mistranslated. This project's Column is just
 * `table.column` -- there's nowhere to put a computed expression -- so a
 * genuinely computed field has nothing faithful to become here. Most real
 * semantic models are plain-column for the overwhelming majority of fields;
 * the exceptions need a richer Model.Column (not yet built) or a duckglue/dbt
 * model instead. Cross-table derived metrics (top-level `metrics`, using
 * `using_relationships`) and named table-level `filters` are out of scope for
 * the same reason -- both need expression machinery this Model doesn't have.
 */
const BARE_COLUMN = /^[a-zA-Z_][a-zA-Z0-9_$]*$/;

export const snowflakeSemanticAdapter: SemanticAdapter = {
  id: "snowflake-semantic",
  label: "Snowflake semantic model (Cortex Analyst)",

  async load(source: string): Promise<Model | null> {
    let raw: string;
    try {
      raw = await readFile(source, "utf8");
    } catch {
      return null;
    }
    let d: any;
    try {
      d = YAML.parse(raw);
    } catch {
      return null;
    }
    if (!Array.isArray(d?.tables) || d.tables.length === 0) return null;

    const tables: Model["tables"] = {};
    const metrics: Model["metrics"] = {};
    const joins: Model["joins"] = [];

    for (const t of d.tables) {
      const physical = t.base_table?.table ?? t.name;
      // Fact name -> a queryable expression, so a metric that references a
      // fact by name can be resolved to something the compiler can run.
      const factExpr = new Map<string, string>();
      const columns: Model["tables"][string]["columns"] = [];

      const addField = (f: any) => {
        const expr = String(f.expr ?? "");
        if (!BARE_COLUMN.test(expr)) return;
        if (columns.some((c) => c.name === expr)) return;
        columns.push({ name: expr, description: (f.description ?? "").trim(),
                       type: String(f.data_type ?? "string").toLowerCase() });
        return expr;
      };
      for (const dim of t.dimensions ?? []) addField(dim);
      for (const dim of t.time_dimensions ?? []) addField(dim);
      for (const f of t.facts ?? []) {
        const expr = addField(f);
        if (expr) factExpr.set(f.name, expr);
      }

      tables[physical] = {
        name: physical,
        description: (t.description ?? "").trim(),
        grain: t.primary_key?.columns?.length
          ? `one row per ${t.primary_key.columns.join(", ")}` : "",
        synonyms: [],
        partitionKeys: [],
        primaryKey: t.primary_key?.columns?.[0] ?? null,
        columns,
      };

      // A table-level metric's expr references facts by their semantic name
      // ("SUM(order_amount)"); resolve each to physical_table.column so the
      // expression is valid dropped straight into a query on its own.
      for (const m of t.metrics ?? []) {
        let expr = String(m.expr ?? "");
        if (!expr) continue;
        for (const [factName, colExpr] of factExpr) {
          expr = expr.replace(new RegExp(`\\b${factName}\\b`, "g"), `${physical}.${colExpr}`);
        }
        metrics[m.name] = {
          name: m.name, label: m.name,
          description: (m.description ?? "").trim(),
          baseTable: physical, expression: expr, filter: null,
          synonyms: m.synonyms ?? [],
        };
      }
    }

    // Relationships name tables by their semantic name, not the physical one
    // tables[] is keyed by -- resolve through the original list.
    const physicalOf = (semanticName: string) =>
      d.tables.find((t: any) => t.name === semanticName)?.base_table?.table ?? semanticName;
    for (const r of d.relationships ?? []) {
      const left = physicalOf(r.left_table);
      const right = physicalOf(r.right_table);
      for (const c of r.relationship_columns ?? []) {
        if (!c.left_column || !c.right_column) continue;
        joins.push({ left, leftOn: c.left_column, right, rightOn: c.right_column, type: "left" });
      }
    }

    if (!Object.keys(metrics).length) return null;
    return {
      source: "snowflake-semantic",
      name: d.name ?? "Snowflake semantic model",
      description: (d.description ?? "").trim(),
      tables, metrics, joins,
    };
  },
};
