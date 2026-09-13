import { mountChartActivity } from "./activity/server.ts";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { CompanyAuth, checkAccessPrincipals, loadAuthConfig, identityOf, canUseSource } from "./security/auth.ts";
import { createTelemetry } from "./operations/telemetry.ts";
import { resolve } from "node:path";
import { analyzeReference, validateReferenceUpload } from "./reference/analyze.ts";
import { validateDashboard } from "./app/filters.ts";
import { tabsOf, tabView } from "./app/tabs.ts";
import { finishResult, resultLimit } from "./compiler/result.ts";
import express from "express";
// Load .env before anything reads process.env, so a source that needs
// SNOWFLAKE_* (or any other) credentials picks them up with no shell setup.
// A missing .env is fine -- most contributors run the bundled duckdb source,
// which needs none.
if (typeof process.loadEnvFile === "function") {
  try { process.loadEnvFile(process.env.SC_ENV_PATH ?? ".env"); } catch { /* no .env file present */ }
}
import { compileTile, splitPartialPeriods, validateTile } from "./compiler/compile.ts";
import { suggestDashboard } from "./suggest/suggest.ts";
import type { Connector } from "./connectors/types.ts";
import { reviewedModel, visibleModel, type Model } from "./semantic/model.ts";
import { metricIssues, publishSchema, readOverlay, registerSchema, summarize, writeOverlay, type ConnectedEntry } from "./sources/connected.ts";
import { connectConnector } from "./sources/registry.ts";
import { joinCandidates, probeJoins, profileTables } from "./modeler/introspect.ts";
import { propose } from "./modeler/propose.ts";
import { proposalIssues, proposalToExtension, proposalToYaml } from "./modeler/yaml.ts";
import { driftOf, extendProposal } from "./modeler/extend.ts";
import { updateExtension, writeExtension } from "./sources/extensions.ts";
import { proposalProblems } from "./modeler/proposals.ts";
import { draftPatchSchema, listDrafts, readDraft, removeDraft, summarizeDraft, writeAuthored, writeDraft, type Draft } from "./modeler/drafts.ts";
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import YAML from "yaml";
import { describe as describeSource, connectOne, expand, loadSources, type AiConfig, type Source } from "./sources/registry.ts";
import { exportLibrary, closeStore, deleteDashboard, listDashboards, loadDashboard, openStore, saveDashboard, migrateLegacySources } from "./store/store.ts";
import { initializeCoreLibrary, listCoreLibrary, saveLibraryFolder, deleteLibraryFolder, loadLibraryView, saveLibraryView, updateLibraryItem, deleteLibraryView } from "./store/store.ts";
import { viewSaveSchema } from "./library/model.ts";
import { loadRls, type RlsConfig } from "./security/rls.ts";
import { applyBestLayout, applyLayout, LAYOUTS } from "./canvas/layouts.ts";
import { requireScope, scopedField } from "./security/queryScope.ts";
import { saveSchema, querySchema, dashboardSchema, canvasSchema, MAX_DOCUMENT_BYTES } from "./compiler/schema.ts";
import { z } from "zod";
import { chat as agentChat, explainTile, suggestImprovements, suggestDashboardStory,
         type ChatMessage, type DashboardTileSummary } from "./agent/loop.ts";
import Anthropic from "@anthropic-ai/sdk";

const SOURCES_PATH = process.env.SOURCES_PATH ?? "./sources.yaml";
const ENV_PATH = process.env.SC_ENV_PATH ?? ".env"; // matches the bare process.loadEnvFile() call above
const PORT = Number(process.env.PORT || 5174);

const auth = new CompanyAuth(await loadAuthConfig(), (event, data) => telemetry.log(event, data));
const telemetry = createTelemetry();
let ready = false;
let sources: Source[] = [];
let defaultPrincipal: string | null = null;
let rls: RlsConfig = { policies: [], principals: {} };
let ai: AiConfig | null = null;

/** Resolve the source for a request; falls back to the first ready one. */
function pick(req: any): Source {
  const want = String(req.header?.("x-sc-source") ?? req.query?.source ?? "");
  if (want && !canUseSource(identityOf(req), want)) throw Object.assign(new Error("This source is not available to your account"), { status: 403 });
  const found = sources.find((s) => s.id === want && s.status === "ready");
  if (want && !found) throw Object.assign(new Error(`Source "${want}" is unavailable`), { status: 404 });
  const ready = found ?? sources.find((s) => s.status === "ready" && canUseSource(identityOf(req), s.id));
  if (!ready) throw new Error("no data source is available");
  return ready;
}
/** Local mode simulates an administrator; in company mode the role comes from the verified session. */
const roleOf = (req: any): "viewer" | "editor" | "admin" => auth.config.mode === "local" ? "admin" : identityOf(req)?.role ?? "viewer";
const actorOf = (req: any) => identityOf(req)?.id ?? "local";
/** Viewers never see ingested-but-unreviewed tables; editors and admins see the full model. */
const modelOf = (req: any): Model => visibleModel(pick(req).model!, roleOf(req));
const connOf = (req: any): Connector => pick(req).conn!;

async function boot() {
  const loaded = await loadSources(SOURCES_PATH);
  sources = loaded.sources;
  defaultPrincipal = loaded.defaultPrincipal;
  ai = loaded.ai;
  rls = await loadRls(process.env.RLS_PATH ?? "./security/policies.yaml");

  checkAccessPrincipals(auth.config.access, rls.principals);
  if (auth.config.access?.default) {
    // The structured log allowlist keeps only the role; the event name says what it means. A write-capable default means every verified user gets editor access.
    const { role } = auth.config.access.default;
    if (role === "viewer") telemetry.log("access.default_configured", { role, mode: auth.config.mode });
    else telemetry.log("access.default_grants_every_verified_user_write_access", { role, mode: auth.config.mode }, "warn");
  }
  await auth.start();

  await openStore();
  await migrateLegacySources(sources.filter((s) => s.model).map((s) => ({ source: s.id, model: s.model!.name })));
  await initializeLibraries();
  ready = true;
  telemetry.log("server.ready", { mode: auth.config.mode, readySources: sources.filter(s => s.status === "ready").length, totalSources: sources.length });
}

async function writeConfig(path: string, content: string) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}
const app = express();
// Express matches routes case-insensitively by default; the role guard keys on the path.
app.set("case sensitive routing", true);
app.disable("x-powered-by");
app.use(telemetry.middleware);
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Referrer-Policy", "no-referrer"); res.setHeader("X-Frame-Options", "DENY");
  if (process.env.SC_SERVE_UI === "true") res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  if (req.path.startsWith("/api")) res.setHeader("Cache-Control", "no-store");
  if (req.path === "/healthz" || req.path === "/readyz") return next();
  const local = (value: string) => { try { return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(value).hostname); } catch { return false; } };
  const host = req.headers.host ?? "", origin = req.headers.origin;
  if (auth.config.mode === "local" ? !local(`http://${host}`) || origin && !local(origin)
    : host !== new URL(auth.config.publicUrl!).host || origin && origin !== auth.config.publicUrl) return res.status(403).json({ error: "Request origin is not allowed" });
  next();
});
app.get("/healthz", (_req, res) => res.json({ status: "ok" }));
app.get("/readyz", (_req, res) => res.status(ready ? 200 : 503).json({ status: ready ? "ready" : "starting" }));
app.use(express.json({ limit: MAX_DOCUMENT_BYTES }));
app.use((error: any, _req: any, res: any, next: any) => {
  if (!error) return next();
  res.status(error.status ?? 400).json({ error: error.status === 413 ? "Dashboard exceeds the 8 MB save limit" : "Invalid JSON request" });
});

auth.mount(app);
app.use("/api", auth.guard);
app.use("/api", (_req, res, next) => {
  if (auth.config.mode !== "local") {
    const json = res.json.bind(res);
    res.json = (body: any) => json(res.statusCode >= 500 ? { error: "The request failed. Contact your administrator with this request ID.", requestId: res.locals.requestId } : body);
  }
  next();
});

/**
 * Express 4 does not catch a rejected promise from an async handler -- it
 * just hangs the request. Worse, Node's default since v15 is to terminate
 * the whole process on an unhandled rejection, which is exactly what an
 * async handler calling pick() (throws when no source is ready) does. Wrap
 * every handler so "no source available" -- from a bad config, a source
 * going down, or (before the fix above) a corrupted sources.yaml -- degrades
 * to one failed request instead of taking the entire server down.
 */
// Hold the operator queue until the work completes, even if its HTTP client disconnects.
let configQueue = Promise.resolve();
const safe = (fn: (req: any, res: any) => any) => async (req: any, res: any) => {
  const run = async () => {
    if (res.destroyed) return;
    try { await fn(req, res); }
    catch (e: any) { telemetry.log("request.failed", { requestId: res.locals.requestId, errorType: e?.name ?? "Error" }, "error"); res.status(e instanceof z.ZodError ? 400 : e.status ?? 500).json({ error: e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : String(e?.message ?? e) }); }
  };
  // Covers /api/sources/:id/connected* too: overlay writes share the queue with sources.yaml edits.
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && /^\/api\/(sources|agent\/key|setup\/model|modeler)(\/|$)/.test(req.path.toLowerCase())) {
    const pending = configQueue.then(run); configQueue = pending.catch(() => {}); await pending;
  } else await run();
};

