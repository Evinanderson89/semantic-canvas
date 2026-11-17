import YAML from "yaml";
import {
  derivedReferences,
  isLineage,
  isNumeric,
  isTemporal,
  metricsByTable,
  metricType,
  timeColumnOf,
  type Column,
  type Join,
  type JoinCardinality,
  type Metric,
  type MetricType,
  type Model,
  type Table,
  type TimeGrain,
} from "./model.ts";

export type SemanticLayerFormat = "duckglue" | "snowflake" | "metricflow" | "glue" | "cube";

export const SEMANTIC_FORMATS: {
  id: SemanticLayerFormat;
  label: string;
  vendor: string;
  filename: string;
  description: string;
}[] = [
  {
    id: "duckglue",
    label: "DuckGlue / Canvas YAML",
    vendor: "Semantic Canvas",
    filename: "model.yaml",
    description: "Native Semantic Canvas & DuckGlue YAML catalogue with tables, metrics, joins, and reporting calendar.",
  },
  {
    id: "snowflake",
    label: "Snowflake Cortex Analyst",
    vendor: "Snowflake",
    filename: "snowflake_semantic_model.yaml",
    description: "Snowflake Cortex Analyst semantic model specification with logical tables, dimensions, time_dimensions, facts, metrics, and relationships.",
  },
  {
    id: "metricflow",
    label: "dbt MetricFlow",
    vendor: "dbt Labs",
    filename: "metricflow_semantic_models.yml",
    description: "dbt Semantic Layer v2 / MetricFlow specification with semantic_models, entities, dimensions, measures, and governed metrics.",
  },
  {
    id: "glue",
    label: "AWS Glue Data Catalog",
    vendor: "Amazon Web Services",
    filename: "aws_glue_semantic_catalog.yaml",
    description: "AWS Glue Data Catalog TableInputs and StorageDescriptor columns paired with Lakehouse SemanticLayerExtension.",
  },
  {
    id: "cube",
    label: "Cube Semantic Layer",
    vendor: "Cube",
    filename: "cubes.yml",
    description: "Cube data schema YAML with cubes, sql_table bindings, joins, dimensions, and simple/ratio/running_total measures.",
  },
];

export function isSemanticLayerFormat(value: unknown): value is SemanticLayerFormat {
  return (
    value === "duckglue" ||
    value === "snowflake" ||
    value === "metricflow" ||
    value === "glue" ||
    value === "cube"
  );
}

const ID_COL_RE = /(^|_)(id|key|code|uuid)$/i;

function resolvedTimeCol(model: Model, table: Table): string | null {
  const direct = (table as Table & { timeColumn?: string | null }).timeColumn;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  if (table.defaultDateColumn) return table.defaultDateColumn;
  const resolved = timeColumnOf(model, table.name);
  if (resolved) {
    const parts = resolved.split(".");
    return parts[parts.length - 1] || null;
  }
  return null;
}

function snowflakeDataType(colType: string): string {
  const t = colType.toLowerCase();
  if (t.includes("timestamp") || t.includes("datetime")) return "TIMESTAMP";
  if (t.includes("date")) return "DATE";
  if (t.includes("bool")) return "BOOLEAN";
  if (t.includes("int") || t.includes("double") || t.includes("float") || t.includes("numeric") || t.includes("decimal") || t.includes("number")) {
    return "NUMBER";
  }
  return "TEXT";
}

function fromSnowflakeDataType(dataType: string): string {
  const t = dataType.toLowerCase();
  if (t.includes("timestamp")) return "timestamp";
  if (t.includes("date")) return "date";
  if (t.includes("bool")) return "boolean";
  if (t.includes("num") || t.includes("int") || t.includes("float") || t.includes("double") || t.includes("dec")) return "double";
  return "string";
}

function parseSimpleAgg(
  expression: string,
  tableName: string,
): { agg: "sum" | "count" | "count_distinct" | "average" | "min" | "max"; expr: string } {
  const trimmed = (expression || "").trim();
  const countDistinctMatch = trimmed.match(/^COUNT\s*\(\s*DISTINCT\s+([^)]+)\)$/i);
  if (countDistinctMatch) {
    const col = countDistinctMatch[1].trim().replace(new RegExp(`^${tableName}\\.`, "i"), "");
    return { agg: "count_distinct", expr: col };
  }
  const fnMatch = trimmed.match(/^(SUM|COUNT|AVG|MIN|MAX)\s*\(\s*([^)]+)\)$/i);
  if (fnMatch) {
    const fn = fnMatch[1].toUpperCase();
    const rawCol = fnMatch[2].trim().replace(new RegExp(`^${tableName}\\.`, "i"), "");
    const agg =
      fn === "SUM"
        ? "sum"
        : fn === "COUNT"
          ? "count"
          : fn === "AVG"
            ? "average"
            : fn === "MIN"
              ? "min"
              : "max";
    return { agg, expr: rawCol === "*" ? "1" : rawCol };
  }
  return { agg: "sum", expr: trimmed.replace(new RegExp(`^${tableName}\\.`, "i"), "") || "1" };
}

function parseSimpleCubeMeasure(
  expression: string,
  tableName: string,
): { type: "sum" | "count" | "count_distinct" | "avg" | "min" | "max" | "number"; sql: string } {
  const trimmed = (expression || "").trim();
  const countDistinctMatch = trimmed.match(/^COUNT\s*\(\s*DISTINCT\s+([A-Za-z0-9_.]+)\s*\)$/i);
  if (countDistinctMatch) {
    const col = countDistinctMatch[1].replace(new RegExp(`^${tableName}\\.`, "i"), "");
    return { type: "count_distinct", sql: col };
  }
  const fnMatch = trimmed.match(/^(SUM|COUNT|AVG|MIN|MAX)\s*\(\s*(\*|[A-Za-z0-9_.]+)\s*\)$/i);
  if (fnMatch) {
    const fn = fnMatch[1].toLowerCase() as "sum" | "count" | "avg" | "min" | "max";
    const col = fnMatch[2].replace(new RegExp(`^${tableName}\\.`, "i"), "");
    return { type: fn, sql: col };
  }
  return { type: "number", sql: trimmed };
}

function buildSnowflakeMetricExpr(model: Model, m: Metric): string {
  const mType = metricType(m);
  if (m.expression && m.expression.trim()) return m.expression;
  if (mType === "ratio" && m.numerator && m.denominator) {
    const num = model.metrics[m.numerator];
    const den = model.metrics[m.denominator];
    const numExpr = num?.expression || m.numerator;
    const denExpr = den?.expression || m.denominator;
    return `${numExpr} / NULLIF(${denExpr}, 0)`;
  }
  if (mType === "cumulative" && m.metric) {
    const base = model.metrics[m.metric];
    return base?.expression || `SUM(${m.metric})`;
  }
  return m.expression || `COUNT(*)`;
}

