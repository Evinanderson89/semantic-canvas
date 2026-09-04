import type { Connector } from "../connectors/types.ts";
import { findJoin, type Model } from "../semantic/model.ts";
import type { FilterSpec, TileSpec, ValidationIssue } from "./spec.ts";

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const GRAINS = new Set(["day", "week", "month", "quarter", "year"]);

/**
 * Validate a tile against the model before any SQL exists. This is what makes
 * an agent-authored dashboard safe: a hallucinated metric is a rejected tile,
 * not a plausible-looking wrong number.
 */
export function validateTile(model: Model, tile: TileSpec): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const id = tile.id;
  // Non-data tiles carry no metrics and nothing to validate.
  if (tile.kind && tile.kind !== "metric") return issues;
  if (!tile.metrics?.length) issues.push({ tile: id, problem: "no metrics" });

  const bases = new Set<string>();
  for (const name of tile.metrics ?? []) {
    const m = model.metrics[name];
    if (!m) { issues.push({ tile: id, problem: `unknown metric "${name}"` }); continue; }
    bases.add(m.baseTable);
  }
  if (bases.size > 1)
    issues.push({ tile: id, problem: `metrics span ${[...bases].join(" and ")}; one tile is one base table` });

  const base = [...bases][0];
  for (const dim of tile.dimensions ?? []) {
    const { grain, table, column } = parseDimension(dim);
    if (grain && !GRAINS.has(grain))
      issues.push({ tile: id, problem: `unknown time grain "${grain}"` });
    const target = table ?? base;
    const t = model.tables[target];
    if (!t) { issues.push({ tile: id, problem: `unknown table "${target}"` }); continue; }
    if (!t.columns.some((c) => c.name === column))
      issues.push({ tile: id, problem: `"${column}" is not a column of ${target}` });
    if (table && table !== base && !findJoin(model, base, table))
      issues.push({ tile: id, problem: `no join from ${base} to ${table}` });
  }
  return issues;
}

export function parseDimension(dim: string) {
  let grain: string | null = null;
  let rest = dim;
  if (dim.includes(":")) { const [g, r] = dim.split(":", 2); grain = g; rest = r; }
  if (rest.includes(".")) { const [t, c] = rest.split(".", 2); return { grain, table: t, column: c }; }
  return { grain, table: null as string | null, column: rest };
}

export function compileTile(model: Model, conn: Connector, tile: TileSpec): string {
  const metrics = tile.metrics.map((n) => model.metrics[n]);
  if (metrics.some((m) => !m)) throw new Error("compileTile called with an unvalidated tile");
  const base = metrics[0].baseTable;
  assertIdent(base);
  const q = conn.quote.bind(conn);

  // ---- dimensions, and the joins they imply --------------------------------
  const dimSelect: string[] = [];
  const groupCols: string[] = [];
  const needed = new Set<string>();

  for (const dim of tile.dimensions ?? []) {
    const { grain, table, column } = parseDimension(dim);
    const owner = table ?? base;
    assertIdent(owner);
    if (owner !== base) needed.add(owner);
    const ref = `${owner}.${q(column)}`;
    const alias = grain ? `${column}_${grain}` : column;
    dimSelect.push(`${grain ? conn.dateTrunc(grain, ref) : ref} AS ${q(alias)}`);
    groupCols.push(q(alias));
  }

  // ---- filters --------------------------------------------------------------
  const where: string[] = [];
  const having: { sql: string; metric: string }[] = [];
  for (const f of tile.where ?? []) {
    if (f.source === "dimension") {
      const { table } = parseDimension(f.field);
      if (table && table !== base) needed.add(table);
    }
    const p = buildPredicate(model, conn, base, f);
    if (!p) continue;
    if (p.having) having.push({ sql: p.sql, metric: f.field });
    else where.push(`(${p.sql})`);
  }

  let from = `${conn.relation(base)} AS ${base}`;
  for (const t of needed) {
    assertIdent(t);
    const j = findJoin(model, base, t)!;
    from += `\n  LEFT JOIN ${conn.relation(t)} AS ${t}` +
            ` ON ${base}.${q(j.leftOn)} = ${t}.${q(j.rightOn)}`;
  }

  // ---- always-on metric filters --------------------------------------------
  //
  // A metric's filter CANNOT be applied as `expr FILTER (WHERE ...)` in general.
  // SQL permits FILTER only on a single aggregate call, and plenty of metrics
  // are composite -- `SUM(x) / NULLIF(COUNT(DISTINCT y), 0)` is a parse error
  // with FILTER appended. So group metrics by their filter:
  //
  //   one group  -> the filter is a plain WHERE, valid for any expression shape
  //   many       -> one CTE per group, recombined on the dimensions
  //
  const groups = new Map<string | null, typeof metrics>();
  for (const m of metrics) {
    const k = m.filter ?? null;
    groups.set(k, [...(groups.get(k) ?? []), m]);
  }

  const sel = (ms: typeof metrics) => ms.map((m) => `${m.expression} AS ${q(m.name)}`);
  const clause = (kw: string, parts: string[]) =>
    parts.length ? `\n${kw} ${parts.join(" AND ")}` : "";

  let sql: string;
  if (groups.size <= 1) {
    const only = [...groups.keys()][0] ?? null;
    sql = `SELECT ${[...dimSelect, ...sel(metrics)].join(",\n       ")}\nFROM ${from}` +
          clause("WHERE", only ? [...where, `(${only})`] : where) +
          (groupCols.length ? `\nGROUP BY ${groupCols.join(", ")}` : "") +
          clause("HAVING", having.map((h) => `(${h.sql})`));
  } else {
    const names: string[] = [];
    const ctes = [...groups.entries()].map(([filter, ms], i) => {
      const name = `g${i}`;
      names.push(name);
      // A HAVING belongs only in the CTE that actually computes its metric.
      const h = having.filter((x) => ms.some((m) => m.name === x.metric)).map((x) => `(${x.sql})`);
      const body =
        `SELECT ${[...dimSelect, ...sel(ms)].join(",\n         ")}\n  FROM ${from}` +
        clause("  WHERE", filter ? [...where, `(${filter})`] : where) +
        (groupCols.length ? `\n  GROUP BY ${groupCols.join(", ")}` : "") +
        clause("  HAVING", h);
      return `${name} AS (\n  ${body}\n)`;
    });
    // With no dimensions each CTE is one row, so there is nothing to join on.
    const join = groupCols.length
      ? names.slice(1).map((n) => `\nFULL OUTER JOIN ${n} USING (${groupCols.join(", ")})`).join("")
      : names.slice(1).map((n) => `\nCROSS JOIN ${n}`).join("");
    sql = `WITH ${ctes.join(",\n")}\n` +
          `SELECT ${[...groupCols, ...metrics.map((m) => q(m.name))].join(", ")}\n` +
          `FROM ${names[0]}${join}`;
  }

  // ---- period-over-period --------------------------------------------------
  const cmp = tile.compare && tile.compare !== "none" ? tile.compare : null;
  const timeDim = (tile.dimensions ?? []).find((d) => d.includes(":"));
  if (cmp && timeDim && groupCols.length) {
    const grain = timeDim.split(":")[0];
    const timeAlias = q(`${parseDimension(timeDim).column}_${grain}`);
    // LAG by one period, or by a year's worth of them. This assumes a dense
    // series, which a date_trunc'd aggregate over a contiguous range is.
    const offset = cmp === "prior" ? 1
      : ({ day: 365, week: 52, month: 12, quarter: 4, year: 1 } as Record<string, number>)[grain] ?? 1;
    const partition = groupCols.filter((c) => c !== timeAlias);
    const over = `OVER (${partition.length ? `PARTITION BY ${partition.join(", ")} ` : ""}` +
                 `ORDER BY ${timeAlias})`;
    const cols = metrics.flatMap((m) => {
      const cur = q(m.name), prev = q(`${m.name}__prev`);
      return [
        `LAG(${cur}, ${offset}) ${over} AS ${prev}`,
        `${cur} - LAG(${cur}, ${offset}) ${over} AS ${q(`${m.name}__delta`)}`,
        `(${cur} - LAG(${cur}, ${offset}) ${over}) / ` +
          `NULLIF(ABS(LAG(${cur}, ${offset}) ${over}), 0) AS ${q(`${m.name}__pct`)}`,
      ];
    });
    sql = `WITH __base AS (\n${sql}\n)\n` +
          `SELECT ${[...groupCols, ...metrics.map((m) => q(m.name)), ...cols].join(",\n       ")}\n` +
          `FROM __base`;
  }

  if (groupCols.length) sql += `\nORDER BY ${groupCols[0]} NULLS LAST`;
  sql += `\nLIMIT ${Math.min(tile.limit ?? 500, 5000)}`;
  return sql;
}

