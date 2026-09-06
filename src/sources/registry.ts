import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import YAML from "yaml";
import type { Connector } from "../connectors/types.ts";
import type { Model, SemanticAdapter } from "../semantic/model.ts";
import { duckglueAdapter } from "../semantic/duckglue.ts";
import { dbtAdapter } from "../semantic/dbt.ts";
import { snowflakeSemanticAdapter } from "../semantic/snowflakeSemantic.ts";
import { pooledDuckdb } from "../connectors/pool.ts";
import { snowflakeConnector } from "../connectors/snowflake.ts";

/**
 * The source registry.
 *
 * A source is (semantic adapter x connector). Both are pluggable and
 * independent, which is the point: the compiler, canvas, cache and row-level
 * security never learn which warehouse they are talking to.
 *
 * Sources load independently. A warehouse that refuses a connection is marked
 * unavailable and reported; it does not prevent the others from serving, which
 * is what makes this safe to leave configured.
 */
export interface SourceConfig {
  id: string; label?: string; adapter: string;
  model: string; connector: Record<string, any>;
}
export interface Source {
  id: string; label: string; adapter: string;
  status: "ready" | "error";
  error?: string;
  model?: Model;
  conn?: Connector;
  connectMs?: number;
}

const ADAPTERS: Record<string, SemanticAdapter> = {
  duckglue: duckglueAdapter,
  dbt: dbtAdapter,
  "snowflake-semantic": snowflakeSemanticAdapter,
};

export const expand = (v: string) =>
  v.replace(/^~(?=\/)/, homedir())
   .replace(/\$\{(\w+)\}/g, (_, k) => process.env[k] ?? "");

async function connect(c: Record<string, any>): Promise<Connector> {
  const type = String(c.type ?? "duckdb");
  if (type === "duckdb")
    return pooledDuckdb(expand(String(c.lakeRoot ?? "")), { size: Number(c.poolSize ?? 4) });
  if (type === "snowflake")
    return snowflakeConnector({
      account: expand(String(c.account)), username: expand(String(c.username)),
      privateKey: c.privateKey ? expand(String(c.privateKey)) : undefined,
      privateKeyPass: c.privateKeyPass ? expand(String(c.privateKeyPass)) : undefined,
      password: c.password ? expand(String(c.password)) : undefined,
      role: c.role, warehouse: String(c.warehouse ?? "COMPUTE_WH"),
      database: String(c.database ?? ""), schema: String(c.schema ?? "PUBLIC"),
      poolSize: Number(c.poolSize ?? 6),
    });
  throw new Error(`unknown connector type "${type}"`);
}

/** Connect one source. Shared by boot-time loading and the "test before you
 *  persist" step when someone adds a source from the Connections screen. */
export async function connectOne(s: SourceConfig): Promise<Source> {
  const t0 = performance.now();
  const base: Source = {
    id: s.id, label: s.label ?? s.id, adapter: s.adapter, status: "error",
  };
  try {
    const adapter = ADAPTERS[s.adapter];
    if (!adapter) throw new Error(`unknown adapter "${s.adapter}"`);
    const model = await adapter.load(expand(s.model));
    if (!model) throw new Error(`adapter "${s.adapter}" did not recognise ${s.model}`);
    const conn = await connect(s.connector);
    return { ...base, status: "ready", model, conn,
             connectMs: Math.round(performance.now() - t0) };
  } catch (e: any) {
    return { ...base, error: String(e?.message ?? e),
             connectMs: Math.round(performance.now() - t0) };
  }
}

/** Config for the embedded in-app agent (src/agent/loop.ts) -- a pluggable
 *  port the same way a data source is: provider + model in sources.yaml,
 *  credential resolved from .env via the same ${VAR} expansion. Absent (or
 *  apiKey unset) just means that agent isn't available; nothing else here
 *  depends on it. */
export interface AiConfig { provider: string; model: string; apiKey: string }

export async function loadSources(path: string): Promise<{
  sources: Source[]; defaultPrincipal: string | null; ai: AiConfig | null;
}> {
  let cfg: any = {};
  try {
    cfg = YAML.parse(await readFile(path, "utf8")) ?? {};
  } catch (e: any) {
    // Surfaced now rather than left to the generic "no usable source" below --
    // a first run against a typo'd YAML file should say so, not just fail.
    console.error(`could not read/parse ${path}: ${e?.message ?? e}`);
    cfg = {};
  }
  const list: SourceConfig[] = cfg.sources ?? [];
  const sources = await Promise.all(list.map(connectOne));
  const ai: AiConfig | null = cfg.ai ? {
    provider: String(cfg.ai.provider ?? "anthropic"),
    model: String(cfg.ai.model ?? "claude-opus-5"),
    apiKey: expand(String(cfg.ai.apiKey ?? "")),
  } : null;
  return { sources, defaultPrincipal: cfg.defaultPrincipal ?? null, ai };
}

/** What the UI needs to render a source picker, without leaking credentials. */
export const describe = (s: Source) => ({
  id: s.id, label: s.label, adapter: s.adapter, status: s.status,
  error: s.error, connectMs: s.connectMs,
  connector: s.conn?.id ?? null,
  tables: s.model ? Object.keys(s.model.tables).length : 0,
  metrics: s.model ? Object.keys(s.model.metrics).length : 0,
});
