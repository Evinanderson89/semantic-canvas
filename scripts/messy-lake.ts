import { resolve } from "node:path";
import { writeMessyLake, MESSY_TODAY } from "../src/testing/messyLake.ts";
// npm run messy-lake [dir] [today]: a deliberately messy warehouse to point the tools at (docs/messy-lake.md).
const dir = resolve(process.argv[2] ?? "sample-data/messy"), today = process.argv[3] ?? MESSY_TODAY;
const { tables } = await writeMessyLake(dir, today);
console.log(`Messy lake written to ${dir} as of ${today}:`);
for (const [t, n] of Object.entries(tables)) console.log(`  ${t.padEnd(18)} ${n.toLocaleString()} rows`);
console.log(`Model (deliberately out of date): ${resolve("sample-data/messy/warehouse.yaml")}\nAdd to sources.yaml:\n  - id: messy\n    label: Messy shop\n    adapter: duckglue\n    model: ./sample-data/messy/warehouse.yaml\n    connector: { type: duckdb, lakeRoot: ${dir}/lake, poolSize: 2 }`);
