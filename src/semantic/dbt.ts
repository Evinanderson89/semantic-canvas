import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { computedMetricIssue, metricComponents, type Model, type SemanticAdapter } from "./model.ts";

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
      t.relation = { database: sm.node_relation?.database, schema: sm.node_relation?.schema_name, table };
      t.grain = sm.description?.trim() || t.grain;
      for (const d of sm.dimensions ?? []) {
        if (d.expr && d.expr !== d.name) throw new Error(`dbt import: dimension expression ${sm.name}.${d.name} is not yet supported`);
        if (!t.columns.some((c) => c.name === d.name))
          t.columns.push({ name: d.name, type: d.type === "time" ? "date" : "string",
                           description: (d.description ?? "").trim() });
        if (d.type === "time" && d.type_params?.time_granularity) t.partitionKeys.push(d.name);
      }
      for (const e of sm.entities ?? []) {
        const col = e.expr ?? e.name;
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(col)) throw new Error(`dbt import: entity expression ${e.name} is not supported`);
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
    const declaredMetricNames = new Set<string>((sem?.metrics ?? []).map((m: any) => String(m.name)));
    const resolveMeasureSpec = (measure: string | undefined, metricName: string) => {
      const owner = (sem?.semantic_models ?? []).find((sm: any) =>
        (sm.measures ?? []).some((x: any) => x.name === measure));
      const base = owner?.node_relation?.alias ?? owner?.name;
      if (!base) throw new Error(`dbt import: measure ${measure} for metric ${metricName} could not be resolved`);
      const spec = (owner.measures ?? []).find((x: any) => x.name === measure);
      const aggregation: Record<string, string> = { sum: "SUM", count: "COUNT", count_distinct: "COUNT_DISTINCT", min: "MIN", max: "MAX", average: "AVG" };
      const agg = aggregation[spec?.agg];
      if (!agg || spec?.non_additive_dimension || spec?.agg_params || spec?.filter)
        throw new Error(`dbt import: measure ${measure} uses unsupported aggregation semantics`);
      const expr = spec?.expr ?? measure;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(expr) && !(agg === "COUNT" && String(expr) === "1"))
        throw new Error(`dbt import: measure expression for ${measure} is not a supported column reference`);
      const ref = String(expr) === "1" ? "1" : `${base}.${expr}`;
      return {
        baseTable: base,
        expression: agg === "COUNT_DISTINCT"
          ? `COUNT(DISTINCT ${ref})` : `${agg}(${ref})`,
      };
    };

    const resolveOrSynthesizeSimpleMetric = (refName: string, metricName: string): string => {
      if (metrics[refName] && (metrics[refName].type ?? "simple") === "simple") {
        return refName;
      }
      if (!declaredMetricNames.has(refName)) {
        const resolved = resolveMeasureSpec(refName, metricName);
        metrics[refName] = {
          name: refName,
          label: refName,
          description: "",
          baseTable: resolved.baseTable,
          expression: resolved.expression,
          filter: null,
          synonyms: [],
        };
        return refName;
      }
      const hasMeasure = (sem?.semantic_models ?? []).some((sm: any) =>
        (sm.measures ?? []).some((x: any) => x.name === refName));
      if (hasMeasure && !metrics[refName]) {
        const synthName = `__measure_${refName}`;
        if (!metrics[synthName]) {
          const resolved = resolveMeasureSpec(refName, metricName);
          metrics[synthName] = {
            name: synthName,
            label: refName,
            description: "",
            baseTable: resolved.baseTable,
            expression: resolved.expression,
            filter: null,
            synonyms: [],
          };
        }
        return synthName;
      }
      return refName;
    };

    // First pass: resolve all simple metrics.
    for (const m of sem?.metrics ?? []) {
      if (m.type !== "simple") continue;
      if (m.filter?.where_filters?.length || m.type_params?.measure?.filter)
        throw new Error(`dbt import: filters on metric ${m.name} are not yet supported`);
      const measure = typeof m.type_params?.measure === "string" ? m.type_params.measure : m.type_params?.measure?.name;
      const resolved = resolveMeasureSpec(measure, m.name);
      metrics[m.name] = {
        name: m.name,
        label: m.label ?? m.name,
        description: (m.description ?? "").trim(),
        baseTable: resolved.baseTable,
        expression: resolved.expression,
        filter: null,
        synonyms: m.meta?.synonyms ?? [],
      };
    }

    const draft: Model = { source: "dbt", name: "", tables, metrics, joins };

    // Second pass: resolve ratio, derived, and cumulative metrics.
    for (const m of sem?.metrics ?? []) {
      if (m.type === "simple") continue;
      if (m.type === "ratio") {
        if (m.filter?.where_filters?.length)
          throw new Error(`dbt import: filters on metric ${m.name} are not yet supported`);
        const numRaw = m.type_params?.numerator;
        const denRaw = m.type_params?.denominator;
        const numName = typeof numRaw === "string" ? numRaw : numRaw?.name;
        const denName = typeof denRaw === "string" ? denRaw : denRaw?.name;
        if (!numName || !denName || numRaw?.filter || denRaw?.filter || numRaw?.alias || denRaw?.alias)
          throw new Error(`dbt import: ratio metric ${m.name} requires numerator and denominator`);
        const numerator = resolveOrSynthesizeSimpleMetric(numName, m.name);
        const denominator = resolveOrSynthesizeSimpleMetric(denName, m.name);
        const metric: Model["metrics"][string] = {
          name: m.name,
          label: m.label ?? m.name,
          description: (m.description ?? "").trim(),
          baseTable: metrics[numerator]?.baseTable ?? "",
          expression: "",
          type: "ratio",
          numerator,
          denominator,
          filter: null,
          synonyms: m.meta?.synonyms ?? [],
        };
        const issue = computedMetricIssue(draft, metric);
        if (issue) throw new Error(`dbt import: ${issue}`);
        metrics[m.name] = metric;
      } else if (m.type === "derived") {
        if (m.filter?.where_filters?.length)
          throw new Error(`dbt import: filters on metric ${m.name} are not yet supported`);
        const expr = typeof m.type_params?.expr === "string" ? m.type_params.expr.trim() : "";
        if (!expr)
          throw new Error(`dbt import: derived metric ${m.name} requires type_params.expr`);
        for (const input of m.type_params?.metrics ?? []) {
          const inputName = typeof input === "string" ? input : input?.name;
          if (input?.filter || input?.offset_window || input?.offset_to_grain || (input?.alias && input.alias !== inputName))
            throw new Error(`dbt import: derived metric ${m.name} uses unsupported input filter, alias, or offset`);
          if (inputName) resolveOrSynthesizeSimpleMetric(inputName, m.name);
        }
        const metric: Model["metrics"][string] = {
          name: m.name,
          label: m.label ?? m.name,
          description: (m.description ?? "").trim(),
          baseTable: "",
          expression: expr,
          type: "derived",
          filter: null,
          synonyms: m.meta?.synonyms ?? [],
        };
        metric.baseTable = metricComponents(draft, metric)[0]?.baseTable ?? "";
        const issue = computedMetricIssue(draft, metric);
        if (issue) throw new Error(`dbt import: ${issue}`);
        metrics[m.name] = metric;
      } else if (m.type === "cumulative") {
        const rawTarget = m.type_params?.metric ?? m.type_params?.cumulative_type_params?.metric ?? m.type_params?.measure;
        if (m.filter?.where_filters?.length || rawTarget?.filter)
          throw new Error(`dbt import: filters on metric ${m.name} are not yet supported`);
        const targetName = typeof rawTarget === "string" ? rawTarget : rawTarget?.name;
        const hasCumulativeParams =
          m.type_params?.window !== undefined ||
          m.type_params?.grain_to_date !== undefined ||
          m.type_params?.cumulative_type_params !== undefined ||
          m.type_params?.metric !== undefined;
        if (!targetName || !hasCumulativeParams)
          throw new Error(`dbt import: cumulative metric ${m.name} requires measure/metric and window or cumulative_type_params`);
        const inputMetric = resolveOrSynthesizeSimpleMetric(targetName, m.name);
        const rawWindow = m.type_params?.window ?? m.type_params?.cumulative_type_params?.window;
        let window: number | undefined;
        if (rawWindow !== undefined && rawWindow !== null) {
          if (typeof rawWindow === "number") window = rawWindow;
          else if (typeof rawWindow === "object" && "count" in rawWindow) window = Number(rawWindow.count);
          else if (typeof rawWindow === "string" && /^\d+(\s+[a-zA-Z]+)?$/.test(rawWindow.trim())) window = Number.parseInt(rawWindow.trim(), 10);
          else window = Number.NaN;
        }
        const metric: Model["metrics"][string] = {
          name: m.name,
          label: m.label ?? m.name,
          description: (m.description ?? "").trim(),
          baseTable: metrics[inputMetric]?.baseTable ?? "",
          expression: "",
          type: "cumulative",
          metric: inputMetric,
          ...(window !== undefined ? { window } : {}),
          filter: null,
          synonyms: m.meta?.synonyms ?? [],
        };
        const issue = computedMetricIssue(draft, metric);
        if (issue) throw new Error(`dbt import: ${issue}`);
        metrics[m.name] = metric;
      } else {
        throw new Error(`dbt import: metric ${m.name} has unsupported type "${m.type}".`);
      }
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
  try { return JSON.parse(await readFile(path, "utf8")); } catch (e: any) { if (e.code === "ENOENT") return null; throw e; }
}
