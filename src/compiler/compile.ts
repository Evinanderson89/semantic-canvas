import type { Connector } from "../connectors/types.ts";
import { findJoin, fieldReachable, isTemporal, metricGrainIssue, joinPairs, metricComponents, metricType, isCrossTableRatio, timeColumnOf, computedMetricIssue, type Metric, type Model } from "../semantic/model.ts";
import type { FilterSpec, TileSpec, ValidationIssue } from "./spec.ts";

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const GRAINS = new Set(["day", "week", "month", "quarter", "year"]);

/**
 * Validate a tile against the model before any SQL exists. This is what makes
 * an agent-authored dashboard safe: a hallucinated metric is a rejected tile,
 * not a plausible-looking wrong number.
 */
export function validateTile(model: Model, tile: TileSpec, options: { role?: string } = {}): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const id = tile.id;
  // Non-data tiles carry no metrics and nothing to validate.
  if (tile.kind && tile.kind !== "metric") return issues;
  if (!tile.metrics?.length) issues.push({ tile: id, problem: "no metrics" });

  const bases = new Set<string>();
  const timeDims = (tile.dimensions ?? []).filter((d) => d.includes(":"));
  for (const name of tile.metrics ?? []) {
    const m = model.metrics[name];
    if (!m) { issues.push({ tile: id, problem: `unknown metric "${name}"` }); continue; }
    const defect = computedMetricIssue(model, m);
    if (defect) { issues.push({ tile: id, problem: defect }); continue; }
    // A computed metric is checked through the simple metrics it is made of.
    for (const c of metricComponents(model, m)) {
      // Ingested tables stay out of viewers' reach until an admin publishes them (docs/connected-canvas.md).
      if (options.role === "viewer" && (c.reviewed === false || m.reviewed === false || model.tables[c.baseTable]?.connected?.status === "unreviewed"))
        issues.push({ tile: id, problem: `"${name}" is ingested but not yet published; an administrator must review ${c.baseTable} before viewers can query it` });
      const grainIssue = metricGrainIssue(c, tile.dimensions ?? []);
      if (grainIssue) issues.push({ tile: id, problem: grainIssue });
    }
    bases.add(m.baseTable);
    if (metricType(m) === "cumulative" && !timeDims.length) issues.push({ tile: id, problem: `${m.label} is cumulative: it needs a time dimension to run along` });
    if (isCrossTableRatio(model, m)) {
      const den = model.metrics[m.denominator!];
      if ((tile.metrics ?? []).length > 1) issues.push({ tile: id, problem: `${m.label} divides ${m.baseTable} by ${den.baseTable}; a ratio across two tables is charted on its own tile` });
      if (timeDims.length && !timeColumnOf(model, den.baseTable)) issues.push({ tile: id, problem: `${den.baseTable} has no date column to align ${m.label}'s denominator on` });
      for (const dim of tile.dimensions ?? []) {
        const { grain, table } = parseDimension(dim);
        if (grain) continue;
        if (!table) issues.push({ tile: id, problem: `${m.label} crosses two tables: name the dimension's table (${dim} → table.${dim})` });
        else if (table !== den.baseTable && !findJoin(model, den.baseTable, table)) issues.push({ tile: id, problem: `no join from ${den.baseTable} to ${table}, which ${m.label}'s denominator needs` });
      }
    }
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

export function compileTile(model: Model, conn: Connector, tile: TileSpec, options: { probe?: boolean; role?: string } = {}): string {
  const issues = validateTile(model, tile, options);
  if (issues.length) throw new Error(issues.map((i) => i.problem).join("; "));
  const tileMetrics = tile.metrics.map((n) => model.metrics[n]);
  if (tileMetrics.some((m) => !m)) throw new Error("compileTile called with an unvalidated tile");
  const q = conn.quote.bind(conn);
  const across = tileMetrics.find((m) => isCrossTableRatio(model, m));

  // The grouped query computes simple metrics only. A computed metric names
  // the simple ones it needs; those ride along as hidden columns (aliased
  // __m_<name> when the tile did not ask for them) and the computed value is
  // formed in one more SELECT over the grouped rows, where a window (for a
  // running total) or a division (for a ratio) is plain SQL.
  const physical = new Map<string, { metric: Metric; alias: string }>();
  for (const m of tileMetrics) for (const c of metricComponents(model, m)) if (!physical.has(c.name)) physical.set(c.name, { metric: c, alias: tile.metrics.includes(c.name) ? c.name : `__m_${c.name}` });

  let sql: string, groupCols: string[], edge: { alias: string; ref: string; grain: string } | null;
  if (across) {
    ({ sql, groupCols } = compileAcross(model, conn, tile, across));
    edge = null; // each side keeps its own edges; the ratio of two partially observed periods is left to the person's date filter
  } else {
    const core = compileCore(model, conn, tile, [...physical.values()]);
    ({ sql, groupCols, edge } = core);
    if (tileMetrics.some((m) => metricType(m) !== "simple")) {
      const timeDim = (tile.dimensions ?? []).find((d) => d.includes(":"));
      const timeAlias = timeDim ? q(`${parseDimension(timeDim).column}_${timeDim.split(":")[0]}`) : null;
      const col = (name: string) => q(physical.get(name)!.alias);
      const value = (m: Metric): string => {
        switch (metricType(m)) {
          case "ratio": return `CAST(${col(m.numerator!)} AS DOUBLE) / NULLIF(${col(m.denominator!)}, 0)`;
          case "derived": return m.expression.replace(/'(?:[^']|'')*'/g, (s) => s).replace(/(?<![A-Za-z0-9_."])([A-Za-z_][A-Za-z0-9_]*)(?![A-Za-z0-9_"]|\s*\()/g, (w) => (physical.has(w) ? col(w) : w));
          case "cumulative": {
            const others = groupCols.filter((c) => c !== timeAlias);
            const frame = m.window ? `ROWS BETWEEN ${m.window - 1} PRECEDING AND CURRENT ROW` : "ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW";
            return `SUM(${col(m.metric!)}) OVER (${others.length ? `PARTITION BY ${others.join(", ")} ` : ""}ORDER BY ${timeAlias} ${frame})`;
          }
          default: return col(m.name);
        }
      };
      const cols = [...groupCols, ...tileMetrics.map((m) => `${value(m)} AS ${q(m.name)}`), ...(edge ? ['"__edge_min"', '"__edge_max"'] : [])];
      sql = `SELECT ${cols.join(",\n       ")}\nFROM (\n${sql}\n) AS __grouped`;
    }
  }

  return finishTile(model, conn, tile, tileMetrics, sql, groupCols, edge, options);
}