app.get("/api/sources", safe((req, res) => res.json({
  sources: sources.filter(s => canUseSource(identityOf(req), s.id)).map(s => ({ ...describeSource(s), ...(auth.config.mode !== "local" && identityOf(req)?.role !== "admin" && s.error ? { error: "Connection unavailable. Contact your administrator." } : {}) })),
  active: sources.find((x) => x.status === "ready" && canUseSource(identityOf(req), x.id))?.id ?? null,
  defaultPrincipal: auth.config.mode === "local" ? defaultPrincipal : undefined,
})));

app.get("/api/setup/guide", safe((_req, res) => res.type("text/plain").sendFile(resolve("docs/self-hosting.md"))));
app.get("/api/setup", safe((_req, res) => res.json({ mode: auth.config.mode,
  checks: { signIn: auth.config.mode !== "local", sources: sources.some(s => s.status === "ready"), catalogue: sources.some(s => Object.keys(s.model?.metrics ?? {}).length > 0), ai: Boolean(ai?.apiKey), monitoring: telemetry.enabled },
  sources: sources.map(describeSource), sessionSeconds: auth.config.sessionSeconds,
})));
app.get("/api/operations/status", safe((_req, res) => res.json({ ready, uptimeSeconds: Math.floor(process.uptime()), monitoring: telemetry.enabled, counters: telemetry.counters,
  sources: sources.map(s => ({ id: s.id, status: s.status })), storage: "Persistent dashboard database", mode: auth.config.mode,
})));

app.get("/api/operations/backup", safe(async (_req, res) => {
  res.setHeader("Content-Disposition", 'attachment; filename="semantic-canvas-library.json"');
  const backup = await exportLibrary(); telemetry.log("audit.library_exported", { actor: identityOf(_req)?.id, count: backup.dashboards.length }); res.json(backup);
}));

app.post("/api/setup/model", safe(async (req, res) => {
  const input = z.object({ content: z.string().max(5 * 1024 * 1024), adapter: z.enum(["duckglue", "snowflake-semantic"]) }).strict().parse(req.body);
  if (Buffer.byteLength(input.content) > 5 * 1024 * 1024) return res.status(413).json({ error: "Semantic model exceeds 5 MB" });
  const parsed = YAML.parse(input.content, { maxAliasCount: 50 });
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return res.status(400).json({ error: "Choose a semantic model YAML file" });
  const dir = resolve(process.env.SC_DATA_DIR ?? resolve(homedir(), ".semantic-canvas"), "models");
  await mkdir(dir, { recursive: true });
  const path = resolve(dir, `${randomUUID()}.yaml`); await writeFile(path, input.content, { mode: 0o600, flag: "wx" });
  res.json({ path });
}));

const SLUG = /^[a-z][a-z0-9-]{1,40}$/;

/**
 * A value written into sources.yaml as a JSON-quoted string is always valid
 * YAML (JSON is a YAML subset) and can never break out of its line -- a
 * label/model/lakeRoot containing a newline, a leading `#`, or a value that
 * would otherwise parse as a YAML keyword (`true`, `null`, ...) all become
 * inert data instead of structure. Fixes a real bug: these fields used to be
 * interpolated bare, so a label containing "\n  - id: evil\n    model: ..."
 * spliced a second, fully attacker-controlled source into the file.
 */
const yamlScalar = (v: string) => JSON.stringify(v);

/** Same idea for .env: quotes and escapes so an embedded newline (a private
 *  key is legitimately multi-line PEM) or `"`/`\` can't inject another line
 *  or variable into the file. */
const quoteEnvValue = (v: string) =>
  `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, "\\n")}"`;

const CONNECTOR_FIELDS = ["account", "username", "privateKey", "privateKeyPass",
  "password", "role", "warehouse", "database", "schema"] as const;
const ENV_VAR_NAME: Record<string, string> = {
  account: "ACCOUNT", username: "USERNAME", privateKey: "PRIVATE_KEY",
  privateKeyPass: "PRIVATE_KEY_PASS", password: "PASSWORD", role: "ROLE",
  warehouse: "WAREHOUSE", database: "DATABASE", schema: "SCHEMA",
};

/**
 * Builds a connector config from submitted fields, falling back field-by-field
 * to `existing` (the current, still-${VAR}-templated block) when a field is
 * left blank. `expand()` resolves `existing` values here, server-side only --
 * this is how an edit can leave a credential "unchanged" without the browser
 * ever having been sent it.
 */
function buildConnector(connectorType: string, body: any, existing: Record<string, any>):
  { ok: true; connector: Record<string, any> } | { ok: false; status: number; error: string } {
  const resolve = (f: string) => {
    const v = body?.[f];
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
    return existing[f] !== undefined ? expand(String(existing[f])) : undefined;
  };
  const connector: Record<string, any> = { type: connectorType };
  if (connectorType === "duckdb") {
    connector.lakeRoot = resolve("lakeRoot") ?? "";
    connector.poolSize = Number(body?.poolSize ?? existing.poolSize ?? 4);
    const awsProfile = resolve("awsProfile");
    if (awsProfile) connector.awsProfile = awsProfile;
    const awsRegion = resolve("awsRegion");
    if (awsRegion) connector.awsRegion = awsRegion;
    if (!connector.lakeRoot) return { ok: false, status: 400, error: "lakeRoot is required" };
  } else if (connectorType === "snowflake") {
    for (const f of CONNECTOR_FIELDS) {
      const v = resolve(f);
      if (v) connector[f] = v;
    }
    connector.poolSize = Number(body?.poolSize ?? existing.poolSize ?? 6);
    connector.warehouse ||= "COMPUTE_WH";
    connector.schema ||= "PUBLIC";
    if (!connector.account || !connector.username)
      return { ok: false, status: 400, error: "account and username are required" };
    if (!connector.privateKey && !connector.password)
      return { ok: false, status: 400, error: "a private key or a password is required" };
    if (!connector.database)
      return { ok: false, status: 400, error: "database is required" };
  } else {
    return { ok: false, status: 400, error: `unknown connector "${connectorType}"` };
  }
  return { ok: true, connector };
}

/** Renders `connector:` sub-lines and, for Snowflake, writes/updates the .env
 *  vars they reference -- never a literal secret in sources.yaml. */
async function renderConnectorLines(id: string, label: string, connectorType: string,
                                     connector: Record<string, any>): Promise<string[]> {
  const lines = [`      type: ${connectorType}`, `      poolSize: ${connector.poolSize}`];
  if (connectorType === "duckdb") {
    lines.push(`      lakeRoot: ${yamlScalar(connector.lakeRoot)}`);
    if (connector.awsProfile) lines.push(`      awsProfile: ${yamlScalar(connector.awsProfile)}`);
    if (connector.awsRegion) lines.push(`      awsRegion: ${yamlScalar(connector.awsRegion)}`);
    return lines;
  }
  const prefix = "SC_" + id.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const envVars: Record<string, string> = {};
  for (const f of CONNECTOR_FIELDS) {
    if (!connector[f]) continue;
    const varName = `${prefix}_${ENV_VAR_NAME[f]}`;
    envVars[varName] = connector[f];
    lines.push(`      ${f}: \${${varName}}`);
  }
  await upsertEnv(envVars, label);
  return lines;
}

/** Sets each var in .env (in place if it already exists there) and in
 *  process.env directly -- more reliable than re-running loadEnvFile, which
 *  by design never overwrites a key that's already set. */
async function upsertEnv(vars: Record<string, string>, label: string) {
  if (!Object.keys(vars).length) return;
  const lines = existsSync(ENV_PATH) ? (await readFile(ENV_PATH, "utf8")).split("\n") : [""];
  const added: string[] = [];
  for (const [name, value] of Object.entries(vars)) {
    const idx = lines.findIndex((l) => l.startsWith(`${name}=`));
    const rendered = `${name}=${quoteEnvValue(value)}`;
    if (idx !== -1) lines[idx] = rendered; else added.push(rendered);
  }
  let text = lines.join("\n");
  if (added.length) text = `${text.replace(/\n+$/, "")}\n\n# ${label.replace(/[\r\n]/g, " ")} (via Connections)\n${added.join("\n")}\n`;
  await writeConfig(ENV_PATH, text);
  Object.assign(process.env, vars);
}

/** Finds the `  - id: <id>` list item in sources.yaml's raw text and returns
 *  its line range, so it can be patched or removed without re-serializing
 *  (and so losing comments/formatting on) everything else in the file. */
function findYamlBlock(text: string, id: string):
  { startLine: number; endLine: number; lines: string[] } | null {
  const lines = text.split("\n");
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const start = lines.findIndex((l) => new RegExp(`^  - id:\\s*${escaped}\\s*$`).test(l));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^  - id:\s*/.test(lines[i])) { end = i; break; }
  }
  while (end - 1 > start && lines[end - 1].trim() === "") end--;
  return { startLine: start, endLine: end, lines };
}

