import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";

export const SUPPORTED_AI_PROVIDERS = ["anthropic", "openai", "gemini", "openai-compatible"] as const;
export type SupportedAiProvider = (typeof SUPPORTED_AI_PROVIDERS)[number];

export interface AiConfig {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
}

export const DEFAULT_AI_MODELS: Record<SupportedAiProvider, string> = {
  anthropic: "claude-opus-5",
  openai: "gpt-5.4",
  gemini: "gemini-2.5-pro",
  "openai-compatible": "gpt-4o",
};

export const AI_PROVIDER_ENV_KEY: Record<SupportedAiProvider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  "openai-compatible": "OPENAI_COMPATIBLE_API_KEY",
};

export function isSupportedAiProvider(provider: string): provider is SupportedAiProvider {
  return (SUPPORTED_AI_PROVIDERS as readonly string[]).includes(provider);
}

export function envKeyForProvider(provider: string): string | undefined {
  return isSupportedAiProvider(provider) ? AI_PROVIDER_ENV_KEY[provider] : undefined;
}

export function defaultModelForProvider(provider: string): string {
  return isSupportedAiProvider(provider) ? DEFAULT_AI_MODELS[provider] : "claude-opus-5";
}

export const managedAiKey = (
  apiKey: string,
  options?: { provider?: string; model?: string; baseUrl?: string },
): Record<string, string> => {
  const provider = options?.provider ?? "anthropic";
  const envVar = envKeyForProvider(provider) ?? "ANTHROPIC_API_KEY";
  const out: Record<string, string> = { [envVar]: apiKey, SC_AI_KEY_MANAGED: "true" };
  if (options?.provider) out.SC_AI_PROVIDER = options.provider;
  if (options?.model) out.SC_AI_MODEL = options.model;
  if (options?.baseUrl !== undefined) out.SC_AI_BASE_URL = options.baseUrl;
  return out;
};

/** Connections owns its saved key, including an explicit removal. Read it from
 * the credential file so an older inherited shell value cannot resurrect it.
 * Until Connections writes that marker, operator-authored YAML/env retains its
 * existing precedence. Each provider uses its own credential variable so an
 * Anthropic key is never supplied to another provider. */
export async function readAiConfig(
  config: { provider?: unknown; model?: unknown; apiKey?: unknown; baseUrl?: unknown } | null | undefined,
  envPath = process.env.SC_ENV_PATH ?? ".env",
  environment: NodeJS.ProcessEnv = process.env,
): Promise<AiConfig | null> {
  let saved: ReturnType<typeof parseEnv> = {};
  try { saved = parseEnv(await readFile(envPath, "utf8")); }
  catch (error: any) { if (error.code !== "ENOENT") throw error; }
  const managed = saved.SC_AI_KEY_MANAGED === "true";
  const hasAmbientKey = Boolean(
    environment.ANTHROPIC_API_KEY ||
    environment.OPENAI_API_KEY ||
    environment.GEMINI_API_KEY ||
    environment.OPENAI_COMPATIBLE_API_KEY,
  );
  if (!config && !managed && !hasAmbientKey) return null;

  const inferredProvider = !config?.provider && !saved.SC_AI_PROVIDER
    ? (environment.ANTHROPIC_API_KEY ? "anthropic"
      : environment.OPENAI_API_KEY ? "openai"
      : environment.GEMINI_API_KEY ? "gemini"
      : environment.OPENAI_COMPATIBLE_API_KEY ? "openai-compatible"
      : "anthropic")
    : undefined;
  const provider = String(config?.provider ?? (managed && saved.SC_AI_PROVIDER ? saved.SC_AI_PROVIDER : inferredProvider ?? "anthropic"));
  const envVar = envKeyForProvider(provider);
  const configuredKey = String(config?.apiKey ?? (envVar ? `\${${envVar}}` : ""));
  const apiKey = envVar && managed
    ? (saved[envVar] ?? "")
    : configuredKey.replace(/\$\{(\w+)\}/g, (_, name) => environment[name] ?? "");

  const model = String(
    config?.model ?? (managed && saved.SC_AI_MODEL ? saved.SC_AI_MODEL : defaultModelForProvider(provider)),
  );
  const rawBaseUrl = config?.baseUrl ?? (managed && saved.SC_AI_BASE_URL ? saved.SC_AI_BASE_URL : undefined);
  const baseUrl = rawBaseUrl !== undefined && String(rawBaseUrl).trim() !== ""
    ? String(rawBaseUrl).trim().replace(/\$\{(\w+)\}/g, (_, name) => environment[name] ?? "")
    : undefined;

  return baseUrl ? { provider, model, apiKey, baseUrl } : { provider, model, apiKey };
}
