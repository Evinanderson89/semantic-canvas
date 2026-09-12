import type { FilterSpec, TileSpec } from "../compiler/spec.ts";
import { parseDimension } from "../compiler/compile.ts";
import { isTemporal, type Model } from "../semantic/model.ts";

/**
 * Data-honesty rules (docs/data-honesty-review.md): the ways a time series
 * lies that can be told from the query result and the model, with no AI.
 * Each finding says what is wrong in plain words and carries fixes the
 * person applies; nothing here changes a tile on its own.
 *
 * Phase 1: rule 2 (lagging comparison) and rule 6 (stale data). Rule 1
 * (partial edge periods) lives in the compiler, which leaves a partial
 * edge bucket out and reports it as `partial`; these rules read that flag.
 */
export type HonestyRule = "lagging" | "stale";

export type HonestyFix =
  /** Append "(through <date>)" to the tile's title. */
  | { kind: "label-through"; date: string }
  /** Append "(as of <date>)" to the tile's title. */
  | { kind: "label-as-of"; date: string }
  /** Add a range filter that leaves out buckets from `before` on, so an unsettled newest period is not compared. */
  | { kind: "exclude-unsettled"; field: string; before: string }
  /** Add a text tile to the dashboard saying what date the data runs through. */
  | { kind: "freshness-note"; date: string };

export interface HonestyFinding {
  rule: HonestyRule;
  tileId: string;
  title: string;
  /** The finding in words, for the card. */
  text: string;
  fixes: HonestyFix[];
  /** Stable across re-scans while nothing changed, so a dismissal holds. */
  key: string;
}

export interface HonestyInput {
  tile: TileSpec;
  model: Model;
  columns: string[];
  rows: unknown[][];
  partial: { start: boolean; end: boolean };
  /** The grouped time dimension, e.g. "week:fct_web_sessions.session_date". */
  timeDimension: string;
  /** Every filter the query ran with (the tile's own, the dashboard's, a drill's). */
  where?: FilterSpec[];
  today: Date;
}

const DAY = 86_400_000;

/** A date at UTC midnight from a result value ("2026-08-24", a Date, or a timestamp). */
export function toUtcDay(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : new Date(Date.UTC(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate()));
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

/** The first day after a bucket that starts on `start` at `grain`. */
export function bucketEnd(start: Date, grain: string): Date {
  const y = start.getUTCFullYear(), mo = start.getUTCMonth(), d = start.getUTCDate();
  switch (grain) {
    case "week": return new Date(Date.UTC(y, mo, d + 7));
    case "month": return new Date(Date.UTC(y, mo + 1, 1));
    case "quarter": return new Date(Date.UTC(y, mo + 3, 1));
    case "year": return new Date(Date.UTC(y + 1, 0, 1));
    default: return new Date(Date.UTC(y, mo, d + 1));
  }
}

/** Roughly how long one bucket is, for "a whole period is missing" tests. */
const grainDays: Record<string, number> = { day: 1, week: 7, month: 30, quarter: 91, year: 365 };

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY);

/** "Aug 31" this year, "Aug 31, 2025" otherwise. */
export function sayDate(isoDate: string, today: Date): string {
  const d = toUtcDay(isoDate);
  if (!d) return isoDate;
  const sameYear = d.getUTCFullYear() === today.getUTCFullYear();
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: sameYear ? undefined : "numeric", timeZone: "UTC" });
}

const periodWord = (g: string) => ({ week: "week", month: "month", quarter: "quarter", year: "year" }[g] ?? "period");

/**
 * Review one time-series tile's result. Returns zero, one or two findings.
 */
