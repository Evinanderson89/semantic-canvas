import express from "express";
// Load .env before anything reads process.env, so a source that needs
// SNOWFLAKE_* (or any other) credentials picks them up with no shell setup.
// A missing .env is fine -- most contributors run the bundled duckdb source,
// which needs none.
if (typeof process.loadEnvFile === "function") {
  try { process.loadEnvFile(); } catch { /* no .env file present */ }
}
import { compileTile, splitPartialPeriods, validateTile } from "./compiler/compile.ts";
import { suggestDashboard } from "./suggest/suggest.ts";
import type { Connector } from "./connectors/types.ts";
import type { Model } from "./semantic/model.ts";
import { existsSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import YAML from "yaml";
import { describe as describeSource, connectOne, expand, loadSources, type AiConfig, type Source } from "./sources/registry.ts";
import { deleteDashboard, listDashboards, loadDashboard, openStore, saveDashboard } from "./store/store.ts";
import { loadRls, scopeFor, type RlsConfig } from "./security/rls.ts";
import { applyBestLayout } from "./canvas/layouts.ts";
import { DEFAULT_CANVAS } from "./canvas/presets.ts";
import { chat as agentChat, explainTile, suggestImprovements, suggestDashboardStory,
         type ChatMessage, type DashboardTileSummary } from "./agent/loop.ts";
import Anthropic from "@anthropic-ai/sdk";

const SOURCES_PATH = process.env.SOURCES_PATH ?? "./sources.yaml";
const ENV_PATH = ".env"; // matches the bare process.loadEnvFile() call above
const PORT = Number(process.env.PORT || 5174);

let sources: Source[] = [];
let defaultPrincipal: string | null = null;
let rls: RlsConfig = { policies: [], principals: {} };
let ai: AiConfig | null = null;

/** Resolve the source for a request; falls back to the first ready one. */
function pick(req: any): Source {
  const want = String(req.header?.("x-sc-source") ?? req.query?.source ?? "");
  const found = sources.find((s) => s.id === want && s.status === "ready");
  const ready = found ?? sources.find((s) => s.status === "ready");
  if (!ready) throw new Error("no data source is available");
  return ready;
}
const modelOf = (req: any): Model => pick(req).model!;
const connOf = (req: any): Connector => pick(req).conn!;

async function boot() {
  const loaded = await loadSources(SOURCES_PATH);
  sources = loaded.sources;
  defaultPrincipal = loaded.defaultPrincipal;
  ai = loaded.ai;
  rls = await loadRls(process.env.RLS_PATH ?? "./security/policies.yaml");

  for (const s of sources) {
    console.log(s.status === "ready"
      ? `source ${s.id.padEnd(18)} ready   ${s.adapter}/${s.conn!.id}  ` +
        `${Object.keys(s.model!.tables).length} tables, ` +
        `${Object.keys(s.model!.metrics).length} metrics  (${s.connectMs}ms)`
      : `source ${s.id.padEnd(18)} FAILED  ${s.error}`);
  }
  if (!sources.some((s) => s.status === "ready"))
    throw new Error(`no usable source in ${SOURCES_PATH}`);

  const storeFile = await openStore();
  console.log(`store  ${storeFile}`);
  console.log(`rls    ${rls.policies.length} policies, ` +
              `${Object.keys(rls.principals).length} principals`);
  console.log(ai?.apiKey
    ? `ai     ${ai.provider}/${ai.model} configured`
    : `ai     not configured (set ANTHROPIC_API_KEY in .env to enable the in-app agent)`);
}

const app = express();
app.use(express.json({ limit: "1mb" }));

/**
 * Express 4 does not catch a rejected promise from an async handler -- it
 * just hangs the request. Worse, Node's default since v15 is to terminate
 * the whole process on an unhandled rejection, which is exactly what an
 * async handler calling pick() (throws when no source is ready) does. Wrap
 * every handler so "no source available" -- from a bad config, a source
 * going down, or (before the fix above) a corrupted sources.yaml -- degrades
 * to one failed request instead of taking the entire server down.
 */
const safe = (fn: (req: any, res: any) => any) => async (req: any, res: any) => {
  try { await fn(req, res); }
  catch (e: any) { res.status(500).json({ error: String(e?.message ?? e) }); }
};

app.get("/api/sources", safe((_req, res) => res.json({
  sources: sources.map(describeSource),
  active: sources.find((x) => x.status === "ready")?.id ?? null,
  defaultPrincipal,
})));

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
    process.env[name] = value;
  }
  let text = lines.join("\n");
  if (added.length) text = `${text.replace(/\n+$/, "")}\n\n# ${label} (via Connections)\n${added.join("\n")}\n`;
  await writeFile(ENV_PATH, text);
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

