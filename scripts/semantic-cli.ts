import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  COACH_CATEGORIES,
  coachSemanticModel,
  type AnalysisGoal,
} from "../src/semantic/coach.ts";
import {
  convertSemanticLayer,
  isSemanticLayerFormat,
  parseSemanticLayerText,
  SEMANTIC_FORMATS,
  translateSnippetToFormat,
  type SemanticLayerFormat,
} from "../src/semantic/convert.ts";

export interface SemanticCliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const VALID_GOALS: ReadonlySet<AnalysisGoal> = new Set<AnalysisGoal>([
  "all",
  "time_series",
  "driver_attribution",
  "ratios_and_funnels",
  "cohorts_and_cumulative",
  "agent_readiness",
]);

function isAnalysisGoal(value: string): value is AnalysisGoal {
  return VALID_GOALS.has(value as AnalysisGoal);
}

const HELP_TEXT = `Semantic Canvas CLI — Multi-Dialect Semantic Layer Converter & Coach

Usage:
  npm run semantic -- <subcommand> [options]

Subcommands:
  formats   List all 5 supported semantic layer dialects (duckglue, snowflake, metricflow, glue, cube)
  convert   Convert a semantic layer file between any two dialects
  coach     Score semantic model readiness, coach analytical questions, and enforce CI quality gates

Options for "formats":
  --json                                 Output supported formats as JSON

Options for "convert":
  --input <path>                         Source semantic model file (YAML or JSON) [required]
  --from <auto|duckglue|snowflake|metricflow|glue|cube>
                                         Source dialect (default: auto)
  --to <duckglue|snowflake|metricflow|glue|cube>
                                         Target dialect [required]
  --output <path>                        Write converted output to file (prints YAML to stdout if omitted)

Options for "coach":
  --input <path>                         Semantic model file to evaluate [required]
  --from <auto|duckglue|snowflake|metricflow|glue|cube>
                                         Source dialect (default: auto)
  --goal <all|time_series|driver_attribution|ratios_and_funnels|cohorts_and_cumulative|agent_readiness>
                                         Filter coaching findings to a readiness goal (default: all)
  --question "<text>"                    Coach a specific natural-language business question
  --format <duckglue|snowflake|metricflow|glue|cube>
                                         Render YAML fix snippets in this dialect (default: duckglue)
  --json                                 Output full SemanticCoachReport as JSON
  --fail-under <0-100>                   Exit with code 1 if overallScore < threshold (CI quality gate)

Global Options:
  -h, --help                             Show this help message
`;

interface ParsedArgs {
  flags: Map<string, string | boolean>;
  positionals: string[];
  error?: string;
}

const BOOLEAN_FLAGS = new Set(["help", "h", "json"]);
const VALUE_FLAGS = new Set([
  "input",
  "i",
  "from",
  "to",
  "output",
  "o",
  "goal",
  "question",
  "q",
  "format",
  "f",
  "fail-under",
]);

function parseCliArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string | boolean>();
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith("--")) {
      const eqIdx = token.indexOf("=");
      if (eqIdx !== -1) {
        const key = token.slice(2, eqIdx);
        const val = token.slice(eqIdx + 1);
        if (BOOLEAN_FLAGS.has(key)) {
          flags.set(key, val !== "false" && val !== "0");
        } else if (VALUE_FLAGS.has(key)) {
          flags.set(key, val);
        } else {
          return { flags, positionals, error: `Unknown flag: --${key}` };
        }
      } else {
        const key = token.slice(2);
        if (BOOLEAN_FLAGS.has(key)) {
          flags.set(key, true);
        } else if (VALUE_FLAGS.has(key)) {
          const next = argv[i + 1];
          if (next === undefined || (next.startsWith("-") && next !== "-")) {
            return { flags, positionals, error: `Missing value for flag: --${key}` };
          }
          flags.set(key, next);
          i++;
        } else {
          return { flags, positionals, error: `Unknown flag: --${key}` };
        }
      }
      continue;
    }
    if (token.startsWith("-") && token.length > 1) {
      const key = token.slice(1);
      if (BOOLEAN_FLAGS.has(key)) {
        flags.set(key, true);
      } else if (VALUE_FLAGS.has(key)) {
        const next = argv[i + 1];
        if (next === undefined) {
          return { flags, positionals, error: `Missing value for flag: -${key}` };
        }
        flags.set(key, next);
        i++;
      } else {
        return { flags, positionals, error: `Unknown flag: -${key}` };
      }
      continue;
    }
    positionals.push(token);
  }

  return { flags, positionals };
}

