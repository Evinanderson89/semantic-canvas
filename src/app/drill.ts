/**
 * Time-grain drill-down: click a bucket on a time-series chart to zoom into
 * it at the next finer grain, scoped to that bucket's exact date range.
 * Pure date math, UTC throughout -- rows come from the warehouse as UTC
 * dates and the compiler's date_trunc runs UTC, so this must too or a
 * clicked bucket's boundary would drift a day depending on the viewer's
 * timezone.
 *
 * Deliberately skips "week" in the drill chain: a week does not nest inside
 * a month, so month -> week -> [back to month] would show a different set of
 * days than the month it came from. Month drills straight to day; week (when
 * it's the tile's own starting grain) also drills to day.
 */
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

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const isoOf = (d: Date) => iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());

const MONTH_LABEL = new Intl.DateTimeFormat(undefined, { month: "short", year: "numeric", timeZone: "UTC" });

/** The [min, max) range and a display label for the bucket `date` falls in
 *  at the given grain -- e.g. bucketRange("month", <2026-03-17>) covers all
 *  of March 2026. */
export function bucketRange(grain: DrillGrain, date: Date): { min: string; max: string; label: string } {
  const y = date.getUTCFullYear();
  switch (grain) {
    case "year":
      return { min: iso(y, 1, 1), max: iso(y + 1, 1, 1), label: String(y) };
    case "quarter": {
      const q = Math.floor(date.getUTCMonth() / 3);
      const startMonth = q * 3 + 1;
      const wraps = startMonth + 3 > 12;
      return {
        min: iso(y, startMonth, 1),
        max: iso(wraps ? y + 1 : y, wraps ? startMonth + 3 - 12 : startMonth + 3, 1),
        label: `Q${q + 1} ${y}`,
      };
    }
    case "month": {
      const m = date.getUTCMonth() + 1;
      const wraps = m === 12;
      return {
        min: iso(y, m, 1), max: iso(wraps ? y + 1 : y, wraps ? 1 : m + 1, 1),
        label: MONTH_LABEL.format(date),
      };
    }
    case "week": {
      // Monday-start, matching DuckDB's date_trunc('week', ...) (ISO weeks).
      const dow = (date.getUTCDay() + 6) % 7; // 0=Mon .. 6=Sun
      const start = new Date(Date.UTC(y, date.getUTCMonth(), date.getUTCDate() - dow));
      const end = new Date(start.getTime() + 7 * 86400000);
      return { min: isoOf(start), max: isoOf(end), label: `Week of ${isoOf(start)}` };
    }
    case "day": {
      const next = new Date(date.getTime() + 86400000);
      return { min: isoOf(date), max: isoOf(next), label: isoOf(date) };
    }
  }
}

/** Builds the next drill-stack entry for a click on a bucket at `grain`,
 *  or null if there's nowhere finer to go (already at day). */
export function drillInto(grain: DrillGrain, column: string, clicked: Date): DrillEntry | null {
  const next = NEXT_GRAIN[grain];
  if (!next) return null;
  return { grain: next, column, ...bucketRange(grain, clicked) };
}
