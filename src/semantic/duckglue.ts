import { readFile } from "node:fs/promises";
import YAML from "yaml";
import { z } from "zod";
import type { Model, SemanticAdapter, Table, TimeGrain } from "./model.ts";

/** Restricted grains only make sense on a date column of the metric's own base table. Shared with the connected overlay. */
export function timeDimensionIssue(name: string, base: string, table: Table | undefined, timeGrains: TimeGrain[] | undefined, timeDimension: unknown): string | null {
  if (!timeGrains) return null;
  return typeof timeDimension === "string" && timeDimension.startsWith(`${base}.`) && table?.columns.some(c => `${base}.${c.name}` === timeDimension && /date|timestamp/i.test(c.type))
    ? null : `Metric ${name}: time_grains requires a date time_dimension on its base table`;
}

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
        reportingLagDays: t.reporting_lag === undefined ? undefined
          : z.number().int().min(0).max(365, `Table ${name}: reporting_lag is days after a period ends, 0 to 365`).parse(t.reporting_lag),
        columns: (t.columns ?? []).map((c: any) => ({
          name: c.name, type: c.type, description: c.description,
        })),
      };
    }

    const metrics: Model["metrics"] = {};
    for (const [name, m] of Object.entries<any>(d.metrics)) {
      const timeGrains = m.time_grains === undefined ? undefined : z.array(z.enum(["day", "week", "month", "quarter", "year"])).min(1).parse(m.time_grains);
      const timeDimension = m.time_dimension;
      const issue = timeDimensionIssue(name, m.base_table, tables[m.base_table], timeGrains, timeDimension);
      if (issue) throw new Error(issue);
      metrics[name] = {
        name,
        label: m.label ?? name,
        description: (m.description ?? "").trim(),
        baseTable: m.base_table,
        expression: m.expression,
        timeGrains, timeDimension,
        direction: m.direction === undefined ? undefined : z.enum(["higher", "lower", "neutral"]).parse(m.direction),
        importance: m.importance === undefined ? undefined : z.number().min(0).max(100).parse(m.importance),
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
