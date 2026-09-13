import type { Connector } from "../connectors/types.ts";
import { findKey, normalizeType, type ColumnProfile, type JoinProbe, type TableProfile } from "./propose.ts";

/**
 * Reading the warehouse for the Modeler: the catalogue (tables and their
 * columns, from the connector), then one aggregate query per table for row
 * count, null counts, distinct counts and date/number ranges, then one
 * query per candidate join for how many keys resolve. Read-only, bounded
 * (columns and tables are capped), and every query goes through the same
 * connector a dashboard uses, so it sees exactly what a chart would.
 */
export const LIMITS = { tables: 200, columns: 80, probes: 60 };

const ID_LIKE = /(^|_)(id|key|code|uuid)$/i;

export async function profileTables(conn: Connector, tables: { name: string; columns: { name: string; type: string }[]; relation?: TableProfile["relation"] }[], onProgress?: (done: number, total: number) => void): Promise<TableProfile[]> {
  const out: TableProfile[] = [];
  const list = tables.slice(0, LIMITS.tables);
  for (const [i, t] of list.entries()) {
    const columns = t.columns.slice(0, LIMITS.columns).map((c) => ({ ...c, type: normalizeType(c.type) }));
    const q = (s: string) => conn.quote(s);
    const parts = ["COUNT(*) AS n"];
    for (const [j, c] of columns.entries()) {
      parts.push(`COUNT(${q(c.name)}) AS ${q(`nn${j}`)}`);
      parts.push(`COUNT(DISTINCT ${q(c.name)}) AS ${q(`d${j}`)}`);
      if (["date", "timestamp", "integer", "double"].includes(c.type)) {
        parts.push(`MIN(${q(c.name)}) AS ${q(`mn${j}`)}`, `MAX(${q(c.name)}) AS ${q(`mx${j}`)}`);
      }
    }
    const sql = `SELECT ${parts.join(", ")} FROM ${conn.relation(t.name, t.relation)}`;
    const r = await conn.execute(sql, 1);
    const row = r.rows[0] ?? [];
    const col = (name: string) => { const i = r.columns.indexOf(name); return i === -1 ? null : row[i]; };
    const rows = Number(col("n") ?? 0);
    out.push({
      name: t.name, rows, relation: t.relation,
      columns: columns.map((c, j): ColumnProfile => ({
        name: c.name, type: c.type, rawType: tables[i].columns[j]?.type ?? c.type,
        nonNull: Number(col(`nn${j}`) ?? 0), distinct: Number(col(`d${j}`) ?? 0),
        min: col(`mn${j}`) as ColumnProfile["min"], max: col(`mx${j}`) as ColumnProfile["max"],
      })),
    });
    onProgress?.(i + 1, list.length);
  }
  return out;
}

/** Candidate joins by name, exactly as propose() would pair them, so each can be probed. */
export function joinCandidates(profiles: TableProfile[]): Omit<JoinProbe, "leftRows" | "matched">[] {
  const keys = new Map(profiles.map((t) => [t.name, findKey(t)]));
  const out: Omit<JoinProbe, "leftRows" | "matched">[] = [];
  for (const t of profiles) {
    const own = keys.get(t.name);
    for (const c of t.columns) {
      if (own && c.name === own.name) continue;
      if (!ID_LIKE.test(c.name)) continue;
      const exact = profiles.filter((x) => x.name !== t.name && keys.get(x.name)?.name === c.name);
      const target = exact.length === 1 ? exact[0] : exact.find((x) => /^dim_/.test(x.name));
      if (target) out.push({ left: t.name, leftOn: c.name, right: target.name, rightOn: keys.get(target.name)!.name });
    }
  }
  return out.slice(0, LIMITS.probes);
}

export async function probeJoins(conn: Connector, profiles: TableProfile[], candidates = joinCandidates(profiles)): Promise<JoinProbe[]> {
  const rel = (name: string) => conn.relation(name, profiles.find((p) => p.name === name)?.relation);
  const q = (s: string) => conn.quote(s);
  const out: JoinProbe[] = [];
  for (const c of candidates) {
    const sql = `SELECT COUNT(l.${q(c.leftOn)}) AS n, COUNT(r.${q(c.rightOn)}) AS matched FROM ${rel(c.left)} AS l LEFT JOIN (SELECT DISTINCT ${q(c.rightOn)} FROM ${rel(c.right)}) AS r ON l.${q(c.leftOn)} = r.${q(c.rightOn)}`;
    try {
      const r = await conn.execute(sql, 1);
      const row = r.rows[0] ?? [];
      out.push({ ...c, leftRows: Number(row[r.columns.indexOf("n")] ?? 0), matched: Number(row[r.columns.indexOf("matched")] ?? 0) });
    } catch {
      // A type mismatch across the two columns is itself an answer: nothing resolves.
      out.push({ ...c, leftRows: 1, matched: 0 });
    }
  }
  return out;
}