async function readExistingBlock(id: string):
  Promise<{ block: NonNullable<ReturnType<typeof findYamlBlock>>; parsed: any } | { error: string }> {
  let text: string;
  try { text = await readFile(SOURCES_PATH, "utf8"); }
  catch (e: any) { return { error: String(e?.message ?? e) }; }
  const block = findYamlBlock(text, id);
  if (!block) return { error: `"${id}" isn't defined in ${SOURCES_PATH} in the expected format` };
  try {
    const parsed = YAML.parse("sources:\n" +
      block.lines.slice(block.startLine, block.endLine).join("\n"))?.sources?.[0] ?? {};
    return { block, parsed };
  } catch (e: any) {
    return { error: `could not parse the existing block for "${id}": ${e?.message ?? e}` };
  }
}

async function initializeLibraries() {
  for (const source of sources) if (source.status === "ready" && source.model) {
    const skipped = await initializeCoreLibrary({ source: source.id, model: source.model.name }, source.model);
    if (skipped.length) telemetry.log("library.skipped_invalid_document", { source: source.id, count: skipped.length, ids: skipped.slice(0, 20).join(",") }, "warn");
  }
}

async function hotReload() {
  const loaded = await loadSources(SOURCES_PATH);
  const retired = sources;
  sources = loaded.sources;
  await initializeLibraries();
  void Promise.allSettled(retired.map(s => s.conn?.close()));
  defaultPrincipal = loaded.defaultPrincipal;
  ai = loaded.ai;
  return {
    sources: sources.map(describeSource),
    active: sources.find((x) => x.status === "ready")?.id ?? null,
    defaultPrincipal,
  };
}

/**
 * Add a source from the Connections screen: no file editing, no restart.
 *
 * The candidate is connected with the literal values first; nothing is
 * written to disk unless that succeeds. On success, credentials go to .env
 * (never sources.yaml -- that gets a ${VAR} reference) and the registry is
 * reloaded in place, so the new source is live for the very next request.
 */
app.post("/api/sources", safe(async (req, res) => {
  const body = req.body ?? {};
  const id = String(body.id ?? "").trim();
  const label = String(body.label ?? id).trim();
  const adapter = String(body.adapter ?? "");
  const model = String(body.model ?? "").trim();
  const connectorType = String(body.connector?.type ?? "");

  if (!SLUG.test(id))
    return res.status(400).json({ error: "id must be lowercase letters, digits and hyphens, starting with a letter" });
  if (sources.some((s) => s.id === id))
    return res.status(409).json({ error: `a source named "${id}" already exists` });
  if (!["duckglue", "dbt", "snowflake-semantic"].includes(adapter))
    return res.status(400).json({ error: `unknown adapter "${adapter}"` });
  if (!model)
    return res.status(400).json({ error: "model path is required" });

  const built = buildConnector(connectorType, body.connector, {});
  if (!built.ok) return res.status(built.status).json({ error: built.error });
  const added = await addSource({ id, label, adapter, model, connectorType, connector: built.connector });
  if ("error" in added) return res.status(added.status).json({ error: added.error });
  res.json(added.reload);
}));

/** Connect with the literal values first; nothing is written unless that succeeds. Shared by the Connections form and the Modeler's publish. */
async function addSource(input: { id: string; label: string; adapter: string; model: string; connectorType: string; connector: Record<string, any> }):
  Promise<{ reload: Awaited<ReturnType<typeof hotReload>> } | { status: number; error: string }> {
  const { id, label, adapter, model, connectorType, connector: rawConnector } = input;
  // DuckDB's pool opens lazily (an in-memory instance; lakeRoot is only ever
  // touched by the read_parquet() a real query issues), so "it connected"
  // proves nothing about lakeRoot -- check the directory ourselves.
  if (connectorType === "duckdb" && !String(rawConnector.lakeRoot ?? "").startsWith("s3://")) {
    const dir = expand(rawConnector.lakeRoot);
    if (!existsSync(dir) || !statSync(dir).isDirectory())
      return { status: 422, error: `lakeRoot does not exist or is not a directory: ${dir}` };
  }

  const trial = await connectOne({ id, label, adapter, model, connector: rawConnector });
  if (trial.status === "error") return { status: 422, error: trial.error! };
  await trial.conn?.close?.().catch(() => {}); // the reload below opens its own pool

  try {
    const connectorLines = await renderConnectorLines(id, label, connectorType, rawConnector);
    const yamlBlock = [
      `  - id: ${id}`, `    label: ${yamlScalar(label)}`, `    adapter: ${adapter}`,
      `    model: ${yamlScalar(model)}`, `    connector:`, ...connectorLines, "",
    ].join("\n");
    const current = (await readFile(SOURCES_PATH, "utf8").catch(() => "")) || "";
    const document = YAML.parseDocument(current);
    if (document.errors.length) throw new Error("Fix the source configuration before adding a source");
    const existing = document.get("sources");
    const added = YAML.parse("sources:\n" + yamlBlock).sources[0];
    if (YAML.isSeq(existing)) existing.add(added);
    else if (existing == null || YAML.isScalar(existing) && existing.value == null) document.set("sources", [added]);
    else throw new Error("sources must be a list");
    await writeConfig(SOURCES_PATH, document.toString({ lineWidth: 0 }));
  } catch (e: any) {
    return { status: 500, error: `connected, but failed to save: ${e?.message ?? e}` };
  }
  return { reload: await hotReload() };
}

// ---- Modeler (docs/modeler.md): a semantic model proposed from the warehouse, reviewed, published as a source ----
const draftCreateSchema = z.object({
  id: z.string().regex(SLUG, "id must be lowercase letters, digits and hyphens, starting with a letter"), label: z.string().min(1).max(200),
  connector: z.record(z.string(), z.unknown()).optional(), fromSource: z.string().regex(SLUG).optional(),
  /** Read the warehouse behind this source and propose only what its model is missing; publishing extends that source. */
  extend: z.string().regex(SLUG).optional(),
}).strict().refine((b) => [b.connector, b.fromSource, b.extend].filter(Boolean).length === 1, "Give one of: a connector, a source to read, or a source to extend");

/** Dashboards in a source that chart any of these metrics: what a drift finding would break for readers. */
async function dashboardsUsing(source: Source, metrics: Set<string>): Promise<{ id: string; name: string; metrics: string[] }[]> {
  if (!metrics.size || !source.model) return [];
  const scope = { source: source.id, model: source.model.name };
  const out: { id: string; name: string; metrics: string[] }[] = [];
  for (const d of await listDashboards(scope)) {
    const doc = await loadDashboard(d.id, scope).catch(() => null);
    if (!doc) continue;
    const used = [...new Set(doc.spec.tiles.flatMap((t) => t.metrics ?? []).filter((m) => metrics.has(m)))].sort();
    if (used.length) out.push({ id: d.id, name: d.name, metrics: used });
  }
  return out;
}

/** Drift: what the model declares that the warehouse no longer has, and what that breaks. Reads the catalogue only; runs any time. */
app.get("/api/modeler/drift", safe(async (req, res) => {
  const id = String(req.query.source ?? "");
  const s = sources.find((x) => x.id === id);
  if (!s || s.status !== "ready" || !s.conn || !s.model) return res.status(404).json({ error: `no ready source "${id}"` });
  if (!s.conn.catalog) return res.status(400).json({ error: "This connector cannot list its tables, so drift cannot be checked." });
  const catalog = await s.conn.catalog();
  const drift = driftOf(s.model, catalog);
  const dashboards = await dashboardsUsing(s, new Set(drift.flatMap((f) => f.metrics)));
  res.json({ source: s.id, checkedAt: new Date().toISOString(), tables: catalog.length, drift, dashboards });
}));

app.get("/api/modeler/drafts", safe(async (_req, res) => res.json({ drafts: (await listDrafts()).map(summarizeDraft) })));

