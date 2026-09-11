# Self-hosting Semantic Canvas

Semantic Canvas now has a packaged local demo and an opt-in company workspace. Company mode is an early team release: test it with your identity provider, data policies and backup process before onboarding real users. Run one application process per workspace. There is no cloud account or proprietary license requirement.

## Try it with Docker

Requires Docker Engine/Desktop and Compose v2. From a checkout:

```sh
docker compose up --build -d
```

Open http://localhost:5173. The sample warehouse needs no credentials. The host port binds to loopback. Do not publish local mode behind a network proxy: its role selector is a simulation, not login.

The named `workspace` volume contains `/data/dashboards.duckdb`, `/data/config/sources.yaml`, `/data/config/.env`, `/data/config/policies.yaml`, and uploaded semantic models. Container replacement preserves this volume. `docker compose down` preserves it; `down --volumes` deletes it.

The runtime serves the built UI and API in one non-root process. Its root filesystem is read-only; only `/data` and temporary storage are writable. Docker logs rotate at 10 MB with three files. Use an external collector for longer retention.

Without Docker, use Node 22.12+ or 24, `npm ci`, `npm run build`, then `npm run serve`. The default data directory is `~/.semantic-canvas`. Set `SC_DATA_DIR` to change it. Development remains `npm start`.

## Set up company sign-in

1. Choose a hostname and point its DNS to your host. Allow ports 80/443 for the included Caddy HTTPS proxy, or use your own managed HTTPS proxy.
2. Register a confidential OpenID Connect web application at your identity provider. Enable authorization code flow and use this exact callback: `https://YOUR_HOST/api/auth/callback`. No wildcard callbacks. Configure the groups you need in the **ID token**; UserInfo-only groups and Entra group-overage references are not resolved. Alternatively, map explicit OIDC subject IDs.
3. Prepare private configuration:

```sh
cp deploy/team.env.example .env.team
cp deploy/access.example.yaml deploy/access.yaml
cp security/policies.yaml deploy/policies.yaml
chmod 600 .env.team
chmod 644 deploy/access.yaml deploy/policies.yaml
```

The access and policy files must be readable by container UID 1000; they contain rules, not credentials. Use ownership or filesystem ACLs if your host requires tighter read permissions. Keep credentials in `.env.team`.

4. Edit `.env.team`: set `SC_DOMAIN`, `SC_PUBLIC_URL` (HTTPS origin, no path), the exact OIDC issuer, client ID and secret. Configure provider scopes if groups need an extra scope. No implicit fallback to local mode is allowed when team settings are missing.
5. Edit `deploy/access.yaml`. Rules are ordered; **the first match wins**. A rule maps one subject or group to an application role, an RLS principal from `deploy/policies.yaml`, and allowed source IDs. Unmatched accounts receive no access. Source IDs may be provisioned later; they grant no access until that source exists. Start with the administrator binding; replace the example editor/viewer groups, principal and `sales` source before assigning them.
6. Edit `deploy/policies.yaml` for your actual tables and territories. The bundled rules describe sample data only. App role and row access are independent: an administrator can have restricted query access. Workspace administrators can change sources and credentials, so grant that role only to trusted operators. Use read-only warehouse credentials.
7. Start the team package:

```sh
docker compose --env-file .env.team -f compose.team.yaml up --build -d
```

The team project uses separate volumes from the demo and starts with no sources. Sign in as the mapped administrator; **Connections → Review setup** shows the next steps. Connect a source, inspect its catalogue, then verify a viewer account against known restricted data. The optional AI key is tested before saving. Company mode cannot be enabled safely with a browser switch; configuration belongs to the server operator.

Caddy manages HTTPS certificates and forwards the original Host header. The app has no published host port in this recipe. If using another proxy, preserve Host exactly as `SC_PUBLIC_URL`, terminate TLS, and keep the upstream private. Do not log full callback URLs, cookies, Authorization headers or request bodies at the proxy.

### Roles and sessions

| Capability | Viewer | Editor | Administrator |
| --- | --- | --- | --- |
| Read permitted catalogues/dashboards, query, filter, drill, ask AI | Yes | Yes | Yes |
| Save/update/delete shared dashboards | No | Yes | Yes |
| Configure sources, AI credentials, workspace setup, library backup | No | No | Yes |

Saved dashboards are shared by source, not private per author. Authenticated viewers can read authored text and filter defaults in dashboards on an allowed source; do not put confidential commentary in a broadly shared dashboard. There are no document-specific ACLs, SCIM provisioning, or invitation emails in this release.

Sessions use opaque Secure/HttpOnly/SameSite cookies, PKCE/state/nonce, and CSRF protection on API writes. Role, source access and row principal come from the verified server session; browser principal headers cannot elevate access. Sessions expire after `SC_SESSION_SECONDS` (default one hour, 5 minutes–8 hours). Restarting the app signs everyone out and reloads policies. Group changes take effect on the next login; removing a user at the IdP does not instantly revoke an existing app session. Restart to invalidate all sessions immediately. Sign out ends the app session, not the provider's global session.