/** The grouped SELECT for one base table: dimensions, the simple metrics given (each under its alias), and the hidden edge columns. */
function compileCore(model: Model, conn: Connector, tile: TileSpec, physical: { metric: Metric; alias: string }[]): { sql: string; groupCols: string[]; edge: { alias: string; ref: string; grain: string } | null } {
  const metrics = physical.map((p) => p.metric);
  const aliasOf = new Map(physical.map((p) => [p.metric.name, p.alias]));
  const base = metrics[0].baseTable;
  assertIdent(base);
  const q = conn.quote.bind(conn);

  // ---- dimensions, and the joins they imply --------------------------------
  const dimSelect: string[] = [];
  const groupCols: string[] = [];
  const needed = new Set<string>();

  // The coarsened time dimension, if any: its edge buckets are checked for
  // completeness below, so the raw min and max date inside each bucket ride
  // along as hidden aggregates.
  let edge: { alias: string; ref: string; grain: string } | null = null;
  for (const dim of tile.dimensions ?? []) {
    const { grain, table, column } = parseDimension(dim);
    const owner = table ?? base;
    assertIdent(owner);
    if (owner !== base) needed.add(owner);
    const ref = `${owner}.${q(column)}`;
    const alias = grain ? `${column}_${grain}` : column;
    dimSelect.push(`${grain ? conn.dateTrunc(grain, ref) : ref} AS ${q(alias)}`);
    groupCols.push(q(alias));
    if (grain && grain !== "day" && !edge) edge = { alias: q(alias), ref, grain };
  }
  // A snapshot table has nothing to be partial about at its own grain: one
  // row per month dated the first IS the whole month. Two declarations say
  // so, either is enough: a metric's time_grains naming this grain as its
  // native reporting grain, or the table's date-typed primary key (one row
  // per period). Only finer-grained data, events inside the bucket, can
  // reveal an incomplete edge.
  if (edge) {
    const native = metrics.some((m) => m.timeGrains?.includes(edge!.grain as any));
    const table = model.tables[base];
    const pk = table?.primaryKey ? table.columns.find((c) => c.name === table.primaryKey) : undefined;
    const periodKeyed = !!pk && isTemporal(pk) && edge.ref.endsWith(q(pk.name));
    if (native || periodKeyed) edge = null;
  }
  const edgeSelect = edge ? [`MIN(${edge.ref}) AS "__edge_min"`, `MAX(${edge.ref}) AS "__edge_max"`] : [];

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

  const sel = (ms: typeof metrics) => ms.map((m) => `${m.expression} AS ${q(aliasOf.get(m.name) ?? m.name)}`);
  const clause = (kw: string, parts: string[]) =>
    parts.length ? `\n${kw} ${parts.join(" AND ")}` : "";

  let sql: string;
  if (groups.size <= 1) {
    const only = [...groups.keys()][0] ?? null;
    sql = `SELECT ${[...dimSelect, ...sel(metrics), ...edgeSelect].join(",\n       ")}\nFROM ${from}` +
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
        `SELECT ${[...dimSelect, ...sel(ms), ...(i === 0 ? edgeSelect : [])].join(",\n         ")}\n  FROM ${from}` +
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
      const a = q(aliasOf.get(m.name) ?? m.name);
      return `${names[owner]}.${a} AS ${a}`;
    });
    const edgeCols = edge ? [`${names[0]}."__edge_min" AS "__edge_min"`, `${names[0]}."__edge_max" AS "__edge_max"`] : [];
    sql = `WITH ${ctes.join(",\n")}\n` +
      `SELECT ${[...groupCols.map((c) => `${key(c, names)} AS ${c}`), ...metricCols, ...edgeCols].join(", ")}\nFROM ${names[0]}${join}`;
  }
  return { sql, groupCols, edge };
}

