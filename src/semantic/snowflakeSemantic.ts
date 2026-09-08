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
 * Imports plain-column fields and table metrics. Computed fields, named
 * filters and top-level derived metrics fail with a source error instead
 * of silently changing the semantic model. Composite join keys, join types
 * and database/schema qualification are preserved.

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

    if (d.metrics?.length) throw new Error("Snowflake import does not yet support top-level derived metrics; use a model with table-level metrics");
    const tables: Model["tables"] = {};
    const metrics: Model["metrics"] = {};
    const joins: Model["joins"] = [];

    for (const t of d.tables) {
      const physical = t.base_table?.table ?? t.name;
      if (tables[physical]) throw new Error(`Snowflake import: duplicate physical table name ${physical}; distinct logical aliases are not yet supported`);
      if (t.filters?.length) throw new Error(`Snowflake import: named filters on ${t.name} are not yet supported`);
      // Fact name -> a queryable expression, so a metric that references a
      // fact by name can be resolved to something the compiler can run.
      const factExpr = new Map<string, string>();
      const columns: Model["tables"][string]["columns"] = [];

      const addField = (f: any) => {
        const expr = String(f.expr ?? "");
        if (!BARE_COLUMN.test(expr)) throw new Error(`Snowflake import: computed field ${t.name}.${f.name} is not yet supported (${expr})`);
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
        relation: { database: t.base_table?.database, schema: t.base_table?.schema, table: physical },
        description: (t.description ?? "").trim(),
        grain: t.primary_key?.columns?.length
          ? `one row per ${t.primary_key.columns.join(", ")}` : "",
        synonyms: [],
        partitionKeys: [],
        primaryKey: t.primary_key?.columns?.length === 1 ? t.primary_key.columns[0] : null,
        columns,
      };

      // A table-level metric's expr references facts by their semantic name
      // ("SUM(order_amount)"); resolve each to physical_table.column so the
      // expression is valid dropped straight into a query on its own.
      for (const m of t.metrics ?? []) {
        let expr = String(m.expr ?? "");
        if (!expr) throw new Error(`Snowflake import: metric ${m.name} has no expression`);
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
      const resolveColumn = (table: string, column: string) => {
        const definition = d.tables.find((t: any) => t.name === table);
        const fields = [...definition?.dimensions ?? [], ...definition?.time_dimensions ?? [], ...definition?.facts ?? []];
        return fields.find((f: any) => f.name === column)?.expr ?? column;
      };
      if (r.relationship_type && !["many_to_one", "one_to_one"].includes(r.relationship_type))
        throw new Error(`Snowflake import: unsupported relationship cardinality ${r.relationship_type}`);
      if (r.join_type && !["left_outer", "left", "inner"].includes(r.join_type))
        throw new Error(`Snowflake import: unsupported join type ${r.join_type}`);
      const columns = (r.relationship_columns ?? []).map((c: any) => ({
        left: resolveColumn(r.left_table, c.left_column), right: resolveColumn(r.right_table, c.right_column),
      }));
      if (!columns.length || columns.some((c: any) => !BARE_COLUMN.test(c.left ?? "") || !BARE_COLUMN.test(c.right ?? "")))
        throw new Error(`Snowflake import: invalid relationship ${r.name}`);
      joins.push({ left, leftOn: columns[0].left, right, rightOn: columns[0].right,
        type: r.join_type === "inner" ? "inner" : "left", ...(columns.length > 1 ? { columns } : {}) });
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
