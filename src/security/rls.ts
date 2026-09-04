import { readFile } from "node:fs/promises";
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
  try {
    const d: any = YAML.parse(await readFile(path, "utf8"));
    const principals: Record<string, Principal> = {};
    for (const [id, p] of Object.entries<any>(d.principals ?? {}))
      principals[id] = { id, name: p.name ?? id, ...p };
    return { policies: d.policies ?? [], principals };
  } catch {
    return { policies: [], principals: {} };
  }
}

export interface Scope {
  /** Filters to AND into the query. */
  filters: FilterSpec[];
  /** Policies that govern data this tile touches but cannot reach via a join. */
  unenforceable: RlsPolicy[];
}

/**
 * Turn policies into filters for one tile.
 *
 * Returns them as ordinary FilterSpecs, which means RLS costs nothing new at
 * query time: it reuses the same predicate builder, the same quoting, and the
 * same join resolution as a user-authored filter.
 */
export function scopeFor(
  model: Model, baseTable: string, cfg: RlsConfig, principal: Principal | null,
): Scope {
  const filters: FilterSpec[] = [];
  const unenforceable: RlsPolicy[] = [];

  for (const p of cfg.policies) {
    const field = `${p.table}.${p.column}`;
    const allowed = principal?.[p.claim];

    // A principal with "*" is unrestricted for this policy.
    if (allowed === "*") continue;

    const reachable = fieldReachable(model, baseTable, field) ||
                      fieldReachable(model, baseTable, p.column) ||
                      baseTable === p.table;
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
