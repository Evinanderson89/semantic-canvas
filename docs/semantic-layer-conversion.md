# Multi-Dialect Semantic Layer Conversion, Coaching & CLI

Status: **built** across `src/semantic/convert.ts`, `src/semantic/coach.ts`, `scripts/semantic-cli.ts`, the `⌘K` Command Palette, REST endpoints, and Remote MCP (`POST /api/mcp`).

## Why

Analytics teams rarely live in a single metadata format. Warehouse tables may be registered in the **AWS Glue Data Catalog**, transformed with **dbt MetricFlow**, queried by AI assistants through **Snowflake Cortex Analyst**, served to applications via **Cube**, and explored as editorial stories in **Semantic Canvas (`duckglue`)**.

Semantic Canvas provides a bidirectional 5-dialect semantic converter and an automated **Semantic Layer Coach** so teams can:

1. **Translate semantic models** between `duckglue`, `snowflake`, `metricflow`, `glue`, and `cube` without hand-rewriting YAML boilerplate.
2. **Audit analytical readiness** across five governance dimensions—time-series honesty, driver attribution joins, unit-economics ratios, cohorts/cumulative windows, and AI/MCP synonyms—receiving copy-pasteable fixes in whichever dialect their repository uses.
3. **Enforce CI/CD Semantic Quality Gates** in pull requests with `npm run semantic -- coach --fail-under <score>`.

---

## Supported Semantic Layer Dialects

All five dialects are defined in `SEMANTIC_FORMATS` (`src/semantic/convert.ts`) and supported for both import (`parseSemanticLayerText` with `"auto"` detection) and export (`exportSemanticModel` / `convertSemanticLayer`):

| Dialect ID | Vendor / Specification | Default Filename | Structural Signature (`auto` detection) |
| --- | --- | --- | --- |
| `duckglue` | **DuckGlue / Canvas YAML** | `model.yaml` | Mapping `tables:` + `metrics:` + `joins:` + optional `model.calendar` |
| `snowflake` | **Snowflake Cortex Analyst** | `snowflake_semantic_model.yaml` | Array `tables:` (`base_table`, `dimensions`, `time_dimensions`, `facts`, `metrics`) + `relationships:` |
| `metricflow` | **dbt MetricFlow** (Semantic Layer v2) | `metricflow_semantic_models.yml` | Array `semantic_models:` (`model: ref(...)`, `entities`, `dimensions`, `measures`) + `metrics:` (`type_params`) |
| `glue` | **AWS Glue Data Catalog** + Lakehouse Manifest | `aws_glue_semantic_catalog.yaml` | `DatabaseInput` / `TableInputs` (`StorageDescriptor.Columns`, `Parameters`) + `SemanticLayerExtension` |
| `cube` | **Cube Semantic Layer** | `cubes.yml` | Array `cubes:` (`sql_table`, `joins`, `dimensions`, `measures`) |

### What translates—and where translation notes apply

- **Tables, keys, and columns:** Physical table references (`database`, `schema`, `table`), primary keys, column data types, temporal dimensions, descriptions, and table grain map directly across all five formats.
- **Joins and relationships:** Declared left/inner join paths and `many_to_one` / `one_to_one` cardinalities map to Snowflake `relationships`, MetricFlow `primary`/`foreign` `entities`, Cube `joins`, and Glue `SemanticLayerExtension.joins`.
- **Governed metrics:** Simple aggregations (`SUM`, `COUNT`, `COUNT(DISTINCT ...)`, `AVG`, `MIN`, `MAX`), `ratio` metrics (`numerator` / `denominator`), `derived` expressions, and `cumulative` metrics serialize idiomatically for each target dialect.
- **Honesty metadata (`reportingLag`, `synonyms`):** DuckGlue and AWS Glue preserve `reportingLag` (`reporting_lag_days` in Glue `TableInput.Parameters`) natively. When exporting to dialects without a native reporting-lag property, `exportSemanticModel` records explicit conversion notes in `summary.notes` rather than silently dropping context.

