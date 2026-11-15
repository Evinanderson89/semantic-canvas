import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAiConfig } from "../src/sources/ai.ts";

let root: string, path: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "canvas-ai-config-")); path = join(root, ".env"); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
it("leaves AI absent when neither configuration nor a credential exists", async () => {
  expect(await readAiConfig(undefined, path, {})).toBeNull();
});
it("supports an environment key without requiring an ai block", async () => {
  expect(await readAiConfig(undefined, path, { ANTHROPIC_API_KEY: "synthetic-env" })).toMatchObject({ provider: "anthropic", apiKey: "synthetic-env" });
});
it("preserves explicit YAML keys, custom environment references, empty-key opt out and model choices until Connections takes ownership", async () => {
  const environment = { ANTHROPIC_API_KEY: "synthetic-default", CUSTOM_KEY: "synthetic-custom" };
  expect(await readAiConfig({ apiKey: "synthetic-literal", model: "custom-model" }, path, environment)).toEqual({ provider: "anthropic", model: "custom-model", apiKey: "synthetic-literal" });
  expect((await readAiConfig({ apiKey: "${CUSTOM_KEY}" }, path, environment))?.apiKey).toBe("synthetic-custom");
  expect((await readAiConfig({ apiKey: "" }, path, environment))?.apiKey).toBe("");
  expect((await readAiConfig({ model: "custom-model" }, path, environment))?.apiKey).toBe("synthetic-default");
});
it("uses the Connections credential file over stale process and YAML values while retaining the selected model", async () => {
  await writeFile(path, 'SC_AI_KEY_MANAGED="true"\nANTHROPIC_API_KEY="synthetic-saved"\n');
  expect(await readAiConfig({ apiKey: "synthetic-yaml", model: "custom-model" }, path, { ANTHROPIC_API_KEY: "synthetic-shell" }))
    .toEqual({ provider: "anthropic", model: "custom-model", apiKey: "synthetic-saved" });
});
it.each(["", 'ANTHROPIC_API_KEY=""\n'])("does not resurrect an older key after a managed removal: %s", async declaration => {
  await writeFile(path, `SC_AI_KEY_MANAGED=true\n${declaration}`);
  expect((await readAiConfig({ apiKey: "synthetic-old" }, path, { ANTHROPIC_API_KEY: "synthetic-shell" }))?.apiKey).toBe("");
});
it("allows an operator to explicitly restore configuration ownership", async () => {
  await writeFile(path, "SC_AI_KEY_MANAGED=false\nANTHROPIC_API_KEY=synthetic-file\n");
  expect((await readAiConfig({ apiKey: "${CUSTOM_KEY}" }, path, { CUSTOM_KEY: "synthetic-operator" }))?.apiKey).toBe("synthetic-operator");
});
it("never supplies an Anthropic credential to a different provider", async () => {
  await writeFile(path, "SC_AI_KEY_MANAGED=true\nANTHROPIC_API_KEY=synthetic-saved\n");
  expect((await readAiConfig({ provider: "other", model: "custom-model" }, path, { ANTHROPIC_API_KEY: "synthetic-shell" }))?.apiKey).toBe("");
});
it("does not silently fall back to an old credential when the managed file cannot be read", async () => {
  await expect(readAiConfig({ apiKey: "synthetic-old" }, root, {})).rejects.toThrow();
});