/**
 * A ratio whose denominator lives on another table: each side is its own
 * grouped query over its own table, joined on the dimension values. The time
 * axis is each side's own date column (sessions by session date, signups by
 * signup date); a categorical dimension must be reachable from both. Every
 * filter, the row-level ones included, has to apply on both sides, or the
 * ratio is refused rather than half-scoped.
 */
function compileAcross(model: Model, conn: Connector, tile: TileSpec, ratio: Metric): { sql: string; groupCols: string[] } {
  const q = conn.quote.bind(conn);
  const num = model.metrics[ratio.numerator!], den = model.metrics[ratio.denominator!];
  const sideDims = (base: string) => (tile.dimensions ?? []).map((d) => {
    const { grain, table, column } = parseDimension(d);
    if (!grain) return d;
    const own = table === base || (!table && model.tables[base].columns.some((c) => c.name === column)) ? column : timeColumnOf(model, base)?.split(".")[1];
    if (!own) throw new Error(`${base} has no date column to align ${ratio.label} on`);
    return `${grain}:${own}`;
  });
  for (const f of tile.where ?? []) {
    if (f.source !== "dimension") throw new Error(`${ratio.label} crosses two tables; an aggregate filter cannot apply to both`);
    if (!fieldReachable(model, den.baseTable, f.field) || !fieldReachable(model, num.baseTable, f.field)) throw new Error(`the filter on ${f.field} cannot be applied to both ${num.baseTable} and ${den.baseTable}, which ${ratio.label} needs`);
  }
  const side = (m: Metric, name: string) => compileCore(model, conn, { ...tile, metrics: [m.name], dimensions: sideDims(m.baseTable) }, [{ metric: m, alias: name }]);
  const n = side(num, "__num"), d = side(den, "__den");
  // Both sides group by the same dimensions in the same order; only a time column's alias may differ.
  const dims = (tile.dimensions ?? []).map((dim, i) => {
    const { grain, column } = parseDimension(dim);
    return { out: q(grain ? `${column}_${grain}` : column), n: n.groupCols[i], d: d.groupCols[i] };
  });
  const sql = `WITH __n AS (\n${n.sql}\n), __d AS (\n${d.sql}\n)\n` +
    `SELECT ${[...dims.map((x) => `COALESCE(__n.${x.n}, __d.${x.d}) AS ${x.out}`), `CAST(__n."__num" AS DOUBLE) / NULLIF(__d."__den", 0) AS ${q(ratio.name)}`].join(", ")}\n` +
    `FROM __n FULL OUTER JOIN __d ON ${dims.length ? dims.map((x) => `__n.${x.n} IS NOT DISTINCT FROM __d.${x.d}`).join(" AND ") : "TRUE"}`;
  return { sql, groupCols: dims.map((x) => x.out) };
}

