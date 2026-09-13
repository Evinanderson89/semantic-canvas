# The calendar

Status: **built**: week start, fiscal year start, time zone.

## Why

Weeks started on Monday, quarters and years were calendar ones, and timestamps were cut in UTC. A retailer whose week starts Sunday, a company whose year starts in February, or a team in New York looking at UTC timestamps got periods that were not theirs — and the partial-period and lagging-comparison rules judged the wrong edges. The calendar is one declaration on the model, and everything that cuts a period follows it.

```yaml
model:
  name: warehouse
  calendar:
    week_start: sunday            # monday (default) or sunday
    fiscal_year_start_month: 2    # 1 (default) to 12
    timezone: America/New_York    # an IANA zone; absent means timestamps are read as they are
```

## What follows it

- **The compiler.** `week:` cuts on the declared start day; `quarter:` and `year:` cut on the fiscal year (a bucket is named by its first day: the quarter starting 1 August, the year starting 1 February). A timestamp column is converted to the zone before any period is cut; a date column is left alone. Period-over-period (`compare: prior|yoy`) and the edge-completeness flags work on the same buckets, so a partial fiscal quarter is left out and labelled exactly as a partial calendar one was.
- **The date presets.** *This quarter* and *Year to date* start on the fiscal quarter and year. (*This month* and the *last N days* presets do not change.)
- **The data-honesty rules.** A year bucket ends twelve months after it starts, whichever month that is; stale and lagging judgements use the same bucket ends.

## What it does not do yet

- 4-4-5 and 5-4-4 retail calendars, and 52/53-week years: these need a calendar table rather than a rule. Declaring one (`calendar: { table: dim_date, ... }`) is the next step.
- Per-user time zones: one zone per model. A team split across zones picks the reporting zone.
- Snowflake: `CONVERT_TIMEZONE` is used for timestamps; DuckDB: `timezone()`. The dbt and Snowflake-semantic adapters do not carry a calendar yet.