The embedded assistant uses the caller's session for its tools. Questions and chat history are separated by user. External stdio MCP remains a trusted local integration and cannot authenticate to team mode; it is refused by the team API. Do not disable authentication to make it work.

Local mode keeps recovery drafts in localStorage. Team mode isolates drafts by account in tab sessionStorage; signing out removes team drafts on that tab. Save work before signing out. The same-origin browser storage is not a security boundary against someone with access to the browser profile. No query-result rows or connection credentials are stored in recovery drafts.

## Connect a semantic layer

Connections pairs a supported adapter with DuckDB or Snowflake. YAML semantic models can be uploaded to the server (5 MB maximum); the source connection test validates them. Uploads persist even if setup is cancelled; operators can remove unused files from `/data/models` after checking source references. dbt requires a mounted target directory containing `manifest.json` and `semantic_manifest.json`. Mount external models/data read-only, e.g. `/company/models:/models:ro`, and use `/models/...` paths in Connections. Files on an administrator's laptop are not automatically visible inside a container.

Adapters still import supported semantics and compile SQL; this is not native execution of every vendor's semantic engine. See `alpha-contract.md` for supported metric types and rejected semantics.

### Connected tables (phase 2)

Tables that Ingest registers through "Connected to Semantic Canvas" (`docs/connected-canvas.md`) are stored in a per-source overlay, `SC_DATA_DIR/models/connected/<sourceId>.yaml`, written atomically with owner-only permissions. The overlay is merged over the base model when the source loads; base model files are never edited, and a base table with the same name wins over an overlay entry. The full installation backup of the `/data` volume includes the overlay; the dashboard library export does not. Disconnecting removes only the overlay entry and is written to the audit log; the data stays in the lake for the operator.

| Action | Viewer | Editor | Administrator |
| --- | --- | --- | --- |
| `GET /api/sources/:id/connected` (viewers receive published entries only) | Yes | Yes | Yes |
| `POST /api/sources/:id/connected` register or replace (replace only by the original registrant or an administrator) | No | Yes | Yes |
| `DELETE /api/sources/:id/connected/:dataset` disconnect (original registrant or an administrator) | No | Yes | Yes |
| `POST /api/sources/:id/connected/:dataset/publish` | No | No | Yes |

Until an administrator publishes a connected table it is unreviewed: editors and administrators see it badged "Ingested, unreviewed"; viewers do not see it in the model, catalogue or query results; dashboard suggestions and the assistant's catalogue exclude it. Metrics not listed at publish time stay unreviewed. Every connected table is a snapshot; the source and each tile that uses the table show "Data as of" the load time. Local mode performs these actions as the simulated administrator.

## Connect logging and monitoring

Every application request produces a structured JSON stdout record with a generated request ID, route template, status, duration and, when authenticated, a pseudonymous actor ID and role. Dashboard/source changes and library exports create audit events. Failure records include an error type, not stack traces or payloads. Bodies, raw query strings, SQL, result rows, uploaded content, credentials and cookies are excluded by an allowlist. Semantic source labels, authored content and warehouse errors may appear in administrator UI responses, so treat admin access as privileged.

Any tool that collects container stdout can ingest these records. For portable export of logs and request traces, configure an OpenTelemetry collector or compatible vendor endpoint:

```dotenv
OTEL_SERVICE_NAME=semantic-canvas
OTEL_EXPORTER_OTLP_ENDPOINT=https://your-collector.example.com
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20YOUR_TOKEN
```

The transport is **OTLP over HTTP with JSON**, not gRPC. A base endpoint gets `/v1/logs` and `/v1/traces`. To export only one signal, use `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` with the full path. Standard signal-specific OTEL headers are supported. Collector credentials are server-only. Restart after changing export settings. No telemetry is sent unless configured.

Use your collector to route data to Grafana, Datadog, Elastic, Splunk or another destination with an appropriate exporter. Vendor authentication and endpoints vary; use their current documentation. `deploy/otel-collector.example.yaml` demonstrates the collector pipeline. Test delivery in your destination: the setup page reports **configured**, not verified delivery.

Exports are asynchronous with bounded queues; exporter failure does not block queries. This is operational logging, not a durable/tamper-proof compliance audit log. Add an external retention and alerting policy. Application request traces do not yet include detailed warehouse/AI spans, distributed trace propagation or browser errors.

`GET /healthz` reports process liveness; `/readyz` reports startup completed. These public endpoints contain no source details. A workspace with no configured sources is ready for setup; readiness is not a live warehouse probe. Administrator-only `/api/operations/status` reports source startup state, uptime and process request/query error counters. Counters reset on restart; they are not a Prometheus endpoint. Alert on unavailable service, growing error rate, collector delivery failures and disk capacity.

## Back up, restore and upgrade

