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

Semantic-canvas has an agentic port: an MCP server (`src/mcp/server.ts`)
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

Tools exposed (`src/agent/tools.ts` -- one definition, shared by every agent
below): `list_sources`, `describe_model`, `profile_field` (cardinality
and samples, for curating a sane breakdown before charting one), `query_metric`,
`list_dashboards` / `get_dashboard` / `save_dashboard`, `list_layouts` /
`arrange_dashboard` (the named layout templates below), and `ask_user` -- a
question the agent asks mid-task appears as a prompt in the human's own
semantic-canvas browser tab (polled for, answered there, picked back up by
the still-waiting tool call), not just in the agent's own chat. That's
deliberate: the point of an agent curating a dashboard is that it's building
something for a person who's watching it happen, not working unsupervised.

### The embedded agent

The MCP server is a port *out* -- it needs you to bring an agent (Claude
Desktop, Claude Code) and attach it yourself. There's also an agent that
lives *in* the app: a chat panel on the canvas, backed by the same tool list
above, so "curate this dashboard" means the same thing whether it's typed
into Claude Desktop over MCP or into this panel -- including `ask_user`,
which surfaces in this same tab either way.

It's configured the same way a data source is -- a pluggable port, not
hardcoded to one provider:

    # sources.yaml
    ai:
      provider: anthropic
      model: claude-opus-5
      apiKey: ${ANTHROPIC_API_KEY}

Set `ANTHROPIC_API_KEY` in `.env` (see `.env.example`) and the chat toggle
appears in the bottom-right corner of the canvas; leave it unset and the
panel simply isn't there, the same as a source that never got credentials --
nothing else in the app depends on it.

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
  Always applies, whatever the mix. A row stretches to fill its own width
  rather than leaving whatever's left over as dead margin -- but capped at
  roughly three-quarters of the row, not all the way to the edge, so a
  chart that ends up alone in its row (easy after a reorder, since reading
  order decides what shares a row, not width) doesn't get stretched thin
  across the entire canvas either (`arrange()` in `src/canvas/geometry.ts`).

Two templates today, not the full set this could grow into -- a first,
provably-working slice rather than a library built before anything used it.

### Additions don't pile up one per row

