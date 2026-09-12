# References, dashboard tabs and connected filters

## Try it

- On Home, choose **Recreate from reference**. The same action is in the dashboard’s **•••** menu.
- Upload a sketch/photo, dashboard image or PDF, or choose **Take a photo**. Reading the reference requires a configured Anthropic model with vision/PDF support.
- Choose **Read reference**, then review each metric and field against the current catalogue. Change an uncertain match using its dropdown. A missing match becomes a clearly labelled text placeholder; it never generates a made-up metric or query.
- Choose **Create dashboard**. Each PDF page becomes a tab. Use Design review and Smart arrange to refine the editable result, then save.
- Use **＋** next to the tab strip to add a tab. Tab actions rename, duplicate or delete the active tab. Deleting a tab participates in undo.
- Choose **Filter** from the canvas palette. Pick a catalogue field and choose **Across dashboard tabs** or **Only this tab**. Review the connected-chart list. Fields that are not reachable from a chart stay disconnected.
- A shared filter remains available in a compact shelf on tabs where its canvas control is absent. The control states how many charts on the current tab it affects. Changes to values are exploration state; they do not mark the authored dashboard unsaved.
- Choose **••• → Copy charts to…** to copy selected charts (or choose from the active tab) into another tab or saved dashboard in the same source. Matching destination filters connect automatically. Each copy can be edited independently.

## Show as

A filter’s **control** (select, date, number) decides what the query receives; its **Show as** choice decides what the person sees. In the filter designer, pick Dropdown, Chips or Segmented for a select field, and Range or Presets for a date field. Chips toggle several values; Segmented keeps exactly one; Presets offer relative windows such as Last 30 days that resolve in the viewer’s calendar at query time, with the resolved dates shown beside the row. Every style produces the same `where` clause as the default. The **Filter styles** starter in Shared views shows one of each. Design, value shapes and the phase 2 list are in [filter presentation](filter-presentation.md).

## Current boundaries

Reference import is an editable reconstruction, not pixel-perfect conversion. It recognizes a bounded set of chart types and preserves relative placement, headings and neutral labels. Chart sizes can expand for readability. Unsupported or incompatible queries remain placeholders. Native reporting periods added to a KPI are explicitly disclosed in the review. Review all matches: image recognition cannot prove that two similar metric names mean the same thing.

Images: PNG, JPEG or WebP, up to 25 MB before browser resizing to a maximum 2,200-pixel edge. PDFs: unencrypted, 1–6 pages, up to 5 MB. The server checks file signatures and PDF readability/page counts before analysis. Large or incomplete model responses are rejected. Camera capture depends on browser support and permission; uploading a photo is the fallback. HEIC must be exported as JPEG first.

The selected file and catalogue names, descriptions, synonyms, field types and declared time grains are sent to the configured AI provider when the user chooses Read reference. Metric SQL expressions, warehouse rows and connection credentials are not included in this extraction request. The original reference is not stored in the dashboard or written to an upload directory. Provider handling is governed by the user’s provider account. Tests use a mocked provider; no claim of evaluated vision accuracy is made.

Tabs share one canvas size and one dashboard revision in this release. Save, backup and recovery contain all tabs. Editing, arranging, design review, chart exports and the canvas assistant operate on the active tab. Dashboard PNG export captures the active tab. Chart-click cross-filtering resets when switching tabs; explicitly authored shared filter controls persist across tabs. They do not synchronize unrelated saved dashboard documents or other browser sessions.

Filters bind to specific tile IDs and fields. The designer suggests exact reachable fields; manual mappings should connect equivalent business meanings only. Select controls show up to 500 available values using the source’s existing row-restricted values endpoint. Ranges support numeric and date fields. Date “To” values include the full final calendar day using an exclusive next-day upper bound. Current selections reset when opening a document or changing role/source. The document contract supports authored defaults; the initial designer does not yet offer a default-value editor. Newly added charts should be explicitly connected in Edit filter; duplicated tabs and copied charts connect as described above.

Chart distribution creates independent copies, not linked master components. Copies retain authored chart filters and settings; temporary selections and drill state are not copied. Saving into another saved dashboard writes immediately with the revision loaded by the chooser. A conflicting revision is rejected and the destination stays intact; reselect the destination to load its current revision. There is no cross-source metric remapping or automatic cross-document filter synchronization.

## Document contract

The document’s optional `tabs` array contains `{ id, title }`. Every tile can carry a `tabId`; legacy tiles with no `tabId` belong to the first tab (or the implicit Overview tab). Optional `filters` contains definitions with a stable ID, label, catalogue field, control type, optional `presentation` (validated against the control type), tab/report scope and explicit `{ tileId, field }` bindings. A filter value or default carries `values`, `min`/`max`, or a date `preset` token, never a preset and a literal range together. A canvas tile of kind `filter` references a definition through `filterId`.

`src/app/tabs.ts` projects the active tab and merges edits without discarding other tabs. `src/app/filters.ts` resolves runtime values and validates catalogue reachability and scope. The save endpoint validates the whole document. Reference schemas and catalogue matching live in `src/reference/blueprint.ts`; the bounded vision/PDF request lives in `src/reference/analyze.ts`.

These are additive fields in document version 1. Back up documents before downgrading: older builds cannot read the new tab/filter fields or filter tile kind.

## Interaction references

The implementation draws on explicit filter binding and multi-tab dashboards in [Metabase](https://www.metabase.com/docs/latest/dashboards/filters), and source/target field selection in [Tableau filter actions](https://help.tableau.com/current/pro/desktop/en-us/actions_filter.htm). These are design references, not claims of feature parity. Reference extraction uses Anthropic’s documented [vision](https://platform.claude.com/docs/en/build-with-claude/vision) and [PDF](https://platform.claude.com/docs/en/build-with-claude/pdf-support) inputs.
