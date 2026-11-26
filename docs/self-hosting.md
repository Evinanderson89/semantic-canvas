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

Before releasing a container build, run `npm run check:container` with Docker running. It builds the image and tests the packaged UI/API, the actual runtime user ID, read-only root filesystem, loopback port binding, a sample query, two saved dashboard designs, and restoring both versions from a stopped-volume backup into a new container. `npm run test:container -- <image>` tests an existing image. The test creates uniquely named containers and volumes and removes only those fixtures afterward. This release check is separate from `npm run check`, which runs source, unit, build, and browser checks without requiring Docker.

Without Docker, use Node.js 22.x (22.12 or newer), 24.x, or 26.x, with the latest patch release in your chosen major version. Run `npm ci`, `npm run build`, then `npm run serve`. The default data directory is `~/.semantic-canvas`. Set `SC_DATA_DIR` to change it. Development remains `npm start`.

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
5. Edit `deploy/access.yaml`. Rules are ordered; **the first match wins**. A rule maps one subject or group to an application role, an RLS principal from `deploy/policies.yaml`, and allowed source IDs. Unmatched accounts receive no access unless the file sets an optional top-level `default` (a role, RLS principal and sources applied only after no binding matches a verified identity), which is what lets self-service Gateway users outside every bound group open Canvas. Keep the default at `viewer`: with `editor` or `admin` every verified account can change dashboards or configuration, and the server logs a warning at startup. The default's principal must exist in `deploy/policies.yaml`, like a binding's. Source IDs may be provisioned later; they grant no access until that source exists. Start with the administrator binding; replace the example editor/viewer groups, principal and `sales` source before assigning them.
6. Edit `deploy/policies.yaml` for your actual tables and territories. The bundled rules describe sample data only. App role and row access are independent: an administrator can have restricted query access. Workspace administrators can change sources and credentials, so grant that role only to trusted operators. Use read-only warehouse credentials.
7. Start the team package:

```sh
docker compose --env-file .env.team -f compose.team.yaml up --build -d
```

The team project uses separate volumes from the demo and starts with no sources. Sign in as the mapped administrator; **Connections → Review setup** shows the next steps. Connect a source, inspect its catalogue, then verify a viewer account against known restricted data. The optional AI key is tested before saving. Company mode cannot be enabled safely with a browser switch; configuration belongs to the server operator.

Caddy manages HTTPS certificates and forwards the original Host header. The app has no published host port in this recipe. If using another proxy, preserve Host exactly as `SC_PUBLIC_URL`, terminate TLS, and keep the upstream private. Do not log full callback URLs, cookies, Authorization headers or request bodies at the proxy.

### Identity provider notes

These notes come from simulated provider profiles in `test/identityProviderProfiles.test.ts`, which reproduce each vendor's documented issuer, client authentication and ID-token shapes. They are not acceptance against a real Okta or Microsoft Entra tenant; test with yours before onboarding users.

`npm run check:keycloak` goes further for one provider: it starts a real Keycloak container with a throwaway realm, starts Canvas in company mode against it, and drives password logins through Keycloak's own login page. It checks role mapping, refusals, code replay, anti-forgery, group removal at the next sign-in, open sessions ending after a group removal or a disabled account, signature verification across a signing-key rotation, sign-out and log contents. It needs Docker and openssl, removes its fixtures, and is not part of CI. It is acceptance against Keycloak over a self-signed local issuer, not against your provider, a browser or your network.

- **Client authentication.** Canvas sends the client secret in the token request body (`client_secret_post`) unless discovery advertises only the Authorization-header method. Okta advertises both, but each application accepts only the method it is registered with, and web applications default to the header method: set `SC_OIDC_CLIENT_AUTH=client_secret_basic` for those. A mismatch fails sign-in with an `auth.callback_failed` record whose `errorType` is `invalid_client`.
- **Okta groups.** Group names appear only after you add a groups claim to the application or authorization server. Without it every account is refused.
- **Entra groups.** The `groups` claim carries group object IDs, not names; bind those IDs. An account in more groups than a token can carry receives a Graph reference instead of a `groups` claim. Canvas does not call Graph, so that account is refused unless it has a subject binding. Entra app roles avoid the limit: assign roles and set `groupsClaim: roles`.
- **Subject bindings** match the token's `sub`. In Entra that value is specific to the application and differs from the object ID shown in the portal.
- **Signatures and key rotation.** Canvas verifies the ID token signature against the provider's published keys. A provider that publishes its next key before signing with it rotates without interruption. If a token is signed with a key Canvas has not seen, that one sign-in fails closed and Canvas re-reads the provider's keys, at most once every ten seconds; the person's next attempt then succeeds. An unknown key is never accepted.

