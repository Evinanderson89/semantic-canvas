import { DEFAULT_CALENDAR, type Calendar, type TimeGrain } from "./model.ts";

/** Date.parse accepts overflow days such as February 30; a reporting day must
 * round-trip unchanged instead of silently becoming a day in another month. */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** A reporting date expressed at midnight UTC for date arithmetic. The model's
 * pinned date is already a calendar label, not an instant to convert again. */
export function reportingDay(now: Date, calendar: Calendar = DEFAULT_CALENDAR): Date {
  if (calendar.today) return new Date(`${calendar.today}T00:00:00Z`);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: calendar.timezone ?? "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const value = (type: string) => parts.find(p => p.type === type)!.value;
  return new Date(`${value("year")}-${value("month")}-${value("day")}T00:00:00Z`);
}

/** Bucket labels are reporting-calendar dates, not timezone-bearing instants.
 * SQL already converts timestamps to the model's zone before making a label;
 * converting that label again would move the clicked bucket to another day. */
export function periodStart(input: Date, grain: TimeGrain, calendar: Calendar = DEFAULT_CALENDAR) {
  const d = new Date(input); d.setUTCHours(0, 0, 0, 0);
  if (grain === "week") d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + (calendar.weekStart === "sunday" ? 0 : 6)) % 7);
  if (["month", "quarter", "year"].includes(grain)) d.setUTCDate(1);
  const shift = calendar.fiscalYearStartMonth - 1;
  if (grain === "quarter") d.setUTCMonth(Math.floor((d.getUTCMonth() - shift) / 3) * 3 + shift);
  if (grain === "year") d.setUTCMonth(d.getUTCMonth() < shift ? shift - 12 : shift);
  return d;
}

/** Advance a bucket's first day; month/quarter/year callers supply a start label. */
export function nextPeriod(input: Date, grain: TimeGrain, n = 1) {
  const d = new Date(input);
  if (grain === "day" || grain === "week") d.setUTCDate(d.getUTCDate() + n * (grain === "week" ? 7 : 1));
  else d.setUTCMonth(d.getUTCMonth() + n * (grain === "year" ? 12 : grain === "quarter" ? 3 : 1));
  return d;
}
