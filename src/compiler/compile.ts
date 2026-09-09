import type { Connector } from "../connectors/types.ts";
import { findJoin, fieldReachable, isTemporal, metricGrainIssue, joinPairs, type Model } from "../semantic/model.ts";
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
    const grainIssue = metricGrainIssue(m, tile.dimensions ?? []);
    if (grainIssue) issues.push({ tile: id, problem: grainIssue });
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
  const aliases = (tile.dimensions ?? []).map((d) => { const x = parseDimension(d); return x.column + (x.grain ? `_${x.grain}` : ""); });
  if (new Set(aliases).size !== aliases.length || aliases.some((a) => tile.metrics.includes(a)))
    issues.push({ tile: id, problem: "dimension and metric output names must be unique" });
  for (const dim of tile.dimensions ?? []) {
    const d = parseDimension(dim);
    const col = model.tables[d.table ?? base]?.columns.find((c) => c.name === d.column);
    if (d.grain && col && !isTemporal(col)) issues.push({ tile: id, problem: `time grain requires a date column: ${dim}` });
  }
  for (const f of tile.where ?? []) {
    if (f.source === "dimension" && (f.field.includes(":") || !fieldReachable(model, base, f.field)))
      issues.push({ tile: id, problem: `unknown or unreachable filter field "${f.field}"` });
    if (f.source === "metric" && (!tile.metrics.includes(f.field) || model.metrics[f.field]?.baseTable !== base))
      issues.push({ tile: id, problem: `metric filter "${f.field}" must name a selected metric on this table` });
  }
  if (tile.compare && tile.compare !== "none" && !(tile.dimensions ?? []).some((d) => d.includes(":")))
    issues.push({ tile: id, problem: "period comparison requires a time dimension" });
  if ((tile.where ?? []).some((f) => f.source === "metric") && new Set((tile.metrics ?? []).map((n) => model.metrics[n]?.filter ?? null)).size > 1)
    issues.push({ tile: id, problem: "aggregate filters across metrics with different always-on filters are not yet supported" });
  if ((tile.dimensions ?? []).filter((d) => d.includes(":")).length > 1 && tile.compare && tile.compare !== "none")
    issues.push({ tile: id, problem: "period comparison requires exactly one time dimension" });
  return issues;
}

export function parseDimension(dim: string) {
  let grain: string | null = null;
  let rest = dim;
  if (dim.includes(":")) { const [g, r] = dim.split(":", 2); grain = g; rest = r; }
  if (rest.includes(".")) { const [t, c] = rest.split(".", 2); return { grain, table: t, column: c }; }
  return { grain, table: null as string | null, column: rest };
}

export function compileTile(model: Model, conn: Connector, tile: TileSpec, options: { probe?: boolean } = {}): string {
  const issues = validateTile(model, tile);
  if (issues.length) throw new Error(issues.map((i) => i.problem).join("; "));
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

  const from = compileFrom(model, conn, base, needed);

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
    // Null dimension values represent the same cohort in every metric group.
    const key = (col: string, owners: string[]) => owners.length === 1 ? `${owners[0]}.${col}` : `COALESCE(${owners.map((n) => `${n}.${col}`).join(", ")})`;
    const join = groupCols.length
      ? names.slice(1).map((n, i) => `\nFULL OUTER JOIN ${n} ON ${groupCols.map((c) => `${key(c, names.slice(0, i + 1))} IS NOT DISTINCT FROM ${n}.${c}`).join(" AND ")}`).join("")
      : names.slice(1).map((n) => `\nCROSS JOIN ${n}`).join("");
    const metricCols = metrics.map((m) => {
      const owner = [...groups.values()].findIndex((ms) => ms.includes(m));
      return `${names[owner]}.${q(m.name)} AS ${q(m.name)}`;
    });
    sql = `WITH ${ctes.join(",\n")}\n` +
      `SELECT ${[...groupCols.map((c) => `${key(c, names)} AS ${c}`), ...metricCols].join(", ")}\nFROM ${names[0]}${join}`;
  }

  // Observed MIN/MAX dates do not establish data completeness: a monthly
  // snapshot can have only the first day, and event data can be sparse.
  // Keep all observed periods. Completeness is unknown until declared upstream.

  // ---- period-over-period --------------------------------------------------
  const cmp = tile.compare && tile.compare !== "none" ? tile.compare : null;
  const timeDim = (tile.dimensions ?? []).find((d) => d.includes(":"));
  if (cmp && timeDim && groupCols.length) {
    const grain = timeDim.split(":")[0];
    const timeAlias = q(`${parseDimension(timeDim).column}_${grain}`);
    const period: Record<string, ["day" | "month" | "year", number]> = {
      day: ["day", 1], week: ["day", 7], month: ["month", 1], quarter: ["month", 3], year: ["year", 1],
    };
    const [unit, n] = cmp === "yoy" ? ["year" as const, 1] : period[grain];
    // Calendar lookup leaves a missing previous period NULL instead of
    // comparing March to January when February is absent. Other dimensions
    // join null-safely, so separate cohorts never bleed into each other.
    const previousDate = conn.dateAdd(unit, `cur.${timeAlias}`, -n);
    const partition = groupCols.filter((c) => c !== timeAlias);
    const on = [`prev.${timeAlias} = ${previousDate}`,
      ...partition.map((c) => `cur.${c} IS NOT DISTINCT FROM prev.${c}`)];
    const cols = metrics.flatMap((m) => {
      const cur = `cur.${q(m.name)}`, prev = `prev.${q(m.name)}`;
      return [`${prev} AS ${q(`${m.name}__prev`)}`,
        `${cur} - ${prev} AS ${q(`${m.name}__delta`)}`,
        `(${cur} - ${prev}) / NULLIF(ABS(${prev}), 0) AS ${q(`${m.name}__pct`)}`];
    });
    sql = `WITH __base AS (\n${sql}\n)\n` +
      `SELECT ${[...groupCols, ...metrics.map((m) => q(m.name))].map((c) => `cur.${c} AS ${c}`).concat(cols).join(",\n       ")}\n` +
      `FROM __base cur LEFT JOIN __base prev ON ${on.join(" AND ")}`;
  }

  const limit = Math.min(tile.limit ?? 500, 5000) + (options.probe ? 1 : 0);
  if (timeDim) {
    const d = parseDimension(timeDim);
    const time = q(`${d.column}_${d.grain}`);
    const others = groupCols.filter((c) => c !== time);
    const order = (direction: string) => [`${time} ${direction} NULLS LAST`, ...others.map((c) => `${c} NULLS LAST`)].join(", ");
    // Limit the newest periods first, then restore chronological chart order.
    sql = `SELECT * FROM (\n${sql}\nORDER BY ${order("DESC")}\nLIMIT ${limit}\n) AS __window\nORDER BY ${order("ASC")}`;
  } else {
    if (groupCols.length) sql += `\nORDER BY ${groupCols.map((c) => `${c} NULLS LAST`).join(", ")}`;
    sql += `\nLIMIT ${limit}`;
  }
  return sql;
}

