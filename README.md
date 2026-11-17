# Semantic Canvas (`v0.2.0`)

An open-source canvas for building dashboards, editorial stories, and executive briefs from governed metrics. Connect a supported semantic model (`duckglue`, `dbt`, `cube`, or `snowflake-semantic`), start with a suggested dashboard or an empty canvas, and arrange charts, KPIs, notes, headings, and images into a cohesive narrative.

**Open-source `v0.2.0` with opt-in company mode.** Try the local sample immediately, or self-host a company workspace with OpenID Connect sign-in, real-time IdP session revalidation, SCIM 2.0 user/group provisioning, server-enforced roles, and source/row access.

## The Broadside Design Philosophy & Three Publication Views

Semantic Canvas is built around the **Broadside ("honesty made visible")** design philosophy: analytical interfaces should read with the typographic hierarchy, provenance clarity, and editorial discipline of a broadsheet publication rather than a cluttered grid of widgets. Every figure discloses its scope, partial periods are hatched rather than disguised, and every AI-generated rationale is checked against calculated warehouse numbers before you apply it.

Move seamlessly across three synchronized views of the same governed document:

- **Dashboard:** A spatial, multi-tile freeform canvas with smart arrangement, section structure, cross-tab filter wiring, target callouts, and interactive drill-downs.
- **Story:** A publication-grade editorial brief with serif narrative headlines, consolidated reporting-scope and provenance margin notes, embedded interactive figures alongside executive prose, and a cryptographic SHA-256 verification footer.
- **Infographic:** A high-density executive broadside pairing a typographic KPI strip with dimensional driver attribution bars, revenue mix breakdowns, and standalone vector SVG export readiness.

## What's New in `v0.2.0`

### 1. BI & Analytics Engineers
- **Expanded Semantic Layer Adapters:**
  - **dbt (`dbt`):** Supports `simple`, `ratio`, `derived`, and `cumulative` metrics from `semantic_manifest.json`.
  - **Cube (`cube`):** Imports Cube semantic models including `measures`, `dimensions`, `segments`, and time dimensions.
  - **Snowflake (`snowflake-semantic`) & Native YAML (`duckglue`):** Governed multi-hop join paths and metric compilation.
- **Warehouse Connectors:** Direct execution against **DuckDB**, **SQLite (`.db`)**, **Parquet/CSV** lakes (local or S3), and **Snowflake**.
- **Compiled SQL & Metric Lineage DAG Inspector (`POST /api/query/lineage`):** Inspect parameterized SQL, join paths, applied RLS predicates, and the upstream table-to-metric DAG for any tile.
- **Source Freshness & SLA Health (`GET /api/sources/:id/health`):** Real-time watermark inspection and SLA status (`healthy`, `warning`, `breached`) per source.
- **2-Way Dashboard-as-Code YAML Sync & Diff (`GET /api/dashboards/:id/yaml`, `POST /api/dashboards/import-yaml`):** Export any dashboard to deterministic YAML for Git version control, preview structural diffs, and import YAML changes back into the workspace.
- **Universal 5-Dialect Semantic Layer Converter & Coach (`GET /api/model/export`, `POST /api/model/convert`, `POST /api/model/coach`):** Convert governed models across **DuckGlue / Canvas (`duckglue`)**, **Snowflake Cortex Analyst (`snowflake`)**, **dbt MetricFlow (`metricflow`)**, **AWS Glue Data Catalog (`glue`)**, and **Cube (`cube`)**, score model readiness across five analytical categories, and generate dialect-native YAML recipes for natural-language questions. See [multi-dialect conversion, coaching & CLI](docs/semantic-layer-conversion.md).
- **Developer & CI/CD Semantic CLI (`npm run semantic`):** Headless CLI supporting `formats`, `convert` (`--from auto --to <dialect>`), and `coach` (`--question`, `--format`, `--json`, and `--fail-under <0-100>` for GitHub Actions Semantic Quality Gates).
- **`⌘K` / `Ctrl+K` Universal Command Palette:** Instant keyboard launcher for governed metrics (synonym-aware search across metric names, tables, and business synonyms), canvas actions, editorial themes, and workspace navigation.

