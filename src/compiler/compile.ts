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

  // ---- drop a coarsened bucket that isn't a full period ----------------------
  //
  // A metric's own date range rarely lines up with a week/month/quarter/year
  // boundary. date_trunc('week', Sep-1) still buckets it with the Monday
  // before -- Aug-26 -- but only ONE real day (Sep-1) actually falls in that
  // bucket, so its total reads as a collapse next to a full week right next
  // to it: exactly the "chart drops to zero at both ends" this fixes. Applied
  // BEFORE the period-over-period LAG below, not after -- comparing against
  // an already-partial neighbor would report a real-looking but meaningless
  // swing for whichever row sits next to the trimmed one.
  //
  // Not needed for "day": each row already IS one full, indivisible unit at
  // that grain (the columns this app buckets are DATE-typed, not timestamps
  // with a partial first/last calendar day), so there's no coarser period for
  // a day bucket to be partial within.
  const coarseTimeDim = (tile.dimensions ?? []).find((d) => {
    const { grain } = parseDimension(d);
    return grain && grain !== "day";
  });
  // Set below when a partial edge was actually trimmed away, so the final
  // wrap (after period-over-period) can re-attach it as real columns rather
  // than this being silent all the way out to the caller.
  let partialBounds: { ref: string; grain: string; unit: "day" | "month" | "year"; n: number } | null = null;
  if (coarseTimeDim) {
    const { grain, table, column } = parseDimension(coarseTimeDim);
    const owner = table ?? base;
    const ref = `${owner}.${q(column)}`;
    const alias = q(`${column}_${grain}`);
    // DuckDB (and Snowflake's DATEADD) have no "quarter" interval unit --
    // expressed as 3 months instead, which is exactly equivalent for this
    // purpose since a coarsened bucket's start is always the 1st of a month.
    const PERIOD: Record<string, [unit: "day" | "month" | "year", n: number]> = {
      week: ["day", 7], month: ["month", 1], quarter: ["month", 3], year: ["year", 1],
    };
    const [unit, n] = PERIOD[grain!];
    const qualifiedAlias = `__periods.${alias}`;
    // One full period after the bucket's start, minus a day, is that
    // bucket's own last day -- date_trunc only ever rounds DOWN to a
    // period's start, so this is the only way to get its end.
    const bucketEnd = conn.dateAdd("day", conn.dateAdd(unit, qualifiedAlias, n), -1);
    const periodCols = [...groupCols, ...metrics.map((m) => q(m.name))];
    // `where` here is the tile's own dimensional/cross-filter scope, the
    // one thing every metric on the tile shares -- correct for the common
    // case (one metric, or several with the same always-on filter). A
    // KNOWN, narrower gap: if two metrics on the SAME tile have DIFFERENT
    // always-on filters (the `groups.size > 1` case above) that happen to
    // cover different date ranges, bounds is computed against their
    // UNION, not each metric's own narrower range -- a metric whose own
    // filter ends earlier than its sibling's could still show a partial
    // edge this doesn't catch. Not fixed here: it would mean a separate
    // bounds query per filter group, and no reported case has hit it yet.
    sql = `WITH __bounds AS (\n  SELECT MIN(${ref}) AS lo, MAX(${ref}) AS hi\n  FROM ${from}` +
          clause("  WHERE", where) + `\n),\n__periods AS (\n${sql}\n)\n` +
          `SELECT ${periodCols.map((c) => `__periods.${c}`).join(", ")}\nFROM __periods CROSS JOIN __bounds\n` +
          `WHERE ${qualifiedAlias} >= __bounds.lo AND ${bucketEnd} <= __bounds.hi`;
    partialBounds = { ref, grain: grain!, unit, n };
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

  // ---- report a trimmed edge, rather than trimming it silently --------------
  //
  // A second, independent MIN/MAX over the same rows -- deliberately not
  // reusing the __bounds CTE above, which is scoped to a query that may by
  // now have zero surviving rows (every period was partial: a data set
  // that doesn't span one full period yet). `LEFT JOIN ... ON TRUE` from
  // THIS bounds query is what guarantees at least one output row exists to
  // carry the two flags even then -- a plain join would multiply zero rows
  // by one and lose them, the exact failure mode a same-query flag would
  // have had. The caller (server.ts) strips "__partial_start"/
  // "__partial_end" before a chart ever sees them and decides what, if
  // anything, to show about a trimmed edge -- this only ever reports
  // whether trimming happened, never re-decides whether TO trim.
  if (partialBounds) {
    const { ref, grain, unit, n } = partialBounds;
    const boundsTrunc = (v: string) => conn.dateTrunc(grain, v);
    const hiBucketEnd = conn.dateAdd("day", conn.dateAdd(unit, boundsTrunc("__report_bounds.hi"), n), -1);
    const startFlag = `(${boundsTrunc("__report_bounds.lo")} <> __report_bounds.lo) AS ${q("__partial_start")}`;
    const endFlag = `(${hiBucketEnd} <> __report_bounds.hi) AS ${q("__partial_end")}`;
    sql = `WITH __report_bounds AS (\n  SELECT MIN(${ref}) AS lo, MAX(${ref}) AS hi\n  FROM ${from}` +
          clause("  WHERE", where) + `\n),\n__report AS (\n${sql}\n)\n` +
          `SELECT __report.*, ${startFlag}, ${endFlag}\n` +
          `FROM __report_bounds LEFT JOIN __report ON TRUE`;
  }

  if (groupCols.length) sql += `\nORDER BY ${groupCols[0]} NULLS LAST`;
  sql += `\nLIMIT ${Math.min(tile.limit ?? 500, 5000)}`;
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