### Roles and sessions

| Capability | Viewer | Editor | Administrator |
| --- | --- | --- | --- |
| Read permitted catalogues/dashboards, query, filter, drill, ask AI | Yes | Yes | Yes |
| Discover raw warehouse schema beyond the semantic model | No | No | Yes, where the connector supports it |
| Save/update/delete shared dashboards | No | Yes | Yes |
| Propose and query unreviewed metrics on an allowed source | No | Yes | Yes |
| Publish proposed metrics to the governed catalogue | No | No | Yes |
| Remove metrics added through a proposal | No | Own unpublished proposals only | Yes |
| Configure sources, AI credentials, workspace setup, library backup | No | No | Yes |

Saved dashboards are shared by source, not private per author. Authenticated viewers can read authored text and filter defaults in dashboards on an allowed source; do not put confidential commentary in a broadly shared dashboard. Per-dashboard lock controls (`locked`) prevent non-owner editors from overwriting an owner's saved dashboard, while administrators retain override access. There are no per-document read ACLs or invitation emails. Optional **SCIM 2.0 provisioning** is served at `/api/scim/v2` when `SC_SCIM_TOKEN` is configured: provisioned users and groups persist in `SC_DATA_DIR/scim.json`, setting `active: false` or deleting a SCIM user immediately revokes live sessions and refuses subsequent OIDC sign-in, and `POST /api/operations/access/reload` reloads `access.yaml` without downtime.

Metric proposals use a restricted aggregate-expression vocabulary over the chosen base table. Canvas validates the expression, executes a warehouse probe using the source connector, and stores accepted proposals in the source extension as unreviewed. The probe checks execution and does not return its aggregate result; it is not a test of a particular viewer's row access. This permission does not grant arbitrary SQL execution or permission to edit the base model. Chart queries retain their row-access rules. Viewers cannot query unpublished metrics or dependent calculations; administrator publication makes an accepted proposal available to them. See [metric proposals](modeler.md#proposed-metrics-a-field-made-to-order) for the expression and publication contract.

`GET /api/schema` checks source access and uses the verified session role. Viewers receive table and column names/types from their published semantic catalog; editors receive the full semantic catalog, including drafts. Neither role requests raw warehouse introspection. Administrators can inspect raw schema where the connector supports it; otherwise they receive the semantic schema. The response's `scope` is `semantic-model` or `warehouse`. Schema discovery describes metadata, not accessible row values or proof that a modeled column is present in the warehouse; query permissions and row policies still apply separately.

Sessions use opaque Secure/HttpOnly/SameSite cookies, PKCE/state/nonce, and CSRF protection on API writes. Role, source access and row principal come from the verified server session; browser principal headers cannot elevate access. Sessions expire after `SC_SESSION_SECONDS` (default one hour, 5 minutes–8 hours). By default sessions are held in memory (so restarting the app signs everyone out and reloads policies); setting `SC_SESSION_SECRET` alongside `SC_DATA_DIR` in `SC_MODE=team` enables AES-256-GCM encrypted session persistence (`SC_DATA_DIR/sessions.json`, mode `0600`, encrypting stored OIDC refresh tokens) across single-node restarts. In team mode, when the provider issues a refresh token, Canvas re-checks each open session with the provider every `SC_SESSION_RECHECK_SECONDS` (default 300; 10–3600; `0` disables) on the session's next request. The session ends if the provider refuses the refresh (a disabled or deleted account, a revoked or expired provider session), if SCIM marks the user `active: false`, or if the account's mapped role, row principal or sources have changed; the person signs in again under the current rules. During a provider outage the session keeps its own expiry and the check is retried after a minute. The refresh token stays on the server. Without a refresh token nothing is re-checked: group changes take effect on the next login (or via `POST /api/operations/access/reload` / SCIM revocation). Keycloak issues refresh tokens by default; Okta needs the Refresh Token grant enabled on the application and `offline_access` in `SC_OIDC_SCOPES`; Entra needs `offline_access` in `SC_OIDC_SCOPES`. A provider session that idles out ends the Canvas session at its next check. In team mode, sign out ends the app session, not the provider's global session. In gateway mode the portal owns the session, so sign out hands the browser to the portal's sign-out, which revokes the refresh token at the identity provider and clears the shared cookies; nobody can re-enter without signing in.

