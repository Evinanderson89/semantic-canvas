import type { Connector } from "../connectors/types.ts";
import type { GatewayPolicyRule } from "../security/auth.ts";
import { requireScope } from "../security/queryScope.ts";
import type { Principal, RlsConfig } from "../security/rls.ts";
import {
  joinPath,
  metricComponents,
  metricOf,
  metricType,
  type JoinCardinality,
  type Metric,
  type MetricType,
  type Model,
} from "../semantic/model.ts";
import { compileTile, parseDimension, validateTile } from "./compile.ts";
import type { TileSpec } from "./spec.ts";
import { issuesText } from "./issueText.ts";

export interface MetricComponentNode {
  name: string;
  label: string;
  baseTable: string;
  expression: string;
  filter: string | null;
}

export interface MetricDagNode {
  name: string;
  label: string;
  type: MetricType;
  baseTable: string;
  expression: string;
  filter: string | null;
  unit: Metric["unit"];
  grain: string;
  components: MetricComponentNode[];
}

export interface LineageJoinHop {
  left: string;
  leftOn: string;
  right: string;
  rightOn: string;
  type: "left" | "inner";
  cardinality: JoinCardinality;
}

export interface TileLineageInspection {
  sql: string;
  baseTable: string;
  metricDag: MetricDagNode[];
  joins: LineageJoinHop[];
  rlsApplied: string[];
}

export interface InspectTileLineageOptions {
  rls?: RlsConfig;
  principal?: Principal | null;
  policy?: GatewayPolicyRule[];
  role?: string;
}

export function inspectTileLineage(
  model: Model,
  conn: Connector,
  tile: TileSpec,
  options?: InspectTileLineageOptions,
): TileLineageInspection {
  const issues = validateTile(model, tile, { role: options?.role });
  if (issues.length) {
    throw Object.assign(new Error(issuesText(issues)), { status: 400, issues });
  }

  const metrics = tile.metrics.map((name) => metricOf(model, name));
  const baseTable = metrics[0]!.baseTable;
  const scopeFilters = options?.rls
    ? requireScope(model, baseTable, options.rls, options.principal ?? null, options.policy ?? []).filters
    : [];
  const scopedTile: TileSpec = scopeFilters.length
    ? { ...tile, where: [...(tile.where ?? []), ...scopeFilters] }
    : tile;
  const sql = compileTile(model, conn, scopedTile, { probe: true, role: options?.role });

  const metricDag: MetricDagNode[] = metrics.map((m) => ({
    name: m.name,
    label: m.label,
    type: metricType(m),
    baseTable: m.baseTable,
    expression: m.expression,
    filter: m.filter ?? null,
    unit: m.unit,
    grain: model.tables[m.baseTable]?.grain ?? "",
    components: metricComponents(model, m).map((c) => ({
      name: c.name,
      label: c.label,
      baseTable: c.baseTable,
      expression: c.expression,
      filter: c.filter ?? null,
    })),
  }));

  const targetTables = new Set<string>();
  for (const dim of scopedTile.dimensions ?? []) {
    const { table } = parseDimension(dim);
    if (table && table !== baseTable) targetTables.add(table);
  }
  for (const f of scopedTile.where ?? []) {
    if (f.source === "metric") continue;
    const { table } = parseDimension(f.field);
    if (table && table !== baseTable) targetTables.add(table);
  }

  const joined = new Set<string>([baseTable]);
  const joins: LineageJoinHop[] = [];
  for (const targetTable of targetTables) {
    const path = joinPath(model, baseTable, targetTable);
    if ("joins" in path) {
      for (const j of path.joins) {
        if (joined.has(j.right)) continue;
        joined.add(j.right);
        joins.push({
          left: j.left,
          leftOn: j.leftOn,
          right: j.right,
          rightOn: j.rightOn,
          type: j.type,
          cardinality: j.cardinality ?? "many_to_one",
        });
      }
    }
  }

  return {
    sql,
    baseTable,
    metricDag,
    joins,
    rlsApplied: scopeFilters.map((f) => f.id),
  };
}