app.post("/api/modeler/drafts", safe(async (req, res) => {
  const input = draftCreateSchema.parse(req.body ?? {});
  if (await readDraft(input.id)) return res.status(409).json({ error: `a draft named "${input.id}" already exists` });
  if (sources.some((s) => s.id === input.id)) return res.status(409).json({ error: `a source named "${input.id}" already exists; choose another id` });
  let conn: Connector, stored: Draft["connector"], fromSource: string | undefined, borrowed = false, extending: Source | undefined;
  if (input.fromSource || input.extend) {
    const s = sources.find((x) => x.id === (input.fromSource ?? input.extend));
    if (!s || s.status !== "ready" || !s.conn || !s.model) return res.status(404).json({ error: `no ready source "${input.fromSource ?? input.extend}"` });
    conn = s.conn; fromSource = s.id; borrowed = true;
    if (input.extend) extending = s;
  } else {
    const connectorType = String((input.connector as any)?.type ?? "");
    const built = buildConnector(connectorType, input.connector, {});
    if (!built.ok) return res.status(built.status).json({ error: built.error });
    if (connectorType === "duckdb" && !String(built.connector.lakeRoot ?? "").startsWith("s3://")) {
      const dir = expand(built.connector.lakeRoot);
      if (!existsSync(dir) || !statSync(dir).isDirectory()) return res.status(422).json({ error: `lakeRoot does not exist or is not a directory: ${dir}` });
    }
    try { conn = await connectConnector(built.connector); } catch (e: any) { return res.status(422).json({ error: String(e?.message ?? e) }); }
    // Stored as sources.yaml would hold it: credentials go to .env now, the draft keeps ${VAR} references.
    const lines = await renderConnectorLines(input.id, input.label, connectorType, built.connector);
    stored = YAML.parse(lines.map((l) => l.replace(/^ {6}/, "")).join("\n"));
  }
  try {
    if (!conn.catalog) return res.status(400).json({ error: "This connector cannot list its tables, so the Modeler cannot read it." });
    const catalog = await conn.catalog();
    if (!catalog.length) return res.status(422).json({ error: "The warehouse has no tables to model." });
    const profiles = await profileTables(conn, catalog);
    const probes = await probeJoins(conn, profiles, joinCandidates(profiles));
    const now = new Date().toISOString();
    const fresh = propose({ id: input.id, label: input.label, tables: profiles, probes });
    const draft: Draft = { id: input.id, label: input.label, connector: stored, fromSource, createdAt: now, createdBy: actorOf(req), updatedAt: now, publishedAt: null, sourceId: null,
      proposal: extending ? extendProposal(fresh, extending.model!, extending.id) : fresh,
      ...(extending ? { drift: driftOf(extending.model!, catalog) } : {}) };
    await writeDraft(draft);
    telemetry.log("audit.modeler_drafted", { actor: actorOf(req), id: draft.id, tables: profiles.length, probes: probes.length, extends: extending?.id });
    res.json(draft);
  } finally { if (!borrowed) await conn!.close().catch(() => {}); }
}));

app.get("/api/modeler/drafts/:id", safe(async (req, res) => {
  const d = await readDraft(String(req.params.id));
  if (!d) return res.status(404).json({ error: `no draft "${req.params.id}"` });
  res.json(d);
}));

app.put("/api/modeler/drafts/:id", safe(async (req, res) => {
  const d = await readDraft(String(req.params.id));
  if (!d) return res.status(404).json({ error: `no draft "${req.params.id}"` });
  const patch = draftPatchSchema.parse(req.body ?? {});
  const next: Draft = { ...d, ...(patch.label ? { label: patch.label } : {}), ...(patch.proposal ? { proposal: patch.proposal } : {}), updatedAt: new Date().toISOString() };
  await writeDraft(next);
  res.json({ ...next, issues: proposalIssues(next.proposal) });
}));

app.get("/api/modeler/drafts/:id/yaml", safe(async (req, res) => {
  const d = await readDraft(String(req.params.id));
  if (!d) return res.status(404).json({ error: `no draft "${req.params.id}"` });
  res.type("text/yaml").send(proposalToYaml(d.proposal));
}));

app.delete("/api/modeler/drafts/:id", safe(async (req, res) => {
  const d = await readDraft(String(req.params.id));
  if (!d) return res.status(404).json({ error: `no draft "${req.params.id}"` });
  await removeDraft(d.id);
  res.json({ ok: true, id: d.id, sourceId: d.sourceId });
}));

/** Write the model file and add (or refresh) the source that reads it. The draft stays, marked published, so it can be revised and republished. */
app.post("/api/modeler/drafts/:id/publish", safe(async (req, res) => {
  const d = await readDraft(String(req.params.id));
  if (!d) return res.status(404).json({ error: `no draft "${req.params.id}"` });
  const issues = proposalIssues(d.proposal);
  if (issues.length) return res.status(400).json({ error: issues[0], issues });
  if (d.proposal.extends) {
    // Extending a source: the base model file is never touched; the additions go to an extension merged over it.
    const target = sources.find((s) => s.id === d.proposal.extends);
    if (!target) return res.status(404).json({ error: `the source this draft extends, ${d.proposal.extends}, is no longer configured` });
    const path = await writeExtension(target.id, proposalToExtension(d.proposal, { by: identityOf(req)?.name ?? actorOf(req), at: new Date().toISOString() }));
    const reload = await hotReload();
    const published: Draft = { ...d, publishedAt: new Date().toISOString(), sourceId: target.id, updatedAt: new Date().toISOString() };
    await writeDraft(published);
    const source = sources.find((s) => s.id === target.id);
    telemetry.log("audit.modeler_extended", { actor: actorOf(req), id: d.id, source: target.id, tables: Object.keys(source?.model?.tables ?? {}).length, metrics: Object.keys(source?.model?.metrics ?? {}).length });
    return res.json({ draft: summarizeDraft(published), source: source ? describeSource(source) : null, path, sources: reload.sources, extended: true });
  }
  const path = await writeAuthored(d.id, proposalToYaml(d.proposal));
  const already = sources.find((s) => s.id === d.id);
  let reload: Awaited<ReturnType<typeof hotReload>>;
  if (already) reload = await hotReload();
  else {
    let connector: Record<string, any>, connectorType: string;
    if (d.fromSource) {
      // The borrowed source's connector, as configured (${VAR} references resolve in buildConnector). Parsed, not line-matched: any YAML layout will do.
      const entry = ((YAML.parse((await readFile(SOURCES_PATH, "utf8").catch(() => "")) || "{}")?.sources ?? []) as any[]).find((x) => x?.id === d.fromSource);
      if (!entry) return res.status(404).json({ error: `the source this draft reads, ${d.fromSource}, is no longer configured` });
      connectorType = String(entry.connector?.type ?? "duckdb");
      const built = buildConnector(connectorType, {}, entry.connector ?? {});
      if (!built.ok) return res.status(built.status).json({ error: built.error });
      connector = built.connector;
    } else {
      connectorType = String(d.connector?.type ?? "duckdb");
      const built = buildConnector(connectorType, {}, d.connector ?? {});
      if (!built.ok) return res.status(built.status).json({ error: built.error });
      connector = built.connector;
    }
    const added = await addSource({ id: d.id, label: d.label, adapter: "duckglue", model: path, connectorType, connector });
    if ("error" in added) return res.status(added.status).json({ error: added.error });
    reload = added.reload;
  }
  const published: Draft = { ...d, publishedAt: new Date().toISOString(), sourceId: d.id, updatedAt: new Date().toISOString() };
  await writeDraft(published);
  const source = sources.find((s) => s.id === d.id);
  telemetry.log("audit.modeler_published", { actor: actorOf(req), id: d.id, tables: Object.keys(source?.model?.tables ?? {}).length, metrics: Object.keys(source?.model?.metrics ?? {}).length });
  res.json({ draft: summarizeDraft(published), source: source ? describeSource(source) : null, path, sources: reload.sources });
}));

/** Non-secret fields only, for the edit form to pre-fill -- privateKey,
 *  privateKeyPass and password never leave the server. */
app.get("/api/sources/:id/config", safe(async (req, res) => {
  const existing = await readExistingBlock(req.params.id);
  if ("error" in existing) return res.status(404).json({ error: existing.error });
  const c = existing.parsed.connector ?? {};
  const SAFE_FIELDS = ["type", "lakeRoot", "awsProfile", "awsRegion", "poolSize", "account", "username", "role", "warehouse", "database", "schema"];
  const connector: Record<string, any> = {};
  for (const f of SAFE_FIELDS) {
    if (c[f] === undefined) continue;
    connector[f] = typeof c[f] === "string" ? expand(c[f]) : c[f];
  }
  res.json({ id: existing.parsed.id, label: existing.parsed.label, adapter: existing.parsed.adapter,
             model: existing.parsed.model, connector });
}));

/**
 * Edit a source in place. A blank field means "keep the current value" --
 * resolved server-side via buildConnector()'s fallback to `existing`, which
 * is how a credential can be left alone without ever round-tripping through
 * the browser. Tests before persisting, same as add.
 */
app.put("/api/sources/:id", safe(async (req, res) => {
  const id = req.params.id;
  if (!sources.some((s) => s.id === id)) return res.status(404).json({ error: `no source named "${id}"` });
  const existing = await readExistingBlock(id);
  if ("error" in existing) return res.status(404).json({ error: existing.error });

  const body = req.body ?? {};
  const label = String(body.label ?? existing.parsed.label ?? id).trim();
  const adapter = String(body.adapter ?? existing.parsed.adapter ?? "");
  const model = String(body.model ?? existing.parsed.model ?? "").trim();
  const connectorType = String(body.connector?.type ?? existing.parsed.connector?.type ?? "");

  if (!["duckglue", "dbt", "snowflake-semantic"].includes(adapter))
    return res.status(400).json({ error: `unknown adapter "${adapter}"` });
  if (!model) return res.status(400).json({ error: "model path is required" });

  const built = buildConnector(connectorType, body.connector, existing.parsed.connector ?? {});
  if (!built.ok) return res.status(built.status).json({ error: built.error });
  const rawConnector = built.connector;

  if (connectorType === "duckdb" && !String(rawConnector.lakeRoot ?? "").startsWith("s3://")) {
    const dir = expand(rawConnector.lakeRoot);
    if (!existsSync(dir) || !statSync(dir).isDirectory())
      return res.status(422).json({ error: `lakeRoot does not exist or is not a directory: ${dir}` });
  }

  const trial = await connectOne({ id, label, adapter, model, connector: rawConnector });
  if (trial.status === "error") return res.status(422).json({ error: trial.error });
  await trial.conn?.close?.().catch(() => {});

  try {
    const connectorLines = await renderConnectorLines(id, label, connectorType, rawConnector);
    const newBlock = [
      `  - id: ${id}`, `    label: ${yamlScalar(label)}`, `    adapter: ${adapter}`,
      `    model: ${yamlScalar(model)}`, `    connector:`, ...connectorLines,
    ];
    const { block } = existing;
    block.lines.splice(block.startLine, block.endLine - block.startLine, ...newBlock);
    await writeConfig(SOURCES_PATH, block.lines.join("\n"));
  } catch (e: any) {
    return res.status(500).json({ error: `connected, but failed to save: ${e?.message ?? e}` });
  }

  res.json(await hotReload());
}));

