# The messy lake

`npm run messy-lake` writes a deliberately messy warehouse to `sample-data/messy/lake` (Parquet, one file per table) and `sample-data/messy/messy-orders.csv` (the same orders as a file, for Ingest), generated deterministically for a fixed "today" so every answer the tools give can be asserted. `sample-data/messy/warehouse.yaml` is the model someone wrote for it and never updated. `test/messy.test.ts` runs the Modeler, drift, the honesty rules and the query path over it and checks that each names the mess it was built to name.

## What is wrong with it, and who should notice

| Mess | Where | Who names it |
| --- | --- | --- |
| A table with no unique column | `fct_events` | the Modeler: "say what one row is" |
| A table with zero rows | `dim_products` | the Modeler: left out, with a warning |
| A join that resolves 91% of the time | `fct_orders.customer_id → dim_customers` | the Modeler: included, flagged under 95% |
| A join that resolves 92% | `dim_customers.region_id → dim_regions` | the Modeler: flagged |
| A column renamed under the model | `order_total` → `amount` | drift: "order_total is gone; revenue breaks" |
| Three tables added since the model was written | `dim_regions`, `fct_refunds`, `fct_events` | extend: proposed as new, with joins |
| A stale copy of a fact table | `stg_orders_2024` | extend: proposed; a person leaves it out |
| The newest week incomplete | `fct_orders.ordered_at` | partial-period flag; lagging-comparison finding |
| Orders dated in the future | `fct_orders.ordered_at` (0.5%) | the honesty rules see a bucket after today (a rule for phase 2) |
| A numeric column stored as text (`$1,234.50`) | `fct_orders.amount_text` | a proposed `SUM(amount_text)` is refused by the warehouse at the probe |
| Dates stored as text in two formats | `dim_customers.signup_date` | typed `string`; not offered as a time column |
| Categorical values in four spellings | `status`, `country`, `channel` | a chart shows them apart; a cleanup rule for Ingest (phase 2) |
| Refunds (negative amounts) and absurd outliers | `fct_orders.amount` | visible in the numbers; an expectation for Runs (phase 2) |
| One order with several refunds | `fct_refunds.order_id` | the join from orders would fan out; declared `one_to_many` refuses it |
| Timestamps partly in a local zone | `fct_events.occurred_at` | the calendar's `timezone` cannot fix a mixed column; documented |
| Blank cells, a bad date, a text amount, a stray column | `messy-orders.csv` | Ingest's type check, before anything is stored |

The rows marked *phase 2* are the ones the tools do not catch yet; they are the next honesty rules and Ingest cleanups to build, and the file is here so building them has something to fail against.
