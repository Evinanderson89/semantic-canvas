import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import YAML from "yaml";
import { runSemanticCli } from "../scripts/semantic-cli.ts";
import { SEMANTIC_FORMATS } from "../src/semantic/convert.ts";
import type { SemanticCoachReport } from "../src/semantic/coach.ts";

describe("Semantic CLI (scripts/semantic-cli.ts)", () => {
  let tempDir = "";
  let draftModelPath = "";
  const sampleWarehousePath = resolve("sample-data/warehouse.yaml");

  const draftDuckGlueYaml = [
    "model:",
    "  name: cli_commerce_draft",
    "  description: Draft commerce semantic layer for CLI testing.",
    "tables:",
    "  fct_orders:",
    "    description: Customer orders fact table.",
    "    grain: one row per order_id",
    "    primary_key: order_id",
    "    columns:",
    "      - name: order_id",
    "        type: string",
    "      - name: customer_id",
    "        type: string",
    "      - name: order_date",
    "        type: date",
    "      - name: gross_revenue",
    "        type: double",
    "      - name: status",
    "        type: string",
    "  dim_customers:",
    "    description: Customer attributes dimension.",
    "    grain: one row per customer_id",
    "    primary_key: customer_id",
    "    columns:",
    "      - name: customer_id",
    "        type: string",
    "      - name: segment",
    "        type: string",
    "      - name: country",
    "        type: string",
    "metrics:",
    "  total_revenue:",
    "    label: Total Revenue",
    "    base_table: fct_orders",
    "    expression: SUM(fct_orders.gross_revenue)",
    "    unit: currency",
    "  order_count:",
    "    label: Order Count",
    "    base_table: fct_orders",
    "    expression: COUNT(fct_orders.order_id)",
    "joins: []",
    "",
  ].join("\n");

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "semantic-cli-test-"));
    draftModelPath = join(tempDir, "draft_model.yaml");
    await writeFile(draftModelPath, draftDuckGlueYaml, "utf8");
  });

  afterAll(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  describe("help & argument validation", () => {
    it("prints usage help on --help, -h, help, or empty argv with exitCode 0", async () => {
      for (const argv of [["--help"], ["-h"], ["help"], []]) {
        const res = await runSemanticCli(argv);
        expect(res.exitCode).toBe(0);
        expect(res.stderr).toBe("");
        expect(res.stdout).toContain("Semantic Canvas CLI");
        expect(res.stdout).toContain("formats");
        expect(res.stdout).toContain("convert");
        expect(res.stdout).toContain("coach");
      }
    });

    it("returns exitCode 1 for unknown subcommands and unknown/incomplete flags", async () => {
      const unknownCmd = await runSemanticCli(["deploy"]);
      expect(unknownCmd.exitCode).toBe(1);
      expect(unknownCmd.stderr).toContain("Unknown subcommand 'deploy'");

      const unknownFlag = await runSemanticCli(["formats", "--bogus"]);
      expect(unknownFlag.exitCode).toBe(1);
      expect(unknownFlag.stderr).toContain("Unknown flag: --bogus");

      const unknownEqFlag = await runSemanticCli(["formats", "--bogus=1"]);
      expect(unknownEqFlag.exitCode).toBe(1);
      expect(unknownEqFlag.stderr).toContain("Unknown flag: --bogus");

      const missingVal = await runSemanticCli(["convert", "--input"]);
      expect(missingVal.exitCode).toBe(1);
      expect(missingVal.stderr).toContain("Missing value for flag: --input");
    });
  });

  describe("formats subcommand", () => {
    it("lists all 5 dialects with filenames and descriptions in human-readable mode", async () => {
      const res = await runSemanticCli(["formats"]);
      expect(res.exitCode).toBe(0);
      expect(res.stderr).toBe("");
      for (const fmt of SEMANTIC_FORMATS) {
        expect(res.stdout).toContain(fmt.id);
        expect(res.stdout).toContain(fmt.label);
        expect(res.stdout).toContain(fmt.filename);
      }
    });

    it("outputs the exact SEMANTIC_FORMATS array with --json", async () => {
      const res = await runSemanticCli(["formats", "--json"]);
      expect(res.exitCode).toBe(0);
      expect(res.stderr).toBe("");
      const parsed = JSON.parse(res.stdout);
      expect(parsed).toHaveLength(5);
      expect(parsed.map((f: { id: string }) => f.id)).toEqual([
        "duckglue",
        "snowflake",
        "metricflow",
        "glue",
        "cube",
      ]);
    });
  });

  describe("convert subcommand", () => {
    it("converts sequentially across DuckGlue -> Snowflake -> MetricFlow -> AWS Glue -> Cube -> DuckGlue", async () => {
      const snowflakePath = join(tempDir, "snowflake_semantic_model.yaml");
      const metricflowPath = join(tempDir, "metricflow_semantic_models.yml");
      const gluePath = join(tempDir, "aws_glue_semantic_catalog.yaml");
      const cubePath = join(tempDir, "cubes.yml");

      // 1. DuckGlue -> Snowflake Cortex Analyst
      const toSnowflake = await runSemanticCli([
        "convert",
        "--input",
        sampleWarehousePath,
        "--from",
        "duckglue",
        "--to",
        "snowflake",
        "--output",
        snowflakePath,
      ]);
      expect(toSnowflake.exitCode).toBe(0);
      expect(toSnowflake.stderr).toBe("");
      expect(toSnowflake.stdout).toContain("Converted duckglue -> snowflake");
      const sfDoc = YAML.parse(await readFile(snowflakePath, "utf8"));
      expect(Array.isArray(sfDoc.tables)).toBe(true);
      expect(sfDoc.tables.length).toBeGreaterThan(0);
      expect(Array.isArray(sfDoc.relationships)).toBe(true);

      // 2. Snowflake -> dbt MetricFlow (auto-detected source)
      const toMetricFlow = await runSemanticCli([
        "convert",
        `--input=${snowflakePath}`,
        "--to=metricflow",
        `--output=${metricflowPath}`,
      ]);
      expect(toMetricFlow.exitCode).toBe(0);
      expect(toMetricFlow.stdout).toContain("Converted snowflake -> metricflow");
      const mfDoc = YAML.parse(await readFile(metricflowPath, "utf8"));
      expect(Array.isArray(mfDoc.semantic_models)).toBe(true);
      expect(Array.isArray(mfDoc.metrics)).toBe(true);

      // 3. dbt MetricFlow -> AWS Glue Data Catalog
      const toGlue = await runSemanticCli([
        "convert",
        "--input",
        metricflowPath,
        "--from",
        "auto",
        "--to",
        "glue",
        "--output",
        gluePath,
      ]);
      expect(toGlue.exitCode).toBe(0);
      expect(toGlue.stdout).toContain("Converted metricflow -> glue");
      const glueDoc = YAML.parse(await readFile(gluePath, "utf8"));
      expect(Array.isArray(glueDoc.TableInputs)).toBe(true);
      expect(glueDoc.DatabaseInput).toBeDefined();

      // 4. AWS Glue -> Cube Semantic Layer
      const toCube = await runSemanticCli([
        "convert",
        "--input",
        gluePath,
        "--to",
        "cube",
        "--output",
        cubePath,
      ]);
      expect(toCube.exitCode).toBe(0);
      expect(toCube.stdout).toContain("Converted glue -> cube");
      const cubeDoc = YAML.parse(await readFile(cubePath, "utf8"));
      expect(Array.isArray(cubeDoc.cubes)).toBe(true);
      expect(cubeDoc.cubes.length).toBeGreaterThan(0);

      // 5. Cube -> DuckGlue printed directly to stdout when --output is omitted
      const backToDuckGlue = await runSemanticCli([
        "convert",
        "--input",
        cubePath,
        "--from",
        "cube",
        "--to",
        "duckglue",
      ]);
      expect(backToDuckGlue.exitCode).toBe(0);
      expect(backToDuckGlue.stderr).toBe("");
      const dgDoc = YAML.parse(backToDuckGlue.stdout);
      expect(dgDoc.tables).toBeDefined();
      expect(typeof dgDoc.tables).toBe("object");
      expect(dgDoc.metrics).toBeDefined();
    });

    it("supports --json on convert and reports clean errors for invalid flags or missing files", async () => {
      const jsonConvert = await runSemanticCli([
        "convert",
        "--input",
        draftModelPath,
        "--to",
        "snowflake",
        "--json",
      ]);
      expect(jsonConvert.exitCode).toBe(0);
      const payload = JSON.parse(jsonConvert.stdout);
      expect(payload.sourceFormat).toBe("duckglue");
      expect(payload.targetFormat).toBe("snowflake");
      expect(payload.filename).toBe("snowflake_semantic_model.yaml");

      const noInput = await runSemanticCli(["convert", "--to", "cube"]);
      expect(noInput.exitCode).toBe(1);
      expect(noInput.stderr).toContain("--input <path> is required");

      const noTo = await runSemanticCli(["convert", "--input", draftModelPath]);
      expect(noTo.exitCode).toBe(1);
      expect(noTo.stderr).toContain("--to <duckglue|snowflake|metricflow|glue|cube> is required");

      const badFrom = await runSemanticCli([
        "convert",
        "--input",
        draftModelPath,
        "--from",
        "lookml",
        "--to",
        "cube",
      ]);
      expect(badFrom.exitCode).toBe(1);
      expect(badFrom.stderr).toContain("Invalid --from dialect 'lookml'");

      const badTo = await runSemanticCli([
        "convert",
        "--input",
        draftModelPath,
        "--to",
        "powerbi",
      ]);
      expect(badTo.exitCode).toBe(1);
      expect(badTo.stderr).toContain("Invalid --to dialect 'powerbi'");

      const missingFile = await runSemanticCli([
        "convert",
        "--input",
        join(tempDir, "does-not-exist.yaml"),
        "--to",
        "cube",
      ]);
      expect(missingFile.exitCode).toBe(1);
      expect(missingFile.stderr).toContain("Could not read input file");
    });
  });

  describe("coach subcommand & CI quality gates", () => {
    it("coaches a custom --question and renders snippets in --format snowflake", async () => {
      const res = await runSemanticCli([
        "coach",
        "--input",
        draftModelPath,
        "--question",
        "Revenue per order by customer segment over time",
        "--format",
        "snowflake",
      ]);
      expect(res.exitCode).toBe(0);
      expect(res.stderr).toBe("");
      expect(res.stdout).toContain("Semantic Layer Coach — cli_commerce_draft");
      expect(res.stdout).toContain('Question Coaching: "Revenue per order by customer segment over time"');
      expect(res.stdout).toContain("Snowflake Cortex Analyst");
      expect(res.stdout).toContain("snowflake_semantic_model.yaml");
      // Snowflake dialect markers in translated snippets
      expect(res.stdout).toContain("base_table:");
      expect(res.stdout).toContain("relationships:");
    });

    it("supports --goal filtering and --json output", async () => {
      const jsonRes = await runSemanticCli([
        "coach",
        "--input",
        draftModelPath,
        "--goal",
        "driver_attribution",
        "--question",
        "Total revenue by segment",
        "--json",
      ]);
      expect(jsonRes.exitCode).toBe(0);
      expect(jsonRes.stderr).toBe("");
      const report = JSON.parse(jsonRes.stdout) as SemanticCoachReport;
      expect(report.modelName).toBe("cli_commerce_draft");
      expect(typeof report.overallScore).toBe("number");
      expect(report.findings.length).toBeGreaterThan(0);
      expect(report.findings.every((f) => f.category === "driver_attribution")).toBe(true);
      expect(report.questionAnalysis?.question).toBe("Total revenue by segment");
      expect(report.findings[0].snippetsByFormat?.snowflake).toBeDefined();
    });

    it("enforces --fail-under CI quality gates (exitCode 1 when below threshold, exitCode 0 when meeting threshold)", async () => {
      const failedGate = await runSemanticCli([
        "coach",
        "--input",
        draftModelPath,
        "--fail-under",
        "99",
      ]);
      expect(failedGate.exitCode).toBe(1);
      expect(failedGate.stderr).toContain("Semantic quality gate failed");
      expect(failedGate.stdout).toContain("Quality Gate: FAILED");

      const passedGate = await runSemanticCli([
        "coach",
        "--input",
        draftModelPath,
        "--fail-under",
        "10",
      ]);
      expect(passedGate.exitCode).toBe(0);
      expect(passedGate.stderr).toBe("");
      expect(passedGate.stdout).toContain("Quality Gate: PASSED");
    });

    it("validates coach flags and reports clear errors on invalid inputs", async () => {
      const noInput = await runSemanticCli(["coach"]);
      expect(noInput.exitCode).toBe(1);
      expect(noInput.stderr).toContain("--input <path> is required");

      const badGoal = await runSemanticCli([
        "coach",
        "--input",
        draftModelPath,
        "--goal",
        "invalid_goal",
      ]);
      expect(badGoal.exitCode).toBe(1);
      expect(badGoal.stderr).toContain("Invalid --goal 'invalid_goal'");

      const badFormat = await runSemanticCli([
        "coach",
        "--input",
        draftModelPath,
        "--format",
        "looker",
      ]);
      expect(badFormat.exitCode).toBe(1);
      expect(badFormat.stderr).toContain("Invalid --format dialect 'looker'");

      const badThreshold = await runSemanticCli([
        "coach",
        "--input",
        draftModelPath,
        "--fail-under",
        "120",
      ]);
      expect(badThreshold.exitCode).toBe(1);
      expect(badThreshold.stderr).toContain("Invalid --fail-under value '120'");
    });
  });
});