/** Removes a source's block from sources.yaml. Leaves any .env vars it used
 *  in place -- orphaned entries are harmless clutter, and there's no way to
 *  tell whether a hand-edited source shares a var with something else. */
app.delete("/api/sources/:id", safe(async (req, res) => {
  const id = req.params.id;
  if (!sources.some((s) => s.id === id)) return res.status(404).json({ error: `no source named "${id}"` });
  if (sources.length <= 1)
    return res.status(400).json({ error: "cannot remove the only configured source" });
  const existing = await readExistingBlock(id);
  if ("error" in existing) return res.status(404).json({ error: existing.error });

  const { block } = existing;
  block.lines.splice(block.startLine, block.endLine - block.startLine);
  try { await writeConfig(SOURCES_PATH, block.lines.join("\n")); }
  catch (e: any) { return res.status(e instanceof z.ZodError ? 400 : e.status ?? 500).json({ error: e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : String(e?.message ?? e) }); }

  res.json(await hotReload());
}));

/**
 * Connected tables (docs/connected-canvas.md): Ingest registers a loaded
 * table and a draft model entry into a per-source overlay. Editors register
 * and disconnect their own entries; only an admin publishes one into the
 * governed catalogue. The lake itself is never touched from here.
 */
// ---- Proposed metrics (docs/modeler.md, "Proposed metrics"): an editor names an aggregate; admins publish it to viewers ----
const proposeMetricSchema = z.object({
  name: z.string().max(64), label: z.string().max(200), baseTable: z.string().max(128), expression: z.string().max(4000),
  description: z.string().max(2000).optional(), filter: z.string().max(4000).nullable().optional(),
}).strict();

app.post("/api/sources/:sourceId/metrics", safe(async (req, res) => {
  const source = connectedSource(req);
  if (source.status !== "ready" || !source.model || !source.conn) return res.status(503).json({ error: "This source is not ready." });
  const p = proposeMetricSchema.parse(req.body);
  const problems = proposalProblems(source.model, p);
  if (problems.length) return res.status(400).json({ error: problems[0], problems });
  const who = identityOf(req)?.name ?? "local", whoId = actorOf(req), at = new Date().toISOString();
  // One probe against the warehouse before anything is stored: the expression has to compile and run.
  const candidate: Model = { ...source.model, metrics: { ...source.model.metrics, [p.name]: { name: p.name, label: p.label, baseTable: p.baseTable, expression: p.expression, filter: p.filter ?? null, synonyms: [], reviewed: false } } };
  try {
    const sql = compileTile(candidate, source.conn, { id: "probe", metrics: [p.name], dimensions: [], layout: { x: 0, y: 0, w: 1, h: 1 } }, { probe: true });
    await source.conn.execute(sql, 1, `probe:${whoId}:${at}`);
  } catch (e: any) { return res.status(422).json({ error: `The warehouse refused it: ${String(e?.message ?? e).split("\n")[0]}`, problems: [] }); }
  await updateExtension(source.id, (ext) => ({ ...ext, metrics: { ...ext.metrics, [p.name]: {
    label: p.label.trim(), base_table: p.baseTable, expression: p.expression.trim(), ...(p.description?.trim() ? { description: p.description.trim() } : {}), ...(p.filter?.trim() ? { filter: p.filter.trim() } : {}),
    reviewed: false, origin: { kind: "proposal", by: who, by_id: whoId, at } } } }));
  telemetry.log("audit.metric_proposed", { actor: whoId, source: source.id, metric: p.name, table: p.baseTable });
  await hotReload();
  res.json({ metric: sources.find((s) => s.id === source.id)?.model?.metrics[p.name] ?? null });
}));

app.post("/api/sources/:sourceId/metrics/:name/publish", safe(async (req, res) => {
  const source = connectedSource(req), name = String(req.params.name);
  const m = source.model?.metrics[name];
  if (!m?.origin || m.origin.kind !== "proposal") return res.status(404).json({ error: `no proposed metric "${name}" on ${source.id}` });
  if (m.reviewed !== false) return res.status(409).json({ error: `${name} is already published.` });
  const who = identityOf(req)?.name ?? "local", at = new Date().toISOString();
  await updateExtension(source.id, (ext) => ({ ...ext, metrics: { ...ext.metrics, [name]: { ...ext.metrics[name], reviewed: true, origin: { ...ext.metrics[name].origin!, published_by: who, published_at: at } } } }));
  telemetry.log("audit.metric_published", { actor: actorOf(req), source: source.id, metric: name });
  await hotReload();
  res.json({ metric: sources.find((s) => s.id === source.id)?.model?.metrics[name] ?? null });
}));

/** The proposer may withdraw an unpublished proposal; an administrator may remove any metric added in Canvas. */
app.delete("/api/sources/:sourceId/metrics/:name", safe(async (req, res) => {
  const source = connectedSource(req), name = String(req.params.name);
  const m = source.model?.metrics[name];
  if (!m?.origin) return res.status(404).json({ error: m ? `${name} comes from the base model; edit it there.` : `no metric "${name}" on ${source.id}` });
  const mine = m.origin.byId === actorOf(req) && m.reviewed === false;
  if (roleOf(req) !== "admin" && !mine) return res.status(403).json({ error: "Only the person who proposed it can withdraw it before it is published; after that, an administrator." });
  await updateExtension(source.id, (ext) => { const { [name]: _gone, ...rest } = ext.metrics; return { ...ext, metrics: rest }; });
  telemetry.log("audit.metric_removed", { actor: actorOf(req), source: source.id, metric: name, published: m.reviewed !== false });
  await hotReload();
  res.json({ ok: true, name });
}));

function connectedSource(req: any): Source {
  const id = String(req.params.sourceId);
  if (!canUseSource(identityOf(req), id)) throw Object.assign(new Error("This source is not available to your account"), { status: 403 });
  const source = sources.find((s) => s.id === id);
  if (!source) throw Object.assign(new Error(`no source named "${id}"`), { status: 404 });
  return source;
}
const ownsEntry = (req: any, entry: ConnectedEntry) => roleOf(req) === "admin" || entry.registeredBy === actorOf(req);

app.get("/api/sources/:sourceId/connected", safe(async (req, res) => {
  const source = connectedSource(req), overlay = await readOverlay(source.id);
  const entries = Object.values(overlay.tables).filter((e) => roleOf(req) !== "viewer" || e.status === "published");
  res.json({ source: source.id, tables: entries.map(summarize) });
}));

app.post("/api/sources/:sourceId/connected", safe(async (req, res) => {
  const source = connectedSource(req), body = registerSchema.parse(req.body);
  const overlay = await readOverlay(source.id), existing = overlay.tables[body.dataset];
  if (existing && !ownsEntry(req, existing)) return res.status(403).json({ error: `${body.dataset} was connected by someone else; only they or an administrator can replace it` });
  if (source.model?.tables[body.dataset] && !source.model.tables[body.dataset].connected) return res.status(409).json({ error: `"${body.dataset}" is already a table of the base model` });
  // Draft metrics are regenerated unreviewed; a published metric of the same name keeps its review as long as it still validates.
  const metrics: ConnectedEntry["metrics"] = {};
  for (const [name, m] of Object.entries(body.metrics)) {
    const kept = existing?.metrics[name];
    metrics[name] = kept?.reviewed ? { ...kept, ...m, reviewed: true } : { ...m, reviewed: false };
  }
  const entry: ConnectedEntry = { status: existing?.status ?? "unreviewed", dataset: body.dataset, importId: body.importId, provenance: body.provenance,
    registeredBy: existing?.registeredBy ?? actorOf(req), table: body.table, metrics };
  const issue = metricIssues(entry);
  if (issue) return res.status(400).json({ error: issue });
  overlay.tables[body.dataset] = entry;
  await writeOverlay(source.id, overlay);
  telemetry.log("audit.connected_registered", { actor: actorOf(req), source: source.id, dataset: body.dataset, importId: body.importId, replaced: Boolean(existing) });
  await hotReload();
  const merged = sources.find((s) => s.id === source.id)?.model?.tables[body.dataset];
  res.json({ ...summarize(entry), table: merged ?? null });
}));

