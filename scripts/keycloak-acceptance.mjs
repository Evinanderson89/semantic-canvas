// Company sign-in acceptance against a real Keycloak, not a simulated provider.
// Starts a throwaway Keycloak container and a team-mode Canvas server, then drives
// password logins through Keycloak's own login page. Creates only uniquely named
// fixtures and removes them afterwards. Needs Docker and openssl. Not part of CI.
//
//   node scripts/keycloak-acceptance.mjs [evidence.json]
//   KEYCLOAK_IMAGE=quay.io/keycloak/keycloak:26.0 (default)
import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const image = process.env.KEYCLOAK_IMAGE ?? "quay.io/keycloak/keycloak:26.0";
const evidencePath = process.argv[2];
const realm = "canvas-acceptance", clientId = "canvas", host = "canvas.example.test";
const secret = () => randomBytes(18).toString("base64url");
const clientSecret = secret(), adminPassword = secret(), userPassword = secret();
const name = `sc-keycloak-accept-${randomUUID().slice(0, 8)}`;
const root = mkdtempSync(join(tmpdir(), "sc-keycloak-"));
const docker = args => execFileSync("docker", args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
const freePort = () => new Promise(done => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => done(port)); }); });
const results = [], servers = [];
const check = (label, ok, detail = "") => { results.push({ check: label, passed: !!ok, ...(detail ? { detail } : {}) }); console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`); };

let ca;
/** One request, no redirects followed, self-signed provider certificate trusted explicitly. */
function request(url, { method = "GET", headers = {}, body } = {}) {
  const target = new URL(url), lib = target.protocol === "https:" ? https : http;
  return new Promise((done, fail) => {
    const req = lib.request(target, { method, headers: { ...(body ? { "content-length": Buffer.byteLength(body) } : {}), ...headers }, ...(target.protocol === "https:" ? { ca } : {}) }, res => {
      let text = ""; res.setEncoding("utf8"); res.on("data", d => text += d);
      res.on("end", () => done({ status: res.statusCode, headers: res.headers, text, cookies: (res.headers["set-cookie"] ?? []).map(c => c.split(";")[0]) }));
    });
    req.on("error", fail); if (body) req.write(body); req.end();
  });
}
const form = fields => new URLSearchParams(fields).toString();
const json = text => { try { return JSON.parse(text); } catch { return null; } };

async function startCanvas(label, issuer, extraEnv = {}) {
  const dir = join(root, label); mkdirSync(dir, { recursive: true });
  const base = { adapter: "duckglue", model: resolve("sample-data/warehouse.yaml"), connector: { type: "duckdb", lakeRoot: resolve("sample-data/lake"), poolSize: 1 } };
  writeFileSync(join(dir, "sources.yaml"), JSON.stringify({ sources: [{ ...base, id: "public" }] }));
  writeFileSync(join(dir, "access.yaml"), JSON.stringify({ groupsClaim: "groups", bindings: [
    { group: "semantic-canvas-admins", role: "admin", principal: "admin", sources: ["*"] },
    { group: "semantic-canvas-viewers", role: "viewer", principal: "emea", sources: ["public"] }] }));
  const port = await freePort(), url = `http://127.0.0.1:${port}`;
  let output = "";
  const app = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { env: { ...process.env, NODE_EXTRA_CA_CERTS: join(root, "certs", "cert.pem"), SC_MODE: "team", SC_HOST: "127.0.0.1",
    SC_PUBLIC_URL: `https://${host}`, SC_OIDC_ISSUER: issuer, SC_OIDC_CLIENT_ID: clientId, SC_OIDC_CLIENT_SECRET: clientSecret, SC_ACCESS_PATH: join(dir, "access.yaml"), SC_DATA_DIR: join(dir, "data"),
    SC_ENV_PATH: join(dir, ".env"), SOURCES_PATH: join(dir, "sources.yaml"), RLS_PATH: resolve("security/policies.yaml"), PORT: String(port), SC_SERVE_UI: "false", ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
  app.stdout.on("data", d => output += d); app.stderr.on("data", d => output += d);
  servers.push(app);
  const call = (path, init = {}) => request(url + path, { ...init, headers: { host, ...init.headers } });
  for (let i = 0; i < 300; i++) { if (app.exitCode !== null) throw new Error(`Canvas (${label}) exited: ${output}`); try { if ((await call("/healthz")).status === 200) return { call, output: () => output }; } catch {} await new Promise(r => setTimeout(r, 100)); }
  throw new Error(`Canvas (${label}) did not start: ${output}`);
}

/** A real authorization-code login: Canvas redirect, Keycloak login page, credential post, Canvas callback. */
async function signIn(canvas, username, password = userPassword) {
  const start = await canvas.call("/api/auth/login");
  if (start.status !== 302) return { stage: "canvas-login", status: start.status };
  const loginCookie = start.cookies.find(c => c.startsWith("__Host-sc_login="));
  const page = await request(start.headers.location);
  const action = /<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/.exec(page.text)?.[1]?.replaceAll("&amp;", "&");
  if (page.status !== 200 || !action) return { stage: "provider-page", status: page.status };
  const posted = await request(action, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie: page.cookies.join("; ") }, body: form({ username, password, credentialId: "" }) });
  const back = posted.headers.location ? new URL(posted.headers.location) : null;
  if (posted.status !== 302 || !back?.searchParams.get("code")) return { stage: "provider-credentials", status: posted.status, codeIssued: false };
  if (back.origin !== `https://${host}`) return { stage: "provider-redirect", status: posted.status };
  const callbackPath = back.pathname + back.search;
  const callback = await canvas.call(callbackPath, { headers: { cookie: loginCookie } });
  const cookie = callback.cookies.find(c => c.startsWith("__Host-sc_session="));
  if (callback.status !== 302 || !cookie) return { stage: "canvas-callback", status: callback.status, text: callback.text, callbackPath, loginCookie };
  const session = json((await canvas.call("/api/auth/session", { headers: { cookie } })).text);
  return { stage: "signed-in", status: 302, cookie, session, callbackPath, loginCookie };
}