/** Edge flags, period-over-period, ordering and the limit: the same tail for every kind of metric. */
function finishTile(model: Model, conn: Connector, tile: TileSpec, metrics: Metric[], sql: string, groupCols: string[], edge: { alias: string; ref: string; grain: string } | null, options: { probe?: boolean }): string {
  const q = conn.quote.bind(conn);

  // Edge completeness. Observed dates cannot prove a bucket is complete (a
  // monthly snapshot legitimately has one row on the first), but they can
  // prove one is incomplete: if the earliest bucket's first observed date
  // is after the bucket's start, or the latest bucket's last observed date
  // is before the bucket's end, that bucket does not cover its whole period
  // and a chart that draws it as a full one lies at the edge. The flags are
  // carried as columns and stripped by splitPartialPeriods(); rows are kept.
  //
  // The judgement is about the bucket, not the row. With a second dimension
  // the grouped query holds one row per (bucket, segment), each with its own
  // first and last observed date; a segment that happened to be quiet for
  // the first few days of the first month is not evidence that the month is
  // incomplete when every other segment reaches its start. So the earliest
  // and latest dates are taken across the whole bucket (a window over the
  // bucket column), and every row of a partial bucket is flagged together.
  //
  // A range filter on the same date column is the exception: the person
  // asked for that window, so a bucket clipped by it is not incomplete, it
  // is what they asked to see. Where the filter bounds the edge, the check
  // is skipped on that side.
  if (edge) {
    const unit: Record<string, ["day" | "month" | "year", number]> = { week: ["day", 7], month: ["month", 1], quarter: ["month", 3], year: ["year", 1] };
    const [u, n] = unit[edge.grain] ?? ["day", 1];
    const bucketEnd = conn.dateAdd("day", conn.dateAdd(u, `__e.${edge.alias}`, n), -1);
    const timeField = (tile.dimensions ?? []).find((d) => d.includes(":"))!.split(":")[1];
    const timeRanges = (tile.where ?? []).filter((f) => f.source === "dimension" && f.mode === "range" && (f.field === timeField || f.field === timeField.split(".").pop()));
    const boundedMin = timeRanges.some((f) => f.min != null && f.min !== "");
    const boundedMax = timeRanges.some((f) => f.max != null && f.max !== "");
    const bucketMin = `MIN(CAST("__edge_min" AS DATE)) OVER (PARTITION BY ${edge.alias})`;
    const bucketMax = `MAX(CAST("__edge_max" AS DATE)) OVER (PARTITION BY ${edge.alias})`;
    const startFlag = boundedMin ? "FALSE" : `(${edge.alias} = (SELECT MIN(${edge.alias}) FROM __e) AND ${bucketMin} > ${edge.alias})`;
    const endFlag = boundedMax ? "FALSE" : `(${edge.alias} = (SELECT MAX(${edge.alias}) FROM __e) AND ${bucketMax} < ${bucketEnd})`;
    sql = `WITH __e AS (\n${sql}\n)\n` +
      `SELECT * EXCLUDE ("__edge_min", "__edge_max"),\n` +
      `       ${startFlag} AS "__partial_start",\n` +
      `       ${endFlag} AS "__partial_end"\n` +
      `FROM __e`;
  }

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
      `SELECT ${[...groupCols, ...metrics.map((m) => q(m.name)), ...(edge ? ['"__partial_start"', '"__partial_end"'] : [])].map((c) => `cur.${c} AS ${c}`).concat(cols).join(",\n       ")}\n` +
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
    const flaggedStart = startIdx !== -1 && Boolean(row[startIdx]), flaggedEnd = endIdx !== -1 && Boolean(row[endIdx]);
    if (flaggedStart) partial = { ...partial, start: true };
    if (flaggedEnd) partial = { ...partial, end: true };
    // A flagged edge bucket is left out, as the tile's note says: drawn as a
    // full period it reads as a collapse, and as the newest period it would
    // feed a false period-over-period change. The flags report it instead.
    if (flaggedStart || flaggedEnd) continue;
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