The embedded assistant uses the caller's session for its tools. Questions and chat history are separated by user. Authenticated Remote HTTP MCP (`POST /api/mcp`) verifies the caller's session and enforces RBAC and RLS; external stdio MCP (`npm run mcp`) remains a local single-user integration and is refused by unauthenticated company API endpoints. Do not disable authentication to make stdio MCP work against a shared deployment.

In a session bound to a source or row-access principal, omitted tool arguments retain that scope and matching arguments are accepted. An explicit mismatch fails before a query or write; Canvas does not silently substitute another warehouse or identity. Switch the source or role in Canvas, or change a scoped connection's setup, before requesting another scope. Unbound local stdio tools can select a source and simulated principal explicitly; the API still applies its access rules.

Local mode keeps recovery drafts in localStorage. Team mode isolates drafts by account in tab sessionStorage; signing out removes team drafts on that tab. Save work before signing out. The same-origin browser storage is not a security boundary against someone with access to the browser profile. No query-result rows or connection credentials are stored in recovery drafts.

## Connect a semantic layer

Connections pairs a supported adapter (`duckglue`, `dbt`, `cube`, `snowflake-semantic`) with **DuckDB**, **PostgreSQL**, **Google BigQuery**, **Snowflake**, or **SQLite (`.db`)**. YAML semantic models can be uploaded to the server (5 MB maximum); the source connection test validates them. Uploads persist even if setup is cancelled; operators can remove unused files from `/data/models` after checking source references. dbt requires a mounted target directory containing `manifest.json` and `semantic_manifest.json`. Mount external models/data read-only, e.g. `/company/models:/models:ro`, and use `/models/...` paths in Connections. Files on an administrator's laptop are not automatically visible inside a container.

Editing an existing source waits for its saved settings to load. A failed load offers Retry and Cancel rather than an empty replacement form. Fields stay fixed during model upload and connection validation; failed saves retain your edits for correction. AI status failures also offer a retry, and a failed credential removal leaves the configured state and confirmation in place. “Configured” reports a stored credential, not a live provider health check.

Adapters still import supported semantics and compile SQL; this is not native execution of every vendor's semantic engine. See `alpha-contract.md` for supported metric types and rejected semantics.

### AI credentials

Connections validates an AI provider credential (`anthropic`, `openai`, `gemini`, or `openai-compatible`) before saving it in `SC_ENV_PATH` (default `.env`, `/data/config/.env` in the container) with owner-only permissions (`0600`). The file must be writable and persist across container replacements. A rejected key leaves the previous credential unchanged. No key is returned by the status endpoint.

All embedded AI features, including reference-image/PDF imports, require a supported provider (`anthropic`, `openai`, `gemini`, or `openai-compatible`), a model name, and a nonblank key before constructing a provider client (`openai-compatible` also requires `ai.baseUrl`). In company modes (`SC_MODE=team` or `gateway`), `ai.baseUrl` rejects loopback, RFC1918 private, CGNAT, and cloud link-local/metadata endpoints unless `SC_ALLOW_PRIVATE_AI_URL=true` is explicitly set by the server operator. Unsupported configuration returns a setup error without sending the reference, catalogue, dashboard or query results to a provider. Connections shows the configuration issue; adding another key is disabled when the server's provider/model selection must be corrected first.

