# Semantic Canvas in the shared workspace

Status: **integrated alpha and packaging plan; not a finished suite distribution**.

## One suite, two apps

Semantic Canvas is the public-facing product brand and the analytics/design app. **Ingest** is its companion data-loading app. **Gateway** supplies shared app discovery, company sign-in, routing and access grants. A company should encounter one installation and one login with two app choices, while the services remain independently deployable.

| Component | Responsibility | Code ownership |
| --- | --- | --- |
| Gateway | Shared workspace, sign-in and app access | [`gateway-platform`](https://github.com/Evinanderson89/gateway-platform) |
| Ingest | Read sources, preview/prepare records, load a destination | `gateway-platform/apps/ingest` |
| Semantic Canvas | Governed metrics, dashboards, reusable views and storytelling | This repository |

Ingest is not a third repository. Gateway remains shared infrastructure and can host other registered apps. This packaging decision does not remove Canvas's standalone local or OIDC team modes.

## Installation choices

- **Full workspace:** the intended default bundle includes Gateway, Ingest and Canvas. A local launcher and integrated Compose configuration exist in Gateway; the integrated stack has been verified from a fresh clone with company sign-in and an Ingest load appearing in Canvas (10 September 2026); pinned images, first-run setup and a tested upgrade remain.
- **Canvas only:** use this repository's existing Docker or local development recipe. Teams can keep their existing pipelines and semantic models.
- **Ingest only:** its local development recipe exists. A polished standalone distribution and company-auth recipe remain future work.

These are intended distribution choices, not three finished installer commands. The full workspace still needs version-pinned images, a compatibility manifest, first-run setup, verified upgrades and a tested release bundle. The [canonical suite packaging plan](https://github.com/Evinanderson89/gateway-platform/blob/main/docs/suite-packaging.md) owns the shared release gates.

## Current integration

Gateway can launch Canvas and Ingest in separate app pages. Both apps provide a return link. The local preview explicitly identifies itself as local; it does not activate company sign-in.

Canvas's `SC_MODE=gateway` accepts the Gateway token from the `gw_session` cookie (browsers) or an `Authorization: Bearer` header (the gateway CLI and scripts), and independently verifies the signed Gateway session using the configured issuer, audience and JWKS, then applies existing role/source/RLS policies and anti-forgery protection. It does not trust role or identity claims from arbitrary proxy headers. Configure `SC_PUBLIC_URL`, `SC_OIDC_ISSUER`, `SC_OIDC_CLIENT_ID`, `SC_GATEWAY_JWKS_URI`, `SC_GATEWAY_PORTAL_URL`, and `SC_ACCESS_PATH` consistently with Gateway. Local fixture identities are not production identities. People who add Canvas to their workspace through Gateway's self-service apps receive the access file's `default` role when one is configured (a viewer default is recommended); without one they are still refused unless a binding matches.

See [self-hosting](self-hosting.md) for Canvas's standalone company mode and storage operations, and the [Gateway integration guide](https://github.com/Evinanderson89/gateway-platform/blob/main/docs/data-apps.md) for shared routing, cookies, grant migrations and companion deployment.

## Imported data is not automatically a semantic model

Ingest currently creates new tables in a per-user DuckDB warehouse or a configured Snowflake destination. Canvas requires a supported model plus a compatible connector. A reviewed Snowflake table can be configured and modeled manually. Canvas's local DuckDB connector currently reads Parquet; it does **not** attach Ingest's `warehouse.duckdb` directly. Shared navigation or a shared volume does not provide a working data handoff.

The intended **Use in Semantic Canvas** action would authorize a compatible connection, propose dimensions and metrics for review, register the approved source/model, and open Canvas on that source. The connection handoff, cross-app credential authorization and automatic model publication are not implemented. Neither the suite name nor a shared login implies that all users may see each other's imported records or credentials.

Until that workflow is built, keep the distinction clear in UI and product copy: loading records creates raw data; the reviewed semantic model defines their analytical meaning.

## Storage and orchestration

Gateway metadata and identity-provider state, Ingest import files/credentials/warehouses, and Canvas's library/configuration have separate backup and ownership boundaries. Canvas's library stores dashboards, folders, reusable views, comments and personal alert state; it is not an ingestion staging database. See [data and recovery](../README.md#data-and-recovery).

Ingest has no schedules, incremental sync or CDC yet. A durable worker and Postgres queue are proposed for recurring imports; this is not an installed scheduling service. Canvas's existing in-app chart-watch scheduler is separate: it checks saved metrics while the server is running, subject to its documented session and access limitations. It does not orchestrate Ingest jobs.

## Release gates

1. Review the linked Gateway/Ingest and Canvas changes, including migrations and verified identity boundaries.
2. Complete reproducible integrated builds, real sign-in/permission checks, fresh installation, existing-volume upgrade and backup/restore verification. The attempted local Docker build failed with a read-only storage error; full deployment is still unverified.
3. Implement and test the reviewed data/model handoff for each supported destination.
4. Add durable recurring import jobs and safe incremental merge behavior before offering “Keep updated.”
5. Publish compatible versioned images, the full-workspace bundle and tested standalone options, with setup and operator documentation.

Update both repositories when shared authentication, storage or compatibility changes. Documentation and website claims must distinguish tested local behavior, mocked provider tests, live account acceptance tests and planned features.
