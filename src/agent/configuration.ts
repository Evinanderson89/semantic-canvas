import { isSupportedAiProvider, SUPPORTED_AI_PROVIDERS, type AiConfig } from "../sources/ai.ts";

export function aiProviderIssue(config: AiConfig | null | undefined): string | null {
  if (config && !isSupportedAiProvider(config.provider)) {
    return `Unsupported AI provider: ${config.provider}. Supported providers are Anthropic, OpenAI, Gemini, and OpenAI-compatible (${SUPPORTED_AI_PROVIDERS.join(", ")}). Update ai.provider in the server configuration.`;
  }
  if (config && !config.model.trim()) {
    return "The AI model is not configured. Set ai.model in the server configuration to an available Anthropic, OpenAI, or Gemini model.";
  }
  if (config?.provider === "openai-compatible" && !config.baseUrl?.trim()) {
    return "The OpenAI-compatible baseUrl is not configured. Set ai.baseUrl in the server configuration or Connections.";
  }
  return null;
}

export function aiConfigurationIssue(config: AiConfig | null | undefined): string | null {
  return aiProviderIssue(config) ?? (!config?.apiKey.trim()
    ? "The AI agent is not set up on this Canvas. An administrator can add an API key under Connections, or set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY."
    : null);
}

/** Check at the HTTP boundary and before constructing any SDK client. A direct
 * function caller must never fall through to the SDK's environment defaults. */
export function requireAiConfiguration(config: AiConfig | null | undefined): asserts config is AiConfig {
  const issue = aiConfigurationIssue(config);
  if (issue) throw Object.assign(new Error(issue), { status: 503 });
}
