import { resolve } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import YAML from "yaml";
import { writeMessyLake, MESSY_TODAY } from "../src/testing/messyLake.ts";
// npm run messy-lake [dir] [today]: a deliberately messy warehouse to point the tools at (docs/messy-lake.md).
const dir = resolve(process.argv[2] ?? "sample-data/messy"), today = process.argv[3] ?? MESSY_TODAY;
const model = resolve(dir, "warehouse.yaml");
let existing = false;
try {
  const saved = YAML.parse(await readFile(model, "utf8"));
  existing = true;
  if (saved?.model?.calendar?.today !== today) {
    throw new Error(`Existing model has a different reporting date (or none). Use a new output directory or match its model.calendar.today before regenerating data: ${model}`);
  }
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
const template = existing ? null : YAML.parseDocument(await readFile(new URL("../sample-data/messy/warehouse.yaml", import.meta.url), "utf8"));
template?.setIn(["model", "calendar", "today"], today);
const { tables } = await writeMessyLake(dir, today);
if (template) await writeFile(model, template.toString(), { flag: "wx" });
console.log(`Messy lake written to ${dir} as of ${today}:`);
for (const [t, n] of Object.entries(tables)) console.log(`  ${t.padEnd(18)} ${n.toLocaleString()} rows`);
console.log(`${existing ? "Existing model preserved" : "Demo model created (intentionally stale schema)"}: ${model}\nAdd this entry under sources in sources.yaml:\n${YAML.stringify([
  { id: "messy", label: "Messy shop", adapter: "duckglue", model, connector: { type: "duckdb", lakeRoot: resolve(dir, "lake"), poolSize: 2 } },
])}`);
