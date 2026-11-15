# Evaluate the redesign, not just the response format

The offline harness prepares three synthetic Sample Warehouse cases: a messy executive dashboard, an empty canvas, and an aggregate-versus-trend reporting-scope challenge. It executes the real compiler and bundled DuckDB queries, preserving the governed model and baseline results alongside each request.

Run from the repository root with a supported Node version:

```sh
npx tsx scripts/evaluate-redesign.ts prepare /tmp/redesign-evaluation-new-run
npx tsx scripts/evaluate-redesign.ts assess scope-and-coverage /path/to/captured-response.json /tmp/redesign-assessment-new-run
npx tsc --project tsconfig.evaluation.json
npx vitest run test/redesignEvaluation.test.ts
```

Output directories must be new. Assessment preserves the original response file and records its response/model hashes. These commands do not load credentials, contact an AI provider, or write dashboard storage. The prepared source configuration contains an environment-variable reference, never a credential value.

## What the assessment establishes

The response must pass the product's proposal validation, semantic query validation, chart-shape/unit checks, and actual sample queries. The evidence records changed queries, returned rows, excluded edge periods, quality findings, authored captions and layout overlaps. A mechanical pass **does not** certify narrative accuracy, completeness, business usefulness or visual quality. The output deliberately leaves `qualityVerdict` as `not-assessed`, even when every query succeeds.

`narrativeInventory` lists the before/after wording of dashboard descriptions, chart titles, notes, investigation context, tab titles, presentation briefs and filter labels, plus the proposal title, reason and assistant explanation. Retained wording stays in the review: an unchanged sentence can become inaccurate when its chart is repurposed. Removed text remains available for checking what was lost. Every entry starts with `reviewStatus: required`; no keyword rule or successful query clears it automatically. `candidateEvidenceIds` only point to context worth inspecting, not verified support for a claim. Use `beforeCandidateEvidenceIds` with `beforeEvidence` for the original dashboard and `candidateEvidenceIds` with `evidence` for the proposed dashboard. A brief's saved evidence IDs may include a removed chart; missing references require review rather than silent substitution.

Both sets of queries run against the current bundled sample and model. They are a reproducible local recheck, not a reconstruction of the provider's historical tool results. Generated chart captions, visual clipping and image contents still require rendered review; they are not authored text fields in this inventory.

Review every factual claim against its exact metric, dates, filters and returned values. An excluded partial edge bucket is absent from the returned trend; it does not make the first displayed month partial. A low value does not establish a cause or missing source data. An all-time scalar need not reconcile with a trend that excludes edge periods. Captions must describe the actual chart type.

Check relationships between metrics as well as their individual values. Shared tables and reporting periods do not establish matching populations. For example, a net-new MRR total includes existing-customer movements; writing that it came from a count of new customers is unsupported even when both figures are correct. Inspect the governed expressions, filters and component definitions. When a relationship is unverified, report the totals separately rather than imply attribution or compute a per-customer value.

Inspect the rendered before/after at desktop and narrow widths, then Story and Infographic. The preview lists metrics that are no longer shown, including when an existing tile was repurposed instead of removed. A metric retained on another chart is not listed as removed; detailed per-tile changes still identify its replacement on the original chart. Assess reading order, usable chart sizes, preserved authored content, and whether the result answers the stated business question. Keep human decisions with supporting evidence in a separate review artifact; do not modify the captured provider response.

## Fresh live evaluation

Use an isolated sample-only server and a new data directory. The agent can read dashboard storage, so using the ordinary working server could expose unrelated saved dashboards. The prepared `sources.yaml` restricts the catalog to the checked-in sample, but isolation also requires a fresh `SC_DATA_DIR`.

Obtain authorization for the bounded provider attempts and synthetic query results before running them. Capture the complete responses and run offline assessment. Leave proposals in preview; do not apply or save them. One attempt per case is a smoke test, not evidence of repeatability. Repeatability needs multiple independently captured runs, latency/failure accounting, and the same editorial and visual review.

This unrestricted synthetic evaluation does not replace company-mode authorization tests, real warehouse coverage checks, or production verification.

## Redesign tool contract