async function hotReload() {
  const loaded = await loadSources(SOURCES_PATH);
  sources = loaded.sources;
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
  const rawConnector = built.connector;

  // DuckDB's pool opens lazily (an in-memory instance; lakeRoot is only ever
  // touched by the read_parquet() a real query issues), so "it connected"
  // proves nothing about lakeRoot -- check the directory ourselves.
  if (connectorType === "duckdb") {
    const dir = expand(rawConnector.lakeRoot);
    if (!existsSync(dir) || !statSync(dir).isDirectory())
      return res.status(422).json({ error: `lakeRoot does not exist or is not a directory: ${dir}` });
  }

  const trial = await connectOne({ id, label, adapter, model, connector: rawConnector });
  if (trial.status === "error") return res.status(422).json({ error: trial.error });
  await trial.conn?.close?.().catch(() => {}); // the reload below opens its own pool

  try {
    const connectorLines = await renderConnectorLines(id, label, connectorType, rawConnector);
    const yamlBlock = [
      `  - id: ${id}`, `    label: ${yamlScalar(label)}`, `    adapter: ${adapter}`,
      `    model: ${yamlScalar(model)}`, `    connector:`, ...connectorLines, "",
    ].join("\n");
    const current = (await readFile(SOURCES_PATH, "utf8").catch(() => "")) || "";
    await writeFile(SOURCES_PATH, current.replace(/\n*$/, "") + "\n\n" + yamlBlock + "\n");
  } catch (e: any) {
    return res.status(500).json({ error: `connected, but failed to save: ${e?.message ?? e}` });
  }

  res.json(await hotReload());
}));

/** Non-secret fields only, for the edit form to pre-fill -- privateKey,
 *  privateKeyPass and password never leave the server. */
