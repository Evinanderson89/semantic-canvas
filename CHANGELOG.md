# Changelog

## Unreleased — CoreCanvas Library and Gateway integration

- Added persistent source-scoped folders, reusable view snapshots, starter dashboards and library setup/migration, replacing Explore by topic.
- Added personal chart-chat and notification display preferences, off by default, without deleting existing activity.
- Added verified Gateway session support and navigation back to the shared app launcher.
- Documented one suite with two apps, standalone/full-workspace packaging choices, storage boundaries and release gates.

The companion Ingest app lives in gateway-platform. Automatic data/model handoff, a version-pinned suite release bundle and integrated company deployment verification remain unfinished. Back up the Canvas library before applying additive store migrations. See [suite packaging](docs/suite-packaging.md).

## Unreleased — company workspaces and self-hosting

- Added non-root Docker packaging with a persistent workspace, a built UI/API runtime, a loopback-only demo and a separate HTTPS team recipe.
- Added OpenID Connect company sign-in with PKCE/state/nonce, opaque sessions, CSRF protection and explicit viewer/editor/admin, source and row-principal bindings.
- Bound embedded agent tools, questions and conversations to the authenticated user; isolated team browser drafts by account and tab.
- Added workspace setup/status, semantic-model YAML upload, structured application/audit logs and optional OTLP/HTTP logs and request traces.
- Added consistent dashboard-library downloads, validated offline restore and stopped-volume backup/recovery instructions.
- Serialized source/credential mutations, made source configuration writes atomic and fixed first-source creation from an empty registry.

This is an early single-instance team release. Real identity-provider verification, document-specific ACLs, provisioning, distributed sessions and durable audit storage remain outside its guarantees. See `docs/self-hosting.md`.

## Unreleased — analytical composition and trust

- Design Review can preview and apply a story structure to an unsectioned dashboard: editable headings, a neutral reading guide, clearer automatic labels and a focal trend. Existing headings, pinned content and authored titles are preserved. Chart fixes refresh the remaining review automatically.
- The Messy dashboard topic now includes monthly revenue, retention and acquisition-cost KPIs alongside real chart issues, demonstrating the complete chart-to-story workflow.
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
