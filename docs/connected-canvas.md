# Connected to Semantic Canvas

Status: **design, agreed direction; phase 1 and 2 in progress**. This note is the contract between Ingest (`gateway-platform/apps/ingest`) and Semantic Canvas for the "Connected to Semantic Canvas" destination. Both repositories carry a copy; change them together.

## What it is

Ingest moves data from tools such as Salesforce, Stripe or a Postgres table into a warehouse. Today the warehouse is a private per-user DuckDB file or a Snowflake schema. **Connected to Semantic Canvas** is a third destination: the loaded table lands somewhere Canvas can read, and a draft model entry for it is registered in Canvas, so the table can be charted immediately.

It is not a transfer between the two apps and it does not move credentials. Ingest writes data; Canvas reads it with its own connector; the user's own Gateway session authorises the registration.

## Guardrails this design exists to enforce

1. **Nothing Canvas is reading is ever modified in place.** Every import lands in an immutable folder. Promotion swaps folders; it never appends files.
2. **Raw rows and governed metrics are two different privileges.** Editors can load and connect. Only admins publish metrics into the governed catalogue and assign row-level policy. Until then a connected table is *unreviewed*: visible to editors and admins, badged, hidden from viewers, excluded from dashboard suggestions.
3. **Repeat imports are versions, not new tables.** A dataset has one name, one current version and an archive. Promote and roll back are folder swaps. Promotion is gated by a schema-drift check.
4. **Every row carries lineage.** `_import_id`, `_loaded_at`, `_source` are stamped on every table.
5. **Freshness is loud.** There are no schedules, so every connected table is a snapshot. Canvas shows "data as of" on the source and Ingest shows the age on the dataset.
6. **Disconnect archives; it never deletes.** Deletion is an operator action outside the app.
7. **Beginner defaults are safe defaults.** Naming is enforced, money-like columns get no automatic sum without a unit, PII-like columns need an admin, quotas cap what one person can fill.

## Lake layout (DuckDB flavour, phase 1)

Operator configures one shared directory, mounted by both apps: `INGEST_CANVAS_LAKE_DIR` in Ingest, and a Canvas source whose `lakeRoot` is `<dir>/tables`.

```
<lake>/
  tables/<dataset>/data.parquet              current version; the only thing Canvas reads
  staging/<dataset>/<import_id>/data.parquet a loaded but not yet promoted version
  staging/<dataset>/<import_id>/manifest.json
  archive/<dataset>/<import_id>/...          previous current versions, kept for rollback
  datasets/<dataset>.json                    dataset record (below)
```

Canvas's DuckDB connector reads `<lakeRoot>/<table>/**/*.parquet` with `union_by_name`, so only `tables/` may contain current data, and each dataset folder holds exactly one version. `staging/`, `archive/` and `datasets/` sit outside `lakeRoot` and are invisible to Canvas.

In the Gateway Compose deployment the directory is one shared volume: Ingest mounts it as `INGEST_CANVAS_LAKE_DIR`, Canvas as `SC_SHARED_LAKE`. Canvas's entrypoint creates `<lake>/tables`, seeds it with the sample lake when it is empty, and on first run writes a `sources.yaml` whose `duckglue-local` source reads `${SC_SHARED_LAKE}/tables`, so the sample warehouse and connected tables come from the same place.

Writes go to a temporary directory under `staging/` and are renamed into place. Promote is two renames: current to `archive/<dataset>/<previous_import_id>`, then staged to `tables/<dataset>`. POSIX has no atomic directory exchange, so Canvas may see the folder missing for a few milliseconds; its query cache and the ordering above make that harmless. Rollback is the same swap in reverse.

**Snowflake flavour (phase 4):** the same dataset record and the same promote and rollback semantics over tables in a dedicated landing schema. Ingest's role can create only in that schema. Canvas has a read-only role on it. Ingest never writes to a schema that holds modeled tables.

## Dataset record

`datasets/<dataset>.json`, owned by Ingest:

```json
{
  "name": "salesforce_account",
  "ownerId": "<sha256 of issuer + subject>",
  "ownerName": "casey@example.test",
  "createdAt": "2026-09-10T15:00:00Z",
  "current": "<import_id or null>",
  "versions": [
    { "importId": "…", "loadedAt": "…", "source": "Salesforce Account", "rows": 1204,
      "bytes": 188211, "columns": [{ "name": "id", "type": "text" }, …],
      "state": "current | staged | archived", "promotedAt": "…", "promotedBy": "…" }
  ],
  "status": "unreviewed | published | disconnected",
  "canvas": { "sourceId": "duckglue-local", "registeredAt": "…", "publishedAt": null }
}
```

The manifest inside each version folder repeats the version entry so the folder is self-describing without the record.

## Naming, lineage and flags

- Dataset names: `^[a-z][a-z0-9_]{0,62}$`, no DuckDB reserved words, and a proposed default of `<source>_<object>` such as `salesforce_account` or `stripe_invoices`. The user can rename before the first load; after that the name is fixed.
- Lineage columns appended to every table: `_import_id VARCHAR`, `_loaded_at TIMESTAMPTZ`, `_source VARCHAR`. They are declared in the model as columns but never proposed as dimensions.
- Money-like columns (`amount`, `total`, `price`, `revenue`, `mrr`, `_cents`, `_usd`, and any Stripe amount field) get no draft sum metric unless the user declares a unit and currency on the load screen. Stripe amounts are declared as minor units automatically.
- PII-like columns (email, phone, national identifiers by name pattern) block connection for editors. An admin may connect them or choose to hash them on load.
- Quotas, operator-configurable: `INGEST_CANVAS_MAX_DATASETS_PER_USER` (default 25) and `INGEST_CANVAS_MAX_BYTES_PER_USER` (default 2 GB) counted across current, staged and archived versions.

