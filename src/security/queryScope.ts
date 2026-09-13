import type { Model } from "../semantic/model.ts";
import { fieldReachable } from "../semantic/model.ts";
import type { Connector } from "../connectors/types.ts";
import { buildPredicate, compileFrom, parseDimension } from "../compiler/compile.ts";
import { scopeFor, type GatewayRule, type Principal, type RlsConfig } from "./rls.ts";
export class ScopeError extends Error { status = 403; }
export function requireScope(model: Model, base: string, cfg: RlsConfig, principal: Principal | null, gatewayRules: GatewayRule[] = []) {
  const scope = scopeFor(model, base, cfg, principal, gatewayRules);
  if (scope.unenforceable.length) throw new ScopeError(`Access denied: this table cannot enforce ${scope.unenforceable.map((p) => p.id).join(", ")}. Choose a compatible table or ask the model owner to add the required relationship.`);
  return scope;
}
/** Discovery queries run over the same base-table scope as the chart. */
export function scopedField(model: Model, conn: Connector, base: string, field: string, cfg: RlsConfig, principal: Principal | null, gatewayRules: GatewayRule[] = []) {
  if (!fieldReachable(model, base, field)) throw new Error(`unknown or unreachable field: ${field}`);
  const { table, column } = parseDimension(field);
  const owner = table ?? base;
  const scope = requireScope(model, base, cfg, principal, gatewayRules);
  const needed = new Set([owner]);
  const predicates = scope.filters.map((f) => {
    const target = parseDimension(f.field).table;
    if (target) needed.add(target);
    return buildPredicate(model, conn, base, f)!.sql;
  });
  const from = compileFrom(model, conn, base, needed);
  return `(SELECT ${owner}.${conn.quote(column)} AS value FROM ${from}${predicates.length ? ` WHERE ${predicates.map((p) => `(${p})`).join(" AND ")}` : ""}) AS scoped`;
}
