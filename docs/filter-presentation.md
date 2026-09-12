# Filter presentation

Status: **phase 1 in progress**. Companion to [references, tabs and connected filters](reference-tabs-filters.md).

## The idea

A dashboard filter has a data type, which decides what the query receives, and a presentation, which decides what the person sees. Today the two are one field: `control` is `select`, `date` or `number` and each has exactly one look. This adds a second, optional axis, `presentation`, so the same country filter can be a dropdown, a row of chips, or a checklist without changing what it does to the query.

**Presentation never changes the query.** A chip row and a dropdown produce the same filter value and the same `where` clause. That is the guardrail: what you see is what was run, whichever widget you chose.

## Presentations by data type

| `control` | `presentation` | What it is | Best for |
| --- | --- | --- | --- |
| `select` | `dropdown` (default) | The existing picker dialog with search | Long lists |
| `select` | `chips` | Every value as a pill, click to toggle, multi-select | Under ~10 values: regions, plans, platforms |
| `select` | `segmented` | Chips, exactly one active | Mutually exclusive views |
| `select` | `checklist` | Vertical list with checkboxes | Scanning and picking several (phase 2) |
| `select` | `search` | Type-ahead, no list until typed | Thousands of values (phase 2) |
| `date` | `range` (default) | From and to | Precise windows |
| `date` | `presets` | Last 7 days, Last 30, This month, This quarter, Year to date, Custom | Most dashboards |
| `date` | `period` | One month or week with previous and next (phase 2) | Period-over-period reading |
| `number` | `range` (default) | From and to | |
| `number` | `slider` | A bounded slider (phase 2) | Scores, percentages |
| `number` | `threshold` | One bound and a direction (phase 2) | "At least", "At most" |

Presentation is validated per control type; a slider cannot attach to a text field. Existing dashboards carry no `presentation` and render exactly as before, so nothing migrates.

## Date presets are relative

A preset is stored as a token such as `last-30-days`, never as literal dates, and resolved at query time in the viewer's calendar. A saved view with "Last 30 days" still means the last 30 days next month. The resolved dates are shown beside the control so the person can see what was run. `Custom` falls back to the range presentation with literal dates.

## Value shape

Unchanged for chips, segmented and checklist: `{ values: [...] }`. Segmented stores one value. Date presets store `{ preset: "last-30-days" }` or, for Custom, `{ min, max }`. The compiler resolves a preset to `min` and `max` before building the predicate, so every downstream consumer keeps seeing a range.

## Where it lives

- Schema: `presentation` on `dashboardFilterSchema`, optional, with a per-control enum; `preset` on `filterValueSchema`.
- Query: `filtersForTile` resolves presets; nothing else in the compiler changes.
- Canvas: chips and segmented render wider than a dropdown, so the filter designer proposes a wider default tile for them; the layout engine already handles tile sizes.
- Designer: a "Show as" choice in the filter designer, listing only the presentations valid for the chosen field.
- Counts on chips appear only when the values query is already cached for the tile; a filter must not cost more than a chart.

## Dashboard actions (phase 2)

An action is a named bundle of filter values, rendered as a button: "EMEA enterprise, last quarter" in one click. Actions live on the dashboard next to filters, apply several filters at once, and are how a dashboard gets chapters. They reuse the presentation work and add nothing to the query path.

## Phases

1. `presentation` field, chips, segmented, date presets, the designer choice, a starter dashboard showing each, tests.
2. Checklist, search, period, slider, threshold, and dashboard actions.
