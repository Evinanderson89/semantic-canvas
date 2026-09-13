# Modeler

Status: **phases 1 to 3 built**: propose from the catalogue, review, publish as a source; extend a model that exists; drift. The agent-drafted prose remains designed.

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

## Extend: what is my model missing?

Most teams that reach Canvas already have a semantic view (a dbt project, a Snowflake semantic view, a hand-written file). For them the Modeler runs the other way round: start a draft with `extend: <source>` and the warehouse is read exactly as above, then the proposal is **diffed against the loaded model**:

- A table the model declares is marked *existing* and never written. Its grain and description are the model's own. The only thing the draft may add to it is a `reporting_lag` (the review asks for one on every fact table that lacks it, because the data-honesty review cannot tell settling from stale without it).
- A table the model does not have is *new*, with its grain, kind, time column and metrics as for a fresh model.
- A join the model declares (in either direction) is *existing*. A join between two modelled tables that the model never declared, or from a new table, is *new*: "Not in the model, though both tables are: `product_id` is `dim_products`'s key; 99.7% resolve."
- A metric the data suggests for a modelled table is a *gap* suggestion, off by default, unless the table has no metric at all. Suggestions whose aggregate the model already has (under any name) or whose column an existing metric already uses are not made.

**Publish** writes `SC_DATA_DIR/models/extensions/<source>.yaml` — only the additions (`tables`, `joins`, `metrics`) and `patches` (a base table's `reporting_lag`) — and reloads the source. The base model file is never edited; a base table, join or metric with the same name always wins on merge, so a later `dbt run` cannot be undone by an extension and an extension cannot redefine what the base owns. Ingest's connected tables merge first, the extension after.

## Drift: what the warehouse no longer has

`GET /api/modeler/drift?source=<id>` (and the *Check drift* button, and `gateway canvas modeler drift <source>`) reads the catalogue and compares it with the loaded model, without a draft:

| Finding | Means | Says |
| --- | --- | --- |
| `table_missing` | a modelled table is not in the warehouse | "`dim_plans` is in the model but not in the warehouse; 2 metrics (…) cannot run." |
| `column_missing` | a declared column is gone | "`fct_sales.amount` is gone from the warehouse; arpu, live_revenue, revenue break." |
| `type_changed` | the column's type moved across the model's vocabulary (integer→double is not drift) | "`fct_sales.sold_on` is TIMESTAMP in the warehouse, date in the model; check …" |

Each finding names the metrics whose expression or filter touches the column, and the answer lists the **dashboards** in that source that chart any of them, so "a column vanished" arrives as "these three dashboards break". An extension draft carries the drift as read when it was made.

## Proposed metrics: a field made to order

A metric is a named expression compiled per query; nothing runs when it is defined. So an editor may propose one on the Metric Registry page — label, table, one aggregate over that table's own columns, an optional always-on row filter, a sentence on what it means — and it exists at once:

- **Checked, then probed.** The vocabulary is closed (src/modeler/proposals.ts): an aggregate (`SUM`, `COUNT`, `AVG`, `MIN`, `MAX`, `COUNT(DISTINCT …)`, `… FILTER (WHERE …)`, `CASE`, `NULLIF`, …) over the base table's columns, qualified or bare; only functions on the allowlist in that file (aggregates, arithmetic, null handling, date and text functions), so nothing that reads files, environment variables or secrets can be named; no other table (joins come from the model), no statement or subquery. Every problem is named in words ("`dim_users.country` is not on `fct_orders`; a metric aggregates one table"). What passes is compiled and run once with `LIMIT 1` before it is stored.
- **Live for editors, badged.** It is written to the source's extension with `reviewed: false` and `origin: proposal` (who, when), and reloads at once. Editors see it with **Proposed by …, unreviewed**; they can chart it, and the tile carries the badge. Viewers do not see it in the model, cannot query it, and the agent leaves it out — the same gate Ingest's connected tables use.
- **Published by an administrator.** *Publish to everyone* flips `reviewed` and records who published it and when; the badge becomes **Added in Canvas · by · date** for good, so anyone can tell what came from the governed base model and what was added here. The proposer may withdraw it while unreviewed; after that only an administrator may remove it. Base-model metrics cannot be removed here.

Everything the Modeler adds (tables, metrics) carries the same provenance badge in the Data Model and the Metric Registry.

| Method and path | Who | Answer |
| --- | --- | --- |
| `POST /sources/:id/metrics` `{ name, label, baseTable, expression, description?, filter? }` | editors, admins | `{ metric }` (`400` with `problems`; `422` when the warehouse refuses it) |
| `POST /sources/:id/metrics/:name/publish` | admins | `{ metric }` |
| `DELETE /sources/:id/metrics/:name` | the proposer while unreviewed; admins | `{ ok, name }` |

From the terminal: `gateway canvas metrics propose|publish|remove`; `gateway canvas model metrics` shows each metric's state and origin.

## HTTP contract

All routes are administrator-only and serialised with the other configuration writes.

| Method and path | Body | Answer |
| --- | --- | --- |
| `GET /api/modeler/drafts` | | `{ drafts: [summary] }` |
| `POST /api/modeler/drafts` | `{ id, label, fromSource }`, `{ id, label, connector }`, or `{ id, label, extend }` | the draft, with its proposal (`422` when the warehouse cannot be read or has no tables); an extension draft also carries `drift` |
| `GET /api/modeler/drafts/:id` | | the draft |
| `PUT /api/modeler/drafts/:id` | `{ label?, proposal? }` | the draft plus `issues` publishing would raise |
| `GET /api/modeler/drafts/:id/yaml` | | the model file as it would be written (`text/yaml`) |
| `POST /api/modeler/drafts/:id/publish` | | `{ draft, source, path, sources }` (`400` with `issues`); for an extension draft `extended: true` and `source` is the extended source |
| `GET /api/modeler/drift?source=` | | `{ source, checkedAt, tables, drift: [finding], dashboards: [{ id, name, metrics }] }` |
| `DELETE /api/modeler/drafts/:id` | | `{ ok, id, sourceId }`; the source and file stay |

The CLI wraps these as `gateway canvas modeler …` (docs/cli.md in the gateway repository).

## Phases

1. Catalogue → proposal with evidence → review → publish as a source. **Done.**
2. Extend a model that exists: only what it lacks, published as an extension over an untouched base. **Done.**
3. Drift: columns gone or retyped, tables missing, the metrics and dashboards each breaks. **Done.**
4. Descriptions and labels drafted by the agent when a key is configured; metric suggestions from column comments; `reporting_lag` measured from load timestamps where a table has them; joins that stopped resolving as drift.
