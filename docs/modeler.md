# Modeler

Status: **phase 1 built** (propose from the catalogue, review, publish as a source). Phases 2 and 3 designed below.

## Why

Canvas charts only what a semantic model declares: tables with a grain, joins that are safe, metrics with a meaning. That is the right constraint and the wrong first step for most teams, who have a warehouse full of tables and no model. The Modeler closes that gap without inventing a new format: it reads the warehouse's own catalogue, proposes a model in the same `duckglue` YAML every hand-written model uses, shows the evidence for each line, and publishes what a person agreed to as an ordinary source.

Three things it deliberately does not do. It does not let a dashboard join tables ad hoc: joins are declared here, with evidence, and Canvas keeps refusing ambiguous ones. It does not assert what the numbers cannot support: a table with no unique column gets "say what one row is", not a guess. And it does not need the AI: every proposal is deterministic; the agent, when configured, only drafts prose.

## What it reads

Through the same connector a dashboard uses, read-only, bounded (200 tables, 80 columns each, 60 join probes):

1. **Catalogue**: every table and its columns with native types. DuckDB lakes list the table directories under the lake root (local or `s3://`) and `DESCRIBE` each; Snowflake reads `INFORMATION_SCHEMA.COLUMNS` for the configured database and schema.
2. **Profile**: one aggregate query per table: row count; per column, non-null count, distinct count, and min/max for dates and numbers.
3. **Join probes**: for each column named like another table's key (`user_id` where `dim_users.user_id` is unique), one query: of the left column's values, how many resolve on the right.

## The rules (src/modeler/propose.ts)

| Proposes | From | Evidence shown |
| --- | --- | --- |
| **Key** | a column unique across every row and never null; id-like names preferred | "`order_id` is unique across 1,000 rows and never null." |
| **Grain** | the key, else "one row per event on `<time column>`" for a fact, else blank | the same sentence, or "No column is unique. Say what one row is." |
| **Kind** | `dim_`/`fct_` prefixes; a table other tables' keys point at is a dimension; a table with a time column and measures is a fact | shown as fact / dimension / not sure, editable |
| **Join** | a column named like another table's key (exact name, or `plan_id` → `dim_plans`) | "`user_id` is `dim_users`'s key; 99.8% of `fct_orders.user_id` values resolve." Below 95% it is flagged; below 50% it is left out. |
| **Time column** | the date/timestamp column present on every row, names like `date`, `_at`, `_on` preferred | picked in the review |
| **Metrics** | `COUNT(*)` per fact table; `SUM` of numeric columns named like measures (amount, revenue, qty, …); `COUNT(DISTINCT …)` of foreign keys | "`amount` is numeric and named like a measure (1,000 values)." |
| **Reporting lag** | nothing; a person fills it in | feeds the data-honesty review |

Warehouse types are mapped to the model's vocabulary (`string`, `integer`, `double`, `boolean`, `date`, `timestamp`); anything else keeps its native name.

## Review and publish

`Modeler` in the sidebar (administrators). Start a draft from an existing source's warehouse, a Parquet lake (a directory or `s3://` with a named AWS profile), or a Snowflake database and schema; credentials go to the server's `.env` exactly as the Connections form stores them, and the draft keeps `${VAR}` references.

The review shows every table with its evidence, grain, kind, time column, reporting lag and description; every join with its resolution; every metric with its name, label, expression and why. Untick what should not exist. **Publish** refuses until every included table has a grain and at least one metric is included, and never accepts an expression carrying `;` or a comment. It writes `SC_DATA_DIR/models/authored/<id>.yaml` and adds a source `<id>` with the `duckglue` adapter pointing at it (or, on a republish, rewrites the file and reloads). The draft stays, marked published, so it can be revised.

The file is a normal model file. Edit it by hand afterwards if you like; the Modeler only rewrites it when you publish again.

## HTTP contract

All routes are administrator-only and serialised with the other configuration writes.

| Method and path | Body | Answer |
| --- | --- | --- |
| `GET /api/modeler/drafts` | | `{ drafts: [summary] }` |
| `POST /api/modeler/drafts` | `{ id, label, fromSource }` or `{ id, label, connector }` | the draft, with its proposal (`422` when the warehouse cannot be read or has no tables) |
| `GET /api/modeler/drafts/:id` | | the draft |
| `PUT /api/modeler/drafts/:id` | `{ label?, proposal? }` | the draft plus `issues` publishing would raise |
| `GET /api/modeler/drafts/:id/yaml` | | the model file as it would be written (`text/yaml`) |
| `POST /api/modeler/drafts/:id/publish` | | `{ draft, source, path, sources }` (`400` with `issues`) |
| `DELETE /api/modeler/drafts/:id` | | `{ ok, id, sourceId }`; the source and file stay |

The CLI wraps these as `gateway canvas modeler …` (docs/cli.md in the gateway repository).

## Phases

1. Catalogue → proposal with evidence → review → publish as a source. **Done.**
2. Descriptions and labels drafted by the agent when a key is configured; metric suggestions from column comments; `reporting_lag` measured from load timestamps where a table has them.
3. Drift: re-read the warehouse behind a published model and report what changed — columns gone, types changed, joins that stopped resolving — with the dashboards each change would break.
