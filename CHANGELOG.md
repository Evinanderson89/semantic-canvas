# Changelog

## Unreleased — analytical composition and trust

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

Existing saved document identities, source ownership and revisions are preserved. Sections and pinned positions are optional fields; older documents infer sections from heading positions when arranged. Back up the dashboard store before upgrading. Older app versions may reject the new optional tile fields.