/** The draft an admin reviews before publishing: columns and expressions, which the list leaves out. Same visibility rule as the list. */
app.get("/api/sources/:sourceId/connected/:dataset", safe(async (req, res) => {
  const source = connectedSource(req), overlay = await readOverlay(source.id), existing = overlay.tables[String(req.params.dataset)];
  if (!existing || (roleOf(req) === "viewer" && existing.status !== "published")) return res.status(404).json({ error: `no connected table "${req.params.dataset}" on ${source.id}` });
  res.json({ dataset: existing.dataset, status: existing.status, table: existing.table, metrics: existing.metrics });
}));

app.post("/api/sources/:sourceId/connected/:dataset/publish", safe(async (req, res) => {
  const source = connectedSource(req), body = publishSchema.parse(req.body);
  const overlay = await readOverlay(source.id), existing = overlay.tables[String(req.params.dataset)];
  if (!existing) return res.status(404).json({ error: `no connected table "${req.params.dataset}" on ${source.id}` });
  const unknown = Object.keys(body.metrics).find((name) => !existing.metrics[name]);
  if (unknown) return res.status(400).json({ error: `"${unknown}" is not a metric of ${existing.dataset}` });
  const entry: ConnectedEntry = { ...existing, status: "published", table: { ...existing.table, ...body.table },
    metrics: Object.fromEntries(Object.entries(existing.metrics).map(([name, m]) => [name, body.metrics[name] ? { ...m, ...body.metrics[name] } : m])) };
  const issue = metricIssues(entry);
  if (issue) return res.status(400).json({ error: issue });
  overlay.tables[existing.dataset] = entry;
  await writeOverlay(source.id, overlay);
  telemetry.log("audit.connected_published", { actor: actorOf(req), source: source.id, dataset: existing.dataset, metrics: Object.keys(body.metrics).length });
  await hotReload();
  res.json(summarize(entry));
}));

app.delete("/api/sources/:sourceId/connected/:dataset", safe(async (req, res) => {
  const source = connectedSource(req), overlay = await readOverlay(source.id), existing = overlay.tables[String(req.params.dataset)];
  if (!existing) return res.status(404).json({ error: `no connected table "${req.params.dataset}" on ${source.id}` });
  if (!ownsEntry(req, existing)) return res.status(403).json({ error: `${existing.dataset} was connected by someone else; only they or an administrator can disconnect it` });
  delete overlay.tables[existing.dataset];
  await writeOverlay(source.id, overlay);
  // Disconnect archives; the data stays in the lake for the operator.
  telemetry.log("audit.connected_disconnected", { actor: actorOf(req), source: source.id, dataset: existing.dataset, importId: existing.importId });
  await hotReload();
  res.json({ ok: true, dataset: existing.dataset });
}));

app.get("/api/model", safe((req, res) => res.json(modelOf(req))));
/** Schema introspection, for "the warehouse schema is fully readable". */
app.get("/api/schema", safe(async (req, res) => {
  const src = pick(req);
  const c: any = src.conn;
  if (typeof c.schema !== "function")
    return res.json({
      tables: Object.values(modelOf(req).tables).map((t) => ({
        name: t.name, columns: t.columns.map((x) => ({ name: x.name, type: x.type })) })),
      source: `${src.label} (from the semantic model)`,
    });
  try { res.json({ tables: await c.schema(), source: c.label }); }
  catch (e: any) { res.status(e instanceof z.ZodError ? 400 : e.status ?? 500).json({ error: e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : String(e?.message ?? e) }); }
}));

app.get("/api/stats", safe((req, res) => res.json((connOf(req) as any).stats?.() ?? {})));
app.get("/api/suggest", safe((req, res) =>
  res.json(suggestDashboard(modelOf(req), {
    table: (req.query.table as string) || null,
    grain: (req.query.grain as string) || "month",
    width: Number(req.query.width) || 1440,
  }))));

/**
 * Distinct values for a field, so a discrete filter offers what is actually
 * there rather than a free-text box you can typo into.
 */
/**
 * Profile a field so the visualization recommender has something real to reason
 * about. Chart choice hinges on facts you cannot get from the schema alone --
 * how many distinct values there are, and whether they look like places.
 */
const ISO2 = new Set(("AD AE AF AG AL AM AO AR AT AU AZ BA BD BE BG BR BW BY CA CH CL CN CO CR CU CY CZ " +
  "DE DK DO DZ EC EE EG ES ET FI FJ FR GB GE GH GR GT HK HN HR HU ID IE IL IN IQ IR IS IT JM JO JP KE " +
  "KH KR KW KZ LB LK LT LU LV MA MD MK MM MN MT MX MY NG NL NO NP NZ OM PA PE PH PK PL PT PY QA RO RS " +
  "RU SA SE SG SI SK SN TH TN TR TW TZ UA UG US UY VE VN ZA ZM ZW").split(" "));
const GEO_NAME = /(country|nation|region|state|province|city|market|territory|geo|iso)/i;

const dashboardScope = (req: any) => ({ source: pick(req).id, model: modelOf(req).name });
app.get("/api/library", safe(async (req, res) => res.json(await listCoreLibrary(dashboardScope(req)))));
app.post("/api/library/folders", safe(async (req, res) => res.json(await saveLibraryFolder(req.body, dashboardScope(req)))));
app.delete("/api/library/folders/:id", safe(async (req, res) => res.json(await deleteLibraryFolder(req.params.id, z.number().int().positive().parse(req.body?.revision), dashboardScope(req)))));
app.get("/api/library/views/:id", safe(async (req, res) => {
  const view = await loadLibraryView(req.params.id, dashboardScope(req));
  return view ? res.json(view) : res.status(404).json({ error: "View not found in this source" });
}));
app.post("/api/library/views", safe(async (req, res) => {
  const view = viewSaveSchema.parse(req.body), issues = validateDashboard(modelOf(req), view.spec);
  if (issues.length) return res.status(400).json({ issues });
  res.json(await saveLibraryView(view, dashboardScope(req)));
}));
app.patch("/api/library/items/:kind/:id", safe(async (req, res) => res.json(await updateLibraryItem(req.params.kind, req.params.id, req.body, dashboardScope(req)))));
app.delete("/api/library/views/:id", safe(async (req, res) => res.json(await deleteLibraryView(req.params.id, z.number().int().positive().parse(req.body?.revision), dashboardScope(req)))));
app.get("/api/dashboards", safe(async (req, res) =>
  res.json({ dashboards: await listDashboards(dashboardScope(req)) })));

app.post("/api/dashboards", safe(async (req, res) => {
  const document = saveSchema.parse(req.body);
  const model = modelOf(req);
  const issues = validateDashboard(model, document.spec);
  if (issues.length) return res.status(400).json({ issues });
  res.json(await saveDashboard(document, dashboardScope(req)));
}));
app.get("/api/dashboards/:id", safe(async (req, res) => {
  const d = await loadDashboard(req.params.id, dashboardScope(req));
  return d ? res.json(d) : res.status(404).json({ error: "Dashboard not found in this source" });
}));
app.delete("/api/dashboards/:id", safe(async (req, res) => {
  const revision = z.number().int().positive().parse(req.body?.revision);
  res.json(await deleteDashboard(req.params.id, dashboardScope(req), revision));
}));
app.post("/api/dashboards/:id/arrange", safe(async (req, res) => {
  const d = await loadDashboard(req.params.id, dashboardScope(req));
  if (!d) return res.status(404).json({ error: "Dashboard not found in this source" });
  const requested = req.body?.layout;
  if (requested && !LAYOUTS.some((l) => l.name === requested)) return res.status(400).json({ error: "Unknown layout" });
  const pages = tabsOf(d.spec).map(tab => {
    const tiles = tabView(d.spec, tab.id).tiles;
    return requested ? { name: requested, tiles: applyLayout(requested, tiles, d.canvas.width) } : applyBestLayout(tiles, d.canvas.width);
  });
  const arranged = { name: requested ?? "per-tab", tiles: pages.flatMap(p => p.tiles) };
  const bottom = Math.max(d.canvas.height, ...arranged.tiles.map((t) => t.layout.y + t.layout.h + 24));
  const canvas = { ...d.canvas, height: Math.round(bottom) };
  const spec = { ...d.spec, tiles: arranged.tiles };
  const saved = await saveDashboard({ id: req.params.id, name: d.name, spec, canvas,
    revision: req.body?.revision ?? d.revision }, dashboardScope(req));
  res.json({ ...saved, layout: arranged.name, spec, canvas });
}));

/**
 * The in-app half of "the agent interviews the user when it's unsure": an
 * MCP tool call posts a question here, the browser polls for it and shows
 * it, a human answers in the UI, and the MCP server (also polling) picks the
 * answer back up and returns it to the agent. Deliberately just polling in
 * both directions -- this is a low-frequency, human-in-the-loop interaction,
 * not a hot path, so a push channel isn't worth the extra infrastructure.
 * In-memory and ephemeral: an agent's pending question doesn't need to
 * survive a server restart.
 */
