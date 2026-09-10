import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { closeStore, exportLibrary, openStore, restoreLibrary } from "../src/store/store.ts";
try { process.loadEnvFile(process.env.SC_ENV_PATH ?? ".env"); } catch {}
const [action, filename] = process.argv.slice(2);
if (!["backup", "restore"].includes(action) || !filename) {
  process.stderr.write("Usage: npm run backup -- /path/library.json OR npm run restore -- /path/library.json\nStop the server first. Restore requires an empty store.\n"); process.exit(1);
}
try {
  await openStore();
  if (action === "backup") { await writeFile(resolve(filename), JSON.stringify(await exportLibrary(), null, 2), { mode: 0o600, flag: "wx" }); process.stdout.write("Dashboard library backed up. Server configuration and credentials need a separate backup.\n"); }
  else { const result = await restoreLibrary(JSON.parse(await readFile(resolve(filename), "utf8"))); process.stdout.write(`Restored ${result.restored} dashboards.\n`); }
} catch (e: any) { process.stderr.write(`Could not ${action}: ${e.message}\n`); process.exitCode = 1; }
finally { await closeStore(); }