---

## Developer & CI/CD CLI (`npm run semantic`)

The `npm run semantic` CLI (`scripts/semantic-cli.ts`) runs locally or in headless CI pipelines with zero running server required.

### 1. List supported dialects (`formats`)

```sh
npm run semantic -- formats
npm run semantic -- formats --json
```

Displays all five `SemanticLayerFormat` identifiers (`duckglue`, `snowflake`, `metricflow`, `glue`, `cube`), vendor labels, default filenames, and descriptions.

### 2. Convert between any two dialects (`convert`)

```sh
# Auto-detect DuckGlue YAML and print Snowflake Cortex Analyst YAML to stdout
npm run semantic -- convert \
  --input sample-data/warehouse.yaml \
  --to snowflake

# Convert Snowflake Cortex Analyst YAML into dbt MetricFlow and write to disk
npm run semantic -- convert \
  --input ./snowflake_semantic_model.yaml \
  --from snowflake \
  --to metricflow \
  --output ./models/metricflow_semantic_models.yml

# Export AWS Glue Data Catalog + Lakehouse Semantic Manifest or Cube cubes.yml
npm run semantic -- convert --input sample-data/warehouse.yaml --to glue --output ./aws_glue_semantic_catalog.yaml
npm run semantic -- convert --input sample-data/warehouse.yaml --to cube --output ./cubes.yml
```

**`convert` flags:**

| Flag | Values / Default | Description |
| --- | --- | --- |
| `--input <path>` | Required | Path to source semantic layer YAML or JSON file |
| `--from <dialect>` | `auto` (default), `duckglue`, `snowflake`, `metricflow`, `glue`, `cube` | Source dialect (auto-detected when omitted or `auto`) |
| `--to <dialect>` | Required: `duckglue`, `snowflake`, `metricflow`, `glue`, `cube` | Target semantic layer dialect |
| `--output <path>` | Optional | Writes converted YAML to `<path>`; prints to `stdout` when omitted |

### 3. Audit model readiness & coach analytical questions (`coach`)

```sh
# Score a model across all 5 governance categories
npm run semantic -- coach --input sample-data/warehouse.yaml

# Coach a specific natural-language analytical question and emit fixes in Snowflake Cortex syntax
npm run semantic -- coach \
  --input sample-data/warehouse.yaml \
  --question "Net revenue retention and churn over time" \
  --format snowflake

# Filter to one readiness goal or emit a machine-readable JSON report
npm run semantic -- coach \
  --input sample-data/warehouse.yaml \
  --goal ratios_and_funnels \
  --format metricflow \
  --json
```

**`coach` flags:**

| Flag | Values / Default | Description |
| --- | --- | --- |
| `--input <path>` | Required | Path to semantic model file (any of the 5 dialects; parsed via `parseSemanticLayerText`) |
| `--from <dialect>` | `auto` (default) or dialect ID | Optional explicit input dialect |
| `--goal <category>` | `all` (default), `time_series`, `driver_attribution`, `ratios_and_funnels`, `cohorts_and_cumulative`, `agent_readiness` | Restrict findings to a specific readiness category |
| `--question "<text>"` | Optional | Evaluate whether the model can answer a natural-language business question now, and generate missing metric/join YAML recipes |
| `--format <dialect>` | `duckglue` (default), `snowflake`, `metricflow`, `glue`, `cube` | Render coaching YAML snippets in the chosen semantic dialect |
| `--json` | Boolean flag | Output the complete `SemanticCoachReport` JSON payload to `stdout` |
| `--fail-under <0-100>` | Optional numeric threshold | Exit with status code `1` when `report.overallScore < threshold` (`0` otherwise) |

### CI/CD Semantic Quality Gate (GitHub Actions)

Add `--fail-under` to pull-request checks so unjoined foreign keys, missing `timeColumn` / `reportingLag` declarations, or undocumented metrics are caught before merge:

