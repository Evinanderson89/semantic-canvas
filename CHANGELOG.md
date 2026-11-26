# Changelog

## v0.3.6 (2026-11-26)

### Per-Visitor Sandbox Isolation, Concurrency & Enterprise Security Hardening (`src/security/`, `src/server.ts`, `src/store/store.ts`)
- **Per-Visitor Sandbox Spreadsheet Session Isolation (`SC_SANDBOX_MODE=true`):** Issues an opaque `HttpOnly; SameSite=Lax` visitor session cookie (`sc_sandbox_sid`, plus `x-sc-sandbox-session` for non-cookie test clients) and binds user-uploaded spreadsheets (`!BUILTIN_SAMPLE_SOURCE_IDS`) to the uploader's session in memory and on disk (`sandbox-meta.json`) without mutating tracked `sources.yaml`. Other visitors cannot list, inspect, query, or refresh another visitor's uploaded workbook (`404`), while built-in sample worlds remain shared and protected from eviction and overwrite.
- **Sandbox Modal, Vandalism & Shared-NAT Rate Hardening:** Blocked `/api/agent/questions` (`GET` & `POST`) and `POST`/`PUT`/`PATCH`/`DELETE` writes to `/dashboards` (preserving read-only `/dashboards/:id/digest`), `/library`, and `/chart-activity` in `SC_SANDBOX_MODE`; rejected built-in starter template renames in `updateLibraryItem`; removed read-only `/api/modeler/spreadsheet/preview` from serial `configQueue` with dedicated preview rate limiting; guarded concurrent built-in sample world imports with an in-flight mutex; redacted server file paths in sandbox source errors; hardened `sandboxClientKey` to use the rightmost proxy hop; and raised default `apiPerMinute` from `180` to `600` for shared office/conference NAT IPs.
- **RBAC Trailing-Slash Fix, `ai.baseUrl` SSRF Guard, Session/SCIM Persistence, HTML Escaping & CSP:** Normalized trailing slashes in `CompanyAuth.guard` and added defense-in-depth `roleOf(req) === "admin"` checks on `/api/agent/key`, `/metrics/:name/publish`, and `/connected/:dataset/publish`; blocked loopback, RFC1918, CGNAT, and link-local `ai.baseUrl` endpoints in company modes unless `SC_ALLOW_PRIVATE_AI_URL=true`; wired `PersistentSessionStore` into `CompanyAuth` when `SC_SESSION_SECRET` + `SC_DATA_DIR` are configured; persisted SCIM state to `SC_DATA_DIR/scim.json` and rejected OIDC sign-in / refresh when a SCIM user has `active: false`; HTML-escaped Executive Digest `html` output; and allowed `https://fonts.googleapis.com` and `https://fonts.gstatic.com` in production CSP (`SC_SERVE_UI=true`).

### Spreadsheet Accuracy, Duplicate-Key Fan-Out Guard & Honest Lag Hatching (`src/modeler/`, `src/compiler/`, `src/charts/`, `src/format/`)
- Fixed word-boundary percentage and grain inference so nouns like `Solar Generation` (`geneRATIOns`) and `Wholesale` are never misclassified as percentages or per-order grains.
- Detected uniform whole-month (`YYYY-MM-01`) and whole-quarter date columns (including unpivoted wide period headers) and emitted `period: { column, grain }` in generated semantic YAML so `compileTile` retains the latest complete month (`Aug 2026`).
- Stripped wide-sheet summary/variance columns (`Total`, `Q1 Total`, `YTD`, `YoY`, `Variance`) before unpivoting, stripped `[Red]`/`[ColorN]` tokens before Excel date detection, skipped `hidden`/`veryHidden` sheets by default, capped `.xlsx` ZIP entry count and inflated bytes, kept `>15`-digit IDs and `zip`/`postal`/`phone` columns as `VARCHAR`, and enforced duplicate right-key fan-out checks on import and atomic DuckDB refresh.
- Replaced hardcoded area-chart hatching with data-driven `hasLag` hatching across `line`, `area`, `bar`, and `combo` charts, and formatted negative compact currency as `-$2.62k` without zero-axis label strike-through.

### Deterministic Prompt Intent, 18-Chart Reference Recreation & Unified UX (`src/suggest/`, `src/reference/`, `src/app/`)
- Expanded `matchModel` domain synonyms across retail, finance/P&L, and energy/operations, added `parsePromptIntent` (time grain, explicit breakdown dimensions, chart-type hints, Top-N limits, and headline metric preservation), upgraded Reference Recreation to all 18 chart kinds with fuzzy matching, 12-column grid snapping, and 1-click zero-key `SAMPLE_REFERENCE_BLUEPRINTS`.
- Simplified the Home screen into a single "Ask or drop" composer, renamed `CoreCanvas Library` to `Workspace Library`, unified Preview/Edit toolbars, upgraded `downloadSvg` to composite multi-tile Vector SVG export, displayed verified truncated `sha256:` hashes and compiled SQL lineage in presentation colophons, hoisted Dark Mode initialization + tour toggle + `Warm Broadsheet` poster tokens, added 1-column mobile Preview reflow (`<700px`), and fixed `@media print` selectors.

