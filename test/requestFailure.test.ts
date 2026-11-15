import Anthropic from "@anthropic-ai/sdk";
import { expect, it } from "vitest";
import { providerFailureDiagnostic, requestFailure } from "../src/operations/requestFailure.ts";
import { logRecord } from "../src/operations/telemetry.ts";

for (const status of [401, 403, 429, 500]) it(`does not confuse provider ${status} with a Canvas authentication or authorization failure`, () => {
  const response = requestFailure(new Anthropic.APIError(status, { error: { message: "upstream payload must not be echoed" } }, "private upstream details", new Headers()));
  expect(response.status).toBe(502);
  expect(response.error).toContain("AI provider");
  expect(response.error).not.toMatch(/private|payload|details/);
});
it("preserves genuine application authentication and access failures", () => {
  expect(requestFailure(Object.assign(new Error("Sign in"), { status: 401 }))).toEqual({ status: 401, error: "Sign in" });
  expect(requestFailure(Object.assign(new Error("No access"), { status: 403 }))).toEqual({ status: 403, error: "No access" });
});

for (const [status, message, category] of [
  [400, "Schema is too complex for compilation: private dashboard content", "tool-schema"],
  [400, "Invalid field: private dashboard content", "invalid-request"],
  [401, "Private authentication details", "authentication"],
  [413, "Private request payload", "request-size"],
  [429, "Private account limits", "busy"],
  [500, "Private upstream details", "upstream"],
] as const) it(`records only safe metadata for provider ${status} ${category}`, () => {
  const error = new Anthropic.APIError(status, { error: { message } }, message, new Headers({ "x-private-header": "secret" }));
  expect(providerFailureDiagnostic(error)).toEqual({ providerStatus: status, providerCategory: category });
  expect(logRecord("request.failed", { ...providerFailureDiagnostic(error), body: message, headers: { secret: true } }))
    .toMatchObject({ providerStatus: status, providerCategory: category });
  expect(JSON.stringify(logRecord("request.failed", { ...providerFailureDiagnostic(error), body: message }))).not.toMatch(/private|secret/i);
  expect(JSON.stringify({ diagnostic: providerFailureDiagnostic(error), response: requestFailure(error) })).not.toMatch(/private|secret/i);
  if (status === 400) expect(requestFailure(error).error).not.toContain("Check the AI connection");
});

it("does not label application validation as a provider failure", () => {
  expect(providerFailureDiagnostic(new Error("Invalid chart"))).toBeUndefined();
  expect(providerFailureDiagnostic(new Anthropic.APIConnectionError({ message: "private network details" })))
    .toEqual({ providerStatus: null, providerCategory: "connection" });
});