Saving or removing a key through Connections sets `SC_AI_KEY_MANAGED=true` in that file. While that marker is true, the file's provider credential variable (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, or `OPENAI_COMPATIBLE_API_KEY`) is authoritative for the embedded agent, including an empty value after removal. This prevents an older shell variable or YAML credential from returning on restart. Provider and model choices come from `ai.provider` and `ai.model` in `sources.yaml` (or `SC_AI_PROVIDER` / `SC_AI_MODEL` when managed through Connections); adding an `ai` block is optional when using the default setup.

For operator-managed credentials, omit the marker or set it to `false` and restart. Then an explicit `ai.apiKey` (including a custom `${VARIABLE}` reference or an empty value to disable it) takes precedence; otherwise the matching provider environment variable is read from the server environment. Removing a key through Connections disables its use by the embedded agent; it does not revoke the provider credential or erase an operator-authored copy in YAML or the parent environment. This credential is separate from Claude Desktop/Code and ChatGPT tunnel setup.

### Connected tables (phase 2)

Tables that Ingest registers through "Connected to Semantic Canvas" (`docs/connected-canvas.md`) are stored in a per-source overlay, `SC_DATA_DIR/models/connected/<sourceId>.yaml`, written atomically with owner-only permissions. The overlay is merged over the base model when the source loads; base model files are never edited, and a base table with the same name wins over an overlay entry. The full installation backup of the `/data` volume includes the overlay; the dashboard library export does not. Disconnecting removes only the overlay entry and is written to the audit log; the data stays in the lake for the operator.

| Action | Viewer | Editor | Administrator |
| --- | --- | --- | --- |
| `GET /api/sources/:id/connected` and `GET /api/sources/:id/connected/:dataset` (viewers receive published entries only) | Yes | Yes | Yes |
| `POST /api/sources/:id/connected` register or replace (replace only by the original registrant or an administrator) | No | Yes | Yes |
| `DELETE /api/sources/:id/connected/:dataset` disconnect (original registrant or an administrator) | No | Yes | Yes |
| `POST /api/sources/:id/connected/:dataset/publish` | No | No | Yes |

Until an administrator publishes a connected table it is unreviewed: editors and administrators see it badged "Ingested, unreviewed"; viewers do not see it in the model, catalogue or query results; dashboard suggestions and the assistant's catalogue exclude it. Administrators publish from **Connections → Review and publish** on the table, choosing the metrics to publish and their label, direction, time grains and importance; metrics not ticked stay unreviewed. Every connected table is a snapshot; the source and each tile that uses the table show "Data as of" the load time. Local mode performs these actions as the simulated administrator.

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

New backups use library format **2**, which stores verified UTC save times separately from legacy wall-clock timestamps whose time zone is unknown. The current restore command accepts formats 1 and 2; older Canvas releases cannot restore format 2. A format-1 dashboard date is recovered from a matching saved-version timestamp when available. Otherwise its original wall-clock value is retained as `legacyUpdatedAt`, and the UI shows that the time zone is unavailable. New saves and renames record explicit UTC times. The on-disk migration is additive and does not rewrite dashboard designs or guess the time zone of older records.

Older dashboard canvases may contain only customized settings. Opening, version history, backup export and archive restore apply the same defaults to missing fields while preserving authored dimensions, grid, snapping and background. Invalid values and unknown settings are not silently replaced: export retains them for repair, and restore rejects them. Legacy dashboards whose model name matches multiple sources remain unassigned and are included in backups; migration does not guess which source owns them. Deleting a built-in starter remains effective after library initialization and backup restoration.

**Full installation backup:** stop the application, then back up the entire `/data` volume plus `.env.team`, `deploy/access.yaml`, `deploy/policies.yaml` and any external mounted model/data files. This includes secrets: encrypt the archive and restrict access. Do not copy an active DuckDB file. Example team volume backup, from the repo root:

```sh
docker compose --env-file .env.team -f compose.team.yaml stop canvas
mkdir -p backups
docker compose --env-file .env.team -f compose.team.yaml run -T --rm --no-deps --entrypoint tar canvas -C /data -czf - . > backups/workspace.tar.gz
docker compose --env-file .env.team -f compose.team.yaml start canvas
```