export function reviewDataHonesty(input: HonestyInput): HonestyFinding[] {
  const { tile, model, columns, rows, partial, timeDimension, where = [], today } = input;
  const { grain, table, column } = parseDimension(timeDimension);
  if (!grain) return [];
  const metric = model.metrics[tile.metrics[0]];
  if (!metric) return [];
  const owner = table ?? metric.baseTable;
  const tbl = model.tables[owner];
  if (!tbl) return [];
  const alias = `${column}_${grain}`;
  const idx = columns.indexOf(alias);
  if (idx === -1) return [];

  // The newest bucket in the result. With partial edges already left out
  // by the compiler this is the newest COMPLETE bucket.
  let newest: Date | null = null;
  for (const r of rows) { const d = toUtcDay(r[idx]); if (d && (!newest || d > newest)) newest = d; }
  if (!newest) return [];
  const newestEnd = bucketEnd(newest, grain);
  const dataThrough = iso(addDays(newestEnd, -1));
  const todayUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const lag = Math.max(0, Math.floor(tbl.reportingLagDays ?? 0));
  const title = tile.title ?? tile.metrics.map((m) => model.metrics[m]?.label ?? m).join(", ");
  const findings: HonestyFinding[] = [];

  // Rule 2: a comparison against a period that is not finished, or that the
  // table says is still settling.
  const comparing = tile.compare === "prior" || tile.compare === "yoy";
  if (comparing) {
    const against = tile.compare === "yoy" ? "the same period last year" : `the ${periodWord(grain)} before`;
    // The newest bucket is complete by the calendar but inside the table's
    // reporting lag: its rows are still arriving, so its change reads low.
    if (lag > 0 && addDays(newestEnd, lag) > todayUtc) {
      findings.push({
        rule: "lagging", tileId: tile.id, title, key: `lagging:${tile.id}:${iso(newest)}:settling`,
        text: `${tbl.name} settles after ${lag} day${lag === 1 ? "" : "s"}, so the ${periodWord(grain)} starting ${sayDate(iso(newest), today)} is still filling in; its change against ${against} reads low.`,
        fixes: [
          { kind: "exclude-unsettled", field: `${owner}.${column}`, before: iso(newest) },
          { kind: "label-through", date: dataThrough },
        ],
      });
    } else if (partial.end) {
      findings.push({
        rule: "lagging", tileId: tile.id, title, key: `lagging:${tile.id}:${iso(newest)}:partial`,
        text: `The newest ${periodWord(grain)} is not finished and is left out, so the change shown is the ${periodWord(grain)} through ${sayDate(dataThrough, today)} against ${against}. Say so, or readers will take it for the current ${periodWord(grain)}.`,
        fixes: [{ kind: "label-through", date: dataThrough }],
      });
    }
  }

  // Rule 6: the newest bucket ends more than one grain before today, after
  // allowing for the table's reporting lag: at least one whole period is
  // missing. A partial newest bucket means data reaches into the current
  // period, which is fresh by definition; and a range filter bounding the
  // end is the person's own window, not stale data.
  const boundedEnd = where.some((f) => f.source === "dimension" && f.mode === "range" && f.max != null && !f.exclude
    && (f.field === column || f.field === `${owner}.${column}`));
  if (!partial.end && !boundedEnd) {
    const expectedBy = addDays(todayUtc, -(grainDays[grain] ?? 1) - lag);
    if (newestEnd < expectedBy) {
      findings.push({
        rule: "stale", tileId: tile.id, title, key: `stale:${tile.id}:${dataThrough}`,
        text: `Data ends ${sayDate(dataThrough, today)}; today is ${sayDate(iso(todayUtc), today)}. Drawn without a date, the chart reads as current.`,
        fixes: [{ kind: "label-as-of", date: dataThrough }, { kind: "freshness-note", date: dataThrough }],
      });
    }
  }
  return findings;
}

const SUFFIX = /\s*\((?:through|as of) [^)]*\)\s*$/;

/** Apply a title-level fix to a tile; idempotent, one suffix at a time. */
export function labelTile(tile: TileSpec, baseTitle: string, fix: Extract<HonestyFix, { kind: "label-through" | "label-as-of" }>, today: Date): TileSpec {
  const clean = (tile.title ?? baseTitle).replace(SUFFIX, "");
  const word = fix.kind === "label-through" ? "through" : "as of";
  return { ...tile, title: `${clean} (${word} ${sayDate(fix.date, today)})` };
}

/** The filter an "exclude unsettled" fix adds; replaces an earlier one of its own. */
export function unsettledFilter(tileId: string, fix: Extract<HonestyFix, { kind: "exclude-unsettled" }>): FilterSpec {
  return { id: `honesty:${tileId}:settled`, field: fix.field, source: "dimension", mode: "range", max: fix.before, maxExclusive: true };
}

/** Whether the compiler would treat this dimension's table as a snapshot (nothing to be partial about). Exported for tests and callers that skip such tiles. */
export function isPeriodKeyed(model: Model, tile: TileSpec, timeDimension: string): boolean {
  const { grain, table, column } = parseDimension(timeDimension);
  const metric = model.metrics[tile.metrics[0]];
  if (!grain || !metric) return false;
  const owner = table ?? metric.baseTable;
  const tbl = model.tables[owner];
  const pk = tbl?.primaryKey ? tbl.columns.find((c) => c.name === tbl.primaryKey) : undefined;
  const native = tile.metrics.some((m) => model.metrics[m]?.timeGrains?.includes(grain as never));
  return native || (!!pk && isTemporal(pk) && pk.name === column);
}

