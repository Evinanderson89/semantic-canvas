# Security policy

Semantic Canvas is a local alpha. Its HTTP server binds to loopback and validates request hosts and origins. The role picker simulates policies; it is not authentication. Do not expose this server to a network or treat simulated roles as a boundary between untrusted users.

Semantic model files and source configuration are trusted local inputs. Metric expressions can contain SQL. Connection credentials stay on the local server; use read-only warehouse credentials. AI is optional and sends the requested document context and scoped query results to the configured provider. Images are omitted from canvas-chat context.

For a vulnerability, contact the repository maintainer through GitHub to arrange a private report, or use GitHub private vulnerability reporting when available. Avoid public reports containing credentials, customer data, private paths or working exploitation details. Include the affected commit/version, configuration, minimal reproduction, observed impact and a sanitized fixture.

This is a volunteer project; no response-time guarantee is offered. Supported releases and security fixes are recorded in CHANGELOG.md. Prefer current dependencies, a committed lockfile, and the supported Node.js versions in package.json.
