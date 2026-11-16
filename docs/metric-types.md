# Metric types

Status: **built** (ratio, derived, cumulative) for the `duckglue` model and everything layered on it (extensions, the Modeler). The dbt and Snowflake-semantic adapters still import simple metrics only.

## Why

A metric used to be one aggregate over one table. That is honest and safe, and it cannot say *conversion rate* (orders over sessions, two tables), *gross margin* (revenue minus cost, two metrics), or *cumulative MRR* (a running total). Every BI team defines those on day one. They are now metric types, defined from governed simple metrics and compiled through the same grouped query, so the review gate, the data-honesty rules, row-level policies and period comparisons apply to them unchanged.

## Definitions

```yaml
metrics:
  mrr_per_subscriber:             # ratio on one table
    type: ratio
    numerator: mrr
    denominator: paying_subscribers
  new_customers_per_session:      # ratio across two tables
    type: ratio
    numerator: new_paying_customers   # on fct_mrr_movements
    denominator: web_sessions         # on fct_web_sessions
  lost_mrr:                       # derived: arithmetic over metric names
    type: derived
    expression: churned_mrr + contraction_mrr
  cumulative_net_new_mrr:         # running total along the time axis
    type: cumulative
    metric: net_new_mrr
  trailing_3_period_net_new_mrr:  # the current period and the two before it
    type: cumulative
    metric: net_new_mrr
    window: 3
```

`base_table` may be left out; it is the first component's. Components must be **simple** metrics (one level: a ratio of derived metrics is refused with a sentence). A derived expression stays on one table; a ratio may cross two. A cumulative metric must use its input's base table; an explicit contradictory override is rejected. A definition that does not hold fails the model load with the metric named.

Computed metrics can declare their own `time_grains` and `time_dimension`. As with simple metrics, a grain restriction requires a date or timestamp column on the metric's resolved base table and cannot split declared source periods. Incomplete or invalid declarations fail model loading. Chart validation enforces the computed metric's own restriction as well as its inputs' restrictions before SQL executes; a metric declared monthly cannot silently become a daily, yearly or all-time calculation. Adding a new chart supplies its declared reporting dimension, while an explicitly unsupported grain remains an error.

Publication also follows the components. A ratio, derived metric or cumulative metric stays out of viewer catalogues, automatic dashboard suggestions and assistant catalogues while any component metric or its table is unreviewed. Editors can still inspect and chart the draft calculation, with a **Dependencies need review** label identifying the unpublished components. Publishing those components makes the dependent metric available again; it does not require rewriting saved dashboards. Viewer query validation continues to check each component independently.

The sample movement ledger defines gross additions as new + expansion + reactivation, and losses as churn + contraction, both positive magnitudes. Net new MRR is the signed sum of movements, so `gross_new_mrr - lost_mrr = net_new_mrr` for the declared movement types. Reactivation never reduces the loss measure. The quick ratio uses the same gross-additions and loss components and remains null when losses are zero. This is the sample model's explicit policy, not a universal definition of the quick ratio. For a group with movement rows but no matching movement type, that component is zero; an empty input remains unknown. Accumulated net change needs an opening MRR balance before it can be called closing MRR.

## The built-in row count

Every table has one measure nobody declares: how many rows. It is named `rows:<table>` (`rows:fct_events`), labelled "Rows of fct_events", and compiles to `COUNT(*)` over the table with the tile's dimensions, filters and time grain applied like any simple metric. Its time dimension is the table's first partition key, so `rows:fct_events` by `month:event_time` counts events per month.

It exists so that **a dimension can be picked before a metric**. In Add a tile, the Dimensions column lists every table's group-by columns from the start; choosing one names the table and the tile counts its rows until a declared metric is chosen (the way Tableau's "Number of Records" works). "Row count" also appears at the top of the metrics list once a table is chosen. Unselecting the last metric while a breakdown remains falls back to the row count rather than emptying the tile.

The row count is synthesized on lookup (`metricOf(model, name)`), never stored in `model.metrics`: the catalogue, the Metric Registry, the wizards and the "N metrics" counts keep listing what people declared. A viewer cannot count rows of an ingested table an administrator has not published, for the same reason they cannot query its metrics.

## How they compile

