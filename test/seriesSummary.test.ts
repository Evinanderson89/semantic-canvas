import { afterEach, expect, it, vi } from "vitest";
import { summarizeMetricSeries, seriesSummarySchema } from "../src/suggest/seriesSummary.ts";
import { TOOLS, runToolInContext } from "../src/agent/tools.ts";
import { DEFAULT_CALENDAR } from "../src/semantic/model.ts";

const tile = { metrics: ["retention"], dimensions: ["month:observed_on"] };
const input = { metric: "retention", lastPeriods: 7, threshold: 1 };
const result = (rows: unknown[][]) => ({ columns: ["observed_on_month", "retention"], rows });
afterEach(() => vi.unstubAllGlobals());

it("counts raw threshold crossings in the specified calendar window, independent of row order", () => {
  const rows = Array.from({ length: 8 }, (_, i) => [`2026-${String(i + 1).padStart(2, "0")}-01`, i ? 1.00001 : .99]);
  const summary = summarizeMetricSeries(tile, result(rows.reverse()), input);
  expect(summary).toMatchObject({ status: "computed", window: { start: "2026-02-01", end: "2026-08-01" },
    requestedPeriods: 7, returnedPeriods: 7, numericPeriods: 7, unreturnedPeriods: 0,
    threshold: { value: 1, above: 7, equal: 0, below: 0 } });
});

it("keeps absent periods, nulls, exact boundary values and measured zero distinct", () => {
  const summary = summarizeMetricSeries(tile, result([["2026-02-01", 0], ["2026-04-01", null], ["2026-05-01", .99999], ["2026-06-01", 1], ["2026-07-01", 1.00001], ["2026-08-01", null]]), input);
  expect(summary).toMatchObject({ returnedPeriods: 6, numericPeriods: 4, nullOrNonNumericPeriods: 2,
    unreturnedPeriods: 1, first: 0, last: null, minimum: 0, maximum: 1.00001,
    threshold: { above: 1, equal: 1, below: 2 } });
});

it("withholds summaries for ambiguous, limited, partial or imprecise evidence", () => {
  const clean = result([["2026-07-01", .99], ["2026-08-01", 1.01]]);
  for (const extra of [{ truncated: true }, { partial: { selected: { end: true } } }, { partial: { ratio: [{}] } }])
    expect(summarizeMetricSeries(tile, { ...clean, ...extra } as typeof clean, input).status).toBe("unavailable");
  for (const rows of [[["2026-02-30", 1]], [["2026-08-02", 1]], [["2026-08-01", 1], ["2026-08-01", 2]], [["2026-08-01", "9007199254740993"]]])
    expect(summarizeMetricSeries(tile, result(rows), input).status).toBe("unavailable");
  for (const dimensions of [[], ["country"], ["month:observed_on", "country"]])
    expect(summarizeMetricSeries({ ...tile, dimensions }, clean, input).status).toBe("unavailable");
  expect(summarizeMetricSeries(tile, clean, { ...input, metric: "another_metric" }).status).toBe("unavailable");
});

it("counts fiscal and weekly bucket labels without pretending excluded buckets are returned", () => {
  const calendar = { ...DEFAULT_CALENDAR, fiscalYearStartMonth: 2, weekStart: "sunday" as const };
  const quarter = summarizeMetricSeries({ ...tile, dimensions: ["quarter:observed_on"] },
    { columns: ["observed_on_quarter", "retention"], rows: [["2026-05-01", 1.1], ["2026-08-01", .9]], partial: { start: true, end: false } },
    { ...input, lastPeriods: 3 }, calendar);
  expect(quarter).toMatchObject({ window: { start: "2026-02-01", end: "2026-08-01" }, unreturnedPeriods: 1, threshold: { above: 1, below: 1 } });
  const week = summarizeMetricSeries({ ...tile, dimensions: ["week:observed_on"] },
    { columns: ["observed_on_week", "retention"], rows: [["2026-03-01", 1.1], ["2026-03-08", 1.2]] }, { ...input, lastPeriods: 2 }, calendar);
  expect(week).toMatchObject({ returnedPeriods: 2, unreturnedPeriods: 0 });
  expect(seriesSummarySchema.safeParse({ ...input, lastPeriods: 5001 }).success).toBe(false);
});

it("summarizes only the query response authorized for the bound source and principal", async () => {
  const fetchMock = vi.fn(async (_url: string, _options: RequestInit) => new Response(JSON.stringify({ ...result([["2026-08-01", 1.1]]), evidence: { reportingCalendar: DEFAULT_CALENDAR } })));
  vi.stubGlobal("fetch", fetchMock);
  const summary = await runToolInContext({ source: "scoped", principal: "emea" }, () =>
    TOOLS.find(t => t.name === "query_metric")!.handler({ ...tile, summarize: { ...input, lastPeriods: 1 } }));
  expect(summary).toMatchObject({ seriesSummary: { status: "computed", threshold: { above: 1 } } });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const options = fetchMock.mock.calls[0][1] as RequestInit;
  expect(new Headers(options.headers).get("x-sc-source")).toBe("scoped");
  expect(new Headers(options.headers).get("x-sc-principal")).toBe("emea");
  expect(JSON.parse(options.body as string)).toEqual(tile);
});