export function exportSemanticModel(
  model: Model,
  format: SemanticLayerFormat,
): {
  format: SemanticLayerFormat;
  filename: string;
  content: string;
  summary: { tables: number; metrics: number; joins: number; notes: string[] };
} {
  const spec = SEMANTIC_FORMATS.find((f) => f.id === format) ?? SEMANTIC_FORMATS[0];
  const tablesList = Object.values(model.tables);
  const metricsList = Object.values(model.metrics);
  const byTable = metricsByTable(model);

  if (format === "duckglue") {
    const doc = {
      model: {
        name: model.name,
        ...(model.description ? { description: model.description } : {}),
        ...(model.calendar
          ? {
              calendar: {
                week_start: model.calendar.weekStart,
                fiscal_year_start_month: model.calendar.fiscalYearStartMonth,
                ...(model.calendar.timezone ? { timezone: model.calendar.timezone } : {}),
                ...(model.calendar.today ? { today: model.calendar.today } : {}),
              },
            }
          : {}),
      },
      tables: Object.fromEntries(
        tablesList.map((t) => [
          t.name,
          {
            ...(t.description ? { description: t.description } : {}),
            ...(t.grain ? { grain: t.grain } : {}),
            ...(t.synonyms?.length ? { synonyms: t.synonyms } : {}),
            partition_keys: t.partitionKeys ?? [],
            ...(t.primaryKey ? { primary_key: t.primaryKey } : {}),
            ...(t.defaultDateColumn ? { default_date_column: t.defaultDateColumn } : {}),
            ...(t.period ? { period: t.period } : {}),
            ...(t.reportingLagDays !== undefined ? { reporting_lag: t.reportingLagDays } : {}),
            columns: t.columns
              .filter((c) => !isLineage(c))
              .map((c) => ({
                name: c.name,
                type: c.type,
                ...(c.description ? { description: c.description } : {}),
              })),
          },
        ]),
      ),
      metrics: Object.fromEntries(
        metricsList.map((m) => [
          m.name,
          {
            label: m.label,
            ...(m.description ? { description: m.description } : {}),
            ...(m.baseTable ? { base_table: m.baseTable } : {}),
            ...(m.expression ? { expression: m.expression } : {}),
            ...(m.type && m.type !== "simple" ? { type: m.type } : {}),
            ...(m.numerator ? { numerator: m.numerator } : {}),
            ...(m.denominator ? { denominator: m.denominator } : {}),
            ...(m.metric ? { metric: m.metric } : {}),
            ...(m.window !== undefined ? { window: m.window } : {}),
            ...(m.unit ? { unit: m.unit } : {}),
            ...(m.direction ? { direction: m.direction } : {}),
            ...(m.importance !== undefined ? { importance: m.importance } : {}),
            ...(m.timeGrains?.length ? { time_grains: m.timeGrains } : {}),
            ...(m.timeDimension ? { time_dimension: m.timeDimension } : {}),
            ...(m.filter ? { filter: m.filter } : {}),
            ...(m.synonyms?.length ? { synonyms: m.synonyms } : {}),
          },
        ]),
      ),
      joins: model.joins.map((j) => ({
        left: j.left,
        left_on: j.leftOn,
        right: j.right,
        right_on: j.rightOn,
        type: j.type,
        ...(j.cardinality ? { cardinality: j.cardinality } : {}),
      })),
    };

    return {
      format,
      filename: spec.filename,
      content: YAML.stringify(doc),
      summary: {
        tables: tablesList.length,
        metrics: metricsList.length,
        joins: model.joins.length,
        notes: ["Exported native DuckGlue / Semantic Canvas YAML with full governance metadata."],
      },
    };
  }

  if (format === "snowflake") {
    const doc = {
      name: model.name,
      description: model.description ?? "",
      tables: tablesList.map((t) => {
        const tableMetrics = byTable[t.name] ?? [];
        const nonLineage = t.columns.filter((c) => !isLineage(c));
        const timeDims = nonLineage.filter((c) => isTemporal(c));
        const facts = nonLineage.filter(
          (c) => !isTemporal(c) && isNumeric(c) && c.name !== t.primaryKey && !ID_COL_RE.test(c.name),
        );
        const dims = nonLineage.filter(
          (c) => !isTemporal(c) && (!isNumeric(c) || c.name === t.primaryKey || ID_COL_RE.test(c.name)),
        );
        const timeCol = resolvedTimeCol(model, t);

        return {
          name: t.name,
          description: t.description || t.grain || "",
          ...(t.grain ? { comment: t.grain } : {}),
          ...(t.synonyms?.length ? { synonyms: t.synonyms } : {}),
          ...(timeCol ? { default_date_column: timeCol } : {}),
          ...(t.reportingLagDays !== undefined ? { reporting_lag_days: t.reportingLagDays } : {}),
          base_table: {
            database: t.relation?.database ?? "ANALYTICS",
            schema: t.relation?.schema ?? "PUBLIC",
            table: t.relation?.table ?? t.name,
          },
          ...(t.primaryKey ? { primary_key: { columns: [t.primaryKey] } } : {}),
          dimensions: dims.map((c) => ({
            name: c.name,
            expr: c.name,
            data_type: snowflakeDataType(c.type),
            ...(c.description ? { description: c.description } : {}),
          })),
          time_dimensions: timeDims.map((c) => ({
            name: c.name,
            expr: c.name,
            data_type: snowflakeDataType(c.type),
            ...(c.description ? { description: c.description } : {}),
          })),
          facts: facts.map((c) => ({
            name: c.name,
            expr: c.name,
            data_type: snowflakeDataType(c.type),
            ...(c.description ? { description: c.description } : {}),
          })),
          metrics: tableMetrics.map((m) => ({
            name: m.name,
            label: m.label,
            description: m.description || m.label,
            expr: buildSnowflakeMetricExpr(model, m),
            ...(m.type && m.type !== "simple" ? { metric_type: m.type } : {}),
            ...(m.numerator ? { numerator: m.numerator } : {}),
            ...(m.denominator ? { denominator: m.denominator } : {}),
            ...(m.metric ? { source_metric: m.metric } : {}),
            ...(m.window !== undefined ? { window: m.window } : {}),
            ...(m.filter ? { filter: m.filter } : {}),
            ...(m.unit ? { unit: m.unit } : {}),
            ...(m.synonyms?.length ? { synonyms: m.synonyms } : {}),
          })),
        };
      }),
      relationships: model.joins.map((j) => ({
        name: `${j.left}_to_${j.right}`,
        left_table: j.left,
        right_table: j.right,
        join_type: j.type === "inner" ? "inner" : "left_outer",
        relationship_type: j.cardinality ?? "many_to_one",
        relationship_columns: [{ left_column: j.leftOn, right_column: j.rightOn }],
      })),
    };

    return {
      format,
      filename: spec.filename,
      content: YAML.stringify(doc),
      summary: {
        tables: tablesList.length,
        metrics: metricsList.length,
        joins: model.joins.length,
        notes: [
          "Mapped tables to Snowflake Cortex Analyst logical tables with dimensions, time_dimensions, facts, and table-scoped metrics.",
          "Mapped model joins to Cortex Analyst relationships.",
        ],
      },
    };
  }

  if (format === "metricflow") {
    const doc = {
      project_configuration: {
        project_name: model.name,
        ...(model.description ? { description: model.description } : {}),
      },
      semantic_models: tablesList.map((t) => {
        const timeCol = resolvedTimeCol(model, t);
        const outgoingJoins = model.joins.filter((j) => j.left === t.name);
        const foreignEntities = outgoingJoins.map((j) => ({
          name: j.leftOn.replace(/_id$/i, "") || j.right,
          type: "foreign",
          expr: j.leftOn,
          meta: { target_table: j.right, target_column: j.rightOn, join_type: j.type },
        }));
        const entityCols = new Set<string>([
          ...(t.primaryKey ? [t.primaryKey] : []),
          ...outgoingJoins.map((j) => j.leftOn),
        ]);
        const tableSimpleMetrics = (byTable[t.name] ?? []).filter((m) => metricType(m) === "simple");

        return {
          name: t.name,
          description: t.description || t.grain || "",
          model: `ref('${t.name}')`,
          ...(timeCol ? { defaults: { agg_time_dimension: timeCol } } : {}),
          entities: [
            ...(t.primaryKey
              ? [
                  {
                    name: t.primaryKey.replace(/_id$/i, "") || t.name,
                    type: "primary",
                    expr: t.primaryKey,
                  },
                ]
              : []),
            ...foreignEntities,
          ],
          dimensions: t.columns
            .filter((c) => !isLineage(c) && !entityCols.has(c.name) && (!isNumeric(c) || isTemporal(c)))
            .map((c) => ({
              name: c.name,
              type: isTemporal(c) ? "time" : "categorical",
              expr: c.name,
              ...(isTemporal(c)
                ? {
                    type_params: {
                      time_granularity: t.period?.column === c.name ? t.period.grain : "day",
                    },
                  }
                : {}),
              ...(c.description ? { description: c.description } : {}),
            })),
          measures: tableSimpleMetrics.map((m) => {
            const parsed = parseSimpleAgg(m.expression, t.name);
            return {
              name: m.name,
              agg: parsed.agg,
              expr: parsed.expr,
              description: m.description || m.label,
              ...(timeCol ? { agg_time_dimension: timeCol } : {}),
            };
          }),
          meta: {
            grain: t.grain ?? "",
            ...(t.synonyms?.length ? { synonyms: t.synonyms } : {}),
            ...(t.reportingLagDays !== undefined ? { reporting_lag_days: t.reportingLagDays } : {}),
            columns: t.columns
              .filter((c) => !isLineage(c))
              .map((c) => ({
                name: c.name,
                type: c.type,
                ...(c.description ? { description: c.description } : {}),
              })),
          },
        };
      }),
      metrics: metricsList.map((m) => {
        const mType = metricType(m);
        const typeParams: Record<string, any> =
          mType === "ratio"
            ? { numerator: m.numerator, denominator: m.denominator }
            : mType === "derived"
              ? {
                  expr: m.expression,
                  metrics: derivedReferences(model, m.expression).map((name) => ({ name })),
                }
              : mType === "cumulative"
                ? {
                    measure: m.metric,
                    metric: m.metric,
                    ...(m.window !== undefined ? { window: `${m.window} months` } : {}),
                  }
                : { measure: m.name };

        return {
          name: m.name,
          label: m.label,
          description: m.description || m.label,
          type: mType,
          type_params: typeParams,
          ...(m.filter ? { filter: `{{ Dimension('${m.baseTable}') }} -- ${m.filter}` } : {}),
          meta: {
            base_table: m.baseTable,
            ...(m.expression ? { expression: m.expression } : {}),
            ...(m.filter ? { sql_filter: m.filter } : {}),
            ...(m.unit ? { unit: m.unit } : {}),
            ...(m.synonyms?.length ? { synonyms: m.synonyms } : {}),
          },
        };
      }),
    };

    return {
      format,
      filename: spec.filename,
      content: YAML.stringify(doc),
      summary: {
        tables: tablesList.length,
        metrics: metricsList.length,
        joins: model.joins.length,
        notes: [
          "Generated dbt MetricFlow semantic_models with primary/foreign entities, time/categorical dimensions, and measures.",
          "Generated top-level dbt MetricFlow metrics (simple, ratio, derived, cumulative).",
        ],
      },
    };
  }

  if (format === "glue") {
    const doc = {
      CatalogId: "aws-glue-semantic-catalog",
      DatabaseInput: {
        Name: model.name,
        Description: model.description ?? "",
      },
      TableInputs: tablesList.map((t) => {
        const timeCol = resolvedTimeCol(model, t);
        return {
          Name: t.name,
          Description: t.description ?? "",
          TableType: "EXTERNAL_TABLE",
          Parameters: {
            classification: "parquet",
            grain: t.grain ?? "",
            ...(t.primaryKey ? { primary_key: t.primaryKey } : {}),
            ...(timeCol ? { default_date_column: timeCol } : {}),
            ...(t.reportingLagDays !== undefined ? { reporting_lag_days: String(t.reportingLagDays) } : {}),
            ...(t.synonyms?.length ? { synonyms: t.synonyms.join(",") } : {}),
          },
          ...(t.partitionKeys?.length
            ? {
                PartitionKeys: t.partitionKeys.map((pk) => ({
                  Name: pk,
                  Type: t.columns.find((c) => c.name === pk)?.type ?? "date",
                })),
              }
            : {}),
          StorageDescriptor: {
            Columns: t.columns
              .filter((c) => !isLineage(c))
              .map((c) => ({
                Name: c.name,
                Type: c.type,
                Comment: c.description ?? "",
              })),
          },
        };
      }),
      SemanticLayerExtension: {
        metrics: metricsList.map((m) => ({
          name: m.name,
          label: m.label,
          base_table: m.baseTable,
          type: m.type ?? "simple",
          expression: m.expression,
          ...(m.numerator ? { numerator: m.numerator } : {}),
          ...(m.denominator ? { denominator: m.denominator } : {}),
          ...(m.metric ? { metric: m.metric } : {}),
          ...(m.window !== undefined ? { window: m.window } : {}),
          ...(m.unit ? { unit: m.unit } : {}),
          ...(m.filter ? { filter: m.filter } : {}),
          ...(m.description ? { description: m.description } : {}),
          ...(m.synonyms?.length ? { synonyms: m.synonyms } : {}),
        })),
        joins: model.joins.map((j) => ({
          left: j.left,
          left_on: j.leftOn,
          right: j.right,
          right_on: j.rightOn,
          type: j.type,
          ...(j.cardinality ? { cardinality: j.cardinality } : {}),
        })),
      },
    };

    return {
      format,
      filename: spec.filename,
      content: YAML.stringify(doc),
      summary: {
        tables: tablesList.length,
        metrics: metricsList.length,
        joins: model.joins.length,
        notes: [
          "Exported AWS Glue Data Catalog DatabaseInput and TableInputs with StorageDescriptor.Columns and table Parameters.",
          "Included SemanticLayerExtension with governed metrics and join graph.",
        ],
      },
    };
  }

  // format === "cube"
  const doc = {
    name: model.name,
    description: model.description ?? "",
    cubes: tablesList.map((t) => {
      const tableMetrics = byTable[t.name] ?? [];
      const outgoingJoins = model.joins.filter((j) => j.left === t.name);
      const timeCol = resolvedTimeCol(model, t);
      const sqlTable = t.relation?.schema
        ? `${t.relation.schema}.${t.relation.table}`
        : t.relation?.table ?? t.name;

      return {
        name: t.name,
        sql_table: sqlTable,
        description: t.description || t.grain || "",
        ...(t.grain ? { grain: t.grain } : {}),
        ...(t.synonyms?.length ? { synonyms: t.synonyms } : {}),
        ...(timeCol ? { default_date_column: timeCol } : {}),
        ...(t.reportingLagDays !== undefined ? { reporting_lag_days: t.reportingLagDays } : {}),
        joins: outgoingJoins.map((j) => ({
          name: j.right,
          relationship: j.cardinality ?? "many_to_one",
          sql: `{CUBE}.${j.leftOn} = {${j.right}}.${j.rightOn}`,
          left_on: j.leftOn,
          right_on: j.rightOn,
          type: j.type,
        })),
        dimensions: t.columns
          .filter((c) => !isLineage(c))
          .map((c) => ({
            name: c.name,
            sql: c.name,
            type: isTemporal(c)
              ? "time"
              : isNumeric(c) && c.name !== t.primaryKey && !ID_COL_RE.test(c.name)
                ? "number"
                : "string",
            ...(c.name === t.primaryKey ? { primary_key: true } : {}),
            ...(c.description ? { description: c.description } : {}),
          })),
        measures: tableMetrics.map((m) => {
          const mType = metricType(m);
          if (mType === "ratio") {
            return {
              name: m.name,
              title: m.label,
              type: "number",
              sql: `{CUBE.${m.numerator}} / NULLIF({CUBE.${m.denominator}}, 0)`,
              numerator: m.numerator,
              denominator: m.denominator,
              ...(m.unit ? { unit: m.unit } : {}),
              ...(m.description ? { description: m.description } : {}),
              ...(m.synonyms?.length ? { synonyms: m.synonyms } : {}),
            };
          }
          if (mType === "derived") {
            return {
              name: m.name,
              title: m.label,
              type: "number",
              sql: m.expression,
              expression: m.expression,
              ...(m.unit ? { unit: m.unit } : {}),
              ...(m.description ? { description: m.description } : {}),
              ...(m.synonyms?.length ? { synonyms: m.synonyms } : {}),
            };
          }
          if (mType === "cumulative") {
            return {
              name: m.name,
              title: m.label,
              type: "running_total",
              sql: `{CUBE.${m.metric}}`,
              metric: m.metric,
              ...(m.window !== undefined
                ? { rolling_window: { trailing: `${m.window} month` }, window: m.window }
                : {}),
              ...(m.unit ? { unit: m.unit } : {}),
              ...(m.description ? { description: m.description } : {}),
              ...(m.synonyms?.length ? { synonyms: m.synonyms } : {}),
            };
          }
          const parsed = parseSimpleCubeMeasure(m.expression, t.name);
          return {
            name: m.name,
            title: m.label,
            type: parsed.type,
            sql: parsed.sql,
            expression: m.expression,
            ...(m.filter
              ? {
                  filter: m.filter,
                  filters: [{ sql: `{CUBE}.${m.filter.replace(new RegExp(`^${t.name}\\.`, "i"), "")}` }],
                }
              : {}),
            ...(m.unit ? { unit: m.unit } : {}),
            ...(m.description ? { description: m.description } : {}),
            ...(m.synonyms?.length ? { synonyms: m.synonyms } : {}),
          };
        }),
      };
    }),
  };

  return {
    format,
    filename: spec.filename,
    content: YAML.stringify(doc),
    summary: {
      tables: tablesList.length,
      metrics: metricsList.length,
      joins: model.joins.length,
      notes: [
        "Mapped tables to Cube definitions with sql_table, joins, dimensions, and measures.",
        "Preserved simple, ratio, derived, and cumulative measures.",
      ],
    },
  };
}