interface PendingQuestion {
  owner: string; id: string; question: string; options?: string[]; answer: string | null; createdAt: number;
}
const agentQuestions = new Map<string, PendingQuestion>();
const nextQuestionId = () => `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
function pruneAnsweredQuestions() {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [id, q] of agentQuestions) if (q.createdAt < cutoff) agentQuestions.delete(id);
}

app.post("/api/agent/questions", safe(async (req, res) => {
  pruneAnsweredQuestions();
  const owner = identityOf(req)?.id ?? "local";
  if (agentQuestions.size >= 5000 || [...agentQuestions.values()].filter(q => q.owner === owner).length >= 50) return res.status(429).json({ error: "Too many pending questions. Try again later." });
  const question = String(req.body?.question ?? "").trim().slice(0, 4000);
  if (!question) return res.status(400).json({ error: "question is required" });
  const options = Array.isArray(req.body?.options) ? req.body.options.slice(0, 12).map((o: unknown) => String(o).slice(0, 500)) : undefined;
  const id = nextQuestionId();
  agentQuestions.set(id, { id, question, options, answer: null, createdAt: Date.now(), owner: identityOf(req)?.id ?? "local" });
  res.json({ id });
}));

/** The browser polls this for whatever's still waiting on a human. */
app.get("/api/agent/questions", safe(async (req, res) => {
  res.json({
    questions: [...agentQuestions.values()].filter((q) => q.answer === null && q.owner === (identityOf(req)?.id ?? "local"))
      .map((q) => ({ id: q.id, question: q.question, options: q.options })),
  });
}));

app.post("/api/agent/questions/:id/answer", safe(async (req, res) => {
  const q = agentQuestions.get(req.params.id);
  if (!q || q.owner !== (identityOf(req)?.id ?? "local")) return res.status(404).json({ error: "no such question (it may have already been answered elsewhere)" });
  const answer = String(req.body?.answer ?? "").trim();
  if (!answer) return res.status(400).json({ error: "answer is required" });
  q.answer = answer;
  res.json({ ok: true });
}));

/** The MCP server polls this until a human answers (or its own timeout gives up). */
app.get("/api/agent/questions/:id", safe(async (req, res) => {
  const q = agentQuestions.get(req.params.id);
  if (!q || q.owner !== (identityOf(req)?.id ?? "local")) return res.status(404).json({ error: "no such question" });
  res.json({ id: q.id, question: q.question, options: q.options, answer: q.answer });
}));

/**
 * The embedded in-app agent: the AI living behind the "ai" port in
 * sources.yaml, as opposed to an external agent attached over MCP. Drives
 * the same tool list (src/agent/tools.ts) the MCP server exposes, so it's
 * exactly as governed -- including ask_user, which surfaces in this same
 * tab either way. Conversations are in-memory and ephemeral, keyed by a
 * client-generated id, same as the agent-questions map above.
 */
const agentConversations = new Map<string, ChatMessage[]>();

app.post("/api/reference/analyze", safe(async (req, res) => {
  try { await validateReferenceUpload(req.body); } catch (e: any) { return res.status(400).json({ error: e.message }); }
  if (!ai?.apiKey) return res.status(503).json({ error: "Connect an AI provider in Connections to read a dashboard reference." });
  const controller = new AbortController();
  const stop = () => controller.abort(); res.on("close", stop);
  try { const blueprint = await analyzeReference(req.body, modelOf(req), ai, controller.signal); if (!res.destroyed) res.json({ blueprint }); }
  finally { res.off("close", stop); }
}));

app.get("/api/agent/status", safe((_req, res) => res.json({
  configured: Boolean(ai?.apiKey && ai.provider === "anthropic"), provider: ai?.provider ?? "anthropic", model: ai?.model ?? "claude-opus-5",
})));

/**
 * Same idea as the Connections screen's "test before you save" sources form:
 * the key is checked against Anthropic before it's written anywhere. A
 * models.retrieve() call is a plain auth check -- no completion, no tokens
 * spent -- the same shape of "does this credential actually work" test a
 * trial source connection is. On success it goes to .env via the same
 * upsertEnv() a Snowflake credential does, never into sources.yaml.
 */
app.post("/api/agent/key", safe(async (req, res) => {
  const apiKey = String(req.body?.apiKey ?? "").trim();
  if (!apiKey) return res.status(400).json({ error: "apiKey is required" });
  const provider = ai?.provider ?? "anthropic";
  const model = ai?.model ?? "claude-opus-5";
  try {
    await new Anthropic({ apiKey }).models.retrieve(model);
  } catch (e: any) {
    const msg = e instanceof Anthropic.AuthenticationError ? "that key was rejected as invalid"
      : e instanceof Anthropic.NotFoundError ? `the model "${model}" isn't available on this key`
      : String(e?.message ?? e);
    return res.status(422).json({ error: msg });
  }
  await upsertEnv({ ANTHROPIC_API_KEY: apiKey }, "AI agent (via Connections)");
  ai = { provider, model, apiKey };
  res.json({ configured: true, provider, model });
}));

app.delete("/api/agent/key", safe(async (_req, res) => {
  await upsertEnv({ ANTHROPIC_API_KEY: "" }, "AI agent (via Connections)");
  if (ai) ai = { ...ai, apiKey: "" };
  res.json({ configured: false });
}));

app.post("/api/agent/chat", safe(async (req, res) => {
  if (!ai) return res.status(503).json({ error: "no ai provider configured -- add an ai: block to sources.yaml" });
  const conversationId = String(req.body?.conversationId ?? "").trim();
  const message = String(req.body?.message ?? "").trim();
  if (!conversationId) return res.status(400).json({ error: "conversationId is required" });
  if (!message) return res.status(400).json({ error: "message is required" });
  const principal = principalOf(req)?.id ?? "";
  const source = pick(req).id;
  const historyKey = JSON.stringify([identityOf(req)?.id ?? "local", source, principal, conversationId]);
  const history = agentConversations.get(historyKey) ?? [];
  const active = req.body.document ? z.object({ spec: dashboardSchema, canvas: canvasSchema, selected: z.array(z.string()).max(500).default([]) }).strict().parse(req.body.document) : undefined;
  const controller = new AbortController();
  res.on("close", () => controller.abort());
  const { text, messages, proposal } = await agentChat(ai, history.slice(-12), message, { source, principal, auth: auth.forwarded(req), signal: controller.signal }, active ? { ...active, model: modelOf(req) } : undefined);
  if (agentConversations.size >= 500) agentConversations.delete(agentConversations.keys().next().value!);
  agentConversations.set(historyKey, messages.slice(-12));
  res.json({ text, proposal });
}));

/**
 * "Explain this" on a single tile -- a one-shot call (see explainTile),
 * not a conversation, so there's no conversationId or history here.
 */
app.post("/api/agent/explain", safe(async (req, res) => {
  if (!ai) return res.status(503).json({ error: "no ai provider configured -- add an ai: block to sources.yaml" });
  const body = req.body ?? {};
  const metrics = Array.isArray(body.metrics) ? body.metrics : [];
  if (!metrics.length) return res.status(400).json({ error: "metrics is required" });
  const principal = principalOf(req)?.id ?? "";
  const source = pick(req).id;
  const text = await explainTile(ai, { source, principal, auth: auth.forwarded(req) }, {
    title: String(body.title ?? metrics.join(", ")),
    metrics, dimensions: Array.isArray(body.dimensions) ? body.dimensions : [],
    where: body.where, compare: body.compare,
    columns: body.columns, rows: body.rows,
  });
  res.json({ text });
}));

/**
 * "Beautify" on a single tile -- critiques presentation (chart choice,
 * breakdown, clutter), a different question from "Explain this" but the
 * same one-shot, read-only shape (see suggestImprovements).
 */
app.post("/api/agent/beautify", safe(async (req, res) => {
  if (!ai) return res.status(503).json({ error: "no ai provider configured -- add an ai: block to sources.yaml" });
  const body = req.body ?? {};
  const metrics = Array.isArray(body.metrics) ? body.metrics : [];
  if (!metrics.length) return res.status(400).json({ error: "metrics is required" });
  const principal = principalOf(req)?.id ?? "";
  const source = pick(req).id;
  const text = await suggestImprovements(ai, { source, principal, auth: auth.forwarded(req) }, {
    title: String(body.title ?? metrics.join(", ")),
    metrics, dimensions: Array.isArray(body.dimensions) ? body.dimensions : [],
    where: body.where, compare: body.compare,
    columns: body.columns, rows: body.rows,
  });
  res.json({ text });
}));

/**
 * Dashboard-level Beautify -- suggests a title and a top-to-bottom reading
 * order for the WHOLE dashboard, not one tile. Structured JSON (see
 * suggestDashboardStory) rather than a paragraph, because the client
 * applies this directly (new title, reordered tiles) instead of just
 * displaying it.
 */
