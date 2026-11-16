# Data-honesty review

Status: **rules 0, 1, 2 and 6 built**, with the Data honesty ledger line and `reporting_lag`. Rule 3 also has input-coverage evidence, warnings and comparison/alert guards; its automatic alignment action remains planned. The remaining rules and layout-pattern work below are design proposals. This is a layer of Design review between the mechanical chart checks and the AI's editorial read.

## Why

Design review today asks whether a chart is drawable: did the query run, is the grain supported, do tiles overlap. It does not ask whether the chart is honest. Time-series data lies in specific, well-known ways, and each way is detectable from the query result and the model without any AI. This layer names those ways, detects them deterministically, and offers a one-click fix the way "Switch to week" does today.

Every rule has three parts: a **signal** the engine can compute, a **finding** in plain words, and a **fix** the person applies. The review never changes a chart on its own.

### Evidence before smoothing

The chart-noise check uses finite observations and adjacent observed pairs. Nulls, empty strings, invalid numbers and booleans do not become zeros, and observations on opposite sides of a missing value are not joined to manufacture a change. At least 14 observed values and 13 valid adjacent pairs are required. Segmented series, missing or repeated reporting dates, gaps and truncated results are not treated as one continuous series for this heuristic.

Before recommending a coarser grain, the review queries it and requires a measured improvement of at least 15%, with no worse score for another previously noisy metric. A flat observed result has a score of zero; a result with too little evidence has no score and cannot establish improvement. Missing values remain available in the chart's data checks, with advice to inspect inputs, joins and denominators.

## Rules

| # | Rule | Signal | Finding | Fix offered |
| --- | --- | --- | --- | --- |
| 1 | **Partial edge period** | The first or last bucket's observed dates do not reach the bucket's edges, on an event table, with no range filter bounding that side | "The first week has one day of data and would read as a collapse." | Left out by default (built). Alternative: "Show as partial" draws it hollow with a note. |
| 0 | **Rows dated in the future** | The newest bucket starts after today | "The newest week starts Oct 4, after today: some rows are dated in the future, so the newest periods are not real." | "Leave out rows dated after today" adds a range filter through today. Built; said first, the other rules stand down until fixed. |
| 2 | **Lagging comparison** | A period-over-period or year-over-year tile whose current bucket is partial, or whose source declares a reporting lag | "August is not finished, so +31% vs last August compares 12 days to 31." | "Compare complete periods only" shifts the comparison to the last complete bucket and labels it "through Aug 12". |
| 3 | **Ratio of unlike coverage** | A cross-table time-series ratio has absent, different or partial input windows within a reporting bucket | "The ratio inputs cover different dates; inspect both before interpreting the rate." | Built: input-date evidence, warnings, withheld comparisons and alert checks. Automatic "Align to shared range" remains a proposed action. |
| 4 | **Cumulative from a cut** | A running total or cumulative metric under a filter or window that removes the series start | "Total to date starts mid-series and looks like growth from zero." | "Show as rolling total" or "Extend to series start". |
| 5 | **Mixed grains in a section** | Sibling tiles in one section carry different time grains | "Daily next to monthly invites a false comparison." | "Align section to month" (the dominant grain). |
| 6 | **Stale data** | The newest bucket is older than today minus one grain, on an event table | "Data ends Sep 5; today is Sep 12." | "Label as of Sep 5" adds the date to the tile; "Add a freshness note" adds it to the dashboard. |
| 7 | **Unfiltered among the filtered** | Every neighbour in a section is bound to a shared filter and one tile is not | "This tile ignores the Region filter the rest of the section uses." | "Bind to Region" or "Move out of section". |
| 8 | **Hard-coded windows** | Several tiles carry the same literal date range in their own filters | "Four charts hard-code Aug 1 to Aug 31; one shared filter would keep them in step." | "Replace with a shared date filter" with a preset. |
| 9 | **No time control** | A dashboard with time-series tiles and no date filter | "Readers cannot change the period." | "Add a period filter" with presets, bound to every time-series tile. |

Rules 0, 1, 2 and 6 need only the query result and the model. Rules 3 and 4 need the metric expressions. Rules 5, 7, 8 and 9 need the dashboard spec. None needs the AI provider.

## Signals the engine already has

