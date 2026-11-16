/**
 * Time-grain drill-down: click a bucket on a time-series chart to zoom into
 * it at the next finer grain, scoped to that bucket's exact date range.
 * Pure date math over the compiler's reporting-calendar bucket labels.
 * Use the model's week/fiscal boundaries, independent of the viewer's zone.
 *
 * Deliberately skips "week" in the drill chain: a week does not nest inside
 * a month, so month -> week -> [back to month] would show a different set of
 * days than the month it came from. Month drills straight to day; week (when
 * it's the tile's own starting grain) also drills to day.
 */
import { DEFAULT_CALENDAR, type Calendar } from "../semantic/model.ts";
import { nextPeriod, periodStart } from "../semantic/calendar.ts";
import type { TileSpec } from "../compiler/spec.ts";

export type DrillGrain = "day" | "week" | "month" | "quarter" | "year";

export const NEXT_GRAIN: Record<DrillGrain, DrillGrain | null> = {
  year: "quarter", quarter: "month", month: "day", week: "day", day: null,
};

export interface DrillEntry {
  grain: DrillGrain;
  /** Raw column being drilled, e.g. "event_date" or "table.event_date". */
  column: string;
  /** Half-open range [min, max) as ISO dates, at the CLICKED bucket's grain. */
  min: string;
  max: string;
  label: string;
}

export type DrillSessions = Record<string, { query: string; entries: DrillEntry[] }>;
/** Exploration belongs to the metric, grouping and authored filters that were
 * clicked. Layout, titles and formatting can change without losing that view. */
export const drillQueryKey = (tile: TileSpec) => JSON.stringify([tile.kind ?? "metric", tile.metrics, tile.dimensions, tile.where ?? []]);
export function retainDrillSessions(tiles: TileSpec[], sessions: DrillSessions): DrillSessions {
  const byId = new Map(tiles.map(tile => [tile.id, tile]));
  const entries = Object.entries(sessions).filter(([id, session]) => {
    const tile = byId.get(id); return tile && session.query === drillQueryKey(tile);
  });
  return entries.length === Object.keys(sessions).length ? sessions : Object.fromEntries(entries);
}

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const isoOf = (d: Date) => iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());

const MONTH_LABEL = new Intl.DateTimeFormat(undefined, { month: "short", year: "numeric", timeZone: "UTC" });

/** The [min, max) range and a display label for the bucket `date` falls in
 *  at the given grain -- e.g. bucketRange("month", <2026-03-17>) covers all
 *  of March 2026. */
export function bucketRange(grain: DrillGrain, date: Date, calendar: Calendar = DEFAULT_CALENDAR): { min: string; max: string; label: string } {
  const start = periodStart(date, grain, calendar), end = nextPeriod(start, grain);
  const range = { min: isoOf(start), max: isoOf(end) };
  const fiscal = calendar.fiscalYearStartMonth !== 1;
  switch (grain) {
    case "year":
      return { ...range, label: fiscal ? `Fiscal year from ${MONTH_LABEL.format(start)}` : String(start.getUTCFullYear()) };
    case "quarter":
      return { ...range, label: fiscal ? `Fiscal quarter from ${MONTH_LABEL.format(start)}` : `Q${Math.floor(start.getUTCMonth() / 3) + 1} ${start.getUTCFullYear()}` };
    case "month": return { ...range, label: MONTH_LABEL.format(start) };
    case "week": return { ...range, label: `Week of ${range.min}` };
    case "day": return { ...range, label: range.min };
  }
}

/** Builds the next drill-stack entry for a click on a bucket at `grain`,
 *  or null if there's nowhere finer to go (already at day). */
export function drillInto(grain: DrillGrain, column: string, clicked: Date, calendar: Calendar = DEFAULT_CALENDAR): DrillEntry | null {
  const next = NEXT_GRAIN[grain];
  if (!next) return null;
  return { grain: next, column, ...bucketRange(grain, clicked, calendar) };
}
