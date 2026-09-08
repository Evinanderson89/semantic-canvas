# Trustworthy local alpha contract

This release repairs the document lifecycle and the confirmed query-governance gaps from the repository review. It does not implement the later native-semantic-layer or collaborative-canvas phases.

## Document lifecycle

Every new canvas, suggestion or demo clears saved identity, history, selection and drill state. Save only changes the status to Saved after a successful server response. Editing during an in-flight save remains dirty; navigating to another document prevents a late response from adopting the old ID. Save a copy offers a new identity when another tab or agent has changed the saved revision.

Document fingerprints include the spec and canvas settings. Cross-filters and drill state remain exploratory. Undo/redo covers tile edits, movement, keyboard nudges and canvas settings. Refresh invalidates the tile query context and cache key without regenerating tiles. A role change clears query and explanation state while preserving authored content.

A browser draft is written after edits and immediately before navigation. Home offers recovery and explicit discard. Recovery is local to a browser origin, is subject to its quota, and is not a backup of the server database. Save errors and unavailable recovery storage remain visible.

## API changes

- `POST /api/dashboards`: validates `id`, `spec`, `canvas`, `schemaVersion` (currently 1) and `revision`. Default revision 0 means create only. A successful response includes the new revision. Conflicts return 409.
- Dashboard list/get/save/delete/arrange are scoped to the selected source ID, including when two models have the same display name. An explicitly unavailable source returns 404.
- Delete requires the current revision. Arrange respects the requested named layout and checks the loaded revision before writing.
- Query bodies contain metrics, dimensions, structured filters, comparison and a bounded limit; arbitrary query properties and raw SQL filters are rejected. Saved tile geometry must be finite and positive, with unique IDs.
- Chart queries and discovery endpoints deny unenforceable policies with 403. The configured RLS file must exist and be structurally valid; explicit `policies: []` disables policies for an intentionally unrestricted local installation.
- The API binds to loopback and checks Host/Origin headers. These checks limit accidental local exposure; they are not a session/authentication system or support for deployment behind a public proxy.

## Query semantics

One tile uses one base table. Dimensions and filters must be reachable through one unambiguous declared relationship. Composite keys are compiled as a conjunction and inner/left join types are preserved. Join cardinality and referential integrity still depend on the authored model; there is no general fanout-proof metric planner.

Simple dbt imports accept column-based sum, count, count-distinct, min, max and average measures. `COUNT(1)` is supported. Complex expressions, measure parameters, non-additive dimensions and metric filters are rejected. File import is a deliberately restricted subset, not native MetricFlow execution.

Snowflake import preserves database/schema/table identity and all keys in a relationship. Unsupported computed fields, named filters or top-level metrics reject the source. SQL expressions inside a supported model remain trusted administrator input, not an untrusted SQL sandbox. Reusing a physical table name for multiple logical aliases is rejected.

Period-over-period SQL matches the previous calendar bucket; missing matches produce NULL. Year-over-year uses calendar-year subtraction; a leap-day comparison clamps to February 28 in the prior year. Weekly year-over-year matches a date one calendar year earlier, not an ISO week-number convention; when there is no matching bucket, it stays unknown. No fiscal calendars, dense date-spine filling, or automatic missing-to-zero conversion are implemented.

All observed buckets are retained. Period completeness is unknown until the model can declare coverage; the UI labels it accordingly. KPI cards select their named metric instead of accidentally displaying the last comparison column. Null latest KPI values remain unknown, and sparse prior periods are not silently substituted with an older observation.

Metrics with different always-on filters aggregate separately and merge dimension keys null-safely. Aggregate filters across those differently scoped groups are rejected until a shared post-aggregation predicate stage is implemented.

## Storage and migration

The dashboard store uses an additive migration for source ID, schema version and revision. Old document JSON is retained. Old text-size presets normalize to numeric sizes on read. A unique model-name-to-source mapping attaches legacy records; ambiguous matches remain unassigned and preserved.

DuckDB connections serialize store operations. Saves validate first, check source/revision, and replace a row inside a transaction. The DuckDB client is pinned to 1.5.5-r.4; its predecessor was an early alpha and failed the new update regression. Explicit transactional replacement also avoids indexed-update limitations described in [DuckDB's index documentation](https://duckdb.org/docs/current/sql/indexes.html#constraint-checking-in-update-statements).

Stop the old server and copy its dashboard directory before upgrading. Do not share a dashboard file between two running app processes. For an isolated trial, set `SC_DATA_DIR` to a new directory. Recovery of ambiguous legacy records currently requires an administrator to assign the intended `source_id` after inspecting a backup.

## Validation scope

Tests cover the sample warehouse, exact synthetic DuckDB answers, source isolation, concurrent revisions, old store schema migration, malformed policy/config input, rejected adapter semantics, agent tool context and tool-schema serialization. Browser regressions exercise save/new/open, refresh and role changes, failed save retry, canvas undo and draft recovery.

Live Snowflake, paid model responses and compatibility with arbitrary vendor manifests need integration testing with real credentials and fixtures. Team authentication, asset storage, source deletion ownership, query cancellation/budgets, complete connection-pool lifecycle handling, responsive dashboards and AI narrative evaluation remain outside this release.