let failed = false;
try {
  // --- fixtures -------------------------------------------------------------
  const certs = join(root, "certs"), imports = join(root, "import"); mkdirSync(certs); mkdirSync(imports);
  writeFileSync(join(root, "openssl.cnf"), "[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=localhost\n[v3]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=digitalSignature,keyEncipherment,keyCertSign\n");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", join(certs, "key.pem"), "-out", join(certs, "cert.pem"), "-config", join(root, "openssl.cnf")], { stdio: "ignore" });
  chmodSync(join(certs, "key.pem"), 0o644); // readable by the container's non-root user; a one-day test key
  ca = readFileSync(join(certs, "cert.pem"));
  const user = (username, groups, enabled = true) => ({ username, enabled, email: `${username}@example.test`, emailVerified: true, firstName: "Test", lastName: username,
    credentials: [{ type: "password", value: userPassword, temporary: false }], groups });
  writeFileSync(join(imports, "realm.json"), JSON.stringify({ realm, enabled: true, sslRequired: "external",
    groups: [{ name: "semantic-canvas-admins" }, { name: "semantic-canvas-viewers" }, { name: "unrelated" }],
    users: [user("ada-admin", ["/semantic-canvas-admins"]), user("vic-viewer", ["/semantic-canvas-viewers", "/unrelated"]), user("moving-viewer", ["/semantic-canvas-viewers"]),
      user("nora-nogroup", ["/unrelated"]), user("dan-disabled", ["/semantic-canvas-admins"], false)],
    clients: [{ clientId, secret: clientSecret, enabled: true, publicClient: false, standardFlowEnabled: true, directAccessGrantsEnabled: false, clientAuthenticatorType: "client-secret",
      redirectUris: [`https://${host}/api/auth/callback`], attributes: { "pkce.code.challenge.method": "S256" },
      protocolMappers: [{ name: "groups", protocol: "openid-connect", protocolMapper: "oidc-group-membership-mapper",
        config: { "claim.name": "groups", "full.path": "false", "id.token.claim": "true", "access.token.claim": "false", "userinfo.token.claim": "false" } }] }] }));
  chmodSync(join(imports, "realm.json"), 0o644);
  const kcPort = await freePort(), kc = `https://localhost:${kcPort}`, issuer = `${kc}/realms/${realm}`;
  docker(["run", "-d", "--name", name, "-p", `127.0.0.1:${kcPort}:8443`, "-v", `${imports}:/opt/keycloak/data/import:ro`, "-v", `${certs}:/certs:ro`,
    "-e", "KC_BOOTSTRAP_ADMIN_USERNAME=admin", "-e", `KC_BOOTSTRAP_ADMIN_PASSWORD=${adminPassword}`, image,
    "start-dev", "--import-realm", "--https-certificate-file=/certs/cert.pem", "--https-certificate-key-file=/certs/key.pem", `--hostname=${kc}`]);
  let discovery;
  for (let i = 0; i < 180 && !discovery; i++) { try { const r = await request(`${issuer}/.well-known/openid-configuration`); if (r.status === 200) discovery = json(r.text); } catch {} if (!discovery) await new Promise(r => setTimeout(r, 1000)); }
  if (!discovery) throw new Error("Keycloak did not become ready: " + docker(["logs", "--tail", "40", name]));
  const version = docker(["exec", name, "/opt/keycloak/bin/kc.sh", "--version"]).split("\n")[0];
  console.log(`Provider: ${version} (${image}); issuer ${issuer}`);
  check("provider discovery issuer matches the configured issuer exactly", discovery.issuer === issuer);

  // A short re-check interval so provider-side changes are observable within this run (default: 300 seconds).
  const recheckSeconds = 10;
  const canvas = await startCanvas("post", issuer, { SC_SESSION_RECHECK_SECONDS: String(recheckSeconds) });
  // --- sign-in and roles ------------------------------------------------------
  check("unauthenticated API request is refused", (await canvas.call("/api/model")).status === 401);
  const admin = await signIn(canvas, "ada-admin");
  check("admin group member signs in as administrator", admin.session?.authenticated && admin.session.user?.role === "admin" && admin.session.canAdmin === true, admin.stage);
  const viewer = await signIn(canvas, "vic-viewer");
  check("viewer group member signs in as viewer, with an unrelated group ignored", viewer.session?.user?.role === "viewer" && viewer.session.canEdit === false, viewer.stage);
  const headers = s => ({ cookie: s.cookie, "x-sc-csrf": s.session.csrf, "content-type": "application/json" });
  check("viewer can read the governed model", (await canvas.call("/api/model", { headers: headers(viewer) })).status === 200);
  check("viewer cannot save a dashboard", (await canvas.call("/api/dashboards", { method: "POST", headers: headers(viewer), body: "{}" })).status === 403);
  check("viewer cannot reach workspace operations", (await canvas.call("/api/operations/status", { headers: headers(viewer) })).status === 403);
  check("administrator can reach workspace operations", (await canvas.call("/api/operations/status", { headers: headers(admin) })).status === 200);
  check("a write without the anti-forgery token is refused", (await canvas.call("/api/dashboards", { method: "POST", headers: { cookie: admin.cookie, "content-type": "application/json" }, body: "{}" })).status === 403);
  const nogroup = await signIn(canvas, "nora-nogroup");
  check("account in no bound group is refused by Canvas with guidance", nogroup.stage === "canvas-callback" && nogroup.status === 403 && /no Semantic Canvas access/.test(nogroup.text));
  const wrong = await signIn(canvas, "ada-admin", "not-the-password");
  check("wrong password: provider issues no code", wrong.stage === "provider-credentials" && wrong.codeIssued === false);
  const disabled = await signIn(canvas, "dan-disabled");
  check("disabled account: provider issues no code", disabled.stage === "provider-credentials" && disabled.codeIssued === false);
  const replay = await canvas.call(admin.callbackPath, { headers: { cookie: admin.loginCookie } });
  check("replayed authorization code is refused", replay.status === 400);
  check("account IDs are pseudonymous and distinct", /^[0-9a-f]{64}$/.test(admin.session.user.id) && admin.session.user.id !== viewer.session.user.id);

  // --- provider-side changes --------------------------------------------------
  const adminToken = json((await request(`${kc}/realms/master/protocol/openid-connect/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ grant_type: "password", client_id: "admin-cli", username: "admin", password: adminPassword }) })).text)?.access_token;
  if (!adminToken) throw new Error("Could not obtain a Keycloak admin token for the throwaway realm");
  const adminApi = (path, init = {}) => request(`${kc}/admin/realms/${realm}${path}`, { ...init, headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json", ...init.headers } });
  const moving = await signIn(canvas, "moving-viewer");
  const movingId = json((await adminApi(`/users?username=moving-viewer&exact=true`)).text)?.[0]?.id;
  const groupId = json((await adminApi(`/groups?search=semantic-canvas-viewers`)).text)?.find(g => g.name === "semantic-canvas-viewers")?.id;
  const removed = await adminApi(`/users/${movingId}/groups/${groupId}`, { method: "DELETE" });
  const relogin = await signIn(canvas, "moving-viewer");
  check("group removal at the provider is enforced at the next sign-in", moving.session?.user?.role === "viewer" && removed.status === 204 && relogin.status === 403);
  // Open sessions: one whose group was removed, one whose account is disabled, one unchanged.
  const vicId = json((await adminApi(`/users?username=vic-viewer&exact=true`)).text)?.[0]?.id;
  const disabledNow = await adminApi(`/users/${vicId}`, { method: "PUT", body: JSON.stringify({ enabled: false }) });
  await new Promise(r => setTimeout(r, (recheckSeconds + 2) * 1000));
  const afterRemoval = (await canvas.call("/api/model", { headers: headers(moving) })).status;
  const afterDisable = (await canvas.call("/api/model", { headers: headers(viewer) })).status;
  const unchanged = (await canvas.call("/api/operations/status", { headers: headers(admin) })).status;
  check("an open session ends within the re-check interval after its group is removed at the provider", afterRemoval === 401, `status ${afterRemoval}`);
  check("an open session ends within the re-check interval after its account is disabled at the provider", disabledNow.status === 204 && afterDisable === 401, `status ${afterDisable}`);
  check("an unchanged account's open session continues through a provider re-check", unchanged === 200 && /"event":"auth.session_(access_changed|revoked)"/.test(canvas.output()) && !canvas.output().includes("auth.recheck_unavailable"), `status ${unchanged}`);

  // Rotate the realm signing key: a higher-priority key becomes the active signer. Canvas has cached the old keys.
  const rotated = await adminApi("/components", { method: "POST", body: JSON.stringify({ name: `rotated-${Date.now()}`, providerId: "rsa-generated", providerType: "org.keycloak.keys.KeyProvider",
    config: { priority: ["200"], enabled: ["true"], active: ["true"], algorithm: ["RS256"], keySize: ["2048"] } }) });
  const first = await signIn(canvas, "ada-admin");
  let second = first;
  if (first.stage !== "signed-in") { for (let i = 0; i < 100 && !canvas.output().includes("auth.provider_keys_refreshed"); i++) await new Promise(r => setTimeout(r, 100)); second = await signIn(canvas, "ada-admin"); }
  check("ID token signature is verified: a token signed with an unfetched key is not accepted on first use", rotated.status === 201 && first.stage === "canvas-callback" && first.status === 400 && /"errorType":"OAUTH_KEY_SELECTION_FAILED"/.test(canvas.output()), `first attempt: ${first.stage}`);
  check("after signing-key rotation the next sign-in succeeds without a restart", second.stage === "signed-in" && second.session?.user?.role === "admin");

  // --- sign-out and logs ------------------------------------------------------
  const out = await canvas.call("/api/auth/logout", { method: "POST", headers: headers(second) });
  check("sign-out ends the Canvas session", out.status === 200 && (await canvas.call("/api/model", { headers: { cookie: second.cookie } })).status === 401);
  check("no client secret, password or email address in Canvas logs", ![clientSecret, userPassword, adminPassword, "@example.test"].some(value => canvas.output().includes(value)));

  // --- header client authentication -------------------------------------------
  const basic = await startCanvas("basic", issuer, { SC_OIDC_CLIENT_AUTH: "client_secret_basic" });
  const basicAdmin = await signIn(basic, "ada-admin");
  check("sign-in works with the client secret sent in the Authorization header", basicAdmin.session?.user?.role === "admin", basicAdmin.stage);

  failed = results.some(r => r.passed === false);
  if (evidencePath) writeFileSync(evidencePath, JSON.stringify({ provider: version, image, canvasCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    ranAt: new Date().toISOString(), passed: results.filter(r => r.passed).length, failed: results.filter(r => r.passed === false).length, results,
    scope: "Real Keycloak, password login through its login page, team mode over a self-signed HTTPS issuer. Not Okta or Entra, not a browser, not a production network path." }, null, 2));
} catch (error) { failed = true; console.error(error?.message ?? error); }
finally {
  for (const app of servers) if (app.exitCode === null) app.kill("SIGTERM");
  try { docker(["rm", "-f", name]); } catch {}
  rmSync(root, { recursive: true, force: true });
}
console.log(failed ? "\nKeycloak acceptance FAILED" : `\nKeycloak acceptance passed: ${results.filter(r => r.passed).length} checks`);
process.exit(failed ? 1 : 0);
