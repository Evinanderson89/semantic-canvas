# Semantic Canvas

An open-source canvas for building dashboards from governed metrics. Connect a supported semantic model, start with a suggested dashboard or an empty canvas, and arrange charts, KPIs, notes, headings and images into a story.

**Open-source alpha with opt-in company mode.** Try the local sample immediately, or self-host a company workspace with OpenID Connect sign-in, server-enforced roles and source/row access. Team mode is an early release: validate your identity provider and policies before onboarding real users. Local mode’s role picker remains a simulation.

## Part of the Semantic Canvas suite

The packaging direction is **one suite with two apps**: Semantic Canvas for governed analytics and dashboard design, and Ingest for bringing data into databases. Gateway provides the shared workspace, sign-in and app navigation. Canvas remains independently usable.

The intended installation choices are **Full workspace** (default), **Canvas only**, and **Ingest only**. The standalone Canvas setup below works today; the full workspace's company deployment, release bundle and automatic Ingest-to-Canvas handoff remain unfinished. See [suite packaging and integration status](docs/suite-packaging.md) and the [Gateway/Ingest repository](https://github.com/Evinanderson89/gateway-platform).

## Run it

With Docker:

```sh
docker compose up --build -d
```

Open [the local demo](http://localhost:5173). Dashboard storage persists in a named volume. For HTTPS company deployment, SSO, logging and recovery, follow the [self-hosting guide](docs/self-hosting.md).

For local development:

Use a supported Node.js release: 22.12+, 24.x, or 26+.

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
- Export charts as CSV or export a dashboard as PNG.
- Review workspace setup in Connections, upload a semantic model, and download a complete dashboard-library backup.
- In company mode, sign in through your identity provider and assign viewer/editor/admin roles with source and row access.
- Collect JSON application/audit logs or export logs and request traces through OpenTelemetry.

See [references, tabs and connected filters](docs/reference-tabs-filters.md) for a walkthrough, file limits and current boundaries.

## What this alpha guarantees—and where it stops

Saved documents have a version, a source identity and a revision. Conflicting updates return an error, and the browser keeps its unsaved work. A new dashboard gets a new identity. The save limit is 8 MB per document, including images.

Queries validate metrics, dimensions and structured filters before compiling SQL. Charts, field samples, distinct values and ranges use the same row restrictions. A policy that cannot be enforced denies that query. A missing or malformed policy file stops startup instead of disabling restrictions.

Time-series limits keep the newest result window. Responses disclose truncation and the visible date window; limited CSV exports are labeled. Period comparisons look up the previous calendar period, so gaps stay unknown. First-of-month snapshots remain visible. The app shows **Coverage unverified** because observed dates do not prove that a reporting period is complete. Fiscal calendars and upstream completeness metadata are not implemented.

Snapshot and retention metrics in the sample declare their supported monthly grain. Unsupported rollups and all-time snapshot sums are rejected instead of returning misleading totals. Model authors can declare `time_grains`, `time_dimension`, optional dashboard `importance`, and `direction` (higher, lower or neutral) in YAML. Undeclared direction uses neutral KPI colors.

These are tested local behaviors, not a claim of semantic equivalence with every vendor's query engine. See [the alpha contract](docs/alpha-contract.md) for supported imports, migration details and known limits.

## Connect a source

Open **Connections** to add, edit or select a source, or edit `sources.yaml`. A source pairs a semantic adapter with a warehouse connector.

| Adapter | Supported import | Explicitly unsupported |
| --- | --- | --- |
| `duckglue` | Bundled YAML model, trusted metric expressions and declared joins | Multi-hop or ambiguous joins |
| `dbt` | Simple metrics backed by supported column aggregates in `semantic_manifest.json` | Ratio, derived, cumulative and conversion metrics; metric filters; non-additive measures; computed dimensions |
| `snowflake-semantic` | Plain-column fields, table-level metrics, composite join keys, left/inner joins, database/schema qualification | Computed fields, named filters, top-level derived metrics, repeated physical table names with different aliases |

Unsupported imports return a source error explaining what could not be represented. The dbt and Snowflake adapters import files and compile local SQL; they do not call the native dbt Semantic Layer or Snowflake semantic query service.

Connectors: local Parquet through DuckDB, and Snowflake. The sample is tested against DuckDB. Snowflake execution requires your own credentials and verification against your model.

For Snowflake, copy `.env.example` to `.env`, fill in the required settings, then configure a source. Use a read-only warehouse role. Connection credentials stay on the local server and are referenced by environment variables in `sources.yaml`.

## AI and MCP

AI is optional. The embedded agent currently supports **Anthropic only**. Set `ANTHROPIC_API_KEY` in `.env` and configure an available model in the `ai` block of `sources.yaml`. The canvas and rule-based suggestions work without a key.

Embedded tools and conversation histories are bound to the selected source and principal; in company mode, they also carry the authenticated caller’s session and are isolated by user. A model cannot switch that scope by changing its tool arguments. AI recommendations still need human judgment; they are not proof of causation or business correctness.

To connect an external MCP agent, keep the app running and start:

```sh
npm run mcp
```

The MCP server exposes catalog discovery, scoped queries, dashboard save/open, layout selection and user questions through the same HTTP API. External MCP clients are trusted local clients and may explicitly select simulated roles. External MCP authentication for company mode is not implemented; team API access is refused without a session.

To update a saved dashboard, call `get_dashboard` and pass its `revision` into `save_dashboard`; revision `0` creates a new document. Both tools accept a `source`. Set `SEMANTIC_CANVAS_URL` when the API uses a different port.

## Data and recovery

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

**CoreCanvas Library** in the sidebar is the workspace home for saved dashboards and reusable views. Create folders and subfolders, search across the library, and use each item's menu to rename or move it. The library replaces **Explore by topic** with Company overview, Revenue & retention, Growth & customers, Shared views (KPI summaries, Trends & comparisons, Story sections), and Examples. On first setup, unfiled dashboards using these topics move into the matching folder; existing folder choices and dashboard contents stay intact. Other dashboards stay at the root. The sample catalogue includes nine live starter dashboards in these folders. Starters open as independent copies: save to keep your version, and reopen **Examples → Dashboard cleanup demo** for a fresh before-and-after exercise. Examples and Shared views start collapsed. Folders, starters, and setup state persist in the library database and backups; later renames, moves, and deletions are respected.

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
