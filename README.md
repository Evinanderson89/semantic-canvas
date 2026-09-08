# Semantic Canvas

An open-source canvas for building dashboards from governed metrics. Connect a supported semantic model, start with a suggested dashboard or an empty canvas, and arrange charts, KPIs, notes, headings and images into a story.

**Local alpha.** The app runs on your computer. The role picker demonstrates row restrictions; it is not user authentication. This release is not a shared or internet-facing BI server.

## Run it

Use Node.js 22 or newer.

```sh
npm ci
npm start
```

Open [Semantic Canvas](http://127.0.0.1:5173). The API runs at `127.0.0.1:5174`. The bundled sample warehouse needs no credentials.

## What you can do

- Start from scratch or generate a dashboard from the semantic catalog.
- Move, resize, align and layer tiles; use Smart Arrange to apply a Grid or Exec Summary layout.
- Add KPIs, charts, tables, headings, notes, dividers and images.
- Explore with filters and time drill-downs, then refresh data without replacing the design.
- Save, reopen, save a copy, undo canvas changes and recover unsaved drafts from Home.
- Use deterministic chart recommendations and optional AI critique, explanations and story suggestions.
- Export charts as CSV or export a dashboard as PNG.

## What this alpha guarantees—and where it stops

Saved documents have a version, a source identity and a revision. Conflicting updates return an error, and the browser keeps its unsaved work. A new dashboard gets a new identity. The save limit is 8 MB per document, including images.

Queries validate metrics, dimensions and structured filters before compiling SQL. Charts, field samples, distinct values and ranges use the same row restrictions. A policy that cannot be enforced denies that query. A missing or malformed policy file stops startup instead of disabling restrictions.

Period comparisons look up the previous calendar period, so gaps stay unknown. First-of-month snapshots remain visible. The app shows **Coverage unverified** because observed dates do not prove that a reporting period is complete. Fiscal calendars and upstream completeness metadata are not implemented.

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

Embedded tools and conversation histories are bound to the selected source and simulated role. A model cannot switch that scope by changing its tool arguments. AI recommendations still need human judgment; they are not proof of causation or business correctness.

To connect an external MCP agent, keep the app running and start:

```sh
npm run mcp
```

The MCP server exposes catalog discovery, scoped queries, dashboard save/open, layout selection and user questions through the same HTTP API. External MCP clients are trusted local clients and may explicitly select simulated roles.

To update a saved dashboard, call `get_dashboard` and pass its `revision` into `save_dashboard`; revision `0` creates a new document. Both tools accept a `source`. Set `SEMANTIC_CANVAS_URL` when the API uses a different port.

## Data and recovery

Saved dashboards live in `~/.semantic-canvas/dashboards.duckdb`. Set `SC_DATA_DIR` to choose another directory. Unsaved recovery drafts are stored in this browser and appear on Home; they do not include query result rows or connection credentials. Browser storage has a quota, so save larger image-heavy documents explicitly.

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
| `src/security` | Policy loading and shared query/discovery scope |
| `src/store` | Document migration, source isolation and atomic revision checks |
| `src/app`, `src/canvas` | Editing, document recovery, chart controls and canvas geometry |
| `src/suggest`, `src/charts` | Suggestions and rendering |
| `src/agent`, `src/mcp` | Embedded AI and external agent tools |

## Next

Team authentication and authorization, native semantic-layer execution, completeness metadata, an evaluated AI action model with preview/apply/undo, responsive layouts and collaboration remain future work. This alpha focuses on preserving authored work and rejecting answers the current implementation cannot produce faithfully.

MIT licensed. See [LICENSE](LICENSE).
