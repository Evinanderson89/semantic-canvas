import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Model, SemanticAdapter } from "./model.ts";

/**
 * dbt adapter.
 *
 * Reads dbt's own artifacts rather than asking anyone to re-declare their model:
 *   semantic_manifest.json -> metrics, entities, dimensions (dbt Semantic Layer)
 *   manifest.json          -> table and column definitions, plus descriptions
 *
 * Point MODEL_PATH at a dbt target/ directory and the same compiler, canvas and
 * row-level security run unchanged -- which is the whole reason adapters exist.
 */
export const dbtAdapter: SemanticAdapter = {
  id: "dbt",
  label: "dbt (semantic manifest)",

  async load(source: string): Promise<Model | null> {
    const dir = source.endsWith(".json") ? source.replace(/\/[^/]+$/, "") : source;
    const sem = await readJson(join(dir, "semantic_manifest.json"));
    const man = await readJson(join(dir, "manifest.json"));
    if (!sem && !man) return null;

    const tables: Model["tables"] = {};
    const joins: Model["joins"] = [];

    // Columns and descriptions come from the compile manifest.
    for (const node of Object.values<any>(man?.nodes ?? {})) {
      if (node.resource_type !== "model") continue;
      tables[node.name] = {
        name: node.name,
        description: (node.description ?? "").trim(),
        grain: "",
        synonyms: node.tags ?? [],
        partitionKeys: [],
        primaryKey: null,
        columns: Object.values<any>(node.columns ?? {}).map((c) => ({
          name: c.name, type: (c.data_type ?? "string").toLowerCase(),
          description: (c.description ?? "").trim(),
        })),
      };
    }

    // Semantic models carry grain, dimensions and the entities that imply joins.
    const entityOwners = new Map<string, { table: string; column: string }[]>();
    for (const sm of sem?.semantic_models ?? []) {
      const table = sm.node_relation?.alias ?? sm.name;
      const t = (tables[table] ??= {
        name: table, description: (sm.description ?? "").trim(), grain: "",
        synonyms: [], partitionKeys: [], primaryKey: null, columns: [],
      });
      t.grain = sm.description?.trim() || t.grain;
      for (const d of sm.dimensions ?? []) {
        if (!t.columns.some((c) => c.name === d.name))
          t.columns.push({ name: d.name, type: d.type === "time" ? "date" : "string",
                           description: (d.description ?? "").trim() });
        if (d.type === "time" && d.type_params?.time_granularity) t.partitionKeys.push(d.name);
      }
      for (const e of sm.entities ?? []) {
        const col = e.expr ?? e.name;
        if (!t.columns.some((c) => c.name === col))
          t.columns.push({ name: col, type: "string" });
        if (e.type === "primary" || e.type === "unique") t.primaryKey = col;
        const list = entityOwners.get(e.name) ?? [];
        list.push({ table, column: col });
        entityOwners.set(e.name, list);
      }
    }

    // A shared entity is dbt's join: foreign side -> primary side.
    for (const [entity, owners] of entityOwners) {
      const primary = owners.find((o) => tables[o.table]?.primaryKey === o.column);
      if (!primary) continue;
      for (const o of owners) {
        if (o.table === primary.table) continue;
        joins.push({ left: o.table, leftOn: o.column,
                     right: primary.table, rightOn: primary.column, type: "left" });
      }
      void entity;
    }

    const metrics: Model["metrics"] = {};
    for (const m of sem?.metrics ?? []) {
      const measure = m.type_params?.measure?.name ?? m.type_params?.numerator?.name;
      const owner = (sem.semantic_models ?? []).find((sm: any) =>
        (sm.measures ?? []).some((x: any) => x.name === measure));
      const base = owner?.node_relation?.alias ?? owner?.name;
      if (!base) continue;
      const spec = (owner.measures ?? []).find((x: any) => x.name === measure);
      const agg = String(spec?.agg ?? "sum").toUpperCase();
      const expr = spec?.expr ?? measure;
      metrics[m.name] = {
        name: m.name,
        label: m.label ?? m.name,
        description: (m.description ?? "").trim(),
        baseTable: base,
        expression: agg === "COUNT_DISTINCT"
          ? `COUNT(DISTINCT ${base}.${expr})` : `${agg}(${base}.${expr})`,
        filter: m.filter?.where_filters?.[0]?.where_sql_template
          ?.replace(/\{\{\s*Dimension\(['"]([^'"]+)['"]\)\s*\}\}/g,
                    (_: string, d: string) => `${base}.${d.split("__").pop()}`) ?? null,
        synonyms: m.meta?.synonyms ?? [],
      };
    }

    if (!Object.keys(metrics).length) return null;
    return {
      source: "dbt",
      name: sem?.project_configuration?.project_name ?? man?.metadata?.project_name ?? "dbt project",
      description: "Imported from dbt semantic manifest.",
      tables, metrics, joins,
    };
  },
};

async function readJson(path: string): Promise<any | null> {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; }
}
