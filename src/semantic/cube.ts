import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import YAML from "yaml";
import {
  computedMetricIssue,
  metricComponents,
  type Join,
  type JoinCardinality,
  type Metric,
  type Model,
  type SemanticAdapter,
  type Table,
} from "./model.ts";

const BARE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

const AGG_MAP: Record<string, string> = {
  sum: "SUM",
  count: "COUNT",
  count_distinct: "COUNT_DISTINCT",
  avg: "AVG",
  average: "AVG",
  min: "MIN",
  max: "MAX",
};

const CARDINALITY_MAP: Record<string, JoinCardinality> = {
  many_to_one: "many_to_one",
  one_to_one: "one_to_one",
  one_to_many: "one_to_many",
  many_to_many: "many_to_many",
  belongs_to: "many_to_one",
  has_one: "one_to_one",
  has_many: "one_to_many",
};

function parseRelation(sqlTable: unknown, fallbackTable: string): Table["relation"] {
  if (typeof sqlTable !== "string" || !sqlTable.trim()) {
    return { table: fallbackTable };
  }
  const parts = sqlTable
    .trim()
    .split(".")
    .map((p) => p.replace(/^["`]|["`]$/g, "").trim())
    .filter(Boolean);
  if (parts.length >= 3) {
    return { database: parts[0], schema: parts[1], table: parts[2] };
  }
  if (parts.length === 2) {
    return { schema: parts[0], table: parts[1] };
  }
  return { table: parts[0] ?? fallbackTable };
}

function normalizeColumnSql(rawSql: unknown, cubeName: string, fallbackCol: string): string {
  const raw = typeof rawSql === "string" && rawSql.trim() ? rawSql.trim() : fallbackCol;
  const stripped = raw
    .replace(/^\$?\{CUBE\}\./i, "")
    .replace(new RegExp(`^\\$?\\{${cubeName}\\}\\.`, "i"), "")
    .replace(new RegExp(`^${cubeName}\\.`, "i"), "");
  if (!BARE_IDENT.test(stripped)) {
    throw new Error(`Cube import: unsupported measure column expression "${raw}" on cube ${cubeName}`);
  }
  return `${cubeName}.${stripped}`;
}

function parseJoinColumns(
  joinDef: any,
  leftCube: string,
  rightCube: string,
): { leftOn: string; rightOn: string } {
  const explicitLeft = joinDef.left_on ?? joinDef.leftOn;
  const explicitRight = joinDef.right_on ?? joinDef.rightOn;
  if (typeof explicitLeft === "string" && typeof explicitRight === "string") {
    if (!BARE_IDENT.test(explicitLeft) || !BARE_IDENT.test(explicitRight)) {
      throw new Error(`Cube import: invalid join columns on ${leftCube} -> ${rightCube}`);
    }
    return { leftOn: explicitLeft, rightOn: explicitRight };
  }
  const sql = typeof joinDef.sql === "string" ? joinDef.sql.trim() : "";
  const match = sql.match(
    /^\s*(?:\$?\{([A-Za-z0-9_]+)\}|([A-Za-z0-9_]+))\.([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:\$?\{([A-Za-z0-9_]+)\}|([A-Za-z0-9_]+))\.([A-Za-z_][A-Za-z0-9_]*)\s*$/,
  );
  if (!match) {
    throw new Error(`Cube import: join on ${leftCube} -> ${rightCube} requires "{CUBE}.<leftCol> = {<right>}.<rightCol>" or left_on/right_on`);
  }
  const ref1 = match[1] ?? match[2];
  const col1 = match[3];
  const ref2 = match[4] ?? match[5];
  const col2 = match[6];
  const isLeftFirst = ref1 === "CUBE" || ref1 === leftCube;
  const isRightSecond = ref2 === rightCube;
  if (isLeftFirst && isRightSecond) {
    return { leftOn: col1, rightOn: col2 };
  }
  const isRightFirst = ref1 === rightCube;
  const isLeftSecond = ref2 === "CUBE" || ref2 === leftCube;
  if (isRightFirst && isLeftSecond) {
    return { leftOn: col2, rightOn: col1 };
  }
  throw new Error(`Cube import: join SQL "${sql}" does not match ${leftCube} -> ${rightCube}`);
}

async function readCubeDocs(source: string): Promise<any[] | null> {
  let st;
  try {
    st = await stat(source);
  } catch {
    return null;
  }
  if (st.isFile()) {
    const ext = extname(source).toLowerCase();
    if (![".yaml", ".yml", ".json"].includes(ext)) return null;
    try {
      const raw = await readFile(source, "utf8");
      const doc = ext === ".json" ? JSON.parse(raw) : YAML.parse(raw);
      return Array.isArray(doc?.cubes) ? [doc] : null;
    } catch {
      return null;
    }
  }
  if (st.isDirectory()) {
    let entries: string[];
    try {
      entries = (await readdir(source)).sort();
    } catch {
      return null;
    }
    const docs: any[] = [];
    for (const entry of entries) {
      const ext = extname(entry).toLowerCase();
      if (![".yaml", ".yml", ".json"].includes(ext)) continue;
      try {
        const raw = await readFile(join(source, entry), "utf8");
        const doc = ext === ".json" ? JSON.parse(raw) : YAML.parse(raw);
        if (Array.isArray(doc?.cubes)) docs.push(doc);
      } catch {
        // Ignore unparseable non-cube files in a directory
      }
    }
    return docs.length > 0 ? docs : null;
  }
  return null;
}

/**
 * Cube semantic layer adapter.
 *
 * Reads Cube data schema definitions in YAML or JSON (`cubes: [...]`) from a
 * single file or a directory of schema files, normalizing cubes, dimensions,
 * joins, and simple/ratio/derived measures into the governed internal Model.
 */
export const cubeAdapter: SemanticAdapter = {
  id: "cube",
  label: "Cube (YAML/JSON)",

  async load(source: string): Promise<Model | null> {
    const docs = await readCubeDocs(source);
    if (!docs) return null;

    const cubes = docs.flatMap((d) => (Array.isArray(d?.cubes) ? d.cubes : []));
    if (cubes.length === 0) return null;

    const tables: Model["tables"] = {};
    const joins: Join[] = [];
    const metrics: Model["metrics"] = {};

    // Count measure names across all cubes so unique names stay clean (`revenue`)
    // while colliding names across cubes are disambiguated (`orders_count`).
    const measureNameCounts = new Map<string, number>();
    for (const cube of cubes) {
      for (const m of cube?.measures ?? []) {
        if (typeof m?.name === "string") {
          measureNameCounts.set(m.name, (measureNameCounts.get(m.name) ?? 0) + 1);
        }
      }
    }

    const metricKeyFor = (cubeName: string, measureName: string): string => {
      if ((measureNameCounts.get(measureName) ?? 0) > 1 && !measureName.startsWith(`${cubeName}_`)) {
        return `${cubeName}_${measureName}`;
      }
      return measureName;
    };

    // Map cube + measure name -> resolved metric key in `metrics`
    const cubeMeasureToMetricKey = new Map<string, string>();
    for (const cube of cubes) {
      const cubeName = String(cube?.name ?? "").trim();
      if (!BARE_IDENT.test(cubeName)) {
        throw new Error(`Cube import: invalid cube name ${JSON.stringify(cube?.name)}`);
      }
      for (const m of cube?.measures ?? []) {
        const mName = String(m?.name ?? "").trim();
        if (!BARE_IDENT.test(mName)) {
          throw new Error(`Cube import: invalid measure name ${JSON.stringify(m?.name)} on cube ${cubeName}`);
        }
        const key = metricKeyFor(cubeName, mName);
        cubeMeasureToMetricKey.set(`${cubeName}.${mName}`, key);
        cubeMeasureToMetricKey.set(`${cubeName}_${mName}`, key);
        if ((measureNameCounts.get(mName) ?? 0) === 1) {
          cubeMeasureToMetricKey.set(mName, key);
        }
      }
    }

    // Pass 1: build tables, dimensions, joins, and simple measures
    const deferredMeasures: { cubeName: string; measure: any; metricKey: string }[] = [];

    for (const cube of cubes) {
      const cubeName = String(cube.name).trim();
      const columns: Table["columns"] = [];
      const partitionKeys: string[] = [];
      let primaryKey: string | null = null;
      let defaultDateColumn: string | undefined;

      for (const d of cube.dimensions ?? []) {
        const dimName = String(d?.name ?? "").trim();
        if (!BARE_IDENT.test(dimName)) {
          throw new Error(`Cube import: invalid dimension name ${JSON.stringify(d?.name)} on cube ${cubeName}`);
        }
        const dimType =
          d.type === "time" ? "date" : d.type === "number" ? "double" : "string";
        if (!columns.some((c) => c.name === dimName)) {
          columns.push({
            name: dimName,
            type: dimType,
            description: String(d.description ?? d.title ?? "").trim() || undefined,
          });
        }
        if (d.primary_key === true || d.primaryKey === true) {
          primaryKey = dimName;
        }
        if (d.type === "time") {
          if (!partitionKeys.includes(dimName)) partitionKeys.push(dimName);
          defaultDateColumn ??= dimName;
        }
      }

      tables[cubeName] = {
        name: cubeName,
        description: String(cube.description ?? cube.title ?? "").trim(),
        grain: String(cube.description ?? "").trim(),
        synonyms: Array.isArray(cube.synonyms) ? cube.synonyms.map(String) : [],
        columns,
        partitionKeys,
        ...(defaultDateColumn ? { defaultDateColumn } : {}),
        primaryKey,
        relation: parseRelation(cube.sql_table ?? cube.sqlTable, cubeName),
      };

      for (const j of cube.joins ?? []) {
        const rightCube = String(j?.name ?? "").trim();
        if (!BARE_IDENT.test(rightCube)) {
          throw new Error(`Cube import: invalid join target ${JSON.stringify(j?.name)} on cube ${cubeName}`);
        }
        const { leftOn, rightOn } = parseJoinColumns(j, cubeName, rightCube);
        const rawRel = String(j.relationship ?? j.cardinality ?? "many_to_one").trim();
        const cardinality = CARDINALITY_MAP[rawRel];
        if (!cardinality) {
          throw new Error(`Cube import: unsupported join relationship "${rawRel}" on ${cubeName} -> ${rightCube}`);
        }
        joins.push({
          left: cubeName,
          leftOn,
          right: rightCube,
          rightOn,
          type: "left",
          cardinality,
        });
      }

      for (const m of cube.measures ?? []) {
        const mName = String(m.name).trim();
        const metricKey = metricKeyFor(cubeName, mName);
        const mType = String(m.type ?? "number").toLowerCase();

        if (
          m.numerator !== undefined ||
          m.denominator !== undefined ||
          mType === "ratio" ||
          mType === "derived" ||
          mType === "number"
        ) {
          deferredMeasures.push({ cubeName, measure: m, metricKey });
          continue;
        }

        const agg = AGG_MAP[mType];
        if (!agg) {
          throw new Error(`Cube import: unsupported measure type "${m.type}" on ${cubeName}.${mName}`);
        }

        let expression: string;
        if (agg === "COUNT" && (!m.sql || String(m.sql).trim() === "*" || String(m.sql).trim() === "1")) {
          expression = "COUNT(*)";
        } else {
          const colRef = normalizeColumnSql(m.sql, cubeName, mName);
          expression = agg === "COUNT_DISTINCT" ? `COUNT(DISTINCT ${colRef})` : `${agg}(${colRef})`;
        }

        metrics[metricKey] = {
          name: metricKey,
          label: String(m.title ?? m.label ?? metricKey).trim(),
          description: String(m.description ?? "").trim(),
          baseTable: cubeName,
          expression,
          filter: typeof m.filter === "string" ? m.filter : null,
          synonyms: Array.isArray(m.synonyms) ? m.synonyms.map(String) : [],
        };
      }
    }

    // Ensure join columns exist on tables if omitted from explicit dimensions
    for (const j of joins) {
      const leftTable = tables[j.left];
      if (leftTable && !leftTable.columns.some((c) => c.name === j.leftOn)) {
        leftTable.columns.push({ name: j.leftOn, type: "string" });
      }
      const rightTable = tables[j.right];
      if (rightTable && !rightTable.columns.some((c) => c.name === j.rightOn)) {
        rightTable.columns.push({ name: j.rightOn, type: "string" });
      }
    }

    const resolveMetricRef = (rawRef: unknown, currentCube: string): string => {
      const ref = String(rawRef ?? "")
        .trim()
        .replace(/^\$?\{|\}$/g, "")
        .replace(/^CUBE\./i, `${currentCube}.`);
      if (metrics[ref]) return ref;
      const mapped =
        cubeMeasureToMetricKey.get(ref) ??
        cubeMeasureToMetricKey.get(`${currentCube}.${ref}`) ??
        cubeMeasureToMetricKey.get(`${currentCube}_${ref}`);
      if (mapped && metrics[mapped]) return mapped;
      return ref;
    };

    const draft: Model = { source: "cube", name: "", tables, metrics, joins };

    // Pass 2: resolve ratio and derived measures
    for (const { cubeName, measure: m, metricKey } of deferredMeasures) {
      const label = String(m.title ?? m.label ?? metricKey).trim();
      const description = String(m.description ?? "").trim();
      const synonyms = Array.isArray(m.synonyms) ? m.synonyms.map(String) : [];

      if (m.numerator !== undefined || m.denominator !== undefined || String(m.type).toLowerCase() === "ratio") {
        const numerator = resolveMetricRef(m.numerator, cubeName);
        const denominator = resolveMetricRef(m.denominator, cubeName);
        const metric: Metric = {
          name: metricKey,
          label,
          description,
          baseTable: metrics[numerator]?.baseTable ?? cubeName,
          expression: "",
          type: "ratio",
          numerator,
          denominator,
          filter: null,
          synonyms,
        };
        const issue = computedMetricIssue(draft, metric);
        if (issue) throw new Error(`Cube import: ${issue}`);
        metrics[metricKey] = metric;
      } else {
        const rawExpr = String(m.sql ?? m.expression ?? "").trim();
        if (!rawExpr) {
          throw new Error(`Cube import: measure ${cubeName}.${m.name} of type "${m.type}" requires numerator/denominator or sql expression`);
        }
        // Normalize {CUBE.measure}, {cube.measure}, or {measure} references to metric keys
        const expr = rawExpr.replace(
          /\$?\{([A-Za-z0-9_.]+)\}|(?<![A-Za-z0-9_."])([A-Za-z_][A-Za-z0-9_]*)(?![A-Za-z0-9_"]|\s*\()/g,
          (full, braced, bare) => {
            const token = braced ?? bare;
            if (!token) return full;
            const resolved = resolveMetricRef(token, cubeName);
            return metrics[resolved] ? resolved : full;
          },
        );
        const metric: Metric = {
          name: metricKey,
          label,
          description,
          baseTable: cubeName,
          expression: expr,
          type: "derived",
          filter: null,
          synonyms,
        };
        metric.baseTable = metricComponents(draft, metric)[0]?.baseTable ?? cubeName;
        const issue = computedMetricIssue(draft, metric);
        if (issue) throw new Error(`Cube import: ${issue}`);
        metrics[metricKey] = metric;
      }
    }

    if (Object.keys(metrics).length === 0) return null;

    const firstNamedDoc = docs.find((d) => typeof d?.name === "string" && d.name.trim());
    const fallbackName = basename(source).replace(/\.(ya?ml|json)$/i, "") || "cube";
    return {
      source: "cube",
      name: firstNamedDoc?.name?.trim() ?? fallbackName,
      description: String(firstNamedDoc?.description ?? "Imported from Cube semantic schema.").trim(),
      tables,
      metrics,
      joins,
    };
  },
};
