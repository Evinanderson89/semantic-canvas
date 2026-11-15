import { readFile } from "node:fs/promises";
import YAML from "yaml";
import type { Model, SemanticAdapter } from "./model.ts";

/**
 * Snowflake semantic model adapter.
 *
 * Imports a restricted subset of Cortex Analyst / semantic-view YAML
 * (docs.snowflake.com/en/user-guide/views-semantic/semantic-view-yaml-spec).
 * No live connection is needed to read it; the connector executes compiled
 * SQL against physical tables, not the native semantic query service.
 *
 * Imports plain-column fields and table metrics. Computed fields, named
 * filters, non-additive rules, private access, variables, explicit metric
 * join paths, SQL-defined tables and top-level derived metrics fail with a
 * source error. Equality join keys/types and database/schema qualification
 * are preserved. Unsupported semantics must never be silently discarded.
 */
const BARE_COLUMN = /^[a-zA-Z_][a-zA-Z0-9_$]*$/;

function identifier(value: unknown, context: string): string {
  if (typeof value !== "string" || value.length > 256 || !BARE_COLUMN.test(value) || Object.hasOwn(Object.prototype, value))
    throw new Error(`Snowflake import: ${context} must be a supported unquoted identifier; received ${JSON.stringify(value)}`);
  return value;
}
function entries(value: unknown, context: string): any[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(entry => !entry || typeof entry !== "object" || Array.isArray(entry)))
    throw new Error(`Snowflake import: ${context} must be a list of definitions`);
  return value;
}
function unsupportedList(value: unknown, property: string, context: string) {
  if (value !== undefined && !(Array.isArray(value) && value.length === 0))
    throw new Error(`Snowflake import: ${property} on ${context} is not yet supported; its semantics cannot be preserved`);
}
function publicAccess(value: unknown, context: string) {
  if (value !== undefined && value !== "public_access")
    throw new Error(`Snowflake import: access_modifier ${String(value)} on ${context} is not yet supported; visibility cannot be preserved`);
}

/** Resolve bare fact references once. Replacing aliases one at a time can
 * rewrite a physical column introduced by an earlier replacement. SQL
 * literals/comments and already-qualified names are not fact references. */