## v0.3.5 (2026-11-21)

### PostgreSQL & BigQuery Warehouses, Messy Excel Auto-Cleaning, Guided Sandbox Tour & KPI Story Arcs
- Added **PostgreSQL** (with OID normalization for `NUMERIC`, `INT8`, and `DATE`) and **Google BigQuery** warehouse connectors alongside **DuckDB**, **Snowflake**, and **SQLite (`.db`)**.
- Added automatic messy corporate spreadsheet cleaning (skipping title/banner rows, stripping `Total`/`Subtotal` rows, scrubbing `#N/A`/`#DIV/0!`/`#REF!` formula errors, unpivoting wide monthly/quarterly columns, and inferring multi-sheet foreign-key joins), 3 built-in sample workbooks (`coffee-roastery-pnl`, `coffee-roastery-2tab`, `us-grid-renewables`), and a 4-step Guided Sandbox Tour.
- Added centered **Detail Sub-Dashboards**, **1-Click KPI Story Arcs** (*Executive Pulse*, *Why Did It Move?*, *Stakeholder & Finance Pack*), Global Date Window presets, shareable view deep-links, and Public Sandbox mode (`SC_SANDBOX_MODE=true`).

## v0.3.3 (2026-11-18)

### Multi-Table Prompt-to-Executive-Story Composer (`src/suggest/match.ts`, `src/suggest/suggest.ts`)
- Expanded synonym and stem normalization in `matchModel` (`arr -> mrr`, `bookings -> mrr`, `expansion -> net_new_mrr`, `bridge/drivers/drove/driving -> movement`, `plans -> plan`, `tiers -> tier`, `channels -> channel`, `cac -> cost`, `funnel -> conversion`) and added `companionTables: string[]` and `matchedByTable: Record<string, Metric[]>` to `Matches` for cross-table prompt matching.
- Exported `composeExecutiveBrief` and upgraded `suggestDashboard`:
  - **Retention parity scale (`lineScale: "fit"` + `100% parity`):** Automatically sets `format: { lineScale: "fit", referenceLines: [{ label: "100% parity", value: 1 }] }` on retention (`nrr`, `grr`, `retention`) trend charts so curves aren't squashed against a zero baseline.
  - **Automatic movement waterfall & cross-table companion charts (`"What is driving the change?"`):** Adds up to 2 governed companion charts from secondary matched tables, including a `waterfall` chart (`"MRR movements · signed contribution"`, `net_new_mrr` by `fct_mrr_movements.movement_type`) and plan/tier/channel breakdowns (`"Active base-subscription MRR by plan"` `barH` on `dim_plans.plan_name`, `donut` on `dim_plans.plan_tier`, `barH` on `channel`).
  - **Closing Scope & Methodology Note (`kind: "text"`):** Appends a self-documenting `"Scope & methodology note"` summarizing base tables, joined dimensions, time grains, and snapshot/reconciliation rules.
- Added 7 unit tests in `test/agenticComposer.test.ts`.

### Format Proposal Actions, Blank-Canvas Research Budget & Structured Trace (`src/canvas/proposals.ts`, `src/agent/redesignSchema.ts`, `src/suggest/redesign.ts`, `src/agent/loop.ts`)
- Added the `format` action to `proposalSchema` and `redesignToolSchema` (compatible with `strictToolSchema` provider grammar bounds) supporting `lineScale` (`"zero" | "fit"`), `palette`, `targetValue`, `targetLabel`, `annotations` (`{ at, label, kind? }[]`), and `referenceLines` (`{ label, value }[]`), and updated `applyProposal` to merge `format` fields into `tile.format`.
- Included `tile.format` in `validateRedesign`'s `analyticalShape` so format upgrades count as analytical improvements.
- Increased `max_iterations` to `5` when `mode === "redesign"` on a blank canvas (`active && active.spec.tiles.length === 0`) and recorded structured `trace: AgentTraceStep[]` telemetry across tool calls (`describe_model`, `profile_field`, `query_metric`, `propose_canvas_changes`, etc.) with human-readable summaries and `rowsChecked`.
- Added unit tests in `test/agentLoopProposals.test.ts`.

