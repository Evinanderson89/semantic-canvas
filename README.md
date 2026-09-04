# semantic-canvas

An open-source BI tool that reads the semantic layer you already have, suggests
a dashboard from it, and lets you rearrange the result on a canvas.

    npm install
    npm start          # api on :5174, ui on :5173

That runs against the bundled duckdb source in `sources.yaml` -- no
credentials needed. To point it at your own warehouse, see "Connecting your
own source" below.

## The idea

Charts are never built from hand-written SQL. A dashboard is a **spec** naming
metrics and dimensions that exist in the model; the spec is validated against
the model, then compiled to SQL for whichever connector is attached.

That is what makes the agentic part trustworthy. Asking a model to write SQL is
open-ended and fails quietly. Asking it to choose from a closed set of governed
metrics is constrained, and anything it invents is rejected before a chart is
drawn rather than rendered as a plausible wrong number.

    semantic layer  ->  Model  ->  DashboardSpec  ->  validate  ->  SQL  ->  rows  ->  chart
       (adapter)                    (agent or UI)                (connector)      (rules)

## Layout

    src/semantic/     adapters; every layer normalizes to one Model
    src/connectors/   SQL endpoints + dialect differences
    src/compiler/     spec validation and spec -> SQL
    src/suggest/      dashboard proposal + chart-type rules
    src/charts/       one <Chart kind=...> interface over every chart type
    src/app/          entry screen, canvas, tile picker

## Connecting your own source

A **source** is a semantic adapter (what the model is written in) paired with
a connector (where the SQL runs) -- independent axes, both listed in
`sources.yaml`. Sources connect in parallel at boot; one that fails to
connect is marked unavailable and logged, it does not take the others down.

**From the app**: open Connections in the sidebar. "+ Add source", or "Edit"
on an existing one, both test-connect with what you enter before saving
anything; on success credentials go to `.env` (an env-var reference, never
the credential itself, lands in `sources.yaml`) and the source is live
immediately -- no file editing, no restart. Editing pre-fills everything
except credentials (the server never sends those back to the browser) --
leave a credential field blank and the existing one is kept, resolved
server-side. "Remove" deletes a source's block from `sources.yaml` after an
inline confirmation; the last remaining source can't be removed.

**By hand**, if you'd rather not go through the browser:

1. `cp .env.example .env` and fill in credentials for the warehouse you're
   attaching (skip this if you're only using the bundled duckdb source).
2. Uncomment the matching block in `sources.yaml` -- there's a filled-in
   template for dbt-on-Snowflake already there -- and point `model` at your
   adapter's manifest.
3. `npm start`. The server logs one line per source: ready with table/metric
   counts, or the error if it isn't.

Adapters currently implemented: `duckglue`, `dbt` (semantic manifest --
this is dbt's MetricFlow output, `semantic_manifest.json`, not a separate
integration), and `snowflake-semantic` (Cortex Analyst / native Semantic
Views YAML). Connectors: `duckdb`, `snowflake`. Adding a warehouse is config
in `sources.yaml`, not code -- everything downstream (compiler, canvas,
row-level security, cache) is source-agnostic.

## Bring your own agent

Semantic-canvas also has an agentic port: an MCP server (`src/mcp/server.ts`)
that any MCP-capable agent -- Claude Desktop, Claude Code, or anything else
that speaks MCP -- can attach to, read the semantic model with, run governed
queries against, and build a dashboard through. It's a thin layer over the
same HTTP API the browser UI uses (`npm run server` has to be running), so an
agent gets exactly the same validation, compiler and row-level security the
UI does -- nothing it can reach lets it write raw SQL or see past RLS.

    npm run mcp        # starts the MCP server on stdio

To point Claude Desktop at it, add to `claude_desktop_config.json`:

    {
      "mcpServers": {
        "semantic-canvas": {
          "command": "npx",
          "args": ["tsx", "/absolute/path/to/semantic-canvas/src/mcp/server.ts"]
        }
      }
    }

Tools exposed: `list_sources`, `describe_model`, `profile_field` (cardinality
and samples, for curating a sane breakdown before charting one), `query_metric`,
`list_dashboards` / `get_dashboard` / `save_dashboard`, `list_layouts` /
`arrange_dashboard` (the named layout templates below), and `ask_user` -- a
question the agent asks mid-task appears as a prompt in the human's own
semantic-canvas browser tab (polled for, answered there, picked back up by
the still-waiting tool call), not just in the agent's own chat. That's
deliberate: the point of an agent curating a dashboard is that it's building
something for a person who's watching it happen, not working unsupervised.

### Named layouts

Smart Arrange (the toolbar button, and `arrange_dashboard` for an agent)
doesn't just pack tiles into rows -- it scores the current tile set against a
small library of named templates (`src/canvas/layouts.ts`) and picks whichever
fits, the same way `recommend()` scores chart types instead of hiding the
choice in an if/else:

- **Exec Summary** -- headline KPIs in one row, trend/breakdown charts below.
  Wins when there are a couple of real headline numbers *and* something
  backing them up; KPIs or charts alone don't trigger it.
- **Grid** -- the fallback: packs everything into clean rows in reading order.
  Always applies, whatever the mix.

Two templates today, not the full set this could grow into -- a first,
provably-working slice rather than a library built before anything used it.

## Two entry points, one document

**Suggest a dashboard** reads the model and proposes one. **Start from scratch**
opens an empty canvas. Both produce the same `DashboardSpec`, so anything one
can express the other can too.

## Deliberate choices

**Chart type is derived, not chosen.** Time dimension -> line, one categorical
-> bar, two measures -> scatter, none -> stat tile. A model asked for a chart
type will eventually put a pie chart on a time series.

**Metrics are grouped by unit class before sharing an axis.** A retention ratio
of 1.01 drawn against MRR of 200,000 is a flat line at zero. Currency, ratio,
duration and count each get their own tile.

**Suggestion is rules-based first.** Deterministic, offline, testable, and it
gives the natural-language path something to be measured against. The LLM seam
produces the same DashboardSpec.

## Status

Works: duckglue, dbt and Snowflake-semantic adapters, DuckDB and Snowflake connectors, multi-source
registry with an in-app Connections screen (add, edit, remove and switch
sources live, no restart), validation, compiler, suggestion, resizable
canvas, tile picker, Plot-backed charts, dashboard saving, row-level
security, an MCP server for bringing your own agent, and named-layout-aware
Smart Arrange.

Not yet: natural-language requests typed directly into the UI (only via an
MCP-connected agent today), cross-filtering, magnitude-aware axis splitting
(CAC and MRR are both currency but three orders of magnitude apart -- they
still share an axis), and more than two named layouts.
