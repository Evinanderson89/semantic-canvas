# Architecture and extension contracts

Semantic Canvas is a modular monolith: semantic adapters describe supported operations, the compiler validates governed queries, connectors execute SQL, the store owns document revisions, and the browser owns the active editing session. Optional AI and MCP use the same query and validation paths.

## Query meaning

`src/compiler/compile.ts` validates metrics, dimensions and structured filters before compilation. Row restrictions are added on the server. Time series select the newest bounded window, then restore chronological order. The server fetches one extra row as evidence of truncation; `src/compiler/result.ts` removes that probe and returns `truncated`, `limit`, `window` and `warnings`. Unknown upstream completeness remains unknown even when every query row fits.

A result limit is not a reporting-period definition. Never infer a full-period total from a limited chart or export. KPI prior-period values are computed before limiting, by calendar lookup.

YAML metrics may declare `time_grains: [month]` and `time_dimension: fct_saas_monthly.month`. These declarations restrict queries; they do not implement general snapshot aggregation. The included balances and retention metrics intentionally require their native grain until a faithful alternative is implemented. A table may declare `reporting_lag: 2` (days after a period ends before its rows are all in); the data-honesty review (`docs/data-honesty-review.md`) uses it to tell a settling period from a stale one. `importance: 0..100` controls optional headline priority. `direction: higher|lower|neutral` determines KPI change colors; unknown directions stay neutral. Adapters must reject semantics they cannot represent.

## Documents and composition

A document consists of a dashboard specification and authored canvas dimensions. Tiles can reference a heading through `section` and opt into `pinned` positioning. Old documents remain readable; layout infers section membership from heading positions when explicit membership is absent. A pinned tile anchors its section during automatic arrangement. Manual text and chart edits remain possible.

Manual edits and complete layout changes record document snapshots. A layout transaction changes tiles and canvas together. Save/recovery fingerprints include both. A failed recovery write prevents replacing the current document.

Design Review can propose a story structure for an unsectioned, unpinned dashboard. `src/suggest/storyStructure.ts` groups existing tiles into headline metrics, a focal trend, supporting trends and breakdowns, then previews headings and a neutral reading guide. It preserves query fields, filters, authored titles and existing notes, and validates the resulting document. Existing headings or pinned tiles suppress this proposal rather than rewriting authored structure. The guide describes a reading order, not observed business findings. Applying the complete proposal is one document undo step.

## Library persistence and reuse

`src/library/model.ts` defines folder and reusable-view contracts. `src/store/store.ts` owns source-scoped `library_folders` and `library_views` tables and a nullable `dashboards.folder_id` column. Migrations are additive. Folder edits, document moves, renames and view saves share the store's serialized queue and optimistic revisions. Ordinary dashboard saves preserve an existing folder unless a folder change is explicitly supplied. Folder trees reject cycles, duplicate sibling names and depth beyond eight levels; deletion requires an empty folder.

`src/library/views.ts` captures one tab or selection as an independent authored composition. It prunes unrelated filter bindings and strips temporary exploration state. Insertion remaps tile, heading and filter identities, keeps copies on the target tab, and preserves saved filter defaults without binding them to existing destination tiles. A view too wide for its destination is arranged to fit. The browser validates the complete resulting dashboard and records one undo snapshot. Saved view definitions are validated against the selected semantic model again when written and inserted; query-time RLS remains authoritative.

`/api/library` returns metadata only. View definitions load on demand. Company write guards protect all library mutations; source allowlists apply before storage access. Folder membership is organizational metadata, not an ACL. Library backups include folders, views and dashboard folder membership, and older backups restore with empty library collections. Restore validates source references and parent trees before the transaction.

## AI action boundary

The browser sends the current unsaved document and selection when opening a canvas conversation. The server supplies the authoritative model and binds tools to the selected source and simulated role. Active-canvas chat has read tools and `propose_canvas_changes`, not direct saved-document writes.