export interface PartialEdges { start: boolean; end: boolean }

/**
 * Strips the "__partial_start"/"__partial_end" columns compileTile() adds
 * for a coarsened time dimension, reporting what they said instead of
 * silently dropping them into the void along with the rows they flagged.
 * A no-op (both false) for any tile compileTile() didn't add them to.
 *
 * A row where every OTHER column is null is the `LEFT JOIN ... ON TRUE`
 * sentinel compileTile() emits when every period in range was partial (a
 * data set that doesn't span one full period yet) -- real rows always
 * have a non-null bucket, since it comes straight off a GROUP BY on a
 * real date. That sentinel exists purely to carry the flags out of a
 * query that would otherwise have zero rows to attach them to; it's
 * dropped here, never handed to a chart as a data point.
 */
export function splitPartialPeriods(
  result: { columns: string[]; rows: unknown[][] },
): { columns: string[]; rows: unknown[][]; partial: PartialEdges } {
  const startIdx = result.columns.indexOf("__partial_start");
  const endIdx = result.columns.indexOf("__partial_end");
  if (startIdx === -1 && endIdx === -1)
    return { columns: result.columns, rows: result.rows, partial: { start: false, end: false } };

  const flagIdx = new Set([startIdx, endIdx].filter((i) => i !== -1));
  const columns = result.columns.filter((_, i) => !flagIdx.has(i));
  let partial: PartialEdges = { start: false, end: false };
  const rows: unknown[][] = [];
  for (const row of result.rows) {
    if (startIdx !== -1 && row[startIdx]) partial = { ...partial, start: true };
    if (endIdx !== -1 && row[endIdx]) partial = { ...partial, end: true };
    const rest = row.filter((_, i) => !flagIdx.has(i));
    if (rest.some((v) => v !== null && v !== undefined)) rows.push(rest);
  }
  return { columns, rows, partial };
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
    if (!m || m.baseTable !== base) throw new Error(`unknown or incompatible filter metric: ${f.field}`);
    // Filtering an aggregate is a HAVING, so the metric's own always-on filter
    // is already applied by the surrounding query -- do not re-apply it here.
    ref = m.expression;
  } else {
    const { table, column } = parseDimension(f.field);
    const owner = table ?? base;
    if (!fieldReachable(model, base, f.field)) throw new Error(`unknown or unreachable filter field: ${f.field}`);
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
  if (f.max != null) bounds.push(`${ref} ${f.maxExclusive ? "<" : "<="} ${lit(f.max)}`);
  if (!bounds.length) return null;
  const sql = bounds.join(" AND ");
  return { sql: f.exclude ? `NOT (${sql})` : sql, having: f.source === "metric" };
}

export function assertIdent(name: string) {
  if (!IDENT.test(name)) throw new Error(`unsafe identifier from model: ${name}`);
}

/** Resolve a complete relationship, shared by aggregation and field discovery. */
export function compileFrom(model: Model, conn: Connector, base: string, needed: Iterable<string> = []): string {
  assertIdent(base);
  if (!model.tables[base]) throw new Error(`unknown table: ${base}`);
  let from = `${conn.relation(base, model.tables[base].relation)} AS ${base}`;
  for (const target of new Set(needed)) {
    if (target === base) continue;
    assertIdent(target);
    const j = findJoin(model, base, target);
    if (!j) throw new Error(`no unambiguous join from ${base} to ${target}`);
    const on = joinPairs(j).map((p) => `${base}.${conn.quote(p.left)} = ${target}.${conn.quote(p.right)}`).join(" AND ");
    from += `\n  ${j.type === "inner" ? "INNER" : "LEFT"} JOIN ${conn.relation(target, model.tables[target].relation)} AS ${target} ON ${on}`;
  }
  return from;
}