### 2. Designers & Storytellers
- **4 Curated Editorial Theme Presets:** Switch between `editorial-warm`, `executive-slate`, `high-contrast-print`, and `boardroom-dark` palettes tuned for screen, projector, and print.
- **Chart Target Lines & Callout Annotations:** First-class horizontal/vertical target thresholds, shaded bands, and point callout labels on canvas charts.
- **Standalone Vector SVG Export:** Export individual charts or entire dashboards, stories, and infographics as crisp, font-embedded standalone vector SVGs for Figma, Keynote, or print.
- **Sketch & PDF Reference Import:** Upload a whiteboard sketch, screenshot, or PDF reference to map visual layouts directly onto governed catalogue metrics.

### 3. Busy Executives
- **One-Click Executive Digest & SHA-256 Verified Brief (`POST /api/dashboards/:id/digest`):** Generate a structured executive brief with headline takeaways, anomaly flags, scope disclosures, and a cryptographic SHA-256 verification hash over the underlying query results.
- **Deterministic "Why Did This Move?" Metric Driver Attribution (`POST /api/query/drivers`):** Decompose period-over-period metric changes across catalogue dimensions ranked by absolute contribution share.
- **AI Rationale Fact-Checking:** Every AI-suggested narrative or design rationale is cross-checked against calculated warehouse figures before presentation, flagging or zeroing out discrepancies.

### 4. Enterprise & AI Ecosystem
- **Provider-Agnostic AI:** Connect `anthropic` (Claude), `openai`, `gemini`, or any `openai-compatible` local/VPC endpoint (vLLM, Ollama, LiteLLM). Core exploration, deterministic review, driver attribution, and smart arrange require no AI key.
- **8-Tool MCP Onboarding Hub + Authenticated Remote MCP (`POST /api/mcp`):** Ready-to-copy configurations for **Claude Desktop**, **Claude Code**, **Codex**, **Cursor**, **Antigravity**, **VS Code**, **Gemini CLI**, and **generic** stdio clients, plus authenticated remote HTTP MCP (`POST /api/mcp`) enforcing company RBAC and RLS—including `convert_semantic_model` and `coach_semantic_model` for multi-dialect semantic translation and readiness coaching.
- **Identity, Provisioning & Governance:** OIDC sign-in with real-time IdP session revalidation, **SCIM 2.0 provisioning (`/api/scim/v2`)**, zero-downtime `access.yaml` hot reload, and per-dashboard ownership and lock controls.
- **High-Availability & Operations Telemetry:** AES-256-GCM encrypted persistent sessions, distributed scheduler leases, Slack and generic webhook alert delivery, and durable audit & ROI telemetry endpoints (`GET /api/operations/audit`, `GET /api/operations/metrics`, `GET /api/operations/manifest`).

## Part of the Semantic Canvas suite

The packaging direction is **one suite with two apps**: Semantic Canvas for governed analytics and dashboard design, and Ingest for bringing data into databases. Gateway provides the shared workspace, sign-in and app navigation. Canvas remains independently usable.

The intended installation choices are **Full workspace** (default), **Canvas only**, and **Ingest only**. The standalone Canvas setup below works today; the full workspace's company deployment, release bundle and automatic Ingest-to-Canvas handoff remain unfinished. See [suite packaging and integration status](docs/suite-packaging.md) and the [Gateway/Ingest repository](https://github.com/Evinanderson89/gateway-platform).

## Run it

With Docker:

```sh
docker compose up --build -d
```

**Try the before-and-after walkthrough:** on Home, choose **Try the design playground**. Start with a messy dashboard, preview a redesign with **Improve with AI** (requires a configured provider), or apply chart fixes in **Design review**. Use **Smart arrange → Tell a story**, then **Review and share** to compare Dashboard, Story and Infographic formats and export a PNG. The starter opens as an unsaved copy. See [presentation and evidence behavior](docs/presentations.md).