function detectFormat(doc: any): SemanticLayerFormat {
  if (!doc || typeof doc !== "object") {
    throw new Error("Invalid semantic layer document: expected a YAML or JSON object.");
  }
  if (doc.DatabaseInput || Array.isArray(doc.TableInputs)) return "glue";
  if (Array.isArray(doc.cubes)) return "cube";
  if (Array.isArray(doc.semantic_models)) return "metricflow";
  if (Array.isArray(doc.tables)) return "snowflake";
  if (doc.tables && typeof doc.tables === "object") return "duckglue";
  if (doc.metrics && typeof doc.metrics === "object") return "duckglue";
  throw new Error(
    "Could not auto-detect semantic layer dialect. Expected duckglue (tables map), snowflake (tables list), metricflow (semantic_models), glue (TableInputs), or cube (cubes).",
  );
}

export function parseSemanticLayerText(
  content: string,
  sourceFormat: SemanticLayerFormat | "auto" = "auto",
): { detectedFormat: SemanticLayerFormat; model: Model } {
  const trimmed = (content ?? "").trim();
  if (!trimmed) {
    throw new Error("Semantic layer content cannot be empty.");
  }

  let doc: any;
  try {
    doc = trimmed.startsWith("{") ? JSON.parse(trimmed) : YAML.parse(trimmed);
  } catch (err: any) {
    throw new Error(`Failed to parse YAML/JSON semantic definition: ${err?.message ?? String(err)}`);
  }

  if (!doc || typeof doc !== "object") {
    throw new Error("Parsed semantic layer definition must be an object.");
  }

  const detectedFormat: SemanticLayerFormat =
    sourceFormat === "auto" ? detectFormat(doc) : sourceFormat;

  if (detectedFormat === "duckglue") {
    const tables: Record<string, Table> = {};
    for (const [name, raw] of Object.entries<any>(doc.tables ?? {})) {
      if (!raw || typeof raw !== "object") continue;
      const defaultDateCol = raw.default_date_column ?? raw.defaultDateColumn ?? raw.timeColumn;
      const reportingLag =
        raw.reporting_lag ?? raw.reportingLag ?? raw.reportingLagDays;
      tables[name] = {
        name,
        description: String(raw.description ?? "").trim(),
        grain: String(raw.grain ?? "").trim(),
        synonyms: Array.isArray(raw.synonyms) ? raw.synonyms.map(String) : [],
        partitionKeys: Array.isArray(raw.partition_keys ?? raw.partitionKeys)
          ? (raw.partition_keys ?? raw.partitionKeys).map(String)
          : [],
        primaryKey: raw.primary_key ?? raw.primaryKey ?? null,
        ...(defaultDateCol ? { defaultDateColumn: String(defaultDateCol) } : {}),
        ...(raw.period && typeof raw.period === "object"
          ? { period: { column: String(raw.period.column), grain: raw.period.grain as TimeGrain } }
          : {}),
        ...(typeof reportingLag === "number" ? { reportingLagDays: reportingLag } : {}),
        columns: Array.isArray(raw.columns)
          ? raw.columns.map((c: any) => ({
              name: String(c.name),
              type: String(c.type ?? "string"),
              ...(c.description ? { description: String(c.description) } : {}),
            }))
          : [],
      };
    }

    const metrics: Record<string, Metric> = {};
    for (const [name, raw] of Object.entries<any>(doc.metrics ?? {})) {
      if (!raw || typeof raw !== "object") continue;
      const mType = (raw.type ?? "simple") as MetricType;
      const baseTable =
        raw.base_table ??
        raw.baseTable ??
        (raw.numerator && metrics[raw.numerator]?.baseTable) ??
        (raw.metric && metrics[raw.metric]?.baseTable) ??
        Object.keys(tables)[0] ??
        "";
      metrics[name] = {
        name,
        label: String(raw.label ?? name),
        description: String(raw.description ?? "").trim(),
        baseTable: String(baseTable),
        expression: String(raw.expression ?? ""),
        ...(mType !== "simple" ? { type: mType } : {}),
        ...(raw.numerator ? { numerator: String(raw.numerator) } : {}),
        ...(raw.denominator ? { denominator: String(raw.denominator) } : {}),
        ...(raw.metric ? { metric: String(raw.metric) } : {}),
        ...(typeof raw.window === "number" ? { window: raw.window } : {}),
        ...(raw.unit ? { unit: raw.unit } : {}),
        ...(raw.direction ? { direction: raw.direction } : {}),
        ...(typeof raw.importance === "number" ? { importance: raw.importance } : {}),
        ...(Array.isArray(raw.time_grains ?? raw.timeGrains)
          ? { timeGrains: (raw.time_grains ?? raw.timeGrains) as TimeGrain[] }
          : {}),
        ...(raw.time_dimension ?? raw.timeDimension
          ? { timeDimension: String(raw.time_dimension ?? raw.timeDimension) }
          : {}),
        filter: raw.filter ?? null,
        synonyms: Array.isArray(raw.synonyms) ? raw.synonyms.map(String) : [],
      };
    }

    // Second pass for computed metric baseTable resolution
    for (const m of Object.values(metrics)) {
      if (!m.baseTable) {
        if (m.numerator && metrics[m.numerator]) m.baseTable = metrics[m.numerator].baseTable;
        else if (m.metric && metrics[m.metric]) m.baseTable = metrics[m.metric].baseTable;
        else {
          const ref = Object.keys(metrics).find((k) => k !== m.name && m.expression.includes(k));
          if (ref && metrics[ref]) m.baseTable = metrics[ref].baseTable;
        }
      }
    }

    const joins: Join[] = Array.isArray(doc.joins)
      ? doc.joins.map((j: any) => ({
          left: String(j.left),
          leftOn: String(j.left_on ?? j.leftOn),
          right: String(j.right),
          rightOn: String(j.right_on ?? j.rightOn),
          type: j.type === "inner" ? "inner" : "left",
          ...(j.cardinality ? { cardinality: j.cardinality as JoinCardinality } : {}),
        }))
      : [];

    return {
      detectedFormat,
      model: {
        source: "duckglue",
        name: String(doc.model?.name ?? doc.name ?? "warehouse"),
        description: String(doc.model?.description ?? doc.description ?? "").trim(),
        tables,
        metrics,
        joins,
      },
    };
  }

  if (detectedFormat === "snowflake") {
    const tables: Record<string, Table> = {};
    const metrics: Record<string, Metric> = {};
    const joins: Join[] = [];

    for (const rawTable of Array.isArray(doc.tables) ? doc.tables : []) {
      const name = String(rawTable.base_table?.table ?? rawTable.name);
      const columns: Column[] = [];
      const partitionKeys: string[] = [];

      const addCol = (entry: any, defaultType: string, isTime = false) => {
        const colName = String(entry.expr && /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.expr) ? entry.expr : entry.name);
        if (!columns.some((c) => c.name === colName)) {
          columns.push({
            name: colName,
            type: entry.data_type ? fromSnowflakeDataType(String(entry.data_type)) : defaultType,
            ...(entry.description ? { description: String(entry.description).trim() } : {}),
          });
        }
        if (isTime && !partitionKeys.includes(colName)) {
          partitionKeys.push(colName);
        }
      };

      for (const d of rawTable.dimensions ?? []) addCol(d, "string", false);
      for (const td of rawTable.time_dimensions ?? []) addCol(td, "date", true);
      for (const f of rawTable.facts ?? []) addCol(f, "double", false);

      const pk =
        Array.isArray(rawTable.primary_key?.columns) && rawTable.primary_key.columns.length > 0
          ? String(rawTable.primary_key.columns[0])
          : null;
      const defaultDateColumn =
        rawTable.default_date_column ?? partitionKeys[0] ?? undefined;

      tables[name] = {
        name,
        description: String(rawTable.description ?? "").trim(),
        grain: String(rawTable.comment ?? (pk ? `one row per ${pk}` : rawTable.description ?? "")).trim(),
        synonyms: Array.isArray(rawTable.synonyms) ? rawTable.synonyms.map(String) : [],
        partitionKeys,
        primaryKey: pk,
        ...(defaultDateColumn ? { defaultDateColumn: String(defaultDateColumn) } : {}),
        ...(typeof rawTable.reporting_lag_days === "number"
          ? { reportingLagDays: rawTable.reporting_lag_days }
          : {}),
        relation: {
          database: rawTable.base_table?.database ?? "ANALYTICS",
          schema: rawTable.base_table?.schema ?? "PUBLIC",
          table: name,
        },
        columns,
      };

      for (const m of rawTable.metrics ?? rawTable.measures ?? []) {
        const mName = String(m.name);
        const mType = (m.metric_type ?? m.type ?? "simple") as MetricType;
        metrics[mName] = {
          name: mName,
          label: String(m.label ?? m.name),
          description: String(m.description ?? "").trim(),
          baseTable: name,
          expression: String(m.expr ?? m.expression ?? ""),
          ...(mType !== "simple" ? { type: mType } : {}),
          ...(m.numerator ? { numerator: String(m.numerator) } : {}),
          ...(m.denominator ? { denominator: String(m.denominator) } : {}),
          ...(m.source_metric ?? m.metric ? { metric: String(m.source_metric ?? m.metric) } : {}),
          ...(typeof m.window === "number" ? { window: m.window } : {}),
          ...(m.unit ? { unit: m.unit } : {}),
          filter: m.filter ?? null,
          synonyms: Array.isArray(m.synonyms) ? m.synonyms.map(String) : [],
        };
      }
    }

    for (const r of Array.isArray(doc.relationships) ? doc.relationships : []) {
      const colPair = Array.isArray(r.relationship_columns) ? r.relationship_columns[0] : undefined;
      const leftOn = String(colPair?.left_column ?? r.left_on ?? "id");
      const rightOn = String(colPair?.right_column ?? r.right_on ?? leftOn);
      joins.push({
        left: String(r.left_table ?? r.left),
        leftOn,
        right: String(r.right_table ?? r.right),
        rightOn,
        type: r.join_type === "inner" ? "inner" : "left",
        ...(r.relationship_type ? { cardinality: r.relationship_type as JoinCardinality } : {}),
      });
    }

    return {
      detectedFormat,
      model: {
        source: "snowflake-semantic",
        name: String(doc.name ?? "snowflake_model"),
        description: String(doc.description ?? "").trim(),
        tables,
        metrics,
        joins,
      },
    };
  }

  if (detectedFormat === "metricflow") {
    const tables: Record<string, Table> = {};
    const metrics: Record<string, Metric> = {};
    const joins: Join[] = [];
    const primaryEntities = new Map<string, { table: string; column: string }>();
    const pendingForeignEntities: { leftTable: string; leftCol: string; entityName: string; meta?: any }[] = [];
    const measureSpecs = new Map<string, { baseTable: string; expression: string; description: string }>();

    const AGG_SQL: Record<string, string> = {
      sum: "SUM",
      count: "COUNT",
      count_distinct: "COUNT_DISTINCT",
      average: "AVG",
      avg: "AVG",
      min: "MIN",
      max: "MAX",
    };

    for (const sm of Array.isArray(doc.semantic_models) ? doc.semantic_models : []) {
      const name = String(sm.name);
      const columns: Column[] = Array.isArray(sm.meta?.columns)
        ? sm.meta.columns.map((c: any) => ({
            name: String(c.name),
            type: String(c.type ?? "string"),
            ...(c.description ? { description: String(c.description) } : {}),
          }))
        : [];
      const partitionKeys: string[] = [];
      let primaryKey: string | null = null;
      const defaultDateColumn = sm.defaults?.agg_time_dimension
        ? String(sm.defaults.agg_time_dimension)
        : undefined;

      for (const e of sm.entities ?? []) {
        const colName = String(e.expr ?? e.name);
        if (!columns.some((c) => c.name === colName)) {
          columns.push({ name: colName, type: "string" });
        }
        if (e.type === "primary" || e.type === "unique") {
          primaryKey = colName;
          primaryEntities.set(String(e.name), { table: name, column: colName });
        } else if (e.type === "foreign") {
          pendingForeignEntities.push({
            leftTable: name,
            leftCol: colName,
            entityName: String(e.name),
            meta: e.meta,
          });
        }
      }

      for (const d of sm.dimensions ?? []) {
        const colName = String(d.expr ?? d.name);
        const colType = d.type === "time" ? "date" : "string";
        if (!columns.some((c) => c.name === colName)) {
          columns.push({
            name: colName,
            type: colType,
            ...(d.description ? { description: String(d.description) } : {}),
          });
        }
        if (d.type === "time" && !partitionKeys.includes(colName)) {
          partitionKeys.push(colName);
        }
      }

      for (const m of sm.measures ?? []) {
        const mName = String(m.name);
        const exprCol = String(m.expr ?? mName);
        if (exprCol !== "1" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(exprCol) && !columns.some((c) => c.name === exprCol)) {
          columns.push({
            name: exprCol,
            type: "double",
            ...(m.description ? { description: String(m.description) } : {}),
          });
        }
        const agg = AGG_SQL[String(m.agg ?? "sum").toLowerCase()] ?? "SUM";
        const sqlExpr =
          agg === "COUNT" && exprCol === "1"
            ? "COUNT(*)"
            : agg === "COUNT_DISTINCT"
              ? `COUNT(DISTINCT ${name}.${exprCol})`
              : `${agg}(${name}.${exprCol})`;
        measureSpecs.set(mName, {
          baseTable: name,
          expression: sqlExpr,
          description: String(m.description ?? "").trim(),
        });
      }

      tables[name] = {
        name,
        description: String(sm.description ?? "").trim(),
        grain: String(sm.meta?.grain ?? sm.description ?? (primaryKey ? `one row per ${primaryKey}` : "")).trim(),
        synonyms: Array.isArray(sm.meta?.synonyms) ? sm.meta.synonyms.map(String) : [],
        partitionKeys,
        primaryKey,
        ...(defaultDateColumn ? { defaultDateColumn } : {}),
        ...(typeof sm.meta?.reporting_lag_days === "number"
          ? { reportingLagDays: sm.meta.reporting_lag_days }
          : {}),
        columns,
      };
    }

    for (const fk of pendingForeignEntities) {
      if (fk.meta?.target_table && tables[fk.meta.target_table]) {
        joins.push({
          left: fk.leftTable,
          leftOn: fk.leftCol,
          right: String(fk.meta.target_table),
          rightOn: String(fk.meta.target_column ?? fk.leftCol),
          type: fk.meta.join_type === "inner" ? "inner" : "left",
        });
        continue;
      }
      const target = primaryEntities.get(fk.entityName);
      if (target && target.table !== fk.leftTable) {
        joins.push({
          left: fk.leftTable,
          leftOn: fk.leftCol,
          right: target.table,
          rightOn: target.column,
          type: "left",
        });
      }
    }

    for (const m of Array.isArray(doc.metrics) ? doc.metrics : []) {
      const mName = String(m.name);
      const mType = (m.type ?? "simple") as MetricType;
      const tp = m.type_params ?? {};
      const measureName =
        typeof tp.measure === "string"
          ? tp.measure
          : typeof tp.measure?.name === "string"
            ? tp.measure.name
            : mName;
      const resolvedMeasure = measureSpecs.get(measureName);
      const baseTable =
        m.meta?.base_table ??
        resolvedMeasure?.baseTable ??
        Object.keys(tables)[0] ??
        "";

      if (mType === "ratio") {
        const num = typeof tp.numerator === "string" ? tp.numerator : tp.numerator?.name;
        const den = typeof tp.denominator === "string" ? tp.denominator : tp.denominator?.name;
        metrics[mName] = {
          name: mName,
          label: String(m.label ?? mName),
          description: String(m.description ?? "").trim(),
          baseTable: String(m.meta?.base_table ?? (num && metrics[num]?.baseTable) ?? baseTable),
          expression: String(m.meta?.expression ?? ""),
          type: "ratio",
          ...(num ? { numerator: String(num) } : {}),
          ...(den ? { denominator: String(den) } : {}),
          ...(m.meta?.unit ? { unit: m.meta.unit } : {}),
          filter: m.meta?.sql_filter ?? null,
          synonyms: Array.isArray(m.meta?.synonyms) ? m.meta.synonyms.map(String) : [],
        };
      } else if (mType === "derived") {
        metrics[mName] = {
          name: mName,
          label: String(m.label ?? mName),
          description: String(m.description ?? "").trim(),
          baseTable: String(baseTable),
          expression: String(tp.expr ?? m.meta?.expression ?? ""),
          type: "derived",
          ...(m.meta?.unit ? { unit: m.meta.unit } : {}),
          filter: m.meta?.sql_filter ?? null,
          synonyms: Array.isArray(m.meta?.synonyms) ? m.meta.synonyms.map(String) : [],
        };
      } else if (mType === "cumulative") {
        const targetMetric =
          typeof tp.metric === "string"
            ? tp.metric
            : typeof tp.measure === "string"
              ? tp.measure
              : tp.measure?.name;
        const rawWin = tp.window ?? tp.cumulative_type_params?.window;
        const winNum =
          typeof rawWin === "number"
            ? rawWin
            : typeof rawWin === "string"
              ? Number.parseInt(rawWin, 10)
              : undefined;
        metrics[mName] = {
          name: mName,
          label: String(m.label ?? mName),
          description: String(m.description ?? "").trim(),
          baseTable: String(
            m.meta?.base_table ?? (targetMetric && metrics[targetMetric]?.baseTable) ?? baseTable,
          ),
          expression: String(m.meta?.expression ?? ""),
          type: "cumulative",
          ...(targetMetric ? { metric: String(targetMetric) } : {}),
          ...(typeof winNum === "number" && Number.isFinite(winNum) ? { window: winNum } : {}),
          ...(m.meta?.unit ? { unit: m.meta.unit } : {}),
          filter: m.meta?.sql_filter ?? null,
          synonyms: Array.isArray(m.meta?.synonyms) ? m.meta.synonyms.map(String) : [],
        };
      } else {
        metrics[mName] = {
          name: mName,
          label: String(m.label ?? mName),
          description: String(m.description ?? resolvedMeasure?.description ?? "").trim(),
          baseTable: String(baseTable),
          expression: String(m.meta?.expression ?? resolvedMeasure?.expression ?? "COUNT(*)"),
          ...(m.meta?.unit ? { unit: m.meta.unit } : {}),
          filter: m.meta?.sql_filter ?? null,
          synonyms: Array.isArray(m.meta?.synonyms) ? m.meta.synonyms.map(String) : [],
        };
      }
    }

    // If semantic_models had measures but no top-level metrics array was provided, synthesize simple metrics from measures
    if (Object.keys(metrics).length === 0 && measureSpecs.size > 0) {
      for (const [mName, spec] of measureSpecs.entries()) {
        metrics[mName] = {
          name: mName,
          label: mName,
          description: spec.description,
          baseTable: spec.baseTable,
          expression: spec.expression,
          filter: null,
          synonyms: [],
        };
      }
    }

    return {
      detectedFormat,
      model: {
        source: "dbt",
        name: String(
          doc.project_configuration?.project_name ?? doc.name ?? "metricflow_model",
        ),
        description: String(
          doc.project_configuration?.description ?? doc.description ?? "",
        ).trim(),
        tables,
        metrics,
        joins,
      },
    };
  }

  if (detectedFormat === "glue") {
    const tables: Record<string, Table> = {};
    for (const ti of Array.isArray(doc.TableInputs) ? doc.TableInputs : []) {
      const name = String(ti.Name ?? ti.name);
      const params = ti.Parameters ?? {};
      const partKeys = Array.isArray(ti.PartitionKeys)
        ? ti.PartitionKeys.map((pk: any) => String(pk.Name ?? pk.name))
        : [];
      const cols: Column[] = Array.isArray(ti.StorageDescriptor?.Columns)
        ? ti.StorageDescriptor.Columns.map((c: any) => ({
            name: String(c.Name ?? c.name),
            type: String(c.Type ?? c.type ?? "string"),
            ...(c.Comment ?? c.description
              ? { description: String(c.Comment ?? c.description) }
              : {}),
          }))
        : [];
      for (const pk of partKeys) {
        if (!cols.some((c) => c.name === pk)) {
          cols.push({ name: pk, type: "date" });
        }
      }
      const lag = params.reporting_lag_days !== undefined ? Number(params.reporting_lag_days) : undefined;
      const synonyms =
        typeof params.synonyms === "string" && params.synonyms.trim()
          ? params.synonyms.split(",").map((s: string) => s.trim()).filter(Boolean)
          : [];

      tables[name] = {
        name,
        description: String(ti.Description ?? "").trim(),
        grain: String(params.grain ?? "").trim(),
        synonyms,
        partitionKeys: partKeys,
        primaryKey: params.primary_key ?? null,
        ...(params.default_date_column ? { defaultDateColumn: String(params.default_date_column) } : {}),
        ...(typeof lag === "number" && Number.isFinite(lag) ? { reportingLagDays: lag } : {}),
        columns: cols,
      };
    }

    const metrics: Record<string, Metric> = {};
    const rawMetrics = doc.SemanticLayerExtension?.metrics ?? [];
    const metricEntries = Array.isArray(rawMetrics)
      ? rawMetrics
      : Object.entries(rawMetrics).map(([k, v]: [string, any]) => ({ name: k, ...v }));
    for (const m of metricEntries) {
      const mName = String(m.name);
      const mType = (m.type ?? "simple") as MetricType;
      metrics[mName] = {
        name: mName,
        label: String(m.label ?? mName),
        description: String(m.description ?? "").trim(),
        baseTable: String(m.base_table ?? m.baseTable ?? Object.keys(tables)[0] ?? ""),
        expression: String(m.expression ?? ""),
        ...(mType !== "simple" ? { type: mType } : {}),
        ...(m.numerator ? { numerator: String(m.numerator) } : {}),
        ...(m.denominator ? { denominator: String(m.denominator) } : {}),
        ...(m.metric ? { metric: String(m.metric) } : {}),
        ...(typeof m.window === "number" ? { window: m.window } : {}),
        ...(m.unit ? { unit: m.unit } : {}),
        filter: m.filter ?? null,
        synonyms: Array.isArray(m.synonyms) ? m.synonyms.map(String) : [],
      };
    }

    const joins: Join[] = Array.isArray(doc.SemanticLayerExtension?.joins)
      ? doc.SemanticLayerExtension.joins.map((j: any) => ({
          left: String(j.left),
          leftOn: String(j.left_on ?? j.leftOn),
          right: String(j.right),
          rightOn: String(j.right_on ?? j.rightOn),
          type: j.type === "inner" ? "inner" : "left",
          ...(j.cardinality ? { cardinality: j.cardinality as JoinCardinality } : {}),
        }))
      : [];

    return {
      detectedFormat,
      model: {
        source: "duckglue",
        name: String(doc.DatabaseInput?.Name ?? doc.name ?? "aws_glue_catalog"),
        description: String(doc.DatabaseInput?.Description ?? doc.description ?? "").trim(),
        tables,
        metrics,
        joins,
      },
    };
  }

  // detectedFormat === "cube"
  const tables: Record<string, Table> = {};
  const metrics: Record<string, Metric> = {};
  const joins: Join[] = [];

  const CUBE_AGG_MAP: Record<string, string> = {
    sum: "SUM",
    count: "COUNT",
    count_distinct: "COUNT_DISTINCT",
    avg: "AVG",
    average: "AVG",
    min: "MIN",
    max: "MAX",
  };

  for (const cube of Array.isArray(doc.cubes) ? doc.cubes : []) {
    const cubeName = String(cube.name);
    const columns: Column[] = [];
    const partitionKeys: string[] = [];
    let primaryKey: string | null = null;
    let defaultDateColumn: string | undefined = cube.default_date_column
      ? String(cube.default_date_column)
      : undefined;

    for (const d of cube.dimensions ?? []) {
      const colName = String(d.name);
      const colType =
        d.type === "time" ? "date" : d.type === "number" ? "double" : "string";
      if (!columns.some((c) => c.name === colName)) {
        columns.push({
          name: colName,
          type: colType,
          ...(d.description ? { description: String(d.description) } : {}),
        });
      }
      if (d.primary_key === true || d.primaryKey === true) {
        primaryKey = colName;
      }
      if (d.type === "time") {
        if (!partitionKeys.includes(colName)) partitionKeys.push(colName);
        defaultDateColumn ??= colName;
      }
    }

    for (const j of cube.joins ?? []) {
      const rightCube = String(j.name);
      let leftOn = j.left_on ?? j.leftOn;
      let rightOn = j.right_on ?? j.rightOn;
      if ((!leftOn || !rightOn) && typeof j.sql === "string") {
        const match = j.sql.match(
          /^\s*(?:\$?\{([A-Za-z0-9_]+)\}|([A-Za-z0-9_]+))\.([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:\$?\{([A-Za-z0-9_]+)\}|([A-Za-z0-9_]+))\.([A-Za-z_][A-Za-z0-9_]*)\s*$/,
        );
        if (match) {
          leftOn = match[3];
          rightOn = match[6];
        }
      }
      const resolvedLeftOn = String(leftOn ?? "id");
      const resolvedRightOn = String(rightOn ?? resolvedLeftOn);
      if (!columns.some((c) => c.name === resolvedLeftOn)) {
        columns.push({ name: resolvedLeftOn, type: "string" });
      }
      joins.push({
        left: cubeName,
        leftOn: resolvedLeftOn,
        right: rightCube,
        rightOn: resolvedRightOn,
        type: j.type === "inner" ? "inner" : "left",
        cardinality: (j.relationship === "has_one"
          ? "one_to_one"
          : j.relationship === "has_many"
            ? "one_to_many"
            : j.relationship ?? "many_to_one") as JoinCardinality,
      });
    }

    for (const m of cube.measures ?? []) {
      const mName = String(m.name);
      const rawType = String(m.type ?? "number").toLowerCase();

      if (m.numerator && m.denominator) {
        metrics[mName] = {
          name: mName,
          label: String(m.title ?? m.label ?? mName),
          description: String(m.description ?? "").trim(),
          baseTable: cubeName,
          expression: "",
          type: "ratio",
          numerator: String(m.numerator),
          denominator: String(m.denominator),
          ...(m.unit ? { unit: m.unit } : {}),
          filter: null,
          synonyms: Array.isArray(m.synonyms) ? m.synonyms.map(String) : [],
        };
      } else if (rawType === "running_total" || m.metric) {
        const targetMetric = String(
          m.metric ?? String(m.sql ?? "").replace(/^\$?\{(?:CUBE\.)?|\}$/gi, ""),
        );
        metrics[mName] = {
          name: mName,
          label: String(m.title ?? m.label ?? mName),
          description: String(m.description ?? "").trim(),
          baseTable: cubeName,
          expression: "",
          type: "cumulative",
          metric: targetMetric,
          ...(typeof m.window === "number" ? { window: m.window } : {}),
          ...(m.unit ? { unit: m.unit } : {}),
          filter: null,
          synonyms: Array.isArray(m.synonyms) ? m.synonyms.map(String) : [],
        };
      } else if (rawType === "number" && !m.expression) {
        const sqlExpr = String(m.sql ?? "").replace(/\$?\{(?:CUBE\.)?([A-Za-z0-9_]+)\}/g, "$1");
        metrics[mName] = {
          name: mName,
          label: String(m.title ?? m.label ?? mName),
          description: String(m.description ?? "").trim(),
          baseTable: cubeName,
          expression: sqlExpr,
          type: "derived",
          ...(m.unit ? { unit: m.unit } : {}),
          filter: null,
          synonyms: Array.isArray(m.synonyms) ? m.synonyms.map(String) : [],
        };
      } else {
        let expr = typeof m.expression === "string" && m.expression.trim() ? m.expression.trim() : "";
        if (!expr) {
          const agg = CUBE_AGG_MAP[rawType] ?? "SUM";
          const rawCol = String(m.sql ?? mName)
            .trim()
            .replace(/^\$?\{CUBE\}\./i, "")
            .replace(new RegExp(`^${cubeName}\\.`, "i"), "");
          if (agg === "COUNT" && (!m.sql || rawCol === "*" || rawCol === "1")) {
            expr = "COUNT(*)";
          } else {
            if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(rawCol) && !columns.some((c) => c.name === rawCol)) {
              columns.push({ name: rawCol, type: "double" });
            }
            expr = agg === "COUNT_DISTINCT" ? `COUNT(DISTINCT ${cubeName}.${rawCol})` : `${agg}(${cubeName}.${rawCol})`;
          }
        }
        metrics[mName] = {
          name: mName,
          label: String(m.title ?? m.label ?? mName),
          description: String(m.description ?? "").trim(),
          baseTable: cubeName,
          expression: expr,
          ...(m.unit ? { unit: m.unit } : {}),
          filter: typeof m.filter === "string" ? m.filter : null,
          synonyms: Array.isArray(m.synonyms) ? m.synonyms.map(String) : [],
        };
      }
    }

    tables[cubeName] = {
      name: cubeName,
      description: String(cube.description ?? "").trim(),
      grain: String(cube.grain ?? cube.description ?? (primaryKey ? `one row per ${primaryKey}` : "")).trim(),
      synonyms: Array.isArray(cube.synonyms) ? cube.synonyms.map(String) : [],
      partitionKeys,
      primaryKey,
      ...(defaultDateColumn ? { defaultDateColumn } : {}),
      ...(typeof cube.reporting_lag_days === "number"
        ? { reportingLagDays: cube.reporting_lag_days }
        : {}),
      columns,
    };
  }

  return {
    detectedFormat,
    model: {
      source: "cube",
      name: String(doc.name ?? "cube_model"),
      description: String(doc.description ?? "Imported from Cube semantic schema.").trim(),
      tables,
      metrics,
      joins,
    },
  };
}