## Schema drift check at promotion

Compare the staged manifest with the current manifest by column name and type.

| Change | Editor | Admin |
| --- | --- | --- |
| Column added | allowed, noted | allowed |
| Column removed | blocked | confirm; the response names dashboards that reference it |
| Column retyped | blocked | confirm; same |
| Row count drops by more than half | blocked | confirm |

Admin status in Ingest is membership in `INGEST_ADMIN_GROUPS` (default `data-admins`), the same Gateway group Canvas maps to its admin role, so the two apps agree on who is an admin without talking to each other.

## Draft model

Ingest generates the draft from the reviewed mapping, in duckglue shape, and shows it in plain language before connecting ("Count of rows: number of accounts").

- Table: `description` from the source, `grain` "one row per <source object>", `primary_key` when a column is named `id` or `<object>_id` and is unique in the load, `partition_keys` empty, `synonyms` from the source object name.
- Columns: mapped types, plus the three lineage columns.
- Dimensions: text, boolean, date and timestamp columns except identifiers and lineage columns.
- Time dimension: the first `date` or `timestamp` column, declared as `default_date_column` on the table entry; Canvas treats it as a time axis only after an admin confirms it is a periodic fact date, not a lifecycle attribute.
- Only `table`, `metrics` and `provenance` travel in the registration payload. Dimension lists, partition keys and the plain-language lines stay in Ingest; Canvas derives dimensions from column types and never proposes lineage columns.
- Draft metrics, all with `reviewed: false`: `<dataset>_rows` (`count(*)`), and for each numeric column not flagged as money-without-unit, `<dataset>_<column>_total` (`sum(column)`) and `<dataset>_<column>_avg`. No time grains, no direction, no importance until review.

## Registration contract

Ingest calls Canvas with the user's own Gateway session cookie and the Canvas anti-forgery header obtained from `GET /api/auth/session`. Canvas verifies the token independently; Ingest never holds a Canvas credential.

`POST /api/sources/:sourceId/connected` (editor or admin)

```json
{
  "dataset": "salesforce_account",
  "importId": "…",
  "table": { "description": "…", "grain": "…", "synonyms": ["accounts"], "primary_key": "id",
             "columns": [{ "name": "id", "type": "string", "description": "…" }, …],
             "default_date_column": "created_date" },
  "metrics": { "salesforce_account_rows": { "label": "Accounts", "expression": "count(*)" }, … },
  "provenance": { "source": "Salesforce Account", "loadedAt": "…", "loadedBy": "casey@example.test", "rows": 1204 }
}
```

Canvas stores connected tables in a per-source overlay, `SC_DATA_DIR/models/connected/<sourceId>.yaml`, merged over the base model when the source loads. Base model files are never edited. Each overlay table carries `status: unreviewed | published`, `provenance`, and `loadedAt`. Registering an existing dataset again replaces its overlay entry only if the caller is the owner or an admin, and only after the drift rules above.

`GET /api/sources/:sourceId/connected/:dataset` returns the draft in full (columns, expressions, review fields) for the review screen. `POST /api/sources/:sourceId/connected/:dataset/publish` (admin) marks the table and chosen metrics reviewed and may set `time_grains`, `direction`, `importance` and a row-level policy. `DELETE /api/sources/:sourceId/connected/:dataset` (owner or admin) removes the overlay entry; data stays in the lake.

Canvas behaviour for unreviewed tables: visible to editors and admins with an "Ingested, unreviewed" badge; hidden from viewers; excluded from dashboard suggestions and from the agent's catalogue; provenance and "data as of" shown on the source and on every tile that uses the table.

## Repeat imports

A second import into an existing dataset name lands in `staging/`. Nothing Canvas reads changes. The user sees "Version 2 staged" with the drift report and a **Promote** button. Promote applies the rules above, archives the previous version and swaps. **Roll back** swaps the archived version back. The overlay in Canvas is updated with the promoted version's columns and provenance; unreviewed metrics are regenerated, published metrics are kept unless the drift check removed their columns.

## Phases

1. **Ingest lake destination (done).** Layout, dataset records, lineage columns, naming, flags, quotas, staged load, promote and roll back with the drift check, draft model generation, minimal UI. Fully testable locally against a temporary lake directory. No Canvas call yet.
2. **Canvas overlay and registration (done).** The overlay loader, the three endpoints, role rules, unreviewed visibility, provenance and "data as of" in the UI. Testable with fixtures.
3. **Wire them together (done).** Ingest calls the registration endpoint, shows the Canvas status on the dataset, deep-links "Open in Semantic Canvas" (`<canvas>/?source=<sourceId>&table=<dataset>`: Canvas switches to that source if the caller may use it, opens the Metric Registry filtered to the table, and strips both parameters; an unknown source or table is ignored), and disconnects. Verified through the local launcher with both apps running.
4. **Snowflake landing schema.** Same record and semantics over Snowflake tables.
5. **Live acceptance and docs.** Fresh Compose run, a real Salesforce or Stripe account, the operator guide, and the release-gate updates in `suite-packaging.md`.

## Out of scope for now

Schedules, incremental merge, CDC and OAuth refresh remain future work; this design gives them a place to land (a new staged version per run) without changing the contract.