`src/canvas/proposals.ts` validates a complete proposal before applying any part of it. Supported actions rename the document, edit a title/note, choose a chart, arrange, add a tile or remove a tile. Governed-query validation, section integrity and pinned positions are checked. The browser rejects a proposal if its captured document fingerprint differs from the current document, then applies accepted changes as one undo step. Proposals do not save automatically.

Chat is limited to six model iterations per turn. Cancellation reaches the provider and scoped tool requests. Paid model behavior is separate from deterministic contract tests. Editorial story suggestions receive composition metadata, not verified business evidence, and are instructed not to assert numerical trends or causes from it.

## Connections

A replaced registry drains and closes retired pools. A pool rejects new requests after retirement and permits active leases to finish before disposing of connections. Browser metadata refreshes after editing a source. Full model-version pinning and migration/remapping of saved metrics remain future work.

The Snowflake SDK uses `toml.parse` for its optional local connection file. The dependency override retains that interface on TOML 5, avoiding the vulnerable 3.x parser without downgrading the SDK. A compatibility fixture checks the parser path used by the SDK. The Express query-string dependency is similarly constrained to a patched compatible 6.x release. Live warehouse execution still requires integration verification.

## Release gates

Before claiming native semantic compatibility, compare a representative fixture corpus against the provider's authoritative execution engine. Before supporting shared deployment, implement real identity, authorization, tenant isolation and operational controls. Before calling narrative assistance reliable, evaluate factual claims against governed results, missing periods and incomplete/limited windows.

## Company workspace and operations

`src/security/auth.ts` separates local simulation from opt-in OIDC company mode. Verified ID-token subject/group bindings produce an opaque session, application role, RLS principal and source allowlist. API middleware authenticates and authorizes before source selection. The embedded agent forwards the caller’s session over a loopback-only HTTP client; its model cannot supply authentication context. External MCP cannot authenticate to company mode.

`SessionBoundary` gates the UI until session lookup completes. Viewers get exploration controls with the canvas locked; administrator-only setup lives in Connections. UI restrictions complement server permissions. Team drafts live in per-account tab storage, while local drafts preserve their existing browser key.

The production server serves the built UI and API from one origin. Docker persists the store, editable source configuration, credentials and uploaded models under `/data`; team access/RLS rules are private operator-mounted files. Operator mutations are serialized and source configuration replacement is atomic. Dashboard library snapshots serialize with saves; validated restore is transactional and restricted to an empty store.

`src/operations/telemetry.ts` emits allowlisted JSON records and optionally batches OTLP/HTTP logs and request spans. Requests carry generated IDs, template routes and pseudonymous actor IDs. No payloads, SQL, rows or credentials are recorded. Startup health, admin status counters and backup/recovery recipes are documented in `self-hosting.md`. All sessions and operational counters remain process-local; this is a single-instance design.

The source-scoped library is initialized once with an editable folder structure. Bundled catalogue starters are persisted dashboard definitions flagged `is_template`; loading one in the UI starts a new document, while server saves reject overwriting a template. Template IDs are excluded from the recent saved-dashboard list. The initialization marker is included in backups, so deleted starter content does not reappear after a restart or restore. First setup files unorganized dashboards by their leading metric without rewriting their specifications or moving already-filed work.

## Suite boundary

Canvas is the analytics app in a suite with Ingest and shared Gateway infrastructure. Keep semantic compilation, source/row access and authored dashboard persistence in Canvas; keep ingestion staging, connector credentials and import jobs in Ingest. Gateway supplies discovery and authenticated access, not implicit cross-app data authorization. Canvas verifies Gateway sessions independently through `SC_MODE=gateway` and its existing access policy. The local launcher is an explicitly separate preview.

See [suite packaging](suite-packaging.md) for standalone/full-workspace choices, the unimplemented reviewed data handoff, storage boundaries and release gates. Ingest's DuckDB file is not directly supported by the current Parquet-backed Canvas connector. A shared login, app link or volume does not close that gap.