Open [the local demo](http://localhost:5173). Dashboard storage persists in a named volume. For HTTPS company deployment, SSO, logging and recovery, follow the [self-hosting guide](docs/self-hosting.md).

For local development:

Use Node.js 22.x (22.12 or newer), 24.x, or 26.x. Use the latest patch release in your chosen major version.

```sh
npm ci
npm start
```

Open [Semantic Canvas](http://127.0.0.1:5173). The API runs at `127.0.0.1:5174`. The bundled sample warehouse needs no credentials.

## What you can do

- Start from scratch or generate a dashboard from the semantic catalog.
- Move, resize, align and layer tiles. Preview Smart Arrange before applying a layout; sections and pinned positions are preserved.
- Add KPIs, charts, tables, headings, notes, dividers, images and connected filter controls.
- Organize a dashboard into tabs. Scope filters to one tab or carry them across tabs with explicit chart connections.
- Recreate a sketch, photo, dashboard image or PDF using catalogue metrics, with a matching review before creation (requires a vision-capable AI provider).
- Copy charts into another tab or saved dashboard, with destination filter connections and revision protection.
- Explore with filters and time drill-downs, then refresh data without replacing the design.
- Save, reopen, save a copy, undo canvas changes and recover unsaved drafts from Home.
- Open the message icon on a chart to discuss it, reply, and resolve conversations. Open the bell to create a personal threshold or anomaly watch, preview its result, and review its history.
- Review charts against their current filters and drill state. Partial reviews identify unavailable or limited results.
- Ask the optional AI assistant to improve the active unsaved document. Review its proposed edits, apply them together, and undo them in one step.
- Export returned chart data as typed Excel with query context, or raw CSV for data tools; export dashboards as PNG.
- Review workspace setup in Connections, upload a semantic model, and download a complete dashboard-library backup.
- In company mode, sign in through your identity provider and assign viewer/editor/admin roles with source and row access.
- Collect JSON application/audit logs or export logs and request traces through OpenTelemetry.

See [references, tabs and connected filters](docs/reference-tabs-filters.md) for a walkthrough, file limits and current boundaries.

## What this alpha guarantees—and where it stops

Saved documents have a version, a source identity and a revision. Conflicting updates return an error, and the browser keeps its unsaved work. A new dashboard gets a new identity. The save limit is 8 MB per document, including images.

Queries validate metrics, dimensions and structured filters before compiling SQL. Charts, field samples, distinct values and ranges use the same row restrictions. A policy that cannot be enforced denies that query. A missing or malformed policy file stops startup instead of disabling restrictions.

Time-series limits keep the newest result window. Responses disclose truncation and the visible date window; limited CSV exports are labeled. Period comparisons look up the previous reporting period, so gaps stay unknown. First-of-month snapshots remain visible. Models can declare a week start, fiscal year start month, reporting time zone and pinned sample date; see [the calendar contract](docs/calendar.md). The app shows **Coverage unverified** because observed dates do not prove that a reporting period is complete. Upstream completeness metadata is not implemented.

Snapshot and retention metrics in the sample declare their supported monthly grain. Unsupported rollups and all-time snapshot sums are rejected instead of returning misleading totals. Model authors can declare `time_grains`, `time_dimension`, optional dashboard `importance`, and `direction` (higher, lower or neutral) in YAML. Undeclared direction uses neutral KPI colors.

These are tested local behaviors, not a claim of semantic equivalence with every vendor's query engine. See [the alpha contract](docs/alpha-contract.md) for supported imports, migration details and known limits.

## Connect a source

Open **Connections** to add, edit or select a source, or edit `sources.yaml`. A source pairs a semantic adapter with a warehouse connector.

| Adapter | Supported import | Explicitly unsupported |
| --- | --- | --- |
| `duckglue` | Bundled YAML model, trusted metric expressions and declared forward join paths, including multiple hops; ratio, derived and cumulative metrics (`docs/metric-types.md`) | Ambiguous shortest paths, reverse traversal, and declared joins that multiply base rows; see [joins](docs/joins.md) |
| `dbt` | `simple`, `ratio`, `derived`, and `cumulative` metrics backed by supported column aggregates in `semantic_manifest.json` | Conversion metrics; non-additive measures; arbitrary SQL metric filters |
| `cube` | Cube `measures`, `dimensions`, `segments`, and time dimensions from YAML/JSON model files | Custom JS dynamic schemas, pre-aggregations, and arbitrary multi-hop reverse joins |
| `snowflake-semantic` | Public plain-column fields and table-level metrics, composite equality join keys, left/inner joins, database/schema qualification | Computed fields, filters, non-additive rules, private access, variables, explicit metric join paths, SQL-defined tables, range/asof joins, top-level derived metrics, repeated physical table names with different aliases |

Unsupported imports return a source error explaining what could not be represented. The dbt, Cube, and Snowflake adapters import files and compile local SQL; they do not call the external vendor semantic query service.

Connectors: **DuckDB**, **SQLite (`.db`)**, **Parquet/CSV** through DuckDB (a local directory, or an S3 lake), and **Snowflake**. The sample is tested against DuckDB. Snowflake execution requires your own credentials and verification against your model.

For an S3 lake, set `lakeRoot` to `s3://bucket/prefix` and name an `awsProfile` from the server's `~/.aws/config` (an SSO login or a `role_arn` + `source_profile` entry) plus the bucket's `awsRegion`; the credential is resolved when the source connects and renewed before an assumed role's session expires. No access key is written to `sources.yaml`. See the commented example there.

For Snowflake, copy `.env.example` to `.env`, fill in the required settings, then configure a source. Use a read-only warehouse role. Connection credentials stay on the local server and are referenced by environment variables in `sources.yaml`.

Tables registered by Ingest ("Connected to Semantic Canvas", see `docs/connected-canvas.md`) appear as ingested and unreviewed, visible to editors and administrators only, until an administrator publishes them; they are kept in a per-source overlay under `SC_DATA_DIR/models/connected/`, never in your model file.

## AI and MCP

AI is optional. The embedded agent currently supports **Anthropic only**. Add a key in **Connections**, or set `ANTHROPIC_API_KEY` in `.env`; choose an available model with `ai.model` in `sources.yaml`. Connections saves its key on the server and preserves replacements/removals across source reloads and restarts, even without an `ai` block. See [credential precedence](docs/self-hosting.md#ai-credentials) for operator-managed configuration. The canvas and rule-based suggestions work without a key.

Embedded tools and conversation histories are bound to the selected source and principal; in company mode, they also carry the authenticated caller’s session and are isolated by user. A model cannot switch that scope by changing its tool arguments. AI recommendations still need human judgment; they are not proof of causation or business correctness.

**Connect Claude Desktop or Claude Code:** open **Connections → Connect Claude**. Choose your client and copy the generated setup. It uses absolute paths and the running API’s port, so it also works when Claude starts outside this repository. Keep Canvas running on the same computer as Claude. No Anthropic API key is needed in Canvas for this connection.

The panel includes a local MCP connection check and a starter prompt. The check launches the MCP server, discovers its tools, and reads the selected source’s metric definitions. It does not contact an AI provider or verify that your Claude client is connected. Confirm that separately in Claude Desktop’s connector settings or Claude Code’s `/mcp` view.

Claude can save directly through these tools. Ask it to propose changes before saving, and use a new dashboard ID when exploring. Refresh Canvas and open the saved dashboard from its library; MCP does not edit your browser’s unsaved canvas. Generated configuration is specific to this installation; regenerate it if the repository, Node installation, or API port moves. Merge configuration entries rather than replacing other MCP servers. Remote/company-mode Claude authentication is not implemented.

**Connect ChatGPT:** open **Connections → Connect ChatGPT**. The setup uses [OpenAI’s Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) and a separate scoped stdio server. Choose a source and row-access principal. Explore-only mode exposes eight read tools; build mode adds dashboard save and arrangement. The scope is enforced by the server, including refusing missing principals and tool requests for another source or principal. Everyone using that tunnel shares the chosen local scope. Company sign-in delegation is not supported.

The panel generates macOS/Linux tunnel commands and checks the local MCP handshake. Completing the connection also requires OpenAI tunnel permissions, a runtime tunnel credential, and custom MCP access in the intended ChatGPT workspace. Canvas never collects that credential. The local check does not establish a tunnel or certify ChatGPT connectivity; verify by querying metrics from ChatGPT. See the in-app steps for connecting and stopping the client. No OpenAI model API integration is required.

For other local MCP clients, the stdio entry point is:

```sh
npm run mcp
```

The MCP server exposes catalog discovery, scoped queries, dashboard save/open, layout selection and user questions through the same HTTP API. External MCP clients are trusted local clients and may explicitly select simulated roles. External MCP authentication for company mode is not implemented; team API access is refused without a session.

To update a saved dashboard, call `get_dashboard` and pass its `revision` into `save_dashboard`; revision `0` creates a new document. Both tools accept a `source`. Set `SEMANTIC_CANVAS_URL` when the API uses a different port.

## Data and recovery

**Edit, Preview, and version history:** the dashboard mode bar identifies editable drafts and read-only previews. Preview does not save or publish. After the first save, **Version history** lists saved designs with timestamps and a layout preview. Before restoring, compare the selected version against current work, including unsaved edits: data and scope changes are shown separately from story content and visual changes, with current and saved values side by side. **Restore as draft** preserves the existing history and opens the chosen design for a new save. History stores chart definitions, layout, authored text and saved filters; warehouse data and semantic definitions remain live. Versions overwritten before this feature are unavailable.

Saved dashboards, chart conversations, and personal alert rules/history live in `~/.semantic-canvas/dashboards.duckdb`. Set `SC_DATA_DIR` to choose another directory. Unsaved recovery drafts are stored in this browser and appear on Home; they do not include query result rows or connection credentials. If browser recovery fails, internal navigation keeps the current document open and offers a downloadable JSON backup. Use **Import backup** on Home to restore it as a new document. Save larger image-heavy documents explicitly; browser storage has a quota.

In Docker, data lives under `/data` in the persistent workspace volume. Company-mode drafts use account-specific tab session storage and are removed from that tab on sign-out. Administrators can download a consistent library snapshot; offline restore validates it and requires an empty store. See [backup and restore](docs/self-hosting.md#back-up-restore-and-upgrade).

Before upgrading an existing installation, stop its server and back up the dashboard directory. The newer DuckDB engine and additive store migration are tested with the old schema. Older application versions may not understand the updated database format or source ownership fields.

Legacy dashboards are attached to a source only when their old model name identifies exactly one source. Ambiguous records are retained in the store for explicit recovery; they are not assigned by guesswork.

## Development

```sh
npm run typecheck
npm test
npx playwright install chromium
npm run e2e
npm run build
```

Browser tests start their own servers on ports 5273/5274 and use `.test-data/` for saves. They do not require the normal app to be running. CI runs type checking, the result and regression tests, a production build and browser tests.

| Directory | Responsibility |
| --- | --- |
| `src/semantic` | Model imports and join metadata |
| `src/compiler` | Runtime document/query schemas, semantic validation and SQL compilation |
| `src/security` | Company authentication, authorization, policy loading and query scope |
| `src/operations`, `deploy` | Structured telemetry and self-hosting recipes |
| `src/store` | Document migration, source isolation and atomic revision checks |
| `src/app`, `src/canvas` | Editing, document recovery, chart controls and canvas geometry |
| `src/suggest`, `src/charts` | Suggestions and rendering |
| `src/agent`, `src/mcp` | Embedded AI and external agent tools |

## Next

Native semantic-layer execution, completeness metadata, evaluated narrative accuracy, responsive viewer layouts and collaboration remain future work. Company mode still needs real-provider validation, finer document permissions, provisioning, distributed sessions and deeper operational instrumentation. This alpha focuses on preserving authored work and rejecting answers the current implementation cannot produce faithfully.

See [architecture and contracts](docs/architecture.md), [contributing](CONTRIBUTING.md), [security](SECURITY.md), and [release notes](CHANGELOG.md). MIT licensed. See [LICENSE](LICENSE).

## CoreCanvas Library

**CoreCanvas Library** in the sidebar is the workspace home for saved dashboards and reusable views. Create folders and subfolders, search across the library, and use each item's menu to rename or move it. The library replaces **Explore by topic** with Company overview, Revenue & retention, Growth & customers, Shared views (KPI summaries, Trends & comparisons, Story sections), and Examples. On first setup, unfiled dashboards using these topics move into the matching folder; existing folder choices and dashboard contents stay intact. Other dashboards stay at the root. The sample catalogue includes ten live starter dashboards in these folders. Eight use curated compositions: revenue waterfalls, geographic signup maps, product heatmaps, channel small multiples, subscription mix, scatter comparisons, and acquisition funnels. Starters open as independent copies: save to keep your version, and reopen **Examples → Dashboard cleanup demo** for a fresh before-and-after exercise. Examples and Shared views start collapsed. Folders, starters, and setup state persist in the library database and backups; later renames, moves, and deletions are respected.

On a dashboard, open **Views → Save a view** to persist selected tiles or the current tab, including labels, section relationships, formatting, layout, and saved filter defaults. Selecting a heading includes its section. Use **Views → Browse saved views** to insert a copy into the current tab, or preview a view from the library and use it as a new dashboard. Metrics run against the current semantic catalogue and the viewer's permissions. Insertion uses fresh tile/filter IDs, preserves the destination's existing content, fits wider views when needed, and supports one-step undo. Copied filters apply only to the copied tiles and stay visible in the filter shelf when they have no canvas control.

The library persists in the server's `dashboards.duckdb`, alongside dashboards; it is included in library backup/restore. It stores definitions and authored content, not cached result rows or connection credentials. Folders are scoped to the source and organize shared work; they are not access-control boundaries. Company viewers can browse/open work, while editors and administrators can save and organize it. Writes reject stale revisions, cross-source moves and folder cycles; only empty folders can be deleted.

Saved views are independent snapshots, not linked components: later changes do not propagate to dashboards where a view was inserted. Temporary filter selections, cross-filtering, drill-downs, comments and alert rules are not carried into a saved view. Model migrations and cross-source remapping remain explicit future work.

## Chart comments and alerts

Enable **Chart chats** and **Chart notifications** independently in **Settings → Chart tools**, available from the sidebar or **Canvas → Chats & notifications**. Both are off by default. These are personal display preferences saved in this browser per signed-in user (or local role preview), across dashboards. Hiding a tool keeps its conversations and alert rules; existing watches continue to run. To stop checks, pause the watch from its chart's bell. These preferences do not change shared dashboard documents or grant access to data.

When enabled, the message and bell icons appear in the upper-right corner of metric charts, including KPI cards. Save the dashboard first. Comments are plain text with replies and resolution; author names come from company sign-in. Conversations are shared within the same source and RLS scope. Alert rules and observed values are private to their owner. Copies of a dashboard or chart start their own activity, and deleting a chart from a saved dashboard removes its activity.

Alerts support a threshold above/below a value and an anomaly check for a single time series. They query the saved metric through the semantic compiler, with saved filter defaults and server-enforced RLS. Changing the saved query or semantic model requires reviewing the watch. Live cross-filtering and drilling do not alter it. Preview a check before saving, check now, pause/resume, and mark updates read. The bell has a small unread dot; it does not repeatedly notify on every check of the same ongoing breach. The last 30 triggered observations are retained.

Checks run in the Node server every 15 minutes, hour, or day, with a scheduler sweep once a minute. Keep the server running. In company mode, an owner's unexpired authenticated session and current source access are required; checks pause until sign-in resumes. In gateway mode a watch also pauses after a server restart until its owner has opened Canvas with a valid Gateway session. Notification delivery is **in-app only**; no email, Slack, browser push, or external service is configured by this feature.

Time-series checks skip the current UTC calendar period and wait for the most recently closed period. Nulls, missing periods, duplicate dates, stale data, and insufficient history produce a waiting state. Anomaly checks need 14 closed periods, use up to 60 prior observations, and compare against the median historical change with a scaled median absolute deviation range. Daily series use week-over-week changes once four weeks of history exist. Sensitivity adjusts the range, with a 1% floor for flat baselines. The range is an investigation aid, not a statistical confidence interval, and source completeness remains unverified. See the [NIST description of scaled MAD](https://www.itl.nist.gov/div898/software/dataplot/refman2/auxillar/mad.htm).

Library backups include conversations and alert observations, so handle them as company data. Restoring a library pauses all watches for review. Existing library backups without activity still restore correctly. Keep the same source and RLS configuration to recover the matching discussion scope.

### Personal source configuration

Keep personal connections out of tracked `sources.yaml`. Copy it to `sources.personal.local` (ignored by Git), add the connection there, and run `SOURCES_PATH=./sources.personal.local npm start`. When using the Connections form, start with this local configuration path too. The default configuration stays sample-only for walkthroughs.
