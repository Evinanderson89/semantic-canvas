import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
const image = process.argv[2] ?? "semantic-canvas:company-preview";
const name = `sc-install-test-${randomUUID().slice(0, 8)}`, restored = `${name}-restored`;
const volume = `${name}-data`, recovery = `${name}-recovery`;
const docker = args => execFileSync("docker", args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
async function launch(container, storage) {
  docker(["run", "-d", "--name", container, "--init", "--read-only", "--tmpfs", "/tmp", "--cap-drop=ALL", "--security-opt", "no-new-privileges:true", "-v", `${storage}:/data`, "-p", "127.0.0.1::5174", image]);
  const runtime = JSON.parse(docker(["inspect", container]))[0];
  const binding = runtime.NetworkSettings.Ports["5174/tcp"][0];
  if (binding.HostIp !== "127.0.0.1") throw new Error("Smoke container must publish only on host loopback");
  if (!runtime.HostConfig.ReadonlyRootfs) throw new Error("Smoke container root filesystem is not read-only");
  const uid = docker(["exec", container, "id", "-u"]);
  if (!/^\d+$/.test(uid) || Number(uid) === 0) throw new Error("Container process is not running as a non-root user");
  const port = binding.HostPort;
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(url + "/readyz")).ok) return url; } catch {} await new Promise(r => setTimeout(r, 200)); }
  throw new Error("Container failed to start: " + docker(["logs", container]));
}
try {
  const url = await launch(name, volume);
  const html = await (await fetch(url)).text(); if (!html.includes("/assets/")) throw new Error("Built UI is missing");
  const source = (await (await fetch(url + "/api/sources")).json()).active; if (!source) throw new Error("Sample source is missing");
  // Local mode still requires an explicit sample row-access principal for queries.
  const headers = { "content-type": "application/json", "x-sc-source": source, "x-sc-principal": "admin" };
  const original = { title: "Restored company dashboard", tiles: [{ id: "revenue", metrics: ["new_mrr"], dimensions: ["month:movement_date"], chart: "line", layout: { x: 24, y: 24, w: 800, h: 360 } }] };
  const query = await fetch(url + "/api/query", { method: "POST", headers, body: JSON.stringify({ metrics: ["new_mrr"], dimensions: ["month:movement_date"], limit: 24 }) });
  if (!query.ok) throw new Error("Packaged sample query failed: " + await query.text());
  const result = await query.json();
  if (!result.columns?.includes("new_mrr") || !result.rows?.length) throw new Error("Packaged sample query returned no revenue evidence");
  const save = await fetch(url + "/api/dashboards", { method: "POST", headers, body: JSON.stringify({ id: "recovery-proof", spec: original }) });
  if (!save.ok) throw new Error(await save.text());
  const updated = { ...original, title: "Reviewed recovery dashboard", tiles: [{ ...original.tiles[0], title: "New business over time", chart: "bar" }] };
  const resave = await fetch(url + "/api/dashboards", { method: "POST", headers, body: JSON.stringify({ id: "recovery-proof", revision: 1, spec: updated }) });
  if (!resave.ok || (await resave.json()).revision !== 2) throw new Error("Second dashboard version was not saved");
  docker(["stop", name]);
  const archive = execFileSync("docker", ["run", "--rm", "-v", `${volume}:/data`, "--entrypoint", "tar", image, "-C", "/data", "-czf", "-", "."], { maxBuffer: 50 * 1024 * 1024 });
  execFileSync("docker", ["run", "--rm", "-i", "-v", `${recovery}:/data`, "--entrypoint", "tar", image, "-C", "/data", "-xzf", "-"], { input: archive });
  const recoveredUrl = await launch(restored, recovery);
  const document = await (await fetch(recoveredUrl + "/api/dashboards/recovery-proof", { headers: { "x-sc-source": source } })).json();
  if (!isDeepStrictEqual(document.spec, updated) || document.revision !== 2) throw new Error("Restored latest design did not survive");
  const history = await (await fetch(recoveredUrl + "/api/dashboards/recovery-proof/versions", { headers })).json();
  if (JSON.stringify(history.versions?.map(v => v.revision)) !== "[2,1]") throw new Error("Restored design history is incomplete");
  for (const [revision, spec] of [[1, original], [2, updated]]) {
    const version = await (await fetch(recoveredUrl + `/api/dashboards/recovery-proof/versions/${revision}`, { headers })).json();
    if (version.revision !== revision || !isDeepStrictEqual(version.spec, spec)) throw new Error(`Restored version ${revision} changed`);
  }
  if (!(await fetch(recoveredUrl + "/api/setup/guide")).ok) throw new Error("Packaged guide is missing");
  process.stdout.write("Docker smoke test passed: non-root read-only runtime, loopback binding, built UI, sample query, two saved designs, stopped-volume backup and complete version-history restore into a new container.\n");
} finally {
  for (const container of [name, restored]) try { docker(["rm", "-f", container]); } catch {}
  for (const storage of [volume, recovery]) try { docker(["volume", "rm", storage]); } catch {}
}