app.post("/api/agent/dashboard-story", safe(async (req, res) => {
  if (!ai) return res.status(503).json({ error: "no ai provider configured -- add an ai: block to sources.yaml" });
  const body = req.body ?? {};
  const tiles: DashboardTileSummary[] = Array.isArray(body.tiles) ? body.tiles.map((t: any) => ({
    id: String(t.id ?? ""), title: String(t.title ?? ""), kind: String(t.kind ?? ""),
    metrics: Array.isArray(t.metrics) ? t.metrics : [],
    dimensions: Array.isArray(t.dimensions) ? t.dimensions : [],
    text: typeof t.text === "string" ? t.text.slice(0, 100000) : undefined,
    layout: t.layout, section: t.section, pinned: t.pinned,
  })).filter((t: DashboardTileSummary) => t.id) : [];
  if (!tiles.length) return res.status(400).json({ error: "tiles is required" });
  const principal = principalOf(req)?.id ?? "";
  const source = pick(req).id;
  // The full governed catalog, built server-side from the connected model
  // rather than trusted from the client -- what "additions" is allowed to
  // propose is exactly what this model actually has, the same governance
  // every other agent-facing surface in this app already enforces.
  const catalog = Object.values(reviewedModel(modelOf(req)).metrics).map((m) => ({
    name: m.name, label: m.label, description: m.description, baseTable: m.baseTable,
  }));
  const result = await suggestDashboardStory(ai, { source, principal, auth: auth.forwarded(req) }, tiles, catalog);
  res.json(result);
}));

app.get("/api/profile", safe(async (req, res) => {
  const base = String(req.query.base ?? "");
  const fields = String(req.query.fields ?? "").split(",").filter(Boolean);
  const out: any[] = [];
  for (const field of fields) {
    const [t, c] = field.includes(".") ? field.split(".", 2) : [base, field];
    const col = modelOf(req).tables[t]?.columns.find((x) => x.name === c);
    if (!col) continue;
    const relation = scopedField(modelOf(req), connOf(req), base || t, field, rls, principalOf(req));
    let cardinality: number | null = null;
    let sample: string[] = [];
    try {
      const r = await connOf(req).execute(
        `SELECT count(DISTINCT value) FROM ${relation}`, 1);
      cardinality = Number(r.rows[0]?.[0] ?? 0);
      const sv = await connOf(req).execute(
        `SELECT DISTINCT value FROM ${relation} WHERE value IS NOT NULL LIMIT 40`, 40);
      sample = sv.rows.map((row) => String(row[0]));
    } catch { /* profiling is advisory; a failure just means fewer hints */ }

    const temporal = /date|timestamp/i.test(col.type);
    const numeric = /^(double|float|decimal|numeric|int|bigint|smallint|real)/i.test(col.type);
    // Geographic if the NAME says so and the VALUES agree. Name alone is not
    // enough -- "region" is as often a sales territory as a place.
    const looksIso = sample.length > 0 &&
      sample.filter((v) => ISO2.has(v.toUpperCase())).length / sample.length > 0.7;
    const geo = looksIso || (GEO_NAME.test(c) && !numeric && !temporal &&
      cardinality != null && cardinality > 1 && cardinality < 400);

    out.push({
      field, type: col.type, cardinality, sample: sample.slice(0, 8),
      role: temporal ? "temporal" : geo ? "geo" : numeric ? "numeric" : "categorical",
      isoLike: looksIso,
    });
  }
  res.json({ fields: out });
}));

app.get("/api/values", safe(async (req, res) => {
  const field = String(req.query.field ?? "");
  const base = String(req.query.base ?? "");
  const [t, c] = field.includes(".") ? field.split(".", 2) : [base, field];
  const table = modelOf(req).tables[t];
  if (!table || !table.columns.some((x) => x.name === c))
    return res.status(400).json({ error: `unknown field ${field}` });
  try {
    const relation = scopedField(modelOf(req), connOf(req), base || t, field, rls, principalOf(req));
    const sql = `SELECT value, count(*) AS n FROM ${relation} ` +
                `GROUP BY 1 ORDER BY n DESC LIMIT 500`;
    const r = await connOf(req).execute(sql, 500);
    res.json({ values: r.rows.map((row) => ({ value: row[0], n: row[1] })), ms: r.ms });
  } catch (e: any) {
    res.status(e instanceof z.ZodError ? 400 : e.status ?? 500).json({ error: e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : String(e?.message ?? e) });
  }
}));

/** Min/max for a numeric field, to seed a range filter. */
app.get("/api/extent", safe(async (req, res) => {
  const field = String(req.query.field ?? "");
  const base = String(req.query.base ?? "");
  const [t, c] = field.includes(".") ? field.split(".", 2) : [base, field];
  const table = modelOf(req).tables[t];
  if (!table || !table.columns.some((x) => x.name === c))
    return res.status(400).json({ error: `unknown field ${field}` });
  try {
    const relation = scopedField(modelOf(req), connOf(req), base || t, field, rls, principalOf(req));
    const r = await connOf(req).execute(
      `SELECT min(value), max(value) FROM ${relation}`, 1);
    res.json({ min: r.rows[0]?.[0] ?? null, max: r.rows[0]?.[1] ?? null });
  } catch (e: any) {
    res.status(e instanceof z.ZodError ? 400 : e.status ?? 500).json({ error: e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : String(e?.message ?? e) });
  }
}));

app.post("/api/suggest", safe((req, res) =>
  res.json(suggestDashboard(modelOf(req), { width: 1440, ...(req.body ?? {}) }))));

/** Who is asking. A header stands in for a session in the PoC. */
function principalOf(req: any) {
  const id = auth.config.mode !== "local" ? identityOf(req)?.principal ?? "" : String(req.header("x-sc-principal") ?? "");
  return rls.principals[id] ?? null;
}

const chartActivity = mountChartActivity(app, { safe, auth, source: pick, sources: () => sources, principal: principalOf, rls: () => rls });

app.get("/api/principals", safe((req, res) =>
  res.json({
    mode: auth.config.mode,
    principals: Object.values(rls.principals).filter(p => auth.config.mode === "local" || p.id === identityOf(req)?.principal).map((p) => ({ id: p.id, name: p.name })),
    policies: rls.policies.map((p) => ({ id: p.id, field: `${p.table}.${p.column}`, claim: p.claim })),
  })));

app.post("/api/query", safe(async (req, res) => {
  const query = querySchema.parse(req.body);
  const tile = { ...query, id: query.id ?? "query", layout: { x: 0, y: 0, w: 1, h: 1 } };
  // The full model with the caller's role: a viewer asking for an unreviewed table gets told why, not "unknown metric".
  const model = pick(req).model!, role = roleOf(req);
  const issues = validateTile(model, tile, { role });
  if (issues.length) return res.status(400).json({ issues });
  try {
    const base = model.metrics[tile.metrics[0]].baseTable;
    const who = principalOf(req);
    // RLS is applied here, server-side, on top of whatever the client sent. A
    // client that strips its filters still gets a scoped query.
    const scope = requireScope(model, base, rls, who);
    const scoped = { ...tile, where: [...(tile.where ?? []), ...scope.filters] };
    const sql = compileTile(model, connOf(req), scoped, { probe: true, role });
    const out = await connOf(req).execute(sql, resultLimit(tile) + 1, `${who?.id ?? "anon"}:${req.header("x-sc-refresh") ?? ""}`);
    // A coarsened time dimension's first/last bucket, if it doesn't span a
    // full period, comes back flagged rather than silently dropped -- split
    // out here, right at the query's only consumer, so no caller of
    // compileTile() has to know these two columns exist at all.
    const { columns, rows, partial } = splitPartialPeriods(out);
    res.json({ ...finishResult({ ...out, columns, rows }, tile),
      partial,
      coverage: tile.dimensions.some((d) => d.includes(":")) ? "unknown" : undefined,
      principal: who?.id ?? null,
      rlsApplied: scope.filters.map((f) => f.id),
      rlsUnenforceable: scope.unenforceable.map((p) => p.id) });
  } catch (e: any) {
    res.status(e instanceof z.ZodError ? 400 : e.status ?? 500).json({ error: e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : String(e?.message ?? e) });
  }
}));

if (process.env.SC_SERVE_UI === "true") {
  const dist = resolve("dist");
  app.use(express.static(dist, { index: false, maxAge: "1h" }));
  app.get("*", (req, res) => req.path.startsWith("/api/") ? res.status(404).json({ error: "Unknown endpoint" }) : res.sendFile(resolve(dist, "index.html")));
}
const host = process.env.SC_HOST ?? (auth.config.mode !== "local" ? "0.0.0.0" : "127.0.0.1");
boot().then(() => {
  const server = app.listen(PORT, host);
  chartActivity.start();
  const stop = () => { ready = false; telemetry.log("server.stopping"); server.close(async () => { await chartActivity.stop(); await Promise.allSettled(sources.map(s => s.conn?.close())); await closeStore(); await telemetry.close(); process.exit(0); }); setTimeout(() => process.exit(1), 15000).unref(); };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
}).catch(async e => { telemetry.log("server.start_failed", { errorType: e?.name ?? "Error" }, "error"); process.stderr.write(`Semantic Canvas could not start: ${String(e?.message ?? "Invalid configuration")}\n`); await telemetry.close(); process.exit(1); });