- Partial edges: `splitPartialPeriods` flags, from PR #24.

For coarsened single-base time queries, an explicit date range retains its selected edge buckets but no longer disables observed-coverage reporting. `partial.selected` distinguishes retained partial edges from `partial.start/end`, whose rows were omitted. Comparisons involving a retained partial edge return null; complete interior periods still compare normally. Chart and presentation warnings identify the selected scope, KPI cards suppress unsupported first/prior changes, and evidence drafts defer trend conclusions. Alert checks leave those edge buckets out of their baseline, while still allowing a complete previous month to be evaluated when the selected current month is partial. Quiet event dates can explain observed edges; none of these checks certifies a source-data defect. Native-grain summary rows retain their declared coverage semantics. Cross-table ratio coverage now has an observed-boundary check: `partial.ratio` exposes both input windows and any categorical group. Affected values remain inspectable, while comparisons and automatic trend conclusions are withheld. Alerts exclude affected periods; complete later periods remain eligible. AI explanation requests include the current returned-row scope notes. This is evidence about observed or declared boundaries, not a certification of data completeness; automatic common-window alignment remains unimplemented.
- Newest bucket date and today: the query result and the clock.
Chart warnings for excluded filter scope, limited results, selected partial periods and ratio input coverage link directly to the current metric evidence panel. The controls remain keyboard-accessible in previews and presentations and are excluded from PNG output while warning text remains. Ratio evidence includes an expandable table of affected returned periods, each categorical group and both input windows. It shows 50 rows initially and can reveal every affected row; the table scrolls independently on narrow screens. The short finding still summarizes three examples, but no longer limits what can be inspected. Pending or replaced query results do not retain an earlier period table.

- Native grains and summary tables: `time_grains` with `time_dimension` on metrics, or an explicit `period: {column, grain}` on a duckglue table. Free-form grain text and a date primary key do not establish whole-period coverage.
- Filter bindings and sections: the dashboard spec.

A table may declare `reporting_lag: 2` (days after a period ends before its rows are all in). Rule 2 then calls a calendar-complete period *settling* while it is inside the lag and offers to leave it out of the comparison; rule 6 allows the lag before calling data stale.

## How phase 1 decides (src/suggest/dataHonesty.ts)

The review reads the query's newest time bucket, `partial` flags, applied filters, table reporting lag and model reporting date. An omitted edge bucket is absent from the returned rows; its omission does not establish that the remaining source data is complete.

- **Future-dated rows** fires when the newest returned bucket starts after the model's reporting date. It offers a range filter through that date. Lagging and stale checks stand down until this is addressed; excluding future dates does not certify completeness of the remaining periods.

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

1. Rules 0 and 1, the ledger line, rules 2 and 6 with fixes, the `reporting_lag` model field. **Done.**
2. Rule 3 coverage evidence and comparison/alert guards are built; automatic alignment and rules 4 and 5 remain planned.
3. Rules 7, 8, 9: filter suggestions, sharing the presentation work in `filter-presentation.md`.
4. Layout patterns named and applied.

## Chart component and date fidelity

Donut, waterfall and funnel charts require a finite value for every component. Numeric strings are read as numbers; missing, blank, boolean and invalid values are not replaced by zero. Donuts require non-negative components and a positive total, expose category shares when the legend is enabled, and render a full ring for a single positive component. Their shares describe only the returned query scope; a result-limit warning still matters.

Waterfalls keep each supplied component separate from the generated **Net change** bar, even when a source category is named “Total” or “Net change”. Clicking a component selects its source category; the generated net change does not create a category filter. This chart adds signed components; it does not infer an opening balance or certify that adding the chosen metrics is meaningful.

For declared temporal fields, date-only values and warehouse bucket timestamps without offsets are interpreted as UTC calendar coordinates, consistently across browser time zones. Explicit offsets retain their instant. Date-looking category strings retain their declared category role.

Snowflake query results preserve full UTC timestamps instead of shortening every SDK Date value to a calendar date. Fractional nanoseconds supplied by the SDK remain in the raw result and data export strings; plain JavaScript Dates retain their available millisecond precision. This is covered with the installed SDK's timestamp objects and simulated connection I/O, including offset instants and dates before 1970, rather than a live warehouse. Browser date scales still have JavaScript's millisecond resolution; raw timestamp precision does not imply nanosecond plot positioning.

