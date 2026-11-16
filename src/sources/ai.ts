import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";

export interface AiConfig { provider: string; model: string; apiKey: string }
export const managedAiKey = (apiKey: string) => ({ ANTHROPIC_API_KEY: apiKey, SC_AI_KEY_MANAGED: "true" });

/** Connections owns its saved key, including an explicit removal. Read it from
 * the credential file so an older inherited shell value cannot resurrect it.
 * Until Connections writes that marker, operator-authored YAML/env retains its
 * existing precedence. Model/provider selection always remains in YAML. */
export async function readAiConfig(config: { provider?: unknown; model?: unknown; apiKey?: unknown } | null | undefined,
  envPath = process.env.SC_ENV_PATH ?? ".env", environment: NodeJS.ProcessEnv = process.env): Promise<AiConfig | null> {
  let saved: ReturnType<typeof parseEnv> = {};
  try { saved = parseEnv(await readFile(envPath, "utf8")); }
  catch (error: any) { if (error.code !== "ENOENT") throw error; }
  const managed = saved.SC_AI_KEY_MANAGED === "true";
  if (!config && !managed && !environment.ANTHROPIC_API_KEY) return null;
  const provider = String(config?.provider ?? "anthropic");
  const configuredKey = String(config?.apiKey ?? (provider === "anthropic" ? "${ANTHROPIC_API_KEY}" : ""));
  const apiKey = provider === "anthropic" && managed ? saved.ANTHROPIC_API_KEY ?? ""
    : configuredKey.replace(/\$\{(\w+)\}/g, (_, name) => environment[name] ?? "");
  return { provider, model: String(config?.model ?? "claude-opus-5"), apiKey };
}
