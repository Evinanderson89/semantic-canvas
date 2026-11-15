import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

/** Only allowlisted metadata leaves the provider boundary. Provider messages
 * can contain request text; never log or echo the raw body, headers or key. */
export function providerFailureDiagnostic(error: unknown) {
  if (!(error instanceof Anthropic.APIError)) return undefined;
  const status = error.status;
  const category = status === 401 || status === 403 ? "authentication"
    : status === 429 || status === 529 ? "busy"
    : status === 400 && /schema|strict|additionalproperties|anyof/i.test(error.message) ? "tool-schema"
    : status === 400 ? "invalid-request"
    : status === 413 ? "request-size"
    : status === undefined ? "connection"
    : "upstream";
  return { providerStatus: status ?? null, providerCategory: category };
}

/** Provider authentication is an upstream failure, never a Canvas session-expiry response. */
export function requestFailure(error: unknown): { status: number; error: string } {
  const provider = providerFailureDiagnostic(error);
  if (provider) {
    const message = provider.providerCategory === "authentication"
      ? "The AI provider could not authenticate. Update the AI connection in Connections and retry."
      : provider.providerCategory === "busy"
        ? "The AI provider is temporarily busy. Wait a moment and retry."
        : provider.providerCategory === "tool-schema"
          ? "The AI provider rejected the tool schema. Your dashboard is unchanged."
        : provider.providerCategory === "invalid-request"
          ? "The AI provider rejected this request. Your dashboard is unchanged."
        : provider.providerCategory === "request-size"
          ? "The AI request was too large for the provider. Your dashboard is unchanged."
        : "The AI provider could not complete this request. Check the AI connection in Connections and retry.";
    return { status: 502, error: message };
  }
  if (error instanceof z.ZodError) return { status: 400, error: error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ") };
  const value = error as { status?: number; message?: string } | null;
  return { status: value?.status ?? 500, error: String(value?.message ?? error) };
}