**Dashboard library backup:** Connections → Review setup → Download dashboard library exports all sources and revisions in a consistent logical snapshot, serialized with saves. It excludes source configuration, warehouse data, credentials and browser drafts. Authored text, filter values and embedded document images are included; protect the file accordingly.

For an offline library backup with Node:

```sh
npm run backup -- /safe/location/library.json
```

Stop the app first; DuckDB locks out a second process. The command refuses to overwrite an existing backup. Restore only into an empty directory:

```sh
SC_DATA_DIR=/safe/new-workspace npm run restore -- /safe/location/library.json
```

Library backups include chart comments, replies, alert rules, and the last 30 alert observations. They contain discussion text and observed metric values, so restrict their access. Restored alerts start paused and must be reviewed before resuming. Configure the same source IDs and policy/model configuration before opening restored dashboards. Restoration validates every document and applies the library atomically. It refuses an existing nonempty database.

**Full installation backup:** stop the application, then back up the entire `/data` volume plus `.env.team`, `deploy/access.yaml`, `deploy/policies.yaml` and any external mounted model/data files. This includes secrets: encrypt the archive and restrict access. Do not copy an active DuckDB file. Example team volume backup, from the repo root:

```sh
docker compose --env-file .env.team -f compose.team.yaml stop canvas
mkdir -p backups
docker compose --env-file .env.team -f compose.team.yaml run --rm --no-deps --entrypoint tar canvas -C /data -czf - . > backups/workspace.tar.gz
docker compose --env-file .env.team -f compose.team.yaml start canvas
```

Save the private host configuration files separately with the same backup date. External warehouse data needs its own backup policy. Test recovery on a separate host/volume with the same release before relying on the backup.

For restoration, provision an empty named volume and restore the archive using the same UID (1000) while the app is stopped. Never unpack an untrusted archive or restore over a populated workspace. Restore the matching private host files, then start the same application version. Start with a library restore if you only need dashboards.

Before upgrading, record the current commit/image ID, make the full stopped backup, then rebuild and restart. Keep the backup and old image until you have checked login, restricted queries, saves and reference imports. Database migrations are additive today; do not assume future migrations are reversible. Roll back both the old image and its matching backup if a migration fails. No automatic scheduled backup or off-host storage is included.

## Chart alert operations

Alerts use the same semantic compiler and row-level permissions as chart queries. Results and rules remain private to the owner; comments are shared only within the same source and RLS scope. A policy change changes that scope instead of exposing earlier discussions under broader access.

The single-process scheduler checks due watches once a minute, up to 100 per sweep, sequentially. Rules choose 15-minute, hourly, or daily checks. There is no distributed scheduler or off-host notification service. Checks are in-app; a closed browser can still receive saved observations when reopened, provided the server was running and, in company mode, the owner still held access: in team mode an unexpired authenticated session, and in gateway mode a valid Gateway session presented to Canvas since the server started. Sign-out, session expiry, a server restart in gateway mode (until the owner opens Canvas again), or lost source access pauses query execution. A changed metric, filter configuration, or semantic model requires updating the watch.

Anomaly checks are robust statistical heuristics, not a guarantee of incident detection. Stale or missing data yields a waiting state. Reporting periods are interpreted in UTC; source completeness and warehouse ingestion watermarks are not verified. Query timeouts/cancellation and richer seasonal forecasting remain part of the broader operational work below.

## Current operational limits

One company workspace, one Node process, one DuckDB dashboard store. Horizontal scaling and highly available sessions require a different shared store/session design. Source settings are operator configuration; there is no per-company tenancy boundary inside one process. Query budgets, warehouse cancellation, permission-change propagation, detailed metrics, user provisioning and security review with your actual identity provider remain work before a broad enterprise rollout.

Implementation references: `src/security/auth.ts`, `src/operations/telemetry.ts`, `src/store/store.ts`, `compose.team.yaml`. OIDC uses the maintained [openid-client library](https://github.com/panva/openid-client). See [OpenTelemetry exporters](https://opentelemetry.io/docs/languages/js/exporters/), [Docker Compose services](https://docs.docker.com/reference/compose-file/services/) and [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https).

## Gateway suite deployment

The instructions above cover standalone Canvas. For the intended full workspace with Ingest, follow [suite packaging](suite-packaging.md) and the [Gateway integration guide](https://github.com/Evinanderson89/gateway-platform/blob/main/docs/data-apps.md). Canvas can use `SC_MODE=gateway` to verify Gateway sessions while retaining its own source, role, row-policy and anti-forgery checks. Configure the public URL, issuer, JWT audience, JWKS, portal URL and access file together; keep internal backend ports private.

The bundled cross-repository Compose example is local development configuration with fixture users. A production suite bundle, first-run setup and end-to-end identity-provider verification are still release work. Before rollout, pin compatible releases of both repositories and verify storage upgrades and restore. Keep Canvas, Gateway and Ingest backups distinct and complete; do not combine their databases just because they share an entry point.
