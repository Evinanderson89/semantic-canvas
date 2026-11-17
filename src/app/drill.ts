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
 *
 * A drill only steps to a grain the tile can actually be reported at. A
 * metric restricted to month reporting (a closing balance such as Ending MRR)
 * or a time column that holds whole-month periods has nothing finer than
 * month: stepping to day would ask the server for a query it must reject.
 * `drillGrain` asks the compiler's own validation which finer grain is
 * allowed, skipping disallowed steps and returning null when none is.
 */
import { DEFAULT_CALENDAR, type Calendar, type Model } from "../semantic/model.ts";
import { validateTile } from "../compiler/compile.ts";
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
export function retainDrillSessions(tiles: TileSpec[], sessions: DrillSessions, model?: Model | null): DrillSessions {
  const byId = new Map(tiles.map(tile => [tile.id, tile]));
  let changed = false;
  const entries = Object.entries(sessions).flatMap(([id, session]): [string, DrillSessions[string]][] => {
    const tile = byId.get(id);
    if (!tile || session.query !== drillQueryKey(tile)) { changed = true; return []; }
    // A drill opened before its grain was known to be invalid (or before the
    // model's grain rules changed) recovers to the deepest valid level.
    const valid = model ? compatibleDrill(model, tile, session.entries) : session.entries;
    if (valid.length === session.entries.length) return [[id, session]];
    changed = true;
    return valid.length ? [[id, { ...session, entries: valid }]] : [];
  });
  return changed ? Object.fromEntries(entries) : sessions;
}

const timeIndex = (tile: TileSpec) => (tile.dimensions ?? []).findIndex(d => d.includes(":"));
const withGrain = (tile: TileSpec, index: number, grain: DrillGrain): TileSpec =>
  ({ ...tile, dimensions: tile.dimensions.map((d, i) => i === index ? `${grain}:${d.split(":").slice(1).join(":")}` : d) });

/** Whether the tile can be reported at `grain` on its time dimension: the
 *  change introduces no validation problem the tile does not already have
 *  (metric reporting grains, whole-period columns, unknown grains). */
export function drillGrainAllowed(model: Model, tile: TileSpec, grain: DrillGrain): boolean {
  const index = timeIndex(tile);
  if (index === -1) return false;
  const known = new Set(validateTile(model, tile).map(i => i.problem));
  return validateTile(model, withGrain(tile, index, grain)).every(i => known.has(i.problem));
}

/** The grain a click on the tile's time bucket should open: the next finer
 *  grain the tile allows, skipping disallowed ones (year -> month when
 *  quarter is not allowed), or null when no finer grain is valid. `tile`
 *  carries the dimensions currently shown, including any active drill. */
export function drillGrain(model: Model, tile: TileSpec): DrillGrain | null {
  const index = timeIndex(tile);
  if (index === -1) return null;
  for (let next = NEXT_GRAIN[tile.dimensions[index].split(":")[0] as DrillGrain]; next; next = NEXT_GRAIN[next])
    if (drillGrainAllowed(model, tile, next)) return next;
  return null;
}

/** The leading entries of a drill stack the tile can still be reported at;
 *  everything from the first incompatible level on is dropped. */
export function compatibleDrill(model: Model, tile: TileSpec, entries: DrillEntry[]): DrillEntry[] {
  const invalid = entries.findIndex(entry => !drillGrainAllowed(model, tile, entry.grain));
  return invalid === -1 ? entries : entries.slice(0, invalid);
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
 *  or null if there's nowhere finer to go (already at day, or `next` -- from
 *  `drillGrain` -- says no finer grain is valid for the tile). */
export function drillInto(grain: DrillGrain, column: string, clicked: Date, calendar: Calendar = DEFAULT_CALENDAR,
  next: DrillGrain | null = NEXT_GRAIN[grain]): DrillEntry | null {
  if (!next) return null;
  return { grain: next, column, ...bucketRange(grain, clicked, calendar) };
}
