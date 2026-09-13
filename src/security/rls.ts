import { readFile } from "node:fs/promises";
import { z } from "zod";
import YAML from "yaml";
import type { FilterSpec } from "../compiler/spec.ts";
import { fieldReachable, type Model } from "../semantic/model.ts";

export interface RlsPolicy {
  id: string; table: string; column: string; claim: string; description?: string;
}
export interface Principal {
  id: string; name: string; [claim: string]: unknown;
}
export interface RlsConfig { policies: RlsPolicy[]; principals: Record<string, Principal> }

export async function loadRls(path: string): Promise<RlsConfig> {
  const claim = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
  const data = z.object({
    policies: z.array(z.object({ id: z.string().min(1), table: z.string().min(1), column: z.string().min(1),
      claim: z.string().min(1), description: z.string().optional() })),
    principals: z.record(z.string(), z.record(z.string(), z.union([claim, z.array(claim)]))).default({}),
  }).parse(YAML.parse(await readFile(path, "utf8")));
  const principals: Record<string, Principal> = {};
  for (const [id, p] of Object.entries(data.principals)) principals[id] = { ...p, id, name: String(p.name ?? id) };
  return { policies: data.policies, principals };
}

export interface Scope {
  /** Filters to AND into the query. */
  filters: FilterSpec[];
  /** Policies that govern data this tile touches but cannot reach via a join. */
  unenforceable: RlsPolicy[];
}

/**
 * A rule the gateway delivered (gateway-platform/docs/policy.md): declared
 * once there for a group, signed onto every request, enforced here like any
 * policy of our own. `only` keeps the listed values; `not` removes them.
 */
export interface GatewayRule { field: string; mode: "only" | "not"; values: string[] }

/**
 * Turn policies into filters for one tile.
 *
 * Returns them as ordinary FilterSpecs, which means RLS costs nothing new at
 * query time: it reuses the same predicate builder, the same quoting, and the
 * same join resolution as a user-authored filter.
 */
export function scopeFor(
  model: Model, baseTable: string, cfg: RlsConfig, principal: Principal | null, gatewayRules: GatewayRule[] = [],
): Scope {
  const filters: FilterSpec[] = [];
  const unenforceable: RlsPolicy[] = [];

  for (const r of gatewayRules) {
    const [table, column] = r.field.split(".");
    if (!table || !column) continue;
    if (!model.tables[table]) {
      // The gateway names a table this model does not have: nothing here can leak through it, and nothing here can enforce it either.
      // A policy on a table that exists elsewhere is not this tile's concern; one on a table that exists here but is unreachable is.
      continue;
    }
    if (!fieldReachable(model, baseTable, r.field)) { unenforceable.push({ id: `gateway:${r.field}`, table, column, claim: "gateway", description: "Set at the gateway." }); continue; }
    filters.push({ id: `gateway:${r.field}:${r.mode}`, field: baseTable === table ? column : r.field, source: "dimension", mode: "discrete", values: r.values, ...(r.mode === "not" ? { exclude: true } : {}) });
  }

  for (const p of cfg.policies) {
    const field = `${p.table}.${p.column}`;
    const allowed = principal?.[p.claim];

    // A principal with "*" is unrestricted for this policy.
    if (allowed === "*") continue;

    const reachable = fieldReachable(model, baseTable, field);
    if (!reachable) {
      // The tile may still expose governed data through a pre-aggregate. Say so
      // rather than pretending the policy applied.
      unenforceable.push(p);
      continue;
    }

    const values = Array.isArray(allowed) ? allowed : allowed == null ? [] : [allowed];
    filters.push({
      id: `rls:${p.id}`,
      field: baseTable === p.table ? p.column : field,
      source: "dimension",
      mode: "discrete",
      // No principal, or no values: deny everything. Failing open on an
      // unknown principal is how RLS turns into a data breach.
      values: values as (string | number)[],
    });
  }
  return { filters, unenforceable };
}