```yaml
name: Semantic Layer Quality Gate
on:
  pull_request:
    paths:
      - "sample-data/**/*.yaml"
      - "models/**/*.yml"

jobs:
  semantic-coach:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - name: Enforce semantic readiness >= 85/100
        run: npm run semantic -- coach --input sample-data/warehouse.yaml --fail-under 85
```

---

## In-App UI: Semantic Layer Coach & `⌘K` Command Palette

### Semantic Layer Coach & Dialect Switcher

Open **Semantic Layer Coach** from **Metric Registry**, **Data Model**, the dashboard `•••` actions menu, or the `⌘K` Command Palette:

- **5-Dialect Recipe Switcher:** Toggle between `DuckGlue / Canvas`, `Snowflake Cortex`, `dbt MetricFlow`, `AWS Glue`, and `Cube` at the top of the panel. Every coaching finding and custom question recipe updates immediately to `finding.snippetsByFormat[selectedFormat]`.
- **Convert & Export Full Model Drawer:** Export the active source's model to any of the five dialects (`GET /api/model/export?format=...`) or paste external semantic YAML/JSON to convert dialects in-browser (`POST /api/model/convert`), with one-click copy and file download.

### `⌘K` / `Ctrl+K` Universal Command Palette

Press **`⌘K`** (macOS) or **`Ctrl+K`** (Windows/Linux)—or click the **`⌘K`** button in the workspace header or dashboard topbar—to open the accessible keyboard launcher:

- **Semantic Metrics (Synonym-Aware):** Search across metric `name`, `label`, `baseTable`, and domain `synonyms` (e.g., typing `"arr"`, `"top line"`, or `"attrition"` surfaces the governed metric). Selecting a metric while editing an unlocked dashboard places a prepared chart tile directly onto the canvas.
- **Actions:** Launch *Semantic Layer Coach & Dialect Converter*, *Executive digest & SHA-256 verified brief*, *Dashboard-as-Code (YAML sync & diff)*, *Review and share (Dashboard, Story & Infographic)*, *Improve dashboard with AI*, *Vector SVG / PNG export*, or *Operations, ROI & audit log*.
- **Themes:** Switch live canvas themes between `editorial-warm`, `executive-slate`, `high-contrast-print`, and `boardroom-dark`.
- **Navigate:** Jump directly to *Workspace Home*, *CoreCanvas Library*, *Metric Registry*, *Data Model*, *Modeler*, or *Connections*.

---

## REST API & Remote MCP Endpoints

### REST API

All model endpoints respect active source selection (`?source=<id>`) and company-mode RBAC/RLS session scopes:

- **`GET /api/model/export?format=<duckglue|snowflake|metricflow|glue|cube>`**
  Exports the active source's governed semantic model in the requested dialect (`duckglue` by default). Returns `{ format, filename, content, summary: { tables, metrics, joins, notes } }`.
- **`POST /api/model/convert`**
  Converts a model between dialects. Accepts JSON `{ targetFormat, content?, sourceFormat? }`. When `content` is omitted, exports the active source's model; when `content` is supplied, parses it (`sourceFormat` defaults to `"auto"`) and returns `{ sourceFormat, targetFormat, filename, content, summary }`.
- **`GET /api/model/coach` & `POST /api/model/coach`**
  Runs `coachSemanticModel` against the active source with optional `goal` and `question` parameters, returning `{ modelName, overallScore, categoryScores, summary, strengths, findings, questionAnalysis }` with `snippetsByFormat` populated for all five dialects.

### Authenticated Remote MCP (`POST /api/mcp`)

External AI agents connected via `POST /api/mcp` can invoke two dedicated semantic governance tools alongside catalog and query tools:

- **`convert_semantic_model`:** Accepts `{ targetFormat, content?, sourceFormat? }` to translate either the active workspace model or supplied YAML/JSON across `duckglue`, `snowflake`, `metricflow`, `glue`, and `cube`.
- **`coach_semantic_model`:** Accepts `{ goal?, question? }` to evaluate model readiness, inspect category scores, and retrieve multi-dialect YAML improvements before proposing metrics or building dashboards.