- **Same table** (ratio, derived, cumulative): the grouped query computes the simple components (hidden as `__m_<name>` when the tile did not ask for them); one more `SELECT` over the grouped rows forms the value. A ratio is `CAST(a AS DOUBLE) / NULLIF(b, 0)`; a derived metric is its expression with metric names replaced by the columns. An unbounded cumulative metric is `SUM(x) OVER (PARTITION BY <other dimensions> ORDER BY <time> ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)`. A bounded window uses a calendar interval: for three monthly periods, `RANGE BETWEEN INTERVAL '2 month' PRECEDING AND CURRENT ROW`. Components retain their always-on filters. Edge flags and period comparisons are then attached, and metric filters select the finished values before the result limit.
- **Across two tables** (a ratio whose denominator lives elsewhere): each side is its own grouped query over its own table, `FULL OUTER JOIN`ed on the dimension values. The **time axis is each side's own date**: the chart names a date on the numerator's table; the denominator uses its metric's declared `time_dimension`, falling back to its table's default date only when no metric date is declared. A categorical dimension must be written `table.column` and be reachable from both tables. Every dimension filter, row-level policy included, must apply on both sides or the query is refused. A metric filter applies to the calculated ratio after division. Such a tile carries that one metric only. Time-series results retain the calculated ratio and carry per-input coverage evidence in `partial.ratio` when either input is absent, its window differs, or observed dates do not span the reporting bucket. Comparisons involving those rows are null. Native source periods and unanimous native metric declarations describe a row's whole period; raw event observations use their reporting-calendar dates.

Ratio coverage is checked separately for each categorical group, using each input’s own filters and the reporting timezone and fiscal calendar. API warnings, chart evidence, KPI comparisons, story drafts and alert evaluation carry these limits. The result-limit probe is removed before coverage evidence is collected, so an omitted row does not create a warning for the displayed window. Matching first/last dates do not prove complete arrivals or detect internal missing days; quiet event dates can also explain an observed edge. Ratios without a time axis do not receive an invented date window. Automatic source repair or alignment is not implemented. DuckDB fixtures and browser tests cover this behavior; live Snowflake execution remains unverified.

For a cross-table ratio, reporting-grain checks run against those same aligned dates. New-chart preparation adds one time axis at a grain supported by the ratio and both inputs, rather than adding both dates as separate dimensions. An explicit unsupported grain is retained for validation and rejected; incompatible input grains require separate charts. Drift impact uses the same date mapping as the query. A missing date declaration or an invalid date field is reported rather than inferred from the column names.

### Filtering calculated values

A bounded cumulative window includes the current reporting period and the preceding `window - 1` calendar periods at the chart’s time grain. Weeks use seven-day steps; quarters use three-month steps; fiscal periods and week starts follow the model’s calendar. For January = 10, missing February, March = 20 and April = 30, April’s trailing three-month sum is 50, not 60. January is outside April’s window even though only three rows were returned.

The sum uses available, non-null component values inside the window. It does not fill missing periods with zero, recover data excluded by date or dimension filters, or certify complete coverage. Initial windows can contain fewer than the declared number of periods. Returned-row data checks can identify internal gaps, but cannot establish that all expected source records have arrived. Metric definition and scope explains these limits alongside the input metric.

DuckDB runtime tests exercise sparse daily, weekly, monthly, quarterly and yearly series, Sunday weeks, fiscal periods, segment isolation, and filter/limit ordering. The interval syntax is also documented for [Snowflake RANGE frames](https://docs.snowflake.com/en/sql-reference/functions-window-syntax); live Snowflake execution has not been verified for this change.

Metric filters select displayed results; dimension filters select the underlying records. For daily revenue of 120, 10 and 50, the running total is 120, 130 and 180. Filtering the running total to at least 150 displays the last day at 180 with a prior-period running total of 130. It does not restart the sum at 50. A date filter beginning on the second day does change the input window, so the running total starts at 10 instead.

The same result-stage filtering applies to simple metrics with different always-on filters, derived arithmetic and same-table or cross-table ratios. A zero denominator remains null; a numeric range does not turn it into zero. An explicit discrete null selection can select those undefined values for investigation.

## What a tile can do with them

Anything it does with a simple metric: dimensions, filters, `compare: prior|yoy` (`margin__prev`, `margin__pct` come back as usual), the KPI card, the data-honesty rules (which read the components' tables), the registry, `gateway canvas query lost_mrr --by month:movement_date`. A cumulative metric needs a time dimension and says so if it has none.

From a chart's **Metric definition and scope** action, **Inspect input definitions** expands a computed metric's dependencies. Ratio inputs are identified as numerator/denominator; derived and cumulative inputs use the same dependency resolution as the compiler. Each input shows its model description, expression, base table, metric-level filter, declared reporting grains and declared time field or table default. Repeated references share one input entry; a metric used as both numerator and denominator carries both roles. These are definitions from the current model, not separately queried component values or a complete upstream warehouse lineage graph. No additional query is needed to inspect them. A missing metric or invalid computed definition is reported explicitly.

## Not yet

- Ratio metrics with more than two terms, or of derived metrics; window functions other than a running sum (rank, moving average).
- The dbt semantic manifest's ratio/derived/cumulative metrics are still refused on import; mapping them onto these types is the obvious next step.
- Proposed metrics on the Metric Registry page are simple only; a "ratio of two existing metrics" proposal would be a natural addition, with no SQL at all.