The shared `query_metric` tool requests `/api/query?evidence=1`. Alongside the unchanged governed query result, it receives metric labels and declared/inferred units, explicit time-bucket start meanings, the reporting calendar, calculated observations and returned-row data findings. Evidence is computed after access rules, partial-period handling and limit-probe removal, from the same finalized rows returned to the caller. The catalog metadata used for evidence respects the caller's role. A reporting calendar or pinned sample clock is not a freshness guarantee.

Each selected metric also carries its authored definition: type, expression, standalone filter, description, base table and declared table grain. Computed metrics include their referenced inputs' definitions and filters. This preserves `FILTER` and `CASE` conditions verbatim; a null standalone filter does not mean the expression covers every row. The evidence does not parse SQL into a certified population, execute another query, or establish a relationship between totals. Query filters and row-level policies still apply. These definitions are available to the embedded agent and both MCP clients, while ordinary chart responses remain unchanged.

Limited results and incompatible ratio input periods withhold automatic observations and explain why. Missing latest values remain unavailable. Observations are calculated locally with the same helpers as report drafting; they do not verify arbitrary AI prose or establish causes. Claude and ChatGPT MCP clients receive this same tool result. Ordinary chart queries omit the additional evidence object.

Redesign requests first request strict decoding for `propose_canvas_changes`. Read tools retain their existing contracts. Creation uses explicit metric, text/heading and divider shapes with core layout, scope and formatting fields, rather than every optional persisted-tile setting. Existing tile properties remain governed by the normal proposal applier.

The `describe` action explicitly replaces the dashboard-wide description; an empty string clears it. The redesign preview shows the previous and proposed text. Without that action, the description is preserved. Description-only proposals do not qualify as a redesign. When editing one tab, keep references to other tabs intact. Description edits follow the same atomic application, undo/redo and save path as chart changes; local validation does not certify the prose's accuracy.

Live diagnostics identified two provider limitations: references with sibling type constraints, and a compiled grammar that is too large even below the published optional-field/union caps. The adapter now inlines references and reduces optional combinations. If the provider returns one of those known schema-capability errors, the request makes one compatibility retry with the same tool schema and local validators but without provider-constrained decoding. Later phases use the same compatibility mode. Authentication errors, unrelated bad requests and actual invalid edits do not trigger this fallback; a second schema failure is returned. The response sets `providerSchemaFallback: true` when this path was used. This flag reports execution behavior, not quality acceptance.

The redesign context includes metric compatibility groups from the reviewed catalog. Selected metrics in one chart must share a base table; a common month grain or dimension join does not make metrics from different base tables compatible. Rejections identify the affected tile and selected metric groups, directing the agent to preserve the intended metrics in separate charts. Group membership alone does not establish compatible units, reporting periods or additivity. The compiler remains authoritative; no metric is silently removed to repair a proposal.

The provider schema preserves action discriminators, chart enums and closed objects. Unsupported numerical, string and array bounds remain in descriptions and are enforced by the original local Zod validators. Semantic validity, chart compatibility, pinned content and reporting scope still require local validation; strict JSON does not establish any of those properties or the quality of the result.

`test/redesignSdk.test.ts` exercises the installed SDK with synthetic HTTP responses: schema serialization and complexity limits, bounded compatibility fallback and correction, unsupported fields, local size bounds, wrong note targets, governed chart creation, and preservation of the original document. These tests make no live provider calls and do not establish that the provider accepts the compiled grammar or produces a useful dashboard. Both require the fresh live evaluation above.

A rejected tool call followed by a text-only completion is not accepted as a completed redesign. The reserved proposal phase attempts a bounded correction with the validation feedback. If that phase produces no valid proposal, the request returns the rejection and states that the dashboard is unchanged. Provider refusals are not retried by this recovery. The installed-SDK regressions cover both correction and failure using mocked HTTP responses.

The `query_metric` tool optionally accepts `summarize: { metric, lastPeriods, threshold }`. It calculates threshold counts and min/max from the same authorized response, over an explicit calendar window ending at the latest returned bucket. It separates numeric, null and unreturned periods; a threshold is a requested reference in raw metric units, not an inferred business target. Limited results, duplicate or invalid dates, unsupported breakdowns, precision risk and partial selected/ratio coverage withhold the summary. No additional query or provider call is made for this arithmetic. This gives the model a way to verify period-count claims; it does not certify arbitrary AI prose. Captions should name charts rather than rely on positions that change between presentation formats.
