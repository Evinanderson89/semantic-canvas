# Data-honesty review

Status: **phase 1 built: rule 1 (PR #24), the Data honesty ledger line, rules 2 and 6 with their fixes, and `reporting_lag`; phases 2 to 4 designed**. A third layer of Design review, between the mechanical chart checks and the AI's editorial read.

## Why

Design review today asks whether a chart is drawable: did the query run, is the grain supported, do tiles overlap. It does not ask whether the chart is honest. Time-series data lies in specific, well-known ways, and each way is detectable from the query result and the model without any AI. This layer names those ways, detects them deterministically, and offers a one-click fix the way "Switch to week" does today.

Every rule has three parts: a **signal** the engine can compute, a **finding** in plain words, and a **fix** the person applies. The review never changes a chart on its own.

## Rules

| # | Rule | Signal | Finding | Fix offered |
| --- | --- | --- | --- | --- |
| 1 | **Partial edge period** | The first or last bucket's observed dates do not reach the bucket's edges, on an event table, with no range filter bounding that side | "The first week has one day of data and would read as a collapse." | Left out by default (built). Alternative: "Show as partial" draws it hollow with a note. |
| 2 | **Lagging comparison** | A period-over-period or year-over-year tile whose current bucket is partial, or whose source declares a reporting lag | "August is not finished, so +31% vs last August compares 12 days to 31." | "Compare complete periods only" shifts the comparison to the last complete bucket and labels it "through Aug 12". |
| 3 | **Ratio of unlike coverage** | A metric whose expression divides two aggregates whose base tables have different partial edges or different max dates | "Sessions run through Sep 5 but orders through Aug 31; the conversion rate for September is inflated." | "Align to shared range" bounds both to the earlier max date. |
| 4 | **Cumulative from a cut** | A running total or cumulative metric under a filter or window that removes the series start | "Total to date starts mid-series and looks like growth from zero." | "Show as rolling total" or "Extend to series start". |
| 5 | **Mixed grains in a section** | Sibling tiles in one section carry different time grains | "Daily next to monthly invites a false comparison." | "Align section to month" (the dominant grain). |
| 6 | **Stale data** | The newest bucket is older than today minus one grain, on an event table | "Data ends Sep 5; today is Sep 12." | "Label as of Sep 5" adds the date to the tile; "Add a freshness note" adds it to the dashboard. |
| 7 | **Unfiltered among the filtered** | Every neighbour in a section is bound to a shared filter and one tile is not | "This tile ignores the Region filter the rest of the section uses." | "Bind to Region" or "Move out of section". |
| 8 | **Hard-coded windows** | Several tiles carry the same literal date range in their own filters | "Four charts hard-code Aug 1 to Aug 31; one shared filter would keep them in step." | "Replace with a shared date filter" with a preset. |
| 9 | **No time control** | A dashboard with time-series tiles and no date filter | "Readers cannot change the period." | "Add a period filter" with presets, bound to every time-series tile. |

Rules 1, 2 and 6 need only the query result and the model. Rules 3 and 4 need the metric expressions. Rules 5, 7, 8 and 9 need the dashboard spec. None needs the AI provider.

## Signals the engine already has

- Partial edges: `splitPartialPeriods` flags, from PR #24.
- Newest bucket date and today: the query result and the clock.
- Native grains and snapshot tables: `time_grains` on metrics, `grain` and a date-typed primary key on tables.
- Filter bindings and sections: the dashboard spec.

A table may declare `reporting_lag: 2` (days after a period ends before its rows are all in). Rule 2 then calls a calendar-complete period *settling* while it is inside the lag and offers to leave it out of the comparison; rule 6 allows the lag before calling data stale.

## How phase 1 decides (src/suggest/dataHonesty.ts)

Both rules read the reviewed query's result: the newest bucket of the time dimension (with a partial edge already left out by the compiler, that is the newest complete bucket), the `partial` flags, the filters the query ran with, the table's `reporting_lag`, and the clock.

- **Lagging comparison** fires on a tile with `compare: prior|yoy` when the newest complete bucket is still inside the reporting lag ("fct_orders settles after 2 days, so the week starting Sep 7 is still filling in; its change against the week before reads low" — fixes: *Compare complete periods only*, which adds a range filter ending before that bucket, and *Label as through*), or when the newest bucket was left out as partial ("the change shown is the week through Sep 6 against the week before; say so" — fix: *Label as through*).
- **Stale data** fires when the newest bucket ends more than one grain plus the reporting lag before today, on a tile whose end is not bounded by a range filter the person chose and whose data does not reach into the current period ("Data ends Aug 30; today is Sep 11" — fixes: *Label as of*, which suffixes the title, and *Add a freshness note*, a text tile).
- A finding's key carries the date it is about, so **Dismiss** holds until the data moves on.

## Layout patterns (arrangements)

Design review already proposes a reading order. It should also name the pattern it is proposing so the person knows why tiles moved. Four patterns cover the reference dashboards:

- **Executive**: a row of headline KPIs with change and trend, one lead chart, supporting detail in two columns, notes.
- **Funnel**: stages top to bottom on the left, per-stage trends on the right, rates beside the counts they come from.
- **Columns by theme**: one column per subject, each a stack from headline to detail, narrative at the end.
- **Cohort**: a cohort table or heatmap as the lead, its inputs beside it, a note explaining the diagonal.

Smart arrange applies the chosen pattern; the review suggests one from the tiles present (KPI count, funnel-shaped metrics, a cohort table). Named in the review as "Arrange as: Executive" with a preview, as story structure is today.

## Where findings show

In Design review, under a new "Data honesty" ledger line beside the three that exist. Each finding is a card with the tile name, the finding in words, and the fix buttons. Findings that were dismissed stay dismissed for that document until the data changes.

## Phases

1. Rule 1, the ledger line, rules 2 and 6 with fixes, the `reporting_lag` model field. **Done.**
2. Rules 3, 4, 5 with fixes.
3. Rules 7, 8, 9: filter suggestions, sharing the presentation work in `filter-presentation.md`.
4. Layout patterns named and applied.