app.get("/api/sources/:id/config", safe(async (req, res) => {
  const existing = await readExistingBlock(req.params.id);
  if ("error" in existing) return res.status(404).json({ error: existing.error });
  const c = existing.parsed.connector ?? {};
  const SAFE_FIELDS = ["type", "lakeRoot", "poolSize", "account", "username", "role", "warehouse", "database", "schema"];
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

  if (connectorType === "duckdb") {
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
    await writeFile(SOURCES_PATH, block.lines.join("\n"));
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
  try { await writeFile(SOURCES_PATH, block.lines.join("\n")); }
  catch (e: any) { return res.status(500).json({ error: String(e?.message ?? e) }); }

  res.json(await hotReload());
}));

app.get("/api/model", safe((req, res) => res.json(modelOf(req))));
/** Schema introspection, for "the warehouse schema is fully readable". */
app.get("/api/schema", safe(async (req, res) => {
  const src = pick(req);
  const c: any = src.conn;
  if (typeof c.schema !== "function")
    return res.json({
      tables: Object.values(src.model!.tables).map((t) => ({
        name: t.name, columns: t.columns.map((x) => ({ name: x.name, type: x.type })) })),
      source: `${src.label} (from the semantic model)`,
    });
  try { res.json({ tables: await c.schema(), source: c.label }); }
  catch (e: any) { res.status(500).json({ error: String(e?.message ?? e) }); }
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

app.get("/api/dashboards", safe(async (req, res) =>
  res.json({ dashboards: await listDashboards(modelOf(req).name) })));

app.post("/api/dashboards", safe(async (req, res) => {
  const { id, name, spec, canvas } = req.body ?? {};
  if (!id || !spec) return res.status(400).json({ error: "id and spec are required" });
  // A real default, not {} -- a dashboard saved with no canvas (e.g. an
  // agent via MCP that didn't bother) still needs preset/snap/grid/locked
  // set to something sane for whenever a human opens it in the browser.
  res.json(await saveDashboard({
    id, name: name || "Untitled", model: modelOf(req).name, spec,
    canvas: canvas ?? DEFAULT_CANVAS,
  }));
}));

app.get("/api/dashboards/:id", safe(async (req, res) => {
  const d = await loadDashboard(req.params.id);
  return d ? res.json(d) : res.status(404).json({ error: "not found" });
}));

app.delete("/api/dashboards/:id", safe(async (req, res) =>
  res.json(await deleteDashboard(req.params.id))));

/**
 * Picks the best-fitting named layout (layouts.ts) for a saved dashboard's
 * current tile set and re-packs into it, growing the canvas if needed --
 * the same function the "Smart arrange" button calls, exposed so an agent
 * (via the MCP server in src/mcp/) can invoke it without a human clicking.
 */
app.post("/api/dashboards/:id/arrange", safe(async (req, res) => {
  const d = await loadDashboard(req.params.id);
  if (!d) return res.status(404).json({ error: "not found" });
  const canvas = d.canvas ?? { width: 1440, height: 900 };
  const { name: layout, tiles } = applyBestLayout(d.spec?.tiles ?? [], canvas.width ?? 1440);
  const bottom = tiles.length
    ? Math.max(...tiles.map((t: any) => t.layout.y + t.layout.h)) + 24 : (canvas.height ?? 900);
  const newCanvas = { ...canvas, height: Math.max(canvas.height ?? 900, Math.round(bottom)) };
  const spec = { ...d.spec, tiles };
  await saveDashboard({ id: req.params.id, name: d.name, model: modelOf(req).name, spec, canvas: newCanvas });
  res.json({ layout, spec, canvas: newCanvas });
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
  id: string; question: string; options?: string[]; answer: string | null; createdAt: number;
}
const agentQuestions = new Map<string, PendingQuestion>();
const nextQuestionId = () => `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
function pruneAnsweredQuestions() {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [id, q] of agentQuestions) if (q.answer !== null && q.createdAt < cutoff) agentQuestions.delete(id);
}

app.post("/api/agent/questions", safe(async (req, res) => {
  pruneAnsweredQuestions();
  const question = String(req.body?.question ?? "").trim();
  if (!question) return res.status(400).json({ error: "question is required" });
  const options = Array.isArray(req.body?.options) ? req.body.options.map(String) : undefined;
  const id = nextQuestionId();
  agentQuestions.set(id, { id, question, options, answer: null, createdAt: Date.now() });
  res.json({ id });
}));

/** The browser polls this for whatever's still waiting on a human. */
app.get("/api/agent/questions", safe(async (_req, res) => {
  res.json({
    questions: [...agentQuestions.values()].filter((q) => q.answer === null)
      .map((q) => ({ id: q.id, question: q.question, options: q.options })),
  });
}));

app.post("/api/agent/questions/:id/answer", safe(async (req, res) => {
  const q = agentQuestions.get(req.params.id);
  if (!q) return res.status(404).json({ error: "no such question (it may have already been answered elsewhere)" });
  const answer = String(req.body?.answer ?? "").trim();
  if (!answer) return res.status(400).json({ error: "answer is required" });
  q.answer = answer;
  res.json({ ok: true });
}));

/** The MCP server polls this until a human answers (or its own timeout gives up). */
app.get("/api/agent/questions/:id", safe(async (req, res) => {
  const q = agentQuestions.get(req.params.id);
  if (!q) return res.status(404).json({ error: "no such question" });
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

app.get("/api/agent/status", safe((_req, res) => res.json({
  configured: Boolean(ai?.apiKey), provider: ai?.provider ?? "anthropic", model: ai?.model ?? "claude-opus-5",
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
  const history = agentConversations.get(conversationId) ?? [];
  const principal = req.header("x-sc-principal") || defaultPrincipal || undefined;
  const source = req.header("x-sc-source") || undefined;
  const { text, messages } = await agentChat(ai, history, message, { source, principal });
  agentConversations.set(conversationId, messages);
  res.json({ text });
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
  const principal = req.header("x-sc-principal") || defaultPrincipal || undefined;
  const source = req.header("x-sc-source") || undefined;
  const text = await explainTile(ai, { source, principal }, {
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
  const principal = req.header("x-sc-principal") || defaultPrincipal || undefined;
  const source = req.header("x-sc-source") || undefined;
  const text = await suggestImprovements(ai, { source, principal }, {
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
  })).filter((t: DashboardTileSummary) => t.id) : [];
  if (!tiles.length) return res.status(400).json({ error: "tiles is required" });
  const principal = req.header("x-sc-principal") || defaultPrincipal || undefined;
  const source = req.header("x-sc-source") || undefined;
  // The full governed catalog, built server-side from the connected model
  // rather than trusted from the client -- what "additions" is allowed to
  // propose is exactly what this model actually has, the same governance
  // every other agent-facing surface in this app already enforces.
  const catalog = Object.values(modelOf(req).metrics).map((m) => ({
    name: m.name, label: m.label, description: m.description, baseTable: m.baseTable,
  }));
  const result = await suggestDashboardStory(ai, { source, principal }, tiles, catalog);
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
    const q = connOf(req).quote.bind(connOf(req));
    let cardinality: number | null = null;
    let sample: string[] = [];
    try {
      const r = await connOf(req).execute(
        `SELECT count(DISTINCT ${q(c)}) FROM ${connOf(req).relation(t)}`, 1);
      cardinality = Number(r.rows[0]?.[0] ?? 0);
      const sv = await connOf(req).execute(
        `SELECT DISTINCT ${q(c)} FROM ${connOf(req).relation(t)} WHERE ${q(c)} IS NOT NULL LIMIT 40`, 40);
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
    const q = connOf(req).quote.bind(connOf(req));
    const sql = `SELECT ${q(c)} AS value, count(*) AS n FROM ${connOf(req).relation(t)} ` +
                `GROUP BY 1 ORDER BY n DESC LIMIT 500`;
    const r = await connOf(req).execute(sql, 500);
    res.json({ values: r.rows.map((row) => ({ value: row[0], n: row[1] })), ms: r.ms });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
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
    const q = connOf(req).quote.bind(connOf(req));
    const r = await connOf(req).execute(
      `SELECT min(${q(c)}), max(${q(c)}) FROM ${connOf(req).relation(t)}`, 1);
    res.json({ min: r.rows[0]?.[0] ?? null, max: r.rows[0]?.[1] ?? null });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
}));

app.post("/api/suggest", safe((req, res) =>
  res.json(suggestDashboard(modelOf(req), { width: 1440, ...(req.body ?? {}) }))));

/** Who is asking. A header stands in for a session in the PoC. */
function principalOf(req: any) {
  const id = String(req.header("x-sc-principal") ?? "");
  return rls.principals[id] ?? null;
}

app.get("/api/principals", safe((_req, res) =>
  res.json({
    principals: Object.values(rls.principals).map((p) => ({ id: p.id, name: p.name })),
    policies: rls.policies.map((p) => ({ id: p.id, field: `${p.table}.${p.column}`, claim: p.claim })),
  })));

app.post("/api/query", safe(async (req, res) => {
  const tile = req.body;
  const issues = validateTile(modelOf(req), tile);
  if (issues.length) return res.status(400).json({ issues });
  try {
    const base = modelOf(req).metrics[tile.metrics[0]].baseTable;
    const who = principalOf(req);
    // RLS is applied here, server-side, on top of whatever the client sent. A
    // client that strips its filters still gets a scoped query.
    const scope = rls.policies.length ? scopeFor(modelOf(req), base, rls, who)
                                      : { filters: [], unenforceable: [] };
    const scoped = { ...tile, where: [...(tile.where ?? []), ...scope.filters] };
    const sql = compileTile(modelOf(req), connOf(req), scoped);
    const out = await connOf(req).execute(sql, tile.limit ?? 5000, who?.id ?? 'anon');
    // A coarsened time dimension's first/last bucket, if it doesn't span a
    // full period, comes back flagged rather than silently dropped -- split
    // out here, right at the query's only consumer, so no caller of
    // compileTile() has to know these two columns exist at all.
    const { columns, rows, partial } = splitPartialPeriods(out);
    res.json({ ...out, columns, rows,
      partial,
      principal: who?.id ?? null,
      rlsApplied: scope.filters.map((f) => f.id),
      rlsUnenforceable: scope.unenforceable.map((p) => p.id) });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message ?? e) });
  }
}));

boot().then(() => app.listen(PORT, () => console.log(`api on http://localhost:${PORT}`)))
  .catch((e) => { console.error(e); process.exit(1); });