Save the private host configuration files separately with the same backup date. External warehouse data needs its own backup policy. Test recovery on a separate host/volume with the same release before relying on the backup.

For restoration, provision an empty named volume and restore the archive using the same UID (1000) while the app is stopped. Never unpack an untrusted archive or restore over a populated workspace. Restore the matching private host files, then start the same application version. Start with a library restore if you only need dashboards.

Before upgrading, record the current commit/image ID, make the full stopped backup, then rebuild and restart. Keep the backup and old image until you have checked login, restricted queries, saves and reference imports. Database migrations are additive today; do not assume future migrations are reversible. Roll back both the old image and its matching backup if a migration fails. No automatic scheduled backup or off-host storage is included.

## Chart alert operations

Alerts use the same semantic compiler and row-level permissions as chart queries. Results and rules remain private to the owner; comments are shared only within the same source, model, local RLS scope and canonical signed gateway rules. A policy change changes that scope instead of exposing earlier discussions under broader access. Viewers cannot read activity or preview alerts for unpublished metrics. Scheduled evaluations check the owner’s current role and publication permissions before querying and again before storing an observation.

The audience format is versioned. Historical activity created before gateway rules were included has unknown scope: it remains in storage and backups, but is not automatically exposed under a new audience. Recreate personal watches under the current scope; old scheduled watches require review and do not execute under a guessed audience.

The single-process scheduler checks due watches once a minute, up to 100 per sweep, sequentially. Rules choose 15-minute, hourly, or daily checks. Checks are stored in-app (and optionally posted to an operator-configured `SC_ALERT_WEBHOOK_URL` webhook when a new breach triggers); a closed browser can still receive saved observations when reopened, provided the server was running and, in company mode, the owner still held access: in team mode an unexpired authenticated session, and in gateway mode a valid Gateway session presented to Canvas since the server started. Sign-out, session expiry, a server restart in gateway mode (until the owner opens Canvas again), or lost source access pauses query execution. A changed metric, filter configuration, or semantic model requires updating the watch.

Anomaly checks are robust statistical heuristics, not a guarantee of incident detection. Stale or missing data yields a waiting state. Closed reporting periods follow the model’s week start, fiscal year start, timezone (UTC when unset), and optional pinned reporting date. Audit timestamps still record the real check time. Source completeness and warehouse ingestion watermarks are not verified. Query timeouts/cancellation and richer seasonal forecasting remain part of the broader operational work below.

### Request limits

In company and gateway modes each signed-in account has per-minute request limits, counted in the application process: 30 AI requests (chat, redesign, explain, suggestions, story and reference analysis), 600 warehouse-backed requests (chart queries, field profiles, filter values and extents) and 1200 other API requests. Set `SC_RATE_AI_PER_MINUTE`, `SC_RATE_QUERY_PER_MINUTE` or `SC_RATE_API_PER_MINUTE` to change one; `0` disables it, and an invalid value stops startup. A refused request returns 429 with `Retry-After` and writes an `audit.rate_limited` record with the pseudonymous actor. An assistant's own tool queries run as the signed-in user and count toward that user's query limit. Local mode is unlimited.

These limits bound one account's provider spend and warehouse load. They are not a spending cap in currency, do not limit concurrent queries, reset when the process restarts, and are not a defence against unauthenticated or distributed traffic: rate-limit sign-in and anonymous requests at your proxy. If more than 20,000 account windows are live at once the oldest is dropped, which can release that account early.

### Query time budget

Each chart query, filter-value lookup, range lookup and alert check has a time budget of `SC_QUERY_TIMEOUT_SECONDS` (default 120; 5–3600; `0` disables; an invalid value stops startup), in every mode. The budget includes time waiting for a warehouse connection. At the budget Canvas cancels the query and returns a message asking the person to narrow the request; a `query.budget_exceeded` record is written. A chart query is also cancelled when its request goes away, for example a closed tab or a removed chart. DuckDB work is interrupted on its connection. Snowflake receives a cancellation request and statement and queue timeouts for the same duration; that path is covered with a simulated driver, not a live warehouse. Field profiling keeps its own shorter budgets. The budget bounds one query's duration, not the bytes it scans or its cost.

