import type { Connector } from "../connectors/types.ts";
import { timeColumnOf, todayOf, type Model } from "../semantic/model.ts";

export type TableHealthStatus = "fresh" | "stale" | "empty";

export interface TableHealthEntry {
  table: string;
  name: string;
  dateColumn: string | null;
  rowCount: number;
  minDate: string | null;
  maxDate: string | null;
  lagDays: number | null;
  slaDays: number;
  status: TableHealthStatus;
}

export interface SourceHealthReport {
  source: string;
  checkedAt: string;
  referenceDate: string;
  healthy: boolean;
  tables: TableHealthEntry[];
}

function normalizeDate(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = value instanceof Date ? value.toISOString() : String(value);
  const match = text.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : text.slice(0, 10) || null;
}

export async function checkSourceHealth(
  model: Model,
  conn: Connector,
  now = todayOf(model),
): Promise<SourceHealthReport> {
  const referenceDate = now.toISOString().slice(0, 10);
  const refMs = Date.parse(`${referenceDate}T00:00:00Z`);
  const tables: TableHealthEntry[] = [];

  for (const table of Object.values(model.tables)) {
    const rawTimeCol = timeColumnOf(model, table.name);
    const dateCol = rawTimeCol?.startsWith(`${table.name}.`)
      ? rawTimeCol.slice(table.name.length + 1)
      : rawTimeCol;
    const relation = table.relation ? conn.relation(table.name, table.relation) : conn.relation(table.name);
    const sql = `SELECT COUNT(*) AS n${dateCol ? `, MIN(${conn.quote(dateCol)}) AS min_d, MAX(${conn.quote(dateCol)}) AS max_d` : ""} FROM ${relation}`;
    const res = await conn.execute(sql, 1);
    const row = res.rows[0] ?? [];
    const rowCount = Number(row[0] ?? 0);
    const minDate = dateCol && rowCount > 0 ? normalizeDate(row[1]) : null;
    const maxDate = dateCol && rowCount > 0 ? normalizeDate(row[2]) : null;
    const maxMs = maxDate !== null ? Date.parse(`${maxDate}T00:00:00Z`) : Number.NaN;
    const lagDays = Number.isFinite(maxMs) ? Math.round((refMs - maxMs) / 86_400_000) : null;
    const slaDays = table.reportingLagDays ?? (table.period?.grain === "month" ? 35 : table.period?.grain === "week" ? 10 : 7);
    const status: TableHealthStatus =
      rowCount === 0 ? "empty" : lagDays !== null && lagDays > slaDays ? "stale" : "fresh";

    tables.push({
      table: table.name,
      name: table.name,
      dateColumn: dateCol ?? null,
      rowCount,
      minDate,
      maxDate,
      lagDays,
      slaDays,
      status,
    });
  }

  return {
    source: model.name,
    checkedAt: new Date().toISOString(),
    referenceDate,
    healthy: tables.every((t) => t.status === "fresh"),
    tables,
  };
}