export function convertSemanticLayer(input: {
  content?: string;
  sourceFormat?: SemanticLayerFormat | "auto";
  model?: Model;
  targetFormat: SemanticLayerFormat;
}): {
  sourceFormat: SemanticLayerFormat;
  targetFormat: SemanticLayerFormat;
  filename: string;
  content: string;
  summary: { tables: number; metrics: number; joins: number; notes: string[] };
} {
  let resolvedModel: Model;
  let resolvedSourceFormat: SemanticLayerFormat =
    input.sourceFormat && input.sourceFormat !== "auto" ? input.sourceFormat : "duckglue";

  if (typeof input.content === "string" && input.content.trim()) {
    const parsed = parseSemanticLayerText(input.content, input.sourceFormat ?? "auto");
    resolvedModel = parsed.model;
    resolvedSourceFormat = parsed.detectedFormat;
  } else if (input.model) {
    resolvedModel = input.model;
    if (!input.sourceFormat || input.sourceFormat === "auto") {
      if (input.model.source === "snowflake-semantic") resolvedSourceFormat = "snowflake";
      else if (input.model.source === "dbt") resolvedSourceFormat = "metricflow";
      else if (input.model.source === "cube") resolvedSourceFormat = "cube";
      else resolvedSourceFormat = "duckglue";
    }
  } else {
    throw new Error("Either semantic layer content or an active model is required for conversion.");
  }

  const exported = exportSemanticModel(resolvedModel, input.targetFormat);
  return {
    sourceFormat: resolvedSourceFormat,
    targetFormat: input.targetFormat,
    filename: exported.filename,
    content: exported.content,
    summary: exported.summary,
  };
}