## Current operational limits

One company workspace, one Node process, one DuckDB dashboard store. Horizontal scaling and highly available sessions require a different shared store/session design. Source settings are operator configuration; there is no per-company tenancy boundary inside one process. Field profiling has execution budgets and cancellation safeguards, with limits described in the [alpha contract](alpha-contract.md). Live-warehouse cancellation verification, per-query cost or scan limits, permission-change propagation, detailed metrics, user provisioning and security review with your actual identity provider remain work before a broad enterprise rollout.

Implementation references: `src/security/auth.ts`, `src/operations/telemetry.ts`, `src/store/store.ts`, `compose.team.yaml`. OIDC uses the maintained [openid-client library](https://github.com/panva/openid-client). See [OpenTelemetry exporters](https://opentelemetry.io/docs/languages/js/exporters/), [Docker Compose services](https://docs.docker.com/reference/compose-file/services/) and [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https).

## Gateway suite deployment

The instructions above cover standalone Canvas. For the intended full workspace with Ingest, follow [suite packaging](suite-packaging.md) and the [Gateway integration guide](https://github.com/Evinanderson89/gateway-platform/blob/main/docs/data-apps.md). Canvas can use `SC_MODE=gateway` to verify Gateway sessions while retaining its own source, role, row-policy and anti-forgery checks. Configure the public URL, issuer, JWT audience, JWKS, portal URL and access file together; keep internal backend ports private.

`SC_SHARED_LAKE` (optional) names the directory Ingest and Canvas share, mounted as one Compose volume in both containers. When it is set, the entrypoint creates `$SC_SHARED_LAKE/tables`, copies the sample lake into it if it is empty, and, when `SC_MODE=gateway` and no `sources.yaml` exists yet, seeds the workspace with `deploy/gateway-sources.yaml`, whose `duckglue-local` source reads `${SC_SHARED_LAKE}/tables`. Without it the entrypoint behaves as before. See `connected-canvas.md` for the lake layout.

The bundled cross-repository Compose example is local development configuration with fixture users. A production suite bundle, first-run setup and end-to-end identity-provider verification are still release work. Before rollout, pin compatible releases of both repositories and verify storage upgrades and restore. Keep Canvas, Gateway and Ingest backups distinct and complete; do not combine their databases just because they share an entry point.

## Data policies from the gateway

In gateway mode Canvas honours the row-level policy the gateway's control API signs onto each request (`x-gateway-policy` and `x-gateway-policy-sig`; see the gateway repository's `docs/policy.md`). Set `SC_GATEWAY_POLICY_SECRET` to the same value as the gateway's `GATEWAY_POLICY_SECRET`; the Compose deployment does this for you. A rule such as `dim_users.country only GB, DE` becomes the same filter a `security/policies.yaml` policy becomes, on every query, drill, filter-value lookup and agent question; a chart whose table cannot reach the governed column is refused rather than run unscoped, and a watch cannot be created while such a rule applies (it would run later without the session). The signature, subject, app and expiry are checked. If either policy header is present but verification fails (including a missing companion header), Canvas refuses the request with 403 and invalidates the cached identity used for background work. An intentionally absent policy and a verified empty rule set remain distinct from invalid policy delivery. Empty `only` lists deny all rows; empty `not` lists exclude nothing, in both chart and field-discovery queries. Embedded tools forward the verified cookie or bearer credential together with the original signed policy headers over loopback; the receiving API verifies them again. Tool access and the cached identity expire at the earlier of the login expiry and policy expiry. The app is the slug the gateway routes this Canvas under, taken from the first label of `SC_PUBLIC_URL`'s host (`semantic-canvas` at `semantic-canvas.apps.example.com`); set `SC_GATEWAY_APP` if the host is named differently. If the gateway sends a policy and no secret is configured here, the request is refused (503) rather than served unscoped, and the server logs `auth.policy_secret_missing` at boot. A watch whose owner has since come under a policy is paused with a reason rather than evaluated without it. The sidebar shows the person their own rules.
