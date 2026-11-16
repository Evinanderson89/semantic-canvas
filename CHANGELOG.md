# Changelog

## v0.2.0 — Broadside Publication Modes, Multi-Adapter Lineage, Executive Digests & Enterprise MCP

### Broadside Design Philosophy & Publication Modes
- Introduced the **Broadside ("honesty made visible")** editorial system across the workspace and interactive views (**Dashboard**, **Story**, and **Infographic**), pairing freeform spatial composition with publication-grade narrative briefs, consolidated reporting-scope margin notes, and high-density executive infographics.

### BI & Analytics Engineers
- Expanded the **dbt (`dbt`)** semantic adapter to support `simple`, `ratio`, `derived`, and `cumulative` metrics from `semantic_manifest.json`.
- Added the **Cube (`cube`)** semantic adapter supporting `measures`, `dimensions`, `segments`, and time dimensions alongside existing `duckglue` and `snowflake-semantic` adapters.
- Added the **SQLite (`.db`)** warehouse connector alongside **DuckDB**, **Parquet/CSV** lakes, and **Snowflake**.
- Added the **Compiled SQL & Metric Lineage DAG Inspector (`POST /api/query/lineage`)** to inspect parameterized SQL, join paths, row-level security predicates, and upstream table-to-metric lineage graphs.
- Added **Source Freshness & SLA Health (`GET /api/sources/:id/health`)** for watermark monitoring and SLA breach detection.
- Added **2-way Dashboard-as-Code YAML Sync & Diff (`GET /api/dashboards/:id/yaml`, `POST /api/dashboards/import-yaml`)** with deterministic serialization, dry-run structural diffing, and Git-friendly round-trip import.

### Designers & Storytellers
- Added **4 curated Editorial Theme Presets**: `editorial-warm`, `executive-slate`, `high-contrast-print`, and `boardroom-dark`.
- Added **chart target lines & callout annotations** for threshold goals, reference bands, and contextual point annotations.
- Added **standalone vector SVG export** for individual tiles and full dashboards, alongside **sketch/PDF reference import** mapped to governed catalogue metrics.

### Busy Executives
- Added **One-click Executive Digest & SHA-256 Verified Brief (`POST /api/dashboards/:id/digest`)** producing cryptographic verification hashes over governed query results.
- Added **deterministic "Why Did This Move?" metric driver attribution (`POST /api/query/drivers`)** ranking dimensional contributors to period-over-period changes.
- Added **AI rationale fact-checking** that verifies every numeric claim in AI-generated rationales against calculated warehouse figures.

### Enterprise & AI Ecosystem
- Added **provider-agnostic AI** supporting `anthropic`, `openai`, `gemini`, and `openai-compatible` endpoints.
- Added the **8-tool MCP onboarding hub** (generating configs for **Claude Desktop**, **Claude Code**, **Codex**, **Cursor**, **Antigravity**, **VS Code**, **Gemini CLI**, and **generic** MCP clients) plus **authenticated remote MCP (`POST /api/mcp`)** with RBAC and RLS enforcement.
- Added **OIDC real-time session revalidation**, **SCIM 2.0 provisioning (`/api/scim/v2`)**, **zero-downtime `access.yaml` reload**, and **per-dashboard ownership/lock controls**.
- Added **AES-256-GCM persistent sessions & distributed scheduler leases**, **Slack/webhook alert delivery**, and **durable audit & ROI telemetry (`GET /api/operations/audit`, `GET /api/operations/metrics`, `GET /api/operations/manifest`)**.

## Unreleased — CoreCanvas Library and Gateway integration

- Tightened the Design review dialog: the four passes are a row of chips (detail on hover), and coverage and the result are one status line.
- Added a built-in row count for every table so Add a tile can start from a dimension: the Dimensions column lists every table's columns up front, a dimension picked first counts rows (`rows:<table>`, `COUNT(*)`), and "Row count" sits at the top of the metrics list once a table is chosen.
- Added persistent source-scoped folders, reusable view snapshots, starter dashboards and library setup/migration, replacing Explore by topic.
- Added personal chart-chat and notification display preferences, off by default, without deleting existing activity.
- Added verified Gateway session support and navigation back to the shared app launcher.
- Added an optional `default` grant to the access file so self-service Gateway users outside every bound group receive a configured role (viewer recommended) instead of a 403; bindings still win, and the default's principal is validated at startup.
- Documented one suite with two apps, standalone/full-workspace packaging choices, storage boundaries and release gates.

The companion Ingest app lives in gateway-platform. Automatic data/model handoff, a version-pinned suite release bundle and integrated company deployment verification remain unfinished. Back up the Canvas library before applying additive store migrations. See [suite packaging](docs/suite-packaging.md).

## Unreleased — company workspaces and self-hosting

- Added non-root Docker packaging with a persistent workspace, a built UI/API runtime, a loopback-only demo and a separate HTTPS team recipe.
- Added OpenID Connect company sign-in with PKCE/state/nonce, opaque sessions, CSRF protection and explicit viewer/editor/admin, source and row-principal bindings.
- Bound embedded agent tools, questions and conversations to the authenticated user; isolated team browser drafts by account and tab.
- Added workspace setup/status, semantic-model YAML upload, structured application/audit logs and optional OTLP/HTTP logs and request traces.
- Added consistent dashboard-library downloads, validated offline restore and stopped-volume backup/recovery instructions.
- Serialized source/credential mutations, made source configuration writes atomic and fixed first-source creation from an empty registry.

This is an early single-instance team release. Real identity-provider verification, document-specific ACLs, provisioning, distributed sessions and durable audit storage remain outside its guarantees. See `docs/self-hosting.md`.

## Unreleased — analytical composition and trust

- Design Review can preview and apply a story structure to an unsectioned dashboard: editable headings, a neutral reading guide, clearer automatic labels and a focal trend. Existing headings, pinned content and authored titles are preserved. Chart fixes refresh the remaining review automatically.
- The Messy dashboard topic now includes monthly revenue, retention and acquisition-cost KPIs alongside real chart issues, demonstrating the complete chart-to-story workflow.
- Generated dashboards now have a focal trend and explicit sections, with separately plotted supporting measures. Metric authors can prioritize headline metrics.
- Smart Arrange previews layouts, wraps compact KPI rows, preserves section membership and pinned positions, and applies tile/canvas geometry as one undo step.
- Text cursor keys no longer move tiles. Canvas tiles support keyboard selection, arrow movement, Shift for larger steps and Alt-arrow resizing.
- Time queries keep the newest results and report truncation, visible date windows and limited exports. KPI comparisons remain calendar-based.
- The sample's snapshot/retention metrics declare monthly reporting. Unsupported grains and all-time snapshot totals fail validation.
- Failed recovery writes keep the current document open. Recovery records are validated and JSON backups can be downloaded and imported as new documents.
- Design Review uses the same filters and drill context as the charts, reports partial scans and invalidates stale advice.
- The embedded assistant receives the unsaved canvas and returns validated edit proposals for preview/apply/undo, with stale-document protection and cancellation.
- Source replacement drains and closes retired connections. Source edits reload active model metadata.
- KPI change colors respect declared metric direction, so rising acquisition cost is not automatically shown as good.
- Build/test dependencies and the Snowflake TOML parser dependency have been updated. The SDK stays on its current major version.

Existing saved document identities, source ownership and revisions are preserved. Sections and pinned positions are optional fields; older documents infer sections from heading positions when arranged. Back up the dashboard store before upgrading. Older app versions may reject the new optional tile fields.
