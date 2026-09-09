# Architecture and extension contracts

Semantic Canvas is a modular monolith: semantic adapters describe supported operations, the compiler validates governed queries, connectors execute SQL, the store owns document revisions, and the browser owns the active editing session. Optional AI and MCP use the same query and validation paths.

## Query meaning

`src/compiler/compile.ts` validates metrics, dimensions and structured filters before compilation. Row restrictions are added on the server. Time series select the newest bounded window, then restore chronological order. The server fetches one extra row as evidence of truncation; `src/compiler/result.ts` removes that probe and returns `truncated`, `limit`, `window` and `warnings`. Unknown upstream completeness remains unknown even when every query row fits.

A result limit is not a reporting-period definition. Never infer a full-period total from a limited chart or export. KPI prior-period values are computed before limiting, by calendar lookup.

YAML metrics may declare `time_grains: [month]` and `time_dimension: fct_saas_monthly.month`. These declarations restrict queries; they do not implement general snapshot aggregation. The included balances and retention metrics intentionally require their native grain until a faithful alternative is implemented. `importance: 0..100` controls optional headline priority. `direction: higher|lower|neutral` determines KPI change colors; unknown directions stay neutral. Adapters must reject semantics they cannot represent.

## Documents and composition

A document consists of a dashboard specification and authored canvas dimensions. Tiles can reference a heading through `section` and opt into `pinned` positioning. Old documents remain readable; layout infers section membership from heading positions when explicit membership is absent. A pinned tile anchors its section during automatic arrangement. Manual text and chart edits remain possible.

Manual edits and complete layout changes record document snapshots. A layout transaction changes tiles and canvas together. Save/recovery fingerprints include both. A failed recovery write prevents replacing the current document.

Design Review can propose a story structure for an unsectioned, unpinned dashboard. `src/suggest/storyStructure.ts` groups existing tiles into headline metrics, a focal trend, supporting trends and breakdowns, then previews headings and a neutral reading guide. It preserves query fields, filters, authored titles and existing notes, and validates the resulting document. Existing headings or pinned tiles suppress this proposal rather than rewriting authored structure. The guide describes a reading order, not observed business findings. Applying the complete proposal is one document undo step.

## AI action boundary

The browser sends the current unsaved document and selection when opening a canvas conversation. The server supplies the authoritative model and binds tools to the selected source and simulated role. Active-canvas chat has read tools and `propose_canvas_changes`, not direct saved-document writes.

`src/canvas/proposals.ts` validates a complete proposal before applying any part of it. Supported actions rename the document, edit a title/note, choose a chart, arrange, add a tile or remove a tile. Governed-query validation, section integrity and pinned positions are checked. The browser rejects a proposal if its captured document fingerprint differs from the current document, then applies accepted changes as one undo step. Proposals do not save automatically.

Chat is limited to six model iterations per turn. Cancellation reaches the provider and scoped tool requests. Paid model behavior is separate from deterministic contract tests. Editorial story suggestions receive composition metadata, not verified business evidence, and are instructed not to assert numerical trends or causes from it.

## Connections

A replaced registry drains and closes retired pools. A pool rejects new requests after retirement and permits active leases to finish before disposing of connections. Browser metadata refreshes after editing a source. Full model-version pinning and migration/remapping of saved metrics remain future work.

The Snowflake SDK uses `toml.parse` for its optional local connection file. The dependency override retains that interface on TOML 5, avoiding the vulnerable 3.x parser without downgrading the SDK. A compatibility fixture checks the parser path used by the SDK. The Express query-string dependency is similarly constrained to a patched compatible 6.x release. Live warehouse execution still requires integration verification.

## Release gates

Before claiming native semantic compatibility, compare a representative fixture corpus against the provider's authoritative execution engine. Before supporting shared deployment, implement real identity, authorization, tenant isolation and operational controls. Before calling narrative assistance reliable, evaluate factual claims against governed results, missing periods and incomplete/limited windows.
