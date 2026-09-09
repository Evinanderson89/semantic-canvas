# Security policy

Semantic Canvas has separate local and company modes. Local mode binds to loopback by default and its role picker simulates policies; do not expose it as a shared service. Company mode (`SC_MODE=team`) requires HTTPS, OpenID Connect and explicit server access bindings. It enforces viewer/editor/admin roles, source allowlists and server-selected row principals. Missing company authentication configuration stops startup; it does not fall back to local mode.

Company mode is an early release, not an independently security-audited enterprise distribution. See [self-hosting](docs/self-hosting.md) for configuration and limits. Sessions are in memory and expire after one hour by default. Group changes require fresh login; restart revokes all app sessions. There is no SCIM, automatic IdP revocation, multi-tenant isolation, private document ACL or external MCP authentication in team mode. All dashboard text and filter defaults are shared with users who can access that source.

Use the included HTTPS proxy or a private upstream behind your own TLS proxy. Protect the persistent data volume and server environment. Full backups contain secrets; logical library backups contain authored document content. Logs are allowlisted and omit payloads and credentials; operators must also configure safe logging at proxies and collectors. Operational audit events are not a durable or tamper-proof compliance ledger.

Semantic model files and source configuration are trusted administrator inputs. Workspace administrators can configure connections and upload semantic models; this is a privileged operator role. Metric expressions can contain SQL. Connection credentials stay on the local server; use read-only warehouse credentials. AI is optional and sends the requested document context and scoped query results to the configured provider. Images are omitted from canvas-chat context.

For a vulnerability, contact the repository maintainer through GitHub to arrange a private report, or use GitHub private vulnerability reporting when available. Avoid public reports containing credentials, customer data, private paths or working exploitation details. Include the affected commit/version, configuration, minimal reproduction, observed impact and a sanitized fixture.

This is a volunteer project; no response-time guarantee is offered. Supported releases and security fixes are recorded in CHANGELOG.md. Prefer current dependencies, a committed lockfile, and the supported Node.js versions in package.json.
