import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { resolve } from "node:path";
import YAML from "yaml";
import { duckglueAdapter } from "../src/semantic/duckglue.ts";
import { duckdbConnector } from "../src/connectors/duckdb.ts";
import { redesignCases, requestFor, queryEvidence, assessResponse, digest, requiredReviews } from "../evaluation/redesign.ts";

// No environment-file loading, HTTP client or provider SDK. Preparing and
// assessing evidence never calls an AI provider or writes dashboard storage.
const [command, ...args] = process.argv.slice(2);
if (!(command === "prepare" && args.length === 1 || command === "assess" && args.length === 3)) {
  throw new Error("Usage: tsx scripts/evaluate-redesign.ts prepare <new-output-directory> OR assess <case-id> <response.json> <new-output-directory>");
}
const modelPath = resolve("sample-data/warehouse.yaml"), lakePath = resolve("sample-data/lake");
const model = await duckglueAdapter.load(modelPath);
if (!model || model.name !== "sample_warehouse") throw new Error("This evaluation only uses the bundled Sample Warehouse");
const connector = await duckdbConnector(lakePath);
try {
  const output = resolve(command === "prepare" ? args[0] : args[2]);
  await mkdir(output); // Fail if it exists: keep earlier runs and raw responses intact.
  const write = (name: string, value: unknown) => writeFile(resolve(output, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
  await write("model.json", model);
  if (command === "prepare") {
    for (const testCase of redesignCases) {
      const initial = await queryEvidence(model, connector, testCase.spec);
      const references = await queryEvidence(model, connector, { title: "Reference queries only", tiles: testCase.references });
      if ([...initial, ...references].some(e => "error" in e)) throw new Error(`Sample queries failed for ${testCase.id}`);
      await write(`${testCase.id}.request.json`, requestFor(testCase));
      await write(`${testCase.id}.baseline.json`, { initial, references });
    }
    await write("manifest.json", { preparedAt: new Date().toISOString(), status: "awaiting-provider-evaluation",
      modelHash: digest(model), data: "Bundled synthetic Sample Warehouse only; no personal sources or saved dashboards",
      cases: redesignCases.map(c => ({ id: c.id, goal: c.goal, criteria: c.criteria, request: `${c.id}.request.json`, baseline: `${c.id}.baseline.json` })), requiredReviews,
      limits: ["Mechanical validity is not narrative accuracy or visual quality.", "A single run per case cannot establish repeatability.", "Live requests require separate authorization and an isolated sample-only server."] });
    await writeFile(resolve(output, "sources.yaml"), YAML.stringify({ defaultPrincipal: "admin", sources: [{ id: "sample", label: "Sample Warehouse", adapter: "duckglue", model: modelPath, connector: { type: "duckdb", lakeRoot: lakePath } }],
      ai: { provider: "anthropic", model: "claude-opus-5", apiKey: "${ANTHROPIC_API_KEY}" } }), { flag: "wx" });
  } else {
    const testCase = redesignCases.find(c => c.id === args[0]);
    if (!testCase) throw new Error(`Unknown case: ${args[0]}`);
    const capture = JSON.parse(await readFile(args[1], "utf8"));
    const result = await assessResponse(testCase, capture.response ?? capture, model, connector);
    await copyFile(args[1], resolve(output, "response.original.json"));
    await write("assessment.json", result);
    if (result.mechanicalStatus !== "passed") process.exitCode = 1;
  }
  process.stdout.write(`${command === "prepare" ? "Prepared synthetic requests and query evidence" : "Assessed captured response; editorial and browser review remain required"}: ${output}\n`);
} finally { await connector.close(); }