const lit = (v: unknown): string => {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return `'${String(v).replace(/'/g, "''")}'`;
};

/**
 * Compile one structured filter. Returns null when it would be a no-op, so an
 * empty value list does not silently become "WHERE false".
 */
export function buildPredicate(
  model: Model, conn: Connector, base: string, f: FilterSpec,
): { sql: string; having: boolean } | null {
  const q = conn.quote.bind(conn);
  let ref: string;
  if (f.source === "metric") {
    const m = model.metrics[f.field];
    if (!m) return null;
    // Filtering an aggregate is a HAVING, so the metric's own always-on filter
    // is already applied by the surrounding query -- do not re-apply it here.
    ref = m.expression;
  } else {
    const { table, column } = parseDimension(f.field);
    const owner = table ?? base;
    if (!model.tables[owner]?.columns.some((c) => c.name === column)) return null;
    assertIdent(owner);
    ref = `${owner}.${q(column)}`;
  }

  if (f.mode === "discrete") {
    const vals = (f.values ?? []).filter((v) => v !== undefined);
    // A security filter with no permitted values denies everything. Only a
    // user-authored filter is allowed to no-op on an empty list.
    if (!vals.length) return f.id.startsWith("rls:") ? { sql: "FALSE", having: false } : null;
    const nulls = vals.some((v) => v === null);
    const rest = vals.filter((v) => v !== null);
    const parts: string[] = [];
    if (rest.length) parts.push(`${ref} ${f.exclude ? "NOT IN" : "IN"} (${rest.map(lit).join(", ")})`);
    if (nulls) parts.push(`${ref} IS ${f.exclude ? "NOT " : ""}NULL`);
    const joined = parts.join(f.exclude ? " AND " : " OR ");
    return { sql: parts.length > 1 ? `(${joined})` : joined, having: f.source === "metric" };
  }

  const bounds: string[] = [];
  if (f.min != null) bounds.push(`${ref} >= ${lit(f.min)}`);
  if (f.max != null) bounds.push(`${ref} <= ${lit(f.max)}`);
  if (!bounds.length) return null;
  const sql = bounds.join(" AND ");
  return { sql: f.exclude ? `NOT (${sql})` : sql, having: f.source === "metric" };
}

export function assertIdent(name: string) {
  if (!IDENT.test(name)) throw new Error(`unsafe identifier from model: ${name}`);
}