function getStringFlag(flags: Map<string, string | boolean>, ...names: string[]): string | undefined {
  for (const name of names) {
    const val = flags.get(name);
    if (typeof val === "string") return val;
  }
  return undefined;
}

function getBoolFlag(flags: Map<string, string | boolean>, ...names: string[]): boolean {
  return names.some((name) => flags.get(name) === true);
}

function formatMeta(format: SemanticLayerFormat) {
  return SEMANTIC_FORMATS.find((f) => f.id === format) ?? SEMANTIC_FORMATS[0];
}

function handleFormats(flags: Map<string, string | boolean>): SemanticCliResult {
  if (getBoolFlag(flags, "json")) {
    return {
      exitCode: 0,
      stdout: `${JSON.stringify(SEMANTIC_FORMATS, null, 2)}\n`,
      stderr: "",
    };
  }

  const lines: string[] = [
    "Supported Semantic Layer Dialects (5):",
    "",
  ];
  for (const fmt of SEMANTIC_FORMATS) {
    lines.push(`  ${fmt.id.padEnd(12)} ${fmt.label} (${fmt.vendor})`);
    lines.push(`  ${"".padEnd(12)} Default file: ${fmt.filename}`);
    lines.push(`  ${"".padEnd(12)} ${fmt.description}`);
    lines.push("");
  }
  return {
    exitCode: 0,
    stdout: `${lines.join("\n").trimEnd()}\n`,
    stderr: "",
  };
}

async function handleConvert(flags: Map<string, string | boolean>): Promise<SemanticCliResult> {
  const inputPath = getStringFlag(flags, "input", "i");
  if (!inputPath || !inputPath.trim()) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "Error: --input <path> is required for 'convert'.\n",
    };
  }

  const rawFrom = (getStringFlag(flags, "from") ?? "auto").trim().toLowerCase();
  if (rawFrom !== "auto" && !isSemanticLayerFormat(rawFrom)) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Error: Invalid --from dialect '${rawFrom}'. Expected auto, duckglue, snowflake, metricflow, glue, or cube.\n`,
    };
  }
  const sourceFormat: SemanticLayerFormat | "auto" = rawFrom === "auto" ? "auto" : rawFrom;

  const rawTo = getStringFlag(flags, "to")?.trim().toLowerCase();
  if (!rawTo) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "Error: --to <duckglue|snowflake|metricflow|glue|cube> is required for 'convert'.\n",
    };
  }
  if (!isSemanticLayerFormat(rawTo)) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Error: Invalid --to dialect '${rawTo}'. Expected duckglue, snowflake, metricflow, glue, or cube.\n`,
    };
  }

  let content: string;
  const resolvedInput = resolve(inputPath);
  try {
    content = await readFile(resolvedInput, "utf8");
  } catch (err: any) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Error: Could not read input file '${resolvedInput}': ${err?.message ?? String(err)}\n`,
    };
  }

  let converted: ReturnType<typeof convertSemanticLayer>;
  try {
    converted = convertSemanticLayer({
      content,
      sourceFormat,
      targetFormat: rawTo,
    });
  } catch (err: any) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Error: Semantic conversion failed: ${err?.message ?? String(err)}\n`,
    };
  }

  const outputPath = getStringFlag(flags, "output", "o");
  const normalizedYaml = converted.content.endsWith("\n")
    ? converted.content
    : `${converted.content}\n`;

  if (outputPath && outputPath.trim()) {
    const resolvedOutput = resolve(outputPath);
    try {
      await mkdir(dirname(resolvedOutput), { recursive: true });
      await writeFile(resolvedOutput, normalizedYaml, "utf8");
    } catch (err: any) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `Error: Could not write output file '${resolvedOutput}': ${err?.message ?? String(err)}\n`,
      };
    }

    const summaryLines = [
      `Converted ${converted.sourceFormat} -> ${converted.targetFormat} (${resolvedOutput})`,
      `Summary: ${converted.summary.tables} tables, ${converted.summary.metrics} metrics, ${converted.summary.joins} joins`,
    ];
    for (const note of converted.summary.notes) {
      summaryLines.push(`Note: ${note}`);
    }
    return {
      exitCode: 0,
      stdout: `${summaryLines.join("\n")}\n`,
      stderr: "",
    };
  }

  if (getBoolFlag(flags, "json")) {
    return {
      exitCode: 0,
      stdout: `${JSON.stringify(converted, null, 2)}\n`,
      stderr: "",
    };
  }

  return {
    exitCode: 0,
    stdout: normalizedYaml,
    stderr: "",
  };
}

