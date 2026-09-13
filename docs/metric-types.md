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
    expression: gross_new_mrr - net_new_mrr
  cumulative_net_new_mrr:         # running total along the time axis
    type: cumulative
    metric: net_new_mrr
  trailing_3_period_net_new_mrr:  # the current period and the two before it
    type: cumulative
    metric: net_new_mrr
    window: 3
```

`base_table` may be left out; it is the first component's. Components must be **simple** metrics (one level: a ratio of derived metrics is refused with a sentence). A derived expression stays on one table; a ratio may cross two. A definition that does not hold fails the model load with the metric named.

## How they compile

- **Same table** (ratio, derived, cumulative): the grouped query computes the simple components (hidden as `__m_<name>` when the tile did not ask for them); one more `SELECT` over the grouped rows forms the value. A ratio is `CAST(a AS DOUBLE) / NULLIF(b, 0)`; a derived metric is its expression with metric names replaced by the columns; a cumulative metric is `SUM(x) OVER (PARTITION BY <other dimensions> ORDER BY <time> ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)` (or `N-1 PRECEDING` for a window). Always-on filters, HAVING, edge-completeness flags, period-over-period and the limit apply exactly as for simple metrics.
- **Across two tables** (a ratio whose denominator lives elsewhere): each side is its own grouped query over its own table, `FULL OUTER JOIN`ed on the dimension values. The **time axis is each side's own date** (customers by `movement_date`, sessions by `session_date`, whichever column the tile named on the numerator side and the table's default date column on the other). A categorical dimension must be written `table.column` and be reachable from both tables. Every filter, row-level policy included, must apply on both sides or the query is refused — a half-scoped ratio is worse than none. Such a tile carries that one metric only, and partial-edge flags are not computed for it (each side's own tile shows them).

## What a tile can do with them

Anything it does with a simple metric: dimensions, filters, `compare: prior|yoy` (`margin__prev`, `margin__pct` come back as usual), the KPI card, the data-honesty rules (which read the components' tables), the registry, `gateway canvas query lost_mrr --by month:movement_date`. A cumulative metric needs a time dimension and says so if it has none.

## Not yet

- Ratio metrics with more than two terms, or of derived metrics; window functions other than a running sum (rank, moving average).
- The dbt semantic manifest's ratio/derived/cumulative metrics are still refused on import; mapping them onto these types is the obvious next step.
- Proposed metrics on the Metric Registry page are simple only; a "ratio of two existing metrics" proposal would be a natural addition, with no SQL at all.