`arrange()`'s stretch cap (above) is right for a deliberate, one-shot "make
this look clean" pass, but wrong for an INCREMENTAL repack -- and two real
call sites are exactly that: Beautify's "Add this tile" (applied one at a
time, up to three proposed per pass) and the tile-overlap self-healing
reflow. Both call `applyLayout("grid", ...)` after changing exactly one
tile, and both used to inherit the stretch by default. That compounds: a
480px addition landing alone in its row gets stretched toward the ~72% cap,
so the NEXT 480px addition -- repacked from that already-widened layout --
no longer fits beside it either, and ends up alone and stretched too. Every
addition lands in its own near-full-width row, and a dashboard that just
grew by three tiles needs three more screens of scrolling to see them --
not because the canvas ran out of room, but because each addition's own
stretch used up the room the next one needed. `arrange()` now takes a
`stretch` option (default true, so Smart Arrange and Beautify's "Reorder
top to bottom" are unaffected); both incremental call sites pass `false`,
so an addition keeps its raw 480px and same-sized tiles keep sharing rows.
`suggestDashboard()` (`src/suggest/suggest.ts`) had the same dead-space
shape from the opposite direction: with three unit-class trend groups, the
third has no partner and used to stay at half-width regardless, leaving the
right half of that row empty. Since this layout is hand-rolled rather than
routed through `arrange()` -- interleaving several different-height
sections (KPIs, trends, breakdowns) back to back makes a width-only repack
risky, it could weld a shorter tile from the next section into a
still-open row -- the lone trend group's width is widened directly to fill
its row instead.

### Tile-overlap self-healing

A tile's own edit can change its HEIGHT -- Beautify's "Show over time" grows
a KPI-height tile back up to chart height, "Remove breakdown" shrinks a
chart down to a KPI -- without knowing what sits below it on the canvas.
Nothing else on the canvas moves to make room, so a tile that grew (or a
neighbor that never had a reason to move) can end up visually overlapping
another one. Every per-tile update flows through one choke point (the
`onUpdate` prop `App.tsx` passes to `<Tile>`), so that's where the fix
lives: after applying an update, check whether it collided with any other
tile (`overlaps()` in `src/canvas/geometry.ts`) and, only if it did, repack
the whole dashboard through the same grid layout Smart Arrange already
uses. An ordinary edit that never touches layout, or one that does but
doesn't collide with anything, is left alone -- this only overrides a
user's deliberate manual placement in the one case where the canvas would
otherwise be showing a genuine layout bug.

### Selecting a tile keeps it visible

The Inspector (the settings panel a tile's selection opens) is a real
column in the `.shell` grid, not an overlay -- it genuinely takes width
away from the canvas viewport. A tile sitting near the right edge, fully
visible a moment ago, can end up with part of itself behind the panel that
just opened to edit it: exactly the shape of a tile that looks like it's
"escaping its bounds," except this time the tile really has drifted out of
the visible area, not just out of its own boundary. Scrolling alone can't
always fix this -- when the tile itself is wider than what's left of the
viewport once the Inspector opens, bringing its right edge into view pushes
the left edge out and vice versa; no scroll position shows both at once.
So selecting a tile (`App.tsx`) first shrinks zoom just enough to make the
whole tile fit -- never grows it, only ever gives back room the Inspector
took, the same clamped fit-to-available-space `fit()` already does for the
whole canvas -- then scrolls the tile fully into view, measured from its
actual rendered position rather than reconstructed from the layout spec's
x/y/w/h (fixed chrome around the canvas doesn't scale with zoom the way the
tile itself does, so a formula-only version can still leave it a few pixels
short).

### An area chart doesn't fake a rise from a period with no data yet

A metric that needs trailing history to compute -- an annualized rate,
say, which needs a full trailing window before it means anything -- has a
real SQL NULL for its first period or two, not a zero. Observable Plot's
line mark already gaps a null y correctly (skips the point, breaks the
curve there), but its area mark doesn't extend that same "defined" test to
the filled shape: the fill still reached back to cover the missing period,
drawing a wedge from an implicit zero up to the first real value. At a
coarse enough grain (quarter, where the metric's very first bucket is
often entirely null) this reads as "logo churn shot up from nothing," when
the true story is "no data existed yet." `definedRows()`
(`src/charts/Chart.tsx`) filters both the fill and the line to rows with a
real value before either mark sees them, for both the plain and stacked
area cases. Checked with `!= null` specifically, not a numeric finiteness
test -- `Number(null)` is `0` in JavaScript, not `NaN`, so a finiteness
check alone would keep exactly the null values this is meant to drop.

### A freshly suggested dashboard fits the viewport it just appeared in

**Suggest a dashboard** computes its tiles against the authored canvas
WIDTH (`canvas.width`, e.g. 1440 for the Desktop preset), so the tiles
themselves are never actually too wide for that canvas -- but the canvas
still needs to be zoomed DOWN to fit whatever screen it's showing on,
which is what `fit()` is for. That call used to fire from a bare
`requestAnimationFrame(fit)` scheduled right when the `/api/suggest`
response came back -- but that response is exactly when the editor mounts
for the first time (the Entry screen unmounts, `.main` and the canvas
surface mount in its place), and a single rAF isn't guaranteed to run
AFTER React has committed that transition. `fit()` could end up measuring
`mainRef`'s width from the OLD Entry screen (wider, no sidebar categories
yet) instead of the real editor layout that had just replaced it --
computing a zoom for the wrong screen and leaving the actual suggested
dashboard sitting at 100%, genuinely wider than the visible viewport.
Replaced with a `useEffect` keyed on `dash`, which React guarantees runs
after the DOM for that render has committed -- `mainRef.current` is
always the real, current layout by the time it fires. Gated by a
`pendingFit` ref rather than firing on every `dash` change: an ordinary
tile edit also updates `dash`, and refitting then would silently undo a
zoom level the user set on purpose.

## Two entry points, one document, and a demo

**Suggest a dashboard** reads the model and proposes one. **Start from scratch**
opens an empty canvas. Both produce the same `DashboardSpec`, so anything one
can express the other can too.

**See Beautify in action** (`src/suggest/demo.ts`) is a third, optional entry
point: a fixed, checked-in dashboard against the bundled sample warehouse,
deliberately built with four real, verified problems instead of generated
fresh each time. `suggestDashboard()` is built to avoid these problems by
construction, which is exactly why it's a poor demo of the tools that catch
them -- there's usually nothing left for Beautify or Smart Arrange to find.
Each tile earns its place by triggering one specific rule this app ships,
not a hypothetical: `web_sessions` at day grain is genuinely noisy real
data, so Beautify offers coarsening to week; `new_mrr` by `movement_type`
is the exact reported bug `detectDegenerate()` exists for (every category
but "new" reads zero), rendered as a plain bar despite `fct_mrr_movements`'
own synonyms naming it a "mrr waterfall," so Beautify separately offers
switching to that; `new_signups` by `dim_users.country` is geographic data
explicitly left as a table, so Beautify offers a map. The layout is
deliberately overlapping -- the same free positioning the canvas always
allows -- so Smart Arrange has an honest, visible mess to pack into clean,
non-overlapping rows. `demoDashboardAvailable()` gates the entry card on
the connected model actually having these specific tables and metrics, so
a real customer's own source just doesn't see the card rather than being
offered a demo that would fail to compile against it. The corpus test
suite (`test/corpus.test.ts`) checks the demo's premises against the real
warehouse on every run -- not just that the tiles compile, but that d2 is
still actually noisy and d3 is still actually degenerate -- so a change to
the sample data generator that quietly fixed either one would fail a test,
not just go unnoticed until someone next opened the demo by hand.

## Interacting with a chart

**Click a bar or category** to cross-filter -- every tile whose join graph
reaches that field re-queries scoped to it, shown as a chip in a bar above
the canvas; click the chip to remove it. **Click a bucket on a line/area/bar
chart with a time axis** to drill into it instead: the tile re-queries at
the next finer grain (year -> quarter -> month -> day; week also drills
straight to day) scoped to that exact bucket, with a breadcrumb to climb
back out. Both are per-tile or per-dashboard view state -- neither is saved
into the dashboard spec.

**Explain this** (the sparkle icon in a tile's header, once an embedded
agent is configured) asks it what a tile's numbers mean -- it can run a
couple of its own governed queries to check what's actually driving a
change rather than guessing, and answers in a small popover, not a chat.
Every agent response on the canvas -- Explain, a tile's own Beautify, and
the dashboard-level one -- goes through a small, safe markdown renderer
(bold, `code`, bullet lists; `src/app/markdown.tsx`) rather than printing
the model's raw text, so a critique that reaches for structure reads as
structure instead of literal asterisks and backticks. A tile's popover
also isn't clipped to the tile's own height any more: a KPI card collapsed
down to its natural size (see below) still has room to show a response
longer than the card itself.

**Export** (the tile header's download icon) offers the tile's current
result as CSV, or the tile as a PNG snapshot; the dashboard toolbar has a
PNG export for the whole canvas. Both are client-side -- no server round
trip beyond the query that's already on screen.

**Beautify** (the wand icon, in edit mode) runs three rules checks, not
one, before it ever needs an agent. The first is chart-KIND fit -- the same
`recommend()` that scores chart types in the Inspector, just pointed back
at a chart that already exists -- catching a structurally wrong choice (a
geographic breakdown left as a table) with a one-click fix. The second
catches what the first one can't: a chart can be the structurally *right*
kind and still be unreadable -- a daily-grain line that zigzags across most
of its own range every single point reads as noise, not a trend, and no
chart-kind swap fixes that, only a coarser grain does. Scored as the mean
absolute point-to-point change relative to the series' own range (so it's
magnitude-free -- a metric swinging between 0.01 and 0.02 scores the same
as one swinging between 10,000 and 20,000), with a one-click fix to the
next coarser grain (day -> week -> month -> quarter -> year) when it fires.
Coarsening itself is careful not to trade one misleading chart for
another: a metric's real date range rarely lines up with a week/month
boundary, so the FIRST and LAST bucket a coarser grain produces are often
partial -- `date_trunc('week', ...)` still buckets a Sep-1 row with the
Monday before it even though only that one real day falls in the bucket,
so its total reads as a collapse next to a full week right beside it (the
same shape as the noise this coarsening is supposed to fix, just moved to
the edges instead of removed). `compileTile()`
(`src/compiler/compile.ts`) drops a coarsened bucket that isn't a full
period, compared against the query's own actual date range rather than
any external calendar assumption, so this holds for whatever date range a
filter or cross-filter narrows the tile to, not just the whole table's own
span. Applied before any period-over-period comparison, not after --
comparing against an already-partial neighbor would report a real-looking
but meaningless swing for whichever row sits next to the trimmed one.

Reported, not just trimmed: dropping the edge silently traded one problem
for a quieter one -- a customer coarsening their own chart would see it
end a period earlier than expected with nothing on screen explaining why.
The query reports which edges it trimmed (`splitPartialPeriods()`, the
same file), and a tile whose data actually got trimmed shows a small
"partial start/end excluded" note next to its title, with the reasoning on
hover. A data set that doesn't span even ONE full period at the chosen
grain -- a source only a few days old, viewed at month grain -- returns
zero rows this way rather than crashing or returning nothing explicable;
the tile shows "Not enough data yet for a full {grain}" instead of a bare
empty chart. Getting the flag out of a query that might have zero
surviving rows is the one non-obvious part: a naive constant column,
attached in the same query that filters the partial rows away, has
nothing left to attach to once every row is gone. A second, independent
bounds query -- deliberately not reusing the first, filtering one --
`LEFT JOIN`ed from the bounds side (which always has exactly one row)
guarantees the flags survive even then.
The third catches a chart that's the right kind, at a fine-enough grain,
and still says nothing: a single-dimension breakdown with no real
contrast in it. Two shapes of the same problem, both read off the actual
data rather than the metric's filter expression, so either catches the
same shape for any reason it happens to occur, not just the bundled
model's own examples of it: several categories come back but every one but
one reads zero (`new_mrr` is already `movement_type = 'new'`, so cutting
it BY movement_type can only ever draw one real bar and four empty ones);
or the breakdown itself only ever returns one row, because the metric's
own filter already pins the exact dimension it's being cut by to one value
(`mrr` is already `status = 'active'`, so cutting it by status returns
just the single row "active" -- no empty bars to notice, just one bar with
nothing to compare it to). Its base table's own date
column, if it has one, is a strictly better rescue than collapsing to a
bare number -- "removed" throws away an axis the data actually has
something to say on -- so "Show over time" leads when that column exists,
with "Remove breakdown" (a plain KPI) offered either way. "If it has one"
is deliberately narrow: not just any date-typed column, only the table's
declared partition key or a date-typed primary key on a table genuinely
grained by period (`timeColumnOf()` in `semantic/model.ts`). A lifecycle
date -- `fct_subscriptions.started_on` -- looks the same type-wise but
isn't safe to trend a current-state metric by: grouping active MRR by
signup date produces a cohort breakdown (each bucket only holds currently
active rows that happen to share a start date), not a real trend, and
would otherwise draw a chart that looks like MRR over time but isn't one.
A table with no column meeting that bar just doesn't get a "Show over
time" option -- a table, not a misleading trend, is the honest fallback.
Underneath
all three, once an agent is configured, "Ask the agent for more" asks for
presentation critique specifically -- sort order, clutter, a better
breakdown -- a different question from "Explain this," which only ever
narrates what the numbers mean.

**Beautify dashboard** (next to Smart Arrange in the canvas toolbar) asks
the same two questions of the WHOLE dashboard instead of one tile. The
rules pass scans every tile for the noisy-grain and pointless-breakdown
problems above and lists each one with its own one-click fix. Underneath it, once an agent is
configured, a second pass reads every tile's title, chart kind and what it
measures, and proposes a dashboard title and a top-to-bottom reading order
-- headline numbers first, the trend that explains them next, supporting
detail last -- plus notes on anything worth a specific callout (an odd
chart choice, a tile that duplicates another one, a KPI whose dimension
makes its definition ambiguous). Unlike a tile's own Beautify, this
suggestion is meant to be applied, not just read: "Use this title" commits
it straight to the dashboard, and "Reorder top to bottom" re-packs every
tile into that order using the same row-packer Smart Arrange already uses,
rather than inventing new placement logic.

The same pass can also propose NEW tiles, not just rearrange what's
there -- a one-tile dashboard (a bare KPI with "no comparison" and nothing
around it) isn't something anyone would actually want handed to them, and
cleaning up what exists doesn't fix that. It's told every governed metric
actually in the model, not just what's already on the canvas, so "MRR (USD)"
sitting alone can come back with concrete adds like "MRR, Subscribers, and
ARPU Over Time" or "What Moved MRR: New, Expansion, Contraction, Churn" --
each with a one-line reason and an "Add this tile" button. Every metric
name a suggestion proposes is checked against the real catalog server-side
before it's ever shown -- the same governed-set discipline as everywhere
else in this app, so "additions" can't invent a metric that doesn't exist
any more than a tile spec can.

## Deliberate choices

**Chart type is derived, not chosen.** Time dimension -> line, one categorical
-> bar, two measures -> scatter, none -> stat tile. A model asked for a chart
type will eventually put a pie chart on a time series.

**Metrics are grouped by unit class before sharing an axis.** A retention ratio
of 1.01 drawn against MRR of 200,000 is a flat line at zero. Currency, ratio,
duration and count each get their own tile. *Within* a class, the same
failure can still happen at a smaller scale -- a multi-measure line chart's
own magnitude split (`magnitudeSplit()` in `src/charts/Chart.tsx`) gives a
series its own secondary axis when it's more than `MAGNITUDE_THRESHOLD`
times smaller than the biggest one on the tile, even though every measure
is nominally the same unit. Originally 20x, calibrated only against the
bug that motivated the feature (marketing spend vs. cost-per-click,
~50,000x apart); two real governed-metric pairings read just as squashed
and never crossed it -- logo churn rate next to NRR/GRR (~8.6x: churn
hugs the bottom of an axis two retention rates near 100% dominate) and
CAC payback months next to LTV/CAC ratio (~7.7x). Lowered to 6, below both
real failures with margin, still comfortably above same-scale pairs that
belong together (NRR vs. GRR, ~1.04x). Fixing that surfaced a second, unit
-inference bug in the same neighborhood: a metric literally named or
labeled a "ratio" (LTV/CAC, SaaS quick ratio) is a unitless multiple, not
a fraction of 1 -- `inferNumberStyle()` (`src/format/format.ts`) used to
read the bare word "ratio" as a percent cue, turning 5.85 into a nonsense
"585%"; now checked first, ahead of both the percent and currency regexes,
so a ratio built from currency inputs (LTV/CAC) also can't fall through to
"$5.85" on the "ltv"/"cac" substrings alone. `inferNumberStyle()` also
missed a metric whose LABEL just doesn't say the word its sibling does:
`logo_churn_annualized`'s label, "Logo churn (annualized)", drops "rate"
(unlike `logo_churn_rate`'s), so name+label alone matched no percent
keyword and a real value of 0.6 rendered via SI-prefix notation as "600m"
-- reading like six hundred million, not sixty percent. Now also checks
the metric's `synonyms` (curated alternate names, e.g. "yearly churn
rate"), not `description` -- free prose explaining what a metric depends
on ("ARPA divided by logo churn RATE") planted a false keyword for `ltv`,
a currency amount that isn't itself a rate. The bare `ratio` substring
check picked up the same kind of false positive once synonyms joined the
search text -- `new_signups`' own synonym "regis**tratio**ns" contains
those five letters by accident -- so it's bounded by "not a letter" on
both sides instead of a plain substring (and not `\bratio\b`, which
doesn't treat the underscore in a snake_case name as a boundary either).

**Suggestion is rules-based first.** Deterministic, offline, testable, and it
gives the natural-language path something to be measured against. The LLM seam
produces the same DashboardSpec.

**Chart recommendations read the model's own words, not just data shape.**
Cardinality and dimension role decide what's structurally possible; a small
keyword match against whatever the CONNECTED model's author wrote in a
table's or metric's own `description`/`synonyms` (see `semanticHints()` in
`src/semantic/model.ts`) can then nudge the ordering among options that
shape already allows -- a table documented with `synonyms: [..., "mrr
waterfall"]` should count for something. The match is against arbitrary
author text, not this app's knowledge of any one dataset, so it means the
same thing for any semantic model connected this way, not just the sample
warehouse that happens to demonstrate it.

**Waterfall** bridges named signed deltas to a running total -- new revenue,
expansion, contraction, churn, each its own bar, connected by dashed
step lines to an auto-appended "Total" bar. It never shows up from data shape
alone (a single categorical breakdown is structurally identical to a bar
chart), only from a semantic hint -- a table or metric whose own
`description`/`synonyms` name it (see "Chart recommendations read the
model's own words" above). One caveat worth knowing if you build one: a
waterfall only reads as rising-and-falling if the underlying metrics are
actually signed. The bundled `fct_mrr_movements` model defines
`contraction_mrr` and `churned_mrr` as negated sums (so they report as
positive magnitudes, like the others), which is a legitimate modeling choice
for a metric registry meant to answer "how much churn was there" as a plain
positive number -- but it means a waterfall built from those four metrics
renders as four additions bridging up to the total, not a rise-then-fall
shape. That's a property of the metrics selected, not something the chart
silently corrects: semantic-canvas never inverts a governed metric's sign to
make a chart look a particular way.

**Funnel** shows named stages narrowing from a top value down to a bottom
one -- centred bars that taper as each stage's share of the top stage
shrinks, labelled with the stage, its value, and that percentage. Stages are
ordered by size (largest first), not by the order rows happened to come
back in, since that's the reading an actual funnel needs. Same rule as
waterfall: never offered from data shape alone (it's structurally a bar
chart either way), only surfaced by a semantic hint -- a table or metric
whose own text says "funnel," the way the bundled model's `fct_web_sessions`
describes itself as "top-of-funnel conversion."

**Small multiples** is the rescue for the case a multi-series line chart
warns about in its own recommendation text: past around 8 categories,
overlaid lines tangle into noise. Instead of one axis with many colours,
it's a small grid -- one mini panel per category, arranged roughly square
rather than guessed at as a single row -- all sharing one y-scale so a
glance at height is still a fair comparison. Position replaces colour as
what tells categories apart, which is exactly what a legend can't do once
there are more than a handful of them. Unlike waterfall and funnel, this
one is structural, not semantic -- it's offered for any time-by-category
selection, just ranked below a plain multi-series line until the category
count actually gets unwieldy.

**Combo** pairs exactly two measures over time -- the first as bars, the
second as a line, fixed by selection order rather than picked by magnitude
the way the plain line chart's dual axis is. Spend as bars against
click-through rate as a line is the shape it's for: a volume worth
comparing period to period next to a rate that's better read as a trend.
Each measure gets its own number style inferred independently (so the bars
read as currency and the line as a percent, not one style forced onto
both), and a real secondary axis appears automatically when the two
measures' magnitudes are too far apart to share one -- the same mechanism
the multi-measure line chart uses.

## Status

Works: duckglue, dbt and Snowflake-semantic adapters, DuckDB and Snowflake connectors, multi-source
registry with an in-app Connections screen (add, edit, remove and switch
sources live, no restart), validation, compiler, suggestion, resizable
canvas, tile picker, Plot-backed charts, dashboard saving, row-level
security, an MCP server for bringing your own agent, an embedded in-app
agent (opt-in via `ANTHROPIC_API_KEY`), named-layout-aware Smart Arrange,
click-to-cross-filter, click-to-drill-down on a time axis, agent-powered
"Explain this" and Beautify, CSV/PNG export, semantic-hint-aware chart
recommendations (including waterfall and funnel, two chart types that only
ever appear when the model's own words call for them), small multiples for
a time-by-category breakdown with too many categories to overlay, a
bar+line combo chart for a volume paired with a rate, and a real second
y-axis on a multi-measure line chart
when two measures' magnitudes are too far apart to share one (cost-per-click
drawn against six-figure marketing spend no longer reads as "this metric is
always zero").

Not yet: natural-language requests typed directly into the UI (only via an
MCP-connected agent today), and more than two named layouts. PNG export can
occasionally time out on a chart-heavy tile (15s) rather than reliably
succeeding -- CSV export is the dependable path today.