## Geographic coverage

Country maps resolve alpha-2, alpha-3, numeric country codes and supported country/area names to the shapes in the bundled `world-atlas` 110m map. The code lookup uses the [UN M49 country/area reference](https://unstats.un.org/unsd/methodology/m49/overview/), retrieved November 14, 2026, plus the existing Taiwan atlas mapping. A recognized country code does not guarantee a drawable shape: small countries and territories may be absent at this map resolution. No new geographic boundaries are inferred.

Every map states how many returned rows have a drawable place and finite metric value. Unknown keys, recognized places without a shape, and missing values remain visible in chart/review disclosures and exported presentations. Numeric keys are explicitly interpreted as ISO numeric country codes; an internal numeric customer or region ID is not a geographic definition. Zero values remain distinguishable from unfilled places.

Multiple rows that resolve to the same country block the map. Canvas does not overwrite a row or sum a metric that may be a rate, snapshot or distinct count. Normalize aliases and group the governed metric at the country level before mapping. A table retains the original rows for inspection. If no rows can be drawn, the chart explains why instead of showing an apparently valid empty world map.

Design suggestions check sample coverage when ranking a country map. City-only, unsupported or unverified samples do not receive an ideal map recommendation. Sample coverage is not a guarantee about the full query result; the rendered chart checks that result separately.

## Reporting bucket identity and chart selection

Combo charts and heatmaps keep exact temporal keys separate from display labels. Intraday labels include time and UTC; if abbreviated labels still collide, the affected dates use exact ISO timestamps. Heatmap rows use metric identities rather than display names, and duplicate metric names include their IDs so two distinct definitions remain distinguishable. Label space is reserved for rotated timestamps rather than clipping the date portion.

Chart selection is restricted to the plotting area. Clicking an axis label or an outer margin does not snap to an edge category or date. Band selection respects the scale's actual positions and padding, including horizontal charts; temporal selection still snaps to an observed reporting bucket. The resulting filter/drill uses the source value rather than its formatted label. This controls selection accuracy; it does not infer whether a selected category explains an outcome.

Horizontal numeric axes reserve edge space for formatted tick labels, including signs, currency, percentages and authored decimal precision. Tick density adapts to chart width while retaining both domain endpoints and the zero baseline. If even the endpoint labels cannot fit, the chart asks for more width or fewer displayed decimal places rather than exporting clipped or overlapping labels. Hiding the numeric axis removes that label-space requirement; queries and returned values are unchanged.

Line charts offer an explicit **Line Y-axis → Fit to data** setting in the inspector. The default still includes zero. Fitted lines state the displayed range beneath the chart, retain distinct tick labels even for very narrow percentage ranges, and do not invent a fitted range when observations are missing. Dual-axis lines identify the fitted left-axis range alongside the existing independent-scale disclosure. The saved setting applies only to lines: changing a tile to a bar, area or combo does not truncate its zero baseline. The SaaS overview starter uses a fitted shared scale for net and gross retention so their variation is visible; query values and metric definitions are unchanged.

## Heatmap color meaning

A heatmap containing one metric uses its actual returned values on a shared color scale, with that metric's display units. A heatmap containing several metrics scales each row independently to its own returned minimum and maximum. Its persistent caption and Low / Middle / High legend explain that colors compare patterns within a metric, not amounts between metrics. A constant row uses the middle color; that is a display convention, not a target or assessment of business performance.

Cell tooltips retain each metric's semantic number format. When the cells are large enough, values also appear directly inside them and in exported images. Missing or invalid numeric values use gray cells with dashed outlines, distinct from measured zero; absent dimension combinations remain blank and their count is disclosed. A missing category retains its own labeled cell rather than disappearing. Hiding the color legend does not hide the explanatory caption.

Duplicate dimension combinations block rendering and export instead of overwriting or summing values. Fix the query grouping in the semantic model or inspect the rows in a table; the renderer cannot decide whether rates, snapshots or distinct counts can be aggregated. These checks concern returned query rows and do not certify underlying warehouse completeness.

## Units in scatterplots and tables

Each scatterplot measure axis uses its own semantic number format and a label naming that measure. Reversing the measure order reverses the axes, not their units. A numeric breakdown on the x axis is displayed as a number rather than inheriting the y metric's currency or percentage format. Unknown numeric coordinates do not become zero-valued points.

Automatic number formatting gives an explicit metric `unit` priority over name, label and synonym hints. Without a declared unit, separator-delimited `rate`, `nrr` and `grr` tokens—including names such as `attach_rate`—supply a percentage hint. Fractional values such as `0.42` then display as `42.0%`, consistently in cards, axes, tables and presentations. A name hint does not validate the calculation or its scale; ambiguous metrics should declare their units. An explicit chart formatting choice can override the display style without changing the returned values.

Tables format each metric and its prior-period value independently. Absolute changes in percentage metrics use percentage points (`pp`); relative comparison changes use `%`. Currency amounts are written in full by default, and explicit compact-number preferences remain available. Dimensions retain their category values, including leading zeros, and raw metric values remain inspectable in cell tooltips. Missing values display a dash rather than zero.

Sorting formatted metric columns compares finite numeric values, including numeric strings, with missing/invalid values at the end. Formatting and sorting do not rewrite the query result or CSV payload. The table's scroll hint responds to actual overflow; presentation tables retain their explicit excerpt count. CSV and PNG controls do not select or move the canvas tile while being clicked.

## Funnel stage interpretation

Funnels keep the returned stage order, including increases, repeated display names and measured zero. Stage names and formatted values sit beside the bars so a narrow or zero-width stage remains readable. Temporal stages use reporting-date labels; scalar metric stages use semantic metric names. Small positive values and shares remain distinguishable from zero. If the available height cannot label every stage legibly, the chart asks for more space or a table and blocks unreadable export.

Percentages compare each returned stage total with the first stage. They do not establish that the same people or accounts progressed through a cohort. A persistent caption makes that distinction in the live chart and exported presentation. A zero first stage has no defined percentage baseline; unsupported numeric ratios also show a dash with an explanation. Missing or invalid stage values block the funnel instead of becoming zero, and negative values require a different chart.

## KPI comparison availability

Comparing a KPI with its first shown period requires at least two shown periods and a valid first value. A single observation displays **no comparison**, including in Story and Infographic; it cannot establish unchanged performance. Two valid equal values still show a real zero change. Missing first-period values are not skipped in favor of a later baseline, and an explicit server prior-period value does not substitute for the user's selected first-period comparison.

## Returned-row checks by segment

For a query with one time dimension, continuity and repeated-period checks run within each complete categorical breakdown combination, regardless of dimension order. Equal dates in different segments are expected. Equal dates within the same combination are flagged without summing the values or claiming that source records are duplicated. Numeric and string category keys, and missing categories and the literal string `null`, keep distinct identities.

Gap checks consider only the interval between each segment's first and last observed dates. They never infer missing data before or after that window. Truncated results, invalid dates or repeated periods prevent gap inference for the affected series; valid independent segments can still be checked. A missing requested breakdown column is reported rather than treating all rows as one series. Several time dimensions remain outside these continuity checks.

Findings include affected-segment examples, the consequence for interpretation and a next check. They do not repair data, replace missing values with zero or infer failed ingestion. The same evidence appears in the chart details, redesign preview, Review and share and exported presentations.

## Breakdown edits and exploratory selections

Selecting one category can make a useful breakdown look redundant. Before offering **Remove breakdown** or **Show over time**, both Design review surfaces check the chart's own query without dashboard selections when the visible filters differ from its authored filters. This additional query uses the same authenticated endpoint, retains the chart's authored filters and metric definitions, and remains subject to server access rules. It does not modify the current selection.

An unconfirmed, failed or result-limited confirmation withholds the axis edit and explains the evidence boundary. A confirmed finding explains that the applied edit affects every selection. The edit remains explicit and undoable; temporary cross-filters remain excluded from saved authored content.

Both review surfaces refresh recognized automatic chart titles when changing the time grain, removing a breakdown or switching to a trend. For example, “New MRR (USD) by movement type” becomes “New MRR (USD) over time” after **Show over time**. Custom titles remain unchanged. The title and query change in one edit, so Save and Undo keep them together.

Missing/invalid values, missing category keys and duplicate category rows cannot establish a redundant breakdown. Numeric strings and measured zeros remain valid evidence. A single zero-valued category is described as the only represented category, never as a nonzero result. Changing query scope, visualization or semantic model cancels a pending per-chart review and closes its stale suggestions.

### Inspector field profiles

The inspector and card renderer resolve KPI/stat presentation from the same semantic field shape. An aggregate card has no sparkline controls; a card with reporting dates does, including older documents saved as `stat`. The active visualization choice follows the rendered card family without rewriting the saved chart type or reporting dimensions. Aggregate cards and tables hide axis and legend controls that cannot affect their display. Aggregate KPI recommendations explicitly state that a time breakdown is needed for a trend.

The inspector ranks visualization choices using profiles for the selected metric’s base table, dimensions, semantic model, source and acting principal. Source/principal changes and data refresh invalidate those profiles. Previous requests are cancelled and their results cannot replace the current selection’s suggestions.

Profiles describe the source under row-level rules; they do not include dashboard or chart filters. The inspector states that scope. Responses are matched to dimensions by field identity, not array position. Missing, ambiguous, malformed or failed responses show an error with a retry action, never scalar-chart recommendations inferred from an empty result. Formatting controls remain usable while profiling is unavailable.

### Add a tile and filter metadata

The visualization picker uses the same identity-checked field profiles as the inspector. Returning to the field selection cancels the old request; entering the visualization step starts a fresh check. A failed or incomplete profile cannot become a zero-cardinality recommendation or enable Add tile. Retry is explicit, and profile scope (source and role, before chart filters) is stated alongside the recommendations.

Filter-value and range requests cancel on field, mode, model or query-context changes. Failed or malformed responses show a retryable error. The first 60 returned values are shown initially, with an action to reveal the full returned list. The API requests 501 ordered values to determine whether its 500-value cap actually truncated the list, and the picker discloses that limit. Values retain their JSON types when selected.

Unknown range bounds stay unknown, numeric range hints retain their fractional precision, and date controls use calendar dates. A “through” date is saved as the following date with an exclusive upper bound so the selected final day is included. A configured filter without bounds is labeled a filter, not claimed to be applied.

### Small-multiple exploration

Small multiples share time and measure scales across panels. Their caption names the shared reporting window and measure scale; no observed measure values are described explicitly instead of presenting a default scale as evidence. Panels that are too small to read ask the user to enlarge the chart or reduce categories. Long panel labels are abbreviated visually but keep the full text in a tooltip and accessible action name.

Select a panel label with a pointer, Enter or Space to cross-filter on its source category. Facet row/column positions never become filter values. Numeric, text, null and boolean values preserve their types; colliding display labels are distinguished. The null selection is visible as “Missing (null)” in the filter bar. Date marks inside these panels do not currently drill; only panel labels are category actions. Canvas dragging and keyboard nudging do not intercept these controls.

### Unassigned breakdown values

Missing/null and blank-text category labels now produce returned-row findings, even without a time dimension. Counts describe query rows, not source records or customers. Findings explain the potential effect on totals and segment comparisons, suggest checking source labels, joins and intentional unassigned groups, and retain all values unchanged. Zero, false and literal text such as `null` are not missing labels. Missing requested categorical columns are flagged on categorical charts as well as time series. Guidance carries into Dashboard, Story, Infographic, copied context and PNG export, and clears after refreshed results correct the labels. This is not a source-record audit or proof of a broken join.

### Filter-choice evidence

Dashboard filter choices now share the tile picker’s validated, identity-bound metadata loader. Base/model/source/role changes invalidate old options immediately, failed responses offer retry, and selected values remain removable. The choice dialog distinguishes true empty lists, incomplete lists and search results within the returned list; available values describe source/role scope before dashboard/chart filters. Typed and blank/null choices have distinct labels without changing their payloads. Segmented overflow stays single-select, and a tile-picker null selection has an explicit summary. These changes improve choice reliability without claiming the available list represents every warehouse value.

### Quick KPI starters

The Views palette's table-based KPI starters use each metric's declared reporting requirements. Monthly snapshots receive their required month dimension instead of attempting an all-time sum. Metrics without a declared period remain aggregate values; the starter does not invent a reporting contract. New groups reserve their entire footprint, wrap into readable rows on narrower canvases and expand the surface when needed. Existing content and pinned positions are preserved, and insertion is one undoable edit.

### Numeric result interpretation

Numeric rendering and readiness share the same finite-number rules as evidence checks: numeric warehouse strings are supported; blanks, booleans, structured values and non-finite results are not measurements. Invalid scalar values display unavailable, invalid latest KPI observations stay unavailable, and all-invalid measures block handoff readiness. Tables retain original values for inspection. General plots normalize only measures, preserving dimension identity and raw query evidence. Area fill and line paths retain unavailable rows as gaps rather than joining across them.

Returned numeric values that exceed reliable browser precision produce a separate display-limitation finding. This covers unsafe integers, decimal strings whose conversion changes their value, underflow and high-significance fractional text. It is not evidence that warehouse data is wrong. Affected metrics do not receive automatic narrative observations, and their time-series KPIs show “precision limited” instead of a calculated change. Other safe metrics in the same result can still supply observations. Charts still use JavaScript numeric positions; the warning accompanies Dashboard, Story, Infographic, copied context and PNG output rather than claiming arbitrary-precision plotting.

The metric evidence panel and chart export menu offer **Download Excel (.xlsx)** and **Download raw CSV** for the current successful query, including time-series KPIs. Both remain limited to the returned rows and use values before chart formatting. Loading, superseded and failed queries cannot export an earlier result. A refresh, source/role change or unmount cancels an in-flight workbook download.

The Excel workbook has a **Data** sheet and a **Query context** sheet. Values are explicit text, numbers or booleans; strings resembling formulas or hyperlinks remain text. Numeric strings, leading-zero identifiers and high-precision numbers remain text so that spreadsheet inference cannot change them. Ordinary numbers remain numeric within Excel's 15-digit and supported-exponent limits. Unicode, whitespace, carriage returns and literal OOXML escape sequences are preserved. Nulls and empty strings become blank cells. Oversized cells, unsupported control characters and invalid row shapes produce a retryable error rather than silent truncation. This is a query export, not a complete typed database backup.

Query context includes the connection identity returned by the API, semantic model/adapter, query principal, query fields and filters, comparison, returned row count, limit/truncation/window, reporting calendar, reported row rules, source snapshot information, scope warnings and returned-row quality findings. Export and response-receipt timestamps are not warehouse freshness evidence. SQL, credentials and live connection instructions are not embedded.

Raw CSV deliberately retains the existing UTF-8, RFC 4180-style values and CRLF lines without a BOM or formula-prefix rewriting. It is intended for data tools, not automatic spreadsheet type inference. The interface explains that spreadsheet apps may interpret formulas and round long values; use the typed workbook or explicitly import CSV columns as text. There is no claim of universal formula sanitization for the raw CSV. For exact calculations beyond spreadsheet precision, calculate in the warehouse. Neither format can recover digits already lost upstream.

Tables now show precision-limited values as their original text rather than formatting a rounded JavaScript number. A visible note explains that unit formatting is withheld and percentage fractions remain fractions. Numeric sorting breaks conversion ties using decimal coefficient/exponent text, so adjacent large integers, long decimals and underflowing scientific notation retain their order. Dashboard, Story and Infographic use the same table behavior; plots still have the numeric-position limitations described above.

### Missing reporting periods in charts

Lines, areas, combo lines and small multiples break across absent buckets when the query declares a day, week, month, quarter or year grain. Each categorical series is checked independently, using the active drill grain. Rendering adds at most one unavailable marker per internal gap; it does not generate a dense date spine, assume zero, or change query rows, comparisons, evidence counts or CSV/Excel exports. Raw date dimensions without a declared grain keep their irregular observation spacing. Stacked areas with missing components request lines or a table instead of implying a complete total. A visible gap does not diagnose a failed load: filters and periods without activity can also explain missing rows.

### Trailing-period calculation

Bounded cumulative metrics use reporting-calendar intervals rather than the last N returned rows. Missing periods never pull older values into the window, and date/dimension filters still restrict the input before accumulation. Metric filters and result limits act afterward. The metric evidence panel explains that these sums use available input values and do not certify complete coverage. Missing periods are not manufactured as zero; the existing returned-row continuity checks can identify internal gaps within their documented limits. See [metric types](metric-types.md) for the calculation contract and sparse-calendar examples.
