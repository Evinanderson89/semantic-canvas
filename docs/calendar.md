# The calendar

Status: **built**: week start, fiscal year start, time zone, and a pinned today for sample data.

## Why

Weeks started on Monday, quarters and years were calendar ones, and timestamps were cut in UTC. A retailer whose week starts Sunday, a company whose year starts in February, or a team in New York looking at UTC timestamps got periods that were not theirs — and the partial-period and lagging-comparison rules judged the wrong edges. The calendar is one declaration on the model, and everything that cuts a period follows it.

```yaml
model:
  name: warehouse
  calendar:
    week_start: sunday            # monday (default) or sunday
    fiscal_year_start_month: 2    # 1 (default) to 12
    timezone: America/New_York    # an IANA zone; absent means timestamps are read as they are
    today: "2026-08-31"           # sample and demo models only: the clock stops here
```

### A pinned today

Pinned dates must be real calendar dates in `YYYY-MM-DD` form. Model loading rejects impossible days such as `2026-02-30` and non-leap-year February 29 instead of letting JavaScript normalize them into March while the warehouse rejects them. The fixture generator applies the same validation before writing files. Returned invalid date labels remain data-quality findings; they cannot supply a fabricated day for freshness or future-date fixes.

A dataset that stops on a known date, such as the sample lake, drifts against the wall clock: the week after it was made, "last 7 days" is empty and every chart is stale. `calendar.today` pins the model's clock. Date presets, the data-honesty review (partial, stale, lagging and future rows), the fixes it offers and the watches that run on the model all read today from there, so the same charts say the same thing on any day. Never set it on a real warehouse: a pinned today would hide that its data has stopped, which is exactly what the review exists to say. The sample warehouse pins 31 August 2026 and the messy lake 13 September 2026.

## What follows it

- **The compiler.** `week:` cuts on the declared start day; `quarter:` and `year:` cut on the fiscal year (a bucket is named by its first day: the quarter starting 1 August, the year starting 1 February). A timestamp column is converted to the zone before any period is cut; a date column is left alone. Period-over-period (`compare: prior|yoy`) and the edge-completeness flags work on the same buckets, so a partial fiscal quarter is left out and labelled exactly as a partial calendar one was.
- **The date presets.** Every preset ends on today's date in the model's reporting timezone (UTC when omitted), regardless of the browser or server timezone. A pinned `calendar.today` is used literally without another timezone conversion. *This quarter* and *Year to date* start on the fiscal quarter and year. *Last N days* counts calendar dates inclusively, including across daylight-saving changes. Date controls send an exclusive next-day upper bound so the final reporting day is included. Presets and watch evaluation share reporting-date and period-boundary helpers.
- **Drill-down.** Clicking a week, quarter or year uses the model's week start and fiscal start month, then requests the next finer grain inside that exact half-open date range. Fiscal breadcrumbs name the starting month rather than assuming a fiscal-year numbering convention. Drill-down and watch evaluation share the same bucket-start and bucket-advance helpers.
- **Date-only range filters.** Bounds written as `YYYY-MM-DD` use the reporting zone for timestamp columns, matching the bucket grouping. This includes drill ranges and date controls, so crossing a daylight-saving boundary does not include an event from the adjacent reporting day. Date columns need no conversion. Explicit timestamp bounds and discrete values retain their raw-column semantics; security allow-lists remain discrete and unchanged. A connector unable to perform the declared timezone conversion rejects the query.
- **The data-honesty rules.** A year bucket ends twelve months after it starts, whichever month that is; stale and lagging judgements use the same bucket ends.

## What it does not do yet

- 4-4-5 and 5-4-4 retail calendars, and 52/53-week years: these need a calendar table rather than a rule. Declaring one (`calendar: { table: dim_date, ... }`) is the next step.
- Per-user time zones: one zone per model. A team split across zones picks the reporting zone.
- Snowflake: `CONVERT_TIMEZONE` is used for timestamps; DuckDB: `timezone()`. The dbt and Snowflake-semantic adapters do not carry a calendar yet.

## Declaring what period a source row represents

A date primary key establishes uniqueness. It does not mean a daily row represents an entire month. In a duckglue model, a table of whole-period summaries can declare its period explicitly:

```yaml
tables:
  fct_saas_monthly:
    grain: one row per calendar month
    primary_key: month
    period: { column: month, grain: month }
    columns:
      - { name: month, type: date }
      - { name: marketing_spend_usd, type: double }
      - { name: new_customers, type: bigint }
```

`period.column` must name a date or timestamp column on the table. `period.grain` is day, week, month, quarter or year, using the model's reporting calendar. Each row represents the whole declared period containing that date. The declaration is supplied by the model author; it does not certify that every expected row or period has arrived. The metric evidence panel displays it.

At the declared grain, a summary dated on the first day is retained. At a compatible coarser grain, each row contributes its declared period's start and end to the edge check: April, May and June summaries cover Q2, while July and August do not cover Q3. A daily date key without a period declaration retains the normal observed-edge checks. Native metric declarations (`time_grains` with `time_dimension`) can also identify an exact native axis when every component agrees; they do not exempt a different date field.

Period rows cannot be split into finer reporting grains. Monthly summaries support month, quarter and year, subject to each metric's own restrictions. Weekly summaries cannot be allocated to months or years because their boundaries cross. A period declaration does not make summing balances or averaging ratios correct: the governed metric expression and its allowed grains still own rollup arithmetic. The included monthly CAC ratio is rollup-safe; Ending MRR remains month-only.

Partial edge periods are excluded from displayed results and cannot supply a prior-period or year-over-year comparison baseline. The comparison stays null when its baseline is excluded. Explicit date-range windows remain visible under the existing query contract, with their bounds in the chart's scope; choosing a window is not a declaration that the underlying source is complete. An excluded date range does not suppress checks on the remaining edges.

The new table declaration is currently read from duckglue YAML. Connected registration and Modeler extension schemas do not yet accept it; they continue to support their existing metric-grain declarations where available.