function resolveFacts(expression: string, facts: Map<string, string>, physical: string): string {
  return expression.replace(/'(?:''|\\[\s\S]|[^'\\])*'|"(?:""|[^"])*"|--[^\n]*|\/\*[\s\S]*?\*\/|\$\$[\s\S]*?\$\$|[a-zA-Z_][a-zA-Z0-9_$]*/g, (token, offset: number) => {
    if (!facts.has(token.toUpperCase())) return token;
    const before = expression.slice(0, offset).trimEnd(), after = expression.slice(offset + token.length).trimStart();
    if (before.endsWith(".") || after.startsWith(".") || after.startsWith("(")) return token;
    return `${physical}.${facts.get(token.toUpperCase())}`;
  });
}

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

    unsupportedList(d.metrics, "top-level derived metrics", "the semantic model");
    unsupportedList(d.variables, "variables", "the semantic model");
    const tables: Model["tables"] = {};
    const metrics: Model["metrics"] = {};
    const joins: Model["joins"] = [];
    const logicalTables = new Map<string, string>();
    const physicalTables = new Set<string>();
    const metricNames = new Set<string>();
    for (const t of entries(d.tables, "tables")) {
      const logical = identifier(t.name, "logical table name");
      const physical = identifier(t.base_table?.table ?? logical, `physical table name for ${logical}`);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(physical))
        throw new Error(`Snowflake import: physical table name ${physical} is not a supported compiler identifier`);
      if (logicalTables.has(logical.toUpperCase())) throw new Error(`Snowflake import: duplicate logical table name ${logical}`);
      logicalTables.set(logical.toUpperCase(), physical);
      if (physicalTables.has(physical.toUpperCase())) throw new Error(`Snowflake import: duplicate physical table name ${physical}; distinct logical aliases are not yet supported`);
      physicalTables.add(physical.toUpperCase());
      if (t.base_table?.definition !== undefined)
        throw new Error(`Snowflake import: base_table.definition on ${logical} is not yet supported; a SQL-defined table cannot be replaced by a physical table`);
    }

    for (const t of d.tables) {
      const physical = t.base_table?.table ?? t.name;
      unsupportedList(t.filters, "named filters", t.name);
      // Fact name -> a queryable expression, so a metric that references a
      // fact by name can be resolved to something the compiler can run.
      const factExpr = new Map<string, string>();
      const columns: Model["tables"][string]["columns"] = [];
      const fieldNames = new Set<string>();

      const addField = (f: any) => {
        const name = identifier(f.name, `field name on ${t.name}`);
        if (fieldNames.has(name.toUpperCase())) throw new Error(`Snowflake import: duplicate field name ${t.name}.${name}`);
        fieldNames.add(name.toUpperCase());
        publicAccess(f.access_modifier, `${t.name}.${name}`);
        if (f.labels !== undefined && (!Array.isArray(f.labels) || f.labels.includes("filter")))
          throw new Error(`Snowflake import: filter labels on ${t.name}.${name} are not yet supported`);
        const expr = String(f.expr ?? "");
        if (!BARE_COLUMN.test(expr)) throw new Error(`Snowflake import: computed field ${t.name}.${f.name} is not yet supported (${expr})`);
        if (columns.some((c) => c.name === expr)) return expr;
        columns.push({ name: expr, description: (f.description ?? "").trim(),
                       type: String(f.data_type ?? "string").toLowerCase() });
        return expr;
      };
      for (const dim of entries(t.dimensions, `${t.name}.dimensions`)) addField(dim);
      for (const dim of entries(t.time_dimensions, `${t.name}.time_dimensions`)) addField(dim);
      for (const f of entries(t.facts, `${t.name}.facts`)) {
        const expr = addField(f);
        if (expr) factExpr.set(f.name.toUpperCase(), expr);
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
      for (const m of entries(t.metrics, `${t.name}.metrics`)) {
        const name = identifier(m.name, `metric name on ${t.name}`);
        if (metricNames.has(name.toUpperCase()))
          throw new Error(`Snowflake import: duplicate metric name ${m.name} on ${t.name}; metric names must be unique across all tables`);
        metricNames.add(name.toUpperCase());
        publicAccess(m.access_modifier, `${t.name}.${name}`);
        unsupportedList(m.non_additive_dimensions, "non_additive_dimensions", `${t.name}.${name}`);
        unsupportedList(m.using_relationships, "using_relationships", `${t.name}.${name}`);
        if (typeof m.expr !== "string" || !m.expr.trim()) throw new Error(`Snowflake import: metric ${m.name} requires a SQL expression string`);
        let expr = m.expr;
        expr = resolveFacts(expr, factExpr, physical);
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
    const physicalOf = (semanticName: string) => {
      const name = identifier(semanticName, "relationship table name"), physical = logicalTables.get(name.toUpperCase());
      if (!physical) throw new Error(`Snowflake import: unknown relationship table ${name}`);
      return physical;
    };
    for (const r of entries(d.relationships, "relationships")) {
      const left = physicalOf(r.left_table);
      const right = physicalOf(r.right_table);
      const resolveColumn = (table: string, column: string) => {
        const definition = d.tables.find((t: any) => t.name.toUpperCase() === table.toUpperCase());
        const fields = [...definition?.dimensions ?? [], ...definition?.time_dimensions ?? [], ...definition?.facts ?? []];
        return fields.find((f: any) => typeof column === "string" && f.name.toUpperCase() === column.toUpperCase())?.expr ?? column;
      };
      if (r.relationship_type && !["many_to_one", "one_to_one"].includes(r.relationship_type))
        throw new Error(`Snowflake import: unsupported relationship cardinality ${r.relationship_type}`);
      if (r.join_type && !["left_outer", "left", "inner"].includes(r.join_type))
        throw new Error(`Snowflake import: unsupported join type ${r.join_type}`);
      const columns = entries(r.relationship_columns, `${r.name}.relationship_columns`).map((c: any) => {
        if (c.type !== undefined || c.right_range !== undefined)
          throw new Error(`Snowflake import: ${c.type ?? "range"} relationship columns on ${r.name} are not yet supported; only equality joins can be preserved`);
        return { left: resolveColumn(r.left_table, c.left_column), right: resolveColumn(r.right_table, c.right_column) };
      });
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
