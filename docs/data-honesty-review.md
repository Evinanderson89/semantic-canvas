# Data-honesty review

Status: **rule 1 built (PR #24); the rest designed**. A third layer of Design review, between the mechanical chart checks and the AI's editorial read.

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

Missing and worth adding to the model: an optional `reporting_lag` on a table ("orders settle after 2 days"), which turns rule 2 and rule 6 from heuristics into declarations.

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

1. Rule 1 (done), the ledger line, rules 2 and 6 with fixes, the `reporting_lag` model field.
2. Rules 3, 4, 5 with fixes.
3. Rules 7, 8, 9: filter suggestions, sharing the presentation work in `filter-presentation.md`.
4. Layout patterns named and applied.
