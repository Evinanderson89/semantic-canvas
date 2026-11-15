import type { AiConfig } from "../sources/ai.ts";

export function aiProviderIssue(config: AiConfig | null | undefined): string | null {
  if (config && config.provider !== "anthropic") return `Unsupported AI provider: ${config.provider}. This Canvas supports Anthropic only. Update ai.provider in the server configuration.`;
  if (config && !config.model.trim()) return "The AI model is not configured. Set ai.model in the server configuration to an available Anthropic model.";
  return null;
}
export function aiConfigurationIssue(config: AiConfig | null | undefined): string | null {
  return aiProviderIssue(config) ?? (!config?.apiKey.trim()
    ? "The AI agent is not set up on this Canvas. An administrator can add an Anthropic key under Connections, or set ANTHROPIC_API_KEY."
    : null);
}
/** Check at the HTTP boundary and before constructing any SDK client. A direct
 * function caller must never fall through to the SDK's environment defaults. */
export function requireAiConfiguration(config: AiConfig | null | undefined): asserts config is AiConfig {
  const issue = aiConfigurationIssue(config);
  if (issue) throw Object.assign(new Error(issue), { status: 503 });
}