### Agentic Dashboard Builder UI & Research Ledger (`src/app/AiRedesign.tsx`, `src/app/Interview.tsx`, `src/app/styles.css`)
- Added a live 4-step **Agentic Research Progress Stepper** (`<ol className="ai-redesign-steps">`), a collapsible **Verified Research Ledger** (`<details className="ai-redesign-ledger">`) showing governed queries checked, agent research trace, and rationale verification status, and an **Instant Deterministic Composer Fallback** (`"Generate deterministic draft from prompt"`) plus a `"Revenue & retention drivers"` preset in `src/app/AiRedesign.tsx`.
- Enriched `step === 0` (`"What should this dashboard tell you?"`) in `src/app/Interview.tsx` to display cross-table companion metrics matched across secondary tables and added a 1-click **`Build instant draft →`** button inside `.readback`.
- Styled `.ai-redesign-steps`, `.ai-redesign-ledger`, `.ai-redesign-deterministic`, `.readback-companions`, and `.instant-draft-btn` in `src/app/styles.css` and added 5 unit tests in `test/agentUiExperience.test.ts`.

## v0.3.1 (2026-11-17)

### Vibrant Broadside UI Overhaul
- Upgraded typography (`index.html`, `src/app/styles.css`) to the Vibrant Broadside font stack: `Bricolage Grotesque` (`--font-display`), `Source Serif 4` (`--font-editorial`), `Plus Jakarta Sans` (`--font-sans`), and `JetBrains Mono` (`--font-mono`).
- Replaced workspace color tokens with **Vibrant Broadside Light** (`#f6f8fc` ground, `#ffffff` surface, `#090d16` ink/masthead rule, `#1d4ed8` Electric Cobalt accent, `#059669` emerald positive, `#e11d48` vermilion negative) and **Vibrant Broadside Obsidian Dark** (`#080c17` ground, `#0d1424` surface, `#3b82f6` cobalt accent, `#10b981` positive, `#f43f5e` negative) in `src/app/styles.css` and `src/charts/MetricColors.tsx`.
- Updated `PALETTES.default` and `PALETTES.cool` in `src/format/format.ts` to Electric Cobalt (`#2563eb` / `#1d4ed8`), emerald, amber, vermilion, violet, and cyan palettes.
- Added `2px solid` Broadside masthead top rules, `.broadside-eyebrow` (`GOVERNED SEMANTIC WORKSPACE · PARAMETERIZED SQL`), and `.masthead-pill` provenance badges (`Settled + Lag Hatched`, `SHA-256 Verified Brief`) across Canvas and Report views (`src/app/App.tsx`, `src/app/ReviewHandoff.tsx`).
- Added governed metric slug badges (`<code className="metric-slug">{spec.metrics[0]}</code>`) in tile headers (`src/app/Tile.tsx`, `src/app/Kpi.tsx`), high-contrast mono KPI delta pill badges (`.kpi-delta .pos` / `.neg`), SVG linear-gradient sparkline area fills (`src/app/Kpi.tsx`), and `01 /` numbered section kickers.

### Compatible-Grain Drill-Down & Issue Punctuation Fix
- Updated `src/app/drill.ts` (`drillGrainAllowed`, `drillGrain`, `compatibleDrill`, `retainDrillSessions`) to validate candidate drill grains against the semantic model (`validateTile`), advancing only to allowed finer grains (e.g., `year -> month` on monthly tables) and returning `null` when no finer grain is supported (preventing invalid `month -> day` drill requests on month-only metrics like `ending_mrr` on `fct_saas_monthly`).
- Updated `src/app/Tile.tsx`, `src/app/query.ts`, and `src/app/App.tsx` so time-axis drill targets are only interactive when a valid finer grain exists and incompatible drill levels are automatically pruned.
- Added `src/compiler/issueText.ts` (`joinProblems`, `issuesText`) and updated `src/app/Tile.tsx`, `src/app/http.ts`, `src/app/Picker.tsx`, `src/compiler/compile.ts`, `src/compiler/lineage.ts`, `src/suggest/storyAdditions.ts`, `src/suggest/digest.ts`, and `src/canvas/proposals.ts` to eliminate duplicate periods (`..`) when joining validation and compiler diagnostics.
- Added 9 regression tests in `test/drillCompatibleGrain.test.ts` and updated `test/comparisonLabel.test.ts` and `test/designerPolish.test.ts`.

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
- Added the **Universal 5-Dialect Semantic Layer Converter (`GET /api/model/export`, `POST /api/model/convert`)** translating semantic models across **DuckGlue / Canvas (`duckglue`)**, **Snowflake Cortex Analyst (`snowflake`)**, **dbt MetricFlow (`metricflow`)**, **AWS Glue Data Catalog (`glue`)**, and **Cube (`cube`)** with automatic source-dialect detection.
- Added the **Semantic Layer Coach & Analysis Readiness Advisor (`GET` / `POST /api/model/coach`)** scoring semantic models across time-series honesty, driver attribution joins, unit-economics ratios, cohorts/cumulative windows, and AI/MCP readiness, with multi-dialect YAML fix snippets and natural-language question coaching.
- Added the **`npm run semantic` Developer & CI/CD CLI (`scripts/semantic-cli.ts`)** with `formats`, `convert`, and `coach` (`--question`, `--format`, `--json`, and `--fail-under <0-100>` CI quality gates), documented in `docs/semantic-layer-conversion.md`.
- Added the **`⌘K` / `Ctrl+K` Universal Command Palette** for instant synonym-aware governed metric placement, workspace navigation, theme switching, and canvas actions.