async function handleCoach(flags: Map<string, string | boolean>): Promise<SemanticCliResult> {
  const inputPath = getStringFlag(flags, "input", "i");
  if (!inputPath || !inputPath.trim()) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "Error: --input <path> is required for 'coach'.\n",
    };
  }

  const rawFrom = (getStringFlag(flags, "from") ?? "auto").trim().toLowerCase();
  if (rawFrom !== "auto" && !isSemanticLayerFormat(rawFrom)) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Error: Invalid --from dialect '${rawFrom}'. Expected auto, duckglue, snowflake, metricflow, glue, or cube.\n`,
    };
  }

  const rawGoal = (getStringFlag(flags, "goal") ?? "all").trim().toLowerCase();
  if (!isAnalysisGoal(rawGoal)) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Error: Invalid --goal '${rawGoal}'. Expected all, time_series, driver_attribution, ratios_and_funnels, cohorts_and_cumulative, or agent_readiness.\n`,
    };
  }

  const rawFormat = (getStringFlag(flags, "format", "f") ?? "duckglue").trim().toLowerCase();
  if (!isSemanticLayerFormat(rawFormat)) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Error: Invalid --format dialect '${rawFormat}'. Expected duckglue, snowflake, metricflow, glue, or cube.\n`,
    };
  }

  const rawFailUnder = getStringFlag(flags, "fail-under");
  let failUnderThreshold: number | undefined;
  if (rawFailUnder !== undefined) {
    const parsedThreshold = Number(rawFailUnder);
    if (!Number.isFinite(parsedThreshold) || parsedThreshold < 0 || parsedThreshold > 100) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `Error: Invalid --fail-under value '${rawFailUnder}'. Expected a number between 0 and 100.\n`,
      };
    }
    failUnderThreshold = parsedThreshold;
  }

  const question = getStringFlag(flags, "question", "q");
  const resolvedInput = resolve(inputPath);
  let rawText: string;
  try {
    rawText = await readFile(resolvedInput, "utf8");
  } catch (err: any) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Error: Could not read input file '${resolvedInput}': ${err?.message ?? String(err)}\n`,
    };
  }

  let detectedFormat: SemanticLayerFormat;
  let model: ReturnType<typeof parseSemanticLayerText>["model"];
  try {
    const parsed = parseSemanticLayerText(
      rawText,
      rawFrom === "auto" ? "auto" : rawFrom,
    );
    detectedFormat = parsed.detectedFormat;
    model = parsed.model;
  } catch (err: any) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Error: Could not parse semantic model: ${err?.message ?? String(err)}\n`,
    };
  }

  const report = coachSemanticModel(model, {
    goal: rawGoal,
    ...(question && question.trim() ? { question: question.trim() } : {}),
  });

  const failedQualityGate =
    failUnderThreshold !== undefined && report.overallScore < failUnderThreshold;
  const exitCode = failedQualityGate ? 1 : 0;
  const stderr = failedQualityGate
    ? `Semantic quality gate failed: overallScore ${report.overallScore}/100 is below --fail-under ${failUnderThreshold}.\n`
    : "";

  if (getBoolFlag(flags, "json")) {
    return {
      exitCode,
      stdout: `${JSON.stringify(report, null, 2)}\n`,
      stderr,
    };
  }

  const targetMeta = formatMeta(rawFormat);
  const lines: string[] = [
    `Semantic Layer Coach — ${report.modelName} (source dialect: ${detectedFormat})`,
    `Heuristic Readiness Score: ${report.overallScore}/100 (Structural heuristic based on declared fields and joins — run a query to validate against warehouse data; not a quality certification)`,
    report.summary,
    "",
    "Category Scores (Heuristic Structural Check):",
  ];

  for (const cat of COACH_CATEGORIES) {
    const score = report.categoryScores[cat.id];
    lines.push(`  - ${cat.label.padEnd(30)} ${String(score).padStart(3)}/100`);
  }

  if (report.strengths.length > 0) {
    lines.push("");
    lines.push("Strengths:");
    for (const s of report.strengths) {
      lines.push(`  + ${s}`);
    }
  }

  if (report.questionAnalysis) {
    const qa = report.questionAnalysis;
    lines.push("");
    lines.push(`Question Coaching: "${qa.question}"`);
    lines.push(
      `  Status: ${qa.canAnswerNow ? "Model appears to support this question (validate with a live query)" : "Model additions recommended"}`,
    );
    if (qa.matchedMetrics.length > 0) {
      lines.push(`  Matched metrics: ${qa.matchedMetrics.join(", ")}`);
    }
    if (qa.matchedDimensions.length > 0) {
      lines.push(`  Matched dimensions: ${qa.matchedDimensions.join(", ")}`);
    }
    for (const step of qa.coachingSteps) {
      lines.push(`  * ${step}`);
    }
    const qaSnippet =
      qa.snippetsByFormat?.[rawFormat] ??
      (qa.suggestedYaml ? translateSnippetToFormat(qa.suggestedYaml, rawFormat) : undefined);
    if (qaSnippet) {
      lines.push("");
      lines.push(`  Suggested Recipe (${targetMeta.label} · ${targetMeta.filename}):`);
      for (const sLine of qaSnippet.split("\n")) {
        lines.push(`    ${sLine}`);
      }
    }
  }

  lines.push("");
  if (report.findings.length === 0) {
    lines.push(`Findings (${rawGoal}): None — model meets all checks for this goal.`);
  } else {
    lines.push(`Findings (${report.findings.length}) — Snippets in ${targetMeta.label} (${targetMeta.filename}):`);
    for (const finding of report.findings) {
      lines.push("");
      lines.push(`  [${finding.priority.toUpperCase()}] ${finding.title} (${finding.category} · ${finding.target})`);
      lines.push(`  ${finding.recommendation}`);
      const snippet =
        finding.snippetsByFormat?.[rawFormat] ??
        translateSnippetToFormat(finding.yamlSnippet, rawFormat, { table: finding.target.split(".")[0] });
      if (snippet) {
        lines.push("  ---");
        for (const sLine of snippet.split("\n")) {
          lines.push(`  ${sLine}`);
        }
      }
    }
  }

  if (failUnderThreshold !== undefined) {
    lines.push("");
    lines.push(
      failedQualityGate
        ? `Quality Gate: FAILED (${report.overallScore}/100 < ${failUnderThreshold})`
        : `Quality Gate: PASSED (${report.overallScore}/100 >= ${failUnderThreshold})`,
    );
  }

  return {
    exitCode,
    stdout: `${lines.join("\n")}\n`,
    stderr,
  };
}

export async function runSemanticCli(argv: string[]): Promise<SemanticCliResult> {
  const parsed = parseCliArgs(argv);
  if (parsed.error) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `Error: ${parsed.error}\n\nRun 'npm run semantic -- --help' for usage.\n`,
    };
  }

  const subcommand = parsed.positionals[0]?.toLowerCase();
  if (
    getBoolFlag(parsed.flags, "help", "h") ||
    subcommand === "help" ||
    subcommand === undefined
  ) {
    return {
      exitCode: 0,
      stdout: HELP_TEXT,
      stderr: "",
    };
  }

  if (subcommand === "formats") {
    return handleFormats(parsed.flags);
  }

  if (subcommand === "convert") {
    return handleConvert(parsed.flags);
  }

  if (subcommand === "coach") {
    return handleCoach(parsed.flags);
  }

  return {
    exitCode: 1,
    stdout: "",
    stderr: `Error: Unknown subcommand '${parsed.positionals[0]}'. Expected formats, convert, or coach.\n\n${HELP_TEXT}`,
  };
}

function isExecutedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    if (import.meta.url === pathToFileURL(resolve(entry)).href) return true;
    if (import.meta.url === pathToFileURL(realpathSync(entry)).href) return true;
  } catch {
    return false;
  }
  return false;
}

if (isExecutedDirectly()) {
  runSemanticCli(process.argv.slice(2)).then(
    ({ exitCode, stdout, stderr }) => {
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
      process.exitCode = exitCode;
    },
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Fatal error: ${msg}\n`);
      process.exitCode = 1;
    },
  );
}
