import { readFile } from "node:fs/promises";
import YAML from "yaml";
import type { Model, SemanticAdapter } from "./model.ts";

/**
 * duckglue: a single YAML file describing tables, joins and metrics.
 * The shape is close to our internal model, so this adapter is mostly renaming.
 */
export const duckglueAdapter: SemanticAdapter = {
  id: "duckglue",
  label: "duckglue (YAML)",

  async load(source: string): Promise<Model | null> {
    let raw: string;
    try {
      raw = await readFile(source, "utf8");
    } catch {
      return null;
    }
    const d: any = YAML.parse(raw);
    if (!d?.tables || !d?.metrics) return null;

    const tables: Model["tables"] = {};
    for (const [name, t] of Object.entries<any>(d.tables)) {
      tables[name] = {
        name,
        description: (t.description ?? "").trim(),
        grain: t.grain ?? "",
        synonyms: t.synonyms ?? [],
        partitionKeys: t.partition_keys ?? [],
        primaryKey: t.primary_key ?? null,
        columns: (t.columns ?? []).map((c: any) => ({
          name: c.name, type: c.type, description: c.description,
        })),
      };
    }

    const metrics: Model["metrics"] = {};
    for (const [name, m] of Object.entries<any>(d.metrics)) {
      metrics[name] = {
        name,
        label: m.label ?? name,
        description: (m.description ?? "").trim(),
        baseTable: m.base_table,
        expression: m.expression,
        filter: m.filter ?? null,
        synonyms: m.synonyms ?? [],
      };
    }

    return {
      source: "duckglue",
      name: d.model?.name ?? "warehouse",
      description: (d.model?.description ?? "").trim(),
      tables,
      metrics,
      joins: (d.joins ?? []).map((j: any) => ({
        left: j.left, leftOn: j.left_on, right: j.right, rightOn: j.right_on,
        type: j.type ?? "left",
      })),
    };
  },
};