function parseSnippetBlocks(yamlSnippet: string): {
  tables: Record<string, any>;
  metrics: Record<string, any>;
  joins: any[];
} {
  const out = {
    tables: {} as Record<string, any>,
    metrics: {} as Record<string, any>,
    joins: [] as any[],
  };

  const blocks = yamlSnippet.split(/\n{2,}(?=(?:tables|metrics|joins):)/g);
  for (const block of blocks) {
    try {
      const parsed = YAML.parse(block);
      if (parsed && typeof parsed === "object") {
        if (parsed.tables && typeof parsed.tables === "object") {
          Object.assign(out.tables, parsed.tables);
        }
        if (parsed.metrics && typeof parsed.metrics === "object") {
          Object.assign(out.metrics, parsed.metrics);
        }
        if (Array.isArray(parsed.joins)) {
          out.joins.push(...parsed.joins);
        }
      }
    } catch {
      // Ignore unparseable fragment
    }
  }
  return out;
}

export function translateSnippetToFormat(
  yamlSnippet: string,
  format: SemanticLayerFormat,
  context?: { table?: string; metricName?: string; label?: string },
): string {
  if (format === "duckglue" || !yamlSnippet.trim()) {
    return yamlSnippet;
  }

  const parsed = parseSnippetBlocks(yamlSnippet);
  const tableEntries = Object.entries(parsed.tables);
  const metricEntries = Object.entries(parsed.metrics);
  const joinEntries = parsed.joins;

  if (tableEntries.length === 0 && metricEntries.length === 0 && joinEntries.length === 0) {
    return yamlSnippet;
  }

  if (format === "snowflake") {
    const sfDoc: Record<string, any> = {};
    const sfTables: any[] = [];

    for (const [tName, tDef] of tableEntries) {
      const timeCol = tDef.default_date_column ?? tDef.timeColumn;
      sfTables.push({
        name: tName,
        base_table: { database: "ANALYTICS", schema: "PUBLIC", table: tName },
        ...(tDef.grain ? { comment: tDef.grain } : {}),
        ...(tDef.reporting_lag ?? tDef.reportingLag
          ? { reporting_lag_days: tDef.reporting_lag ?? tDef.reportingLag }
          : {}),
        ...(timeCol
          ? {
              time_dimensions: [
                { name: timeCol, expr: timeCol, data_type: "DATE" },
              ],
            }
          : {}),
      });
    }

    if (metricEntries.length > 0) {
      const targetTable =
        metricEntries[0][1]?.base_table ?? context?.table ?? "fct_metrics";
      let tbl = sfTables.find((t) => t.name === targetTable);
      if (!tbl) {
        tbl = {
          name: targetTable,
          base_table: { database: "ANALYTICS", schema: "PUBLIC", table: targetTable },
        };
        sfTables.push(tbl);
      }
      tbl.metrics = metricEntries.map(([mName, mDef]) => {
        const expr =
          mDef.expression ||
          (mDef.type === "ratio" && mDef.numerator && mDef.denominator
            ? `${mDef.numerator} / NULLIF(${mDef.denominator}, 0)`
            : mDef.type === "cumulative" && mDef.metric
              ? `SUM(${mDef.metric}) OVER (ROWS BETWEEN ${(mDef.window ?? 6) - 1} PRECEDING AND CURRENT ROW)`
              : `SUM(${mName})`);
        return {
          name: mName,
          description: mDef.description ?? mDef.label ?? mName,
          expr,
          ...(Array.isArray(mDef.synonyms) ? { synonyms: mDef.synonyms } : {}),
        };
      });
    }

    if (sfTables.length > 0) sfDoc.tables = sfTables;
    if (joinEntries.length > 0) {
      sfDoc.relationships = joinEntries.map((j) => ({
        name: `${j.left}_to_${j.right}`,
        left_table: j.left,
        right_table: j.right,
        join_type: j.type === "inner" ? "inner" : "left_outer",
        relationship_type: "many_to_one",
        relationship_columns: [
          {
            left_column: j.left_on ?? j.leftOn,
            right_column: j.right_on ?? j.rightOn,
          },
        ],
      }));
    }
    return YAML.stringify(sfDoc).trim();
  }

  if (format === "metricflow") {
    const mfDoc: Record<string, any> = {};
    const semModels: any[] = [];

    for (const [tName, tDef] of tableEntries) {
      const timeCol = tDef.default_date_column ?? tDef.timeColumn;
      semModels.push({
        name: tName,
        model: `ref('${tName}')`,
        ...(tDef.grain ? { description: tDef.grain } : {}),
        ...(timeCol
          ? {
              defaults: { agg_time_dimension: timeCol },
              dimensions: [
                {
                  name: timeCol,
                  type: "time",
                  type_params: { time_granularity: "day" },
                },
              ],
            }
          : {}),
      });
    }

    for (const j of joinEntries) {
      const leftOn = String(j.left_on ?? j.leftOn ?? "id");
      const entityName = leftOn.replace(/_id$/i, "") || j.right;
      let sm = semModels.find((s) => s.name === j.left);
      if (!sm) {
        sm = { name: j.left, model: `ref('${j.left}')`, entities: [] };
        semModels.push(sm);
      }
      sm.entities ??= [];
      sm.entities.push({
        name: entityName,
        type: "foreign",
        expr: leftOn,
      });
    }

    if (semModels.length > 0) mfDoc.semantic_models = semModels;

    if (metricEntries.length > 0) {
      mfDoc.metrics = metricEntries.map(([mName, mDef]) => {
        const mType = mDef.type ?? "simple";
        const typeParams =
          mType === "ratio"
            ? { numerator: mDef.numerator, denominator: mDef.denominator }
            : mType === "cumulative"
              ? {
                  measure: mDef.metric ?? mName,
                  ...(mDef.window ? { window: `${mDef.window} months` } : {}),
                }
              : { measure: mName };
        return {
          name: mName,
          label: mDef.label ?? mName,
          type: mType,
          type_params: typeParams,
          ...(mDef.description ? { description: mDef.description } : {}),
          ...(Array.isArray(mDef.synonyms) ? { meta: { synonyms: mDef.synonyms } } : {}),
        };
      });
    }
    return YAML.stringify(mfDoc).trim();
  }

  if (format === "glue") {
    const glueDoc: Record<string, any> = {};
    if (tableEntries.length > 0) {
      glueDoc.TableInputs = tableEntries.map(([tName, tDef]) => {
        const timeCol = tDef.default_date_column ?? tDef.timeColumn;
        return {
          Name: tName,
          TableType: "EXTERNAL_TABLE",
          Parameters: {
            classification: "parquet",
            ...(tDef.grain ? { grain: tDef.grain } : {}),
            ...(timeCol ? { default_date_column: timeCol } : {}),
            ...(tDef.reporting_lag ?? tDef.reportingLag
              ? { reporting_lag_days: String(tDef.reporting_lag ?? tDef.reportingLag) }
              : {}),
            ...(tDef.status ? { status: tDef.status } : {}),
          },
        };
      });
    }
    if (metricEntries.length > 0 || joinEntries.length > 0) {
      glueDoc.SemanticLayerExtension = {
        ...(metricEntries.length > 0
          ? {
              metrics: metricEntries.map(([mName, mDef]) => ({
                name: mName,
                label: mDef.label ?? mName,
                ...(mDef.base_table ? { base_table: mDef.base_table } : {}),
                type: mDef.type ?? "simple",
                ...(mDef.expression ? { expression: mDef.expression } : {}),
                ...(mDef.numerator ? { numerator: mDef.numerator } : {}),
                ...(mDef.denominator ? { denominator: mDef.denominator } : {}),
                ...(mDef.metric ? { metric: mDef.metric } : {}),
                ...(mDef.window ? { window: mDef.window } : {}),
                ...(mDef.description ? { description: mDef.description } : {}),
                ...(Array.isArray(mDef.synonyms) ? { synonyms: mDef.synonyms } : {}),
              })),
            }
          : {}),
        ...(joinEntries.length > 0
          ? {
              joins: joinEntries.map((j) => ({
                left: j.left,
                left_on: j.left_on ?? j.leftOn,
                right: j.right,
                right_on: j.right_on ?? j.rightOn,
                type: j.type ?? "left",
              })),
            }
          : {}),
      };
    }
    return YAML.stringify(glueDoc).trim();
  }

  // format === "cube"
  const cubes: any[] = [];
  const ensureCube = (name: string) => {
    let c = cubes.find((x) => x.name === name);
    if (!c) {
      c = { name, sql_table: name };
      cubes.push(c);
    }
    return c;
  };

  for (const [tName, tDef] of tableEntries) {
    const c = ensureCube(tName);
    if (tDef.grain) c.description = tDef.grain;
    const timeCol = tDef.default_date_column ?? tDef.timeColumn;
    if (timeCol) {
      c.dimensions = [{ name: timeCol, sql: timeCol, type: "time" }];
    }
    if (tDef.reporting_lag ?? tDef.reportingLag) {
      c.reporting_lag_days = tDef.reporting_lag ?? tDef.reportingLag;
    }
  }

  for (const j of joinEntries) {
    const c = ensureCube(j.left);
    const leftOn = j.left_on ?? j.leftOn;
    const rightOn = j.right_on ?? j.rightOn;
    c.joins ??= [];
    c.joins.push({
      name: j.right,
      relationship: "many_to_one",
      sql: `{CUBE}.${leftOn} = {${j.right}}.${rightOn}`,
    });
  }

  for (const [mName, mDef] of metricEntries) {
    const cubeName = mDef.base_table ?? context?.table ?? "metrics";
    const c = ensureCube(cubeName);
    c.measures ??= [];
    const mType = mDef.type ?? "simple";
    if (mType === "ratio") {
      c.measures.push({
        name: mName,
        title: mDef.label ?? mName,
        type: "number",
        sql: `{CUBE.${mDef.numerator}} / NULLIF({CUBE.${mDef.denominator}}, 0)`,
        ...(mDef.description ? { description: mDef.description } : {}),
        ...(Array.isArray(mDef.synonyms) ? { synonyms: mDef.synonyms } : {}),
      });
    } else if (mType === "cumulative") {
      c.measures.push({
        name: mName,
        title: mDef.label ?? mName,
        type: "running_total",
        sql: `{CUBE.${mDef.metric ?? mName}}`,
        ...(mDef.window ? { rolling_window: { trailing: `${mDef.window} month` } } : {}),
        ...(mDef.description ? { description: mDef.description } : {}),
      });
    } else {
      const parsedAgg = parseSimpleCubeMeasure(mDef.expression ?? "", cubeName);
      c.measures.push({
        name: mName,
        title: mDef.label ?? mName,
        type: parsedAgg.type,
        sql: parsedAgg.sql,
        ...(mDef.description ? { description: mDef.description } : {}),
        ...(Array.isArray(mDef.synonyms) ? { synonyms: mDef.synonyms } : {}),
      });
    }
  }

  return YAML.stringify({ cubes }).trim();
}

export function buildSnippetsByFormat(
  yamlSnippet: string,
  context?: { table?: string; metricName?: string; label?: string },
): Record<SemanticLayerFormat, string> {
  return {
    duckglue: translateSnippetToFormat(yamlSnippet, "duckglue", context),
    snowflake: translateSnippetToFormat(yamlSnippet, "snowflake", context),
    metricflow: translateSnippetToFormat(yamlSnippet, "metricflow", context),
    glue: translateSnippetToFormat(yamlSnippet, "glue", context),
    cube: translateSnippetToFormat(yamlSnippet, "cube", context),
  };
}