### Designers & Storytellers
- Added **4 curated Canvas Theme Presets** (`broadside`, `newsroom-dark`, `swiss-grid`, and `studio-warm`).
- Added **chart target lines & callout annotations** for threshold goals, reference bands, and contextual point annotations.
- Added **standalone vector SVG export** for individual tiles and full dashboards, alongside **sketch/PDF reference import** mapped to governed catalogue metrics.

### Busy Executives
- Added **One-click Executive Digest & SHA-256 Verified Brief (`POST /api/dashboards/:id/digest`)** producing cryptographic verification hashes over governed query results.
- Added **deterministic "Why Did This Move?" metric driver attribution (`POST /api/query/drivers`)** ranking dimensional contributors to period-over-period changes.
- Added **AI rationale fact-checking** that verifies every numeric claim in AI-generated rationales against calculated warehouse figures.

### Enterprise & AI Ecosystem
- Added **provider-agnostic AI** supporting `anthropic`, `openai`, `gemini`, and `openai-compatible` endpoints.
- Added the **8-tool MCP onboarding hub** (generating configs for **Claude Desktop**, **Claude Code**, **Codex**, **Cursor**, **Antigravity**, **VS Code**, **Gemini CLI**, and **generic** MCP clients) plus **authenticated remote MCP (`POST /api/mcp`)** with RBAC and RLS enforcement and dedicated `convert_semantic_model` and `coach_semantic_model` tools.
- Added **OIDC real-time session revalidation**, **SCIM 2.0 provisioning (`/api/scim/v2`)**, **zero-downtime `access.yaml` reload**, and **per-dashboard ownership/lock controls**.
- Added **AES-256-GCM persistent sessions & distributed scheduler leases**, **optional webhook alert delivery (`SC_ALERT_WEBHOOK_URL`)**, and **durable audit & ROI telemetry (`GET /api/operations/audit`, `GET /api/operations/metrics`, `GET /api/operations/manifest`)**.

## v0.1.3 — Workspace Library and Gateway integration

- Tightened the Design review dialog: the four passes are a row of chips (detail on hover), and coverage and the result are one status line.
- Added a built-in row count for every table so Add a tile can start from a dimension: the Dimensions column lists every table's columns up front, a dimension picked first counts rows (`rows:<table>`, `COUNT(*)`), and "Row count" sits at the top of the metrics list once a table is chosen.
- Added persistent source-scoped folders, reusable view snapshots, starter dashboards and library setup/migration, replacing Explore by topic.
- Added personal chart-chat and notification display preferences, off by default, without deleting existing activity.
- Added verified Gateway session support and navigation back to the shared app launcher.
- Added an optional `default` grant to the access file so self-service Gateway users outside every bound group receive a configured role (viewer recommended) instead of a 403; bindings still win, and the default's principal is validated at startup.
- Documented suite packaging choices, storage boundaries, and release gates in [suite packaging](docs/suite-packaging.md).

## v0.1.2 — Company workspaces and self-hosting

- Added non-root Docker packaging with a persistent workspace, a built UI/API runtime, a loopback-only demo and a separate HTTPS team recipe.
- Added OpenID Connect company sign-in with PKCE/state/nonce, opaque sessions, CSRF protection and explicit viewer/editor/admin, source and row-principal bindings.
- Bound embedded agent tools, questions and conversations to the authenticated user; isolated team browser drafts by account and tab.
- Added workspace setup/status, semantic-model YAML upload, structured application/audit logs and optional OTLP/HTTP logs and request traces.
- Added consistent dashboard-library downloads, validated offline restore and stopped-volume backup/recovery instructions.
- Serialized source/credential mutations, made source configuration writes atomic and fixed first-source creation from an empty registry.

## v0.1.1 — Analytical composition and trust

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
