# Detail Dashboards & Smart Story Subdetails

Click a KPI value or a chart’s **Open detail dashboard** button to open a centered sub-dashboard with several live governed charts while your main dashboard stays in place. For MRR metrics, the default detail view combines the latest headline value, a signed movement waterfall, and a multi-period trend.

## Smart-Adding Story Subdetails

In the detail dashboard header (or in the Inspector’s **✦ Smart-add story details** shortcut), authors can enrich the sub-dashboard without manual form setup:

- **Live Deterministic Mover Attribution (Zero AI Tokens):** When a single-metric time series is open, Semantic Canvas runs `/api/query/drivers` against your warehouse under the active RLS and dashboard filters to surface the top period-over-period segment shift (`WHAT MOVED MOST`) and badge the matching breakdown card (`★ Top mover`).
- **1-Click Story Arcs:** Curated editorial presets (**Executive Pulse**, **Why Did It Move?**, and **Stakeholder & Finance Pack**) configure the sub-dashboard’s title, reading guide (`subtitle`), layout (`focus` or `grid`), and up to 4 complementary views in one click.
- **Individual Governed Subdetails:** Ranked story cards let authors toggle model-authored movement bridges, visual latest-period segment bar charts (`mix:<field>`), period-over-period delta tables, trends, and underlying data ledgers (`1..6` views total).

For full control over titles, reading notes, layout, and exact ordering, choose **Customize this dashboard** (or **Set up detail dashboard** in the Inspector). **Apply setup** updates the draft; **Save** on the main dashboard (or the inline **Save main dashboard** button) persists it.

## Governed Scope & `Metric.explorations`

The tile’s `detailDashboard` property stores `{ title, subtitle?, views, layout }` rather than static query snapshots. If a configured view cannot run under narrowed filters, its card explains that it is unavailable rather than widening scope silently. **Add to main dashboard** promotes any detail chart onto the main canvas with its captured provenance note; one undo removes it.

Duckglue metric definitions may declare explicit cross-table `explorations`:

```yaml
explorations:
  - label: What added and lost MRR?
    metric: net_new_mrr
    dimension: fct_mrr_movements.movement_type
    timeDimension: fct_mrr_movements.movement_date
    description: Signed contributions from the movement ledger, not the closing balance.
  - label: Where did net MRR shift by plan tier?
    metric: net_new_mrr
    dimension: dim_plans.plan_tier
    timeDimension: fct_mrr_movements.movement_date
    chart: bar
    description: Signed net MRR movement by plan tier from the movement ledger.
```

Coarse periodic source columns (such as `fct_saas_monthly.month`) map their full displayed period (`[periodStart, nextPeriodStart)`) onto daily target columns (`movement_date`) so end-date filters or cross-filters never truncate days `2..31`. When an AI provider is configured, **Explain this view with AI** runs strictly on explicit click and includes all scope and non-reconciliation caveats.
