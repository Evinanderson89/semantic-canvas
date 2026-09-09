import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
const image = process.argv[2] ?? "semantic-canvas:company-preview";
const name = `sc-install-test-${randomUUID().slice(0, 8)}`, restored = `${name}-restored`;
const volume = `${name}-data`, recovery = `${name}-recovery`;
const docker = args => execFileSync("docker", args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
async function launch(container, storage) {
  docker(["run", "-d", "--name", container, "--init", "--read-only", "--tmpfs", "/tmp", "--cap-drop=ALL", "--security-opt", "no-new-privileges:true", "-v", `${storage}:/data`, "-p", "127.0.0.1::5174", image]);
  const port = JSON.parse(docker(["inspect", container]))[0].NetworkSettings.Ports["5174/tcp"][0].HostPort;
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(url + "/readyz")).ok) return url; } catch {} await new Promise(r => setTimeout(r, 200)); }
  throw new Error("Container failed to start: " + docker(["logs", container]));
}
try {
  const url = await launch(name, volume);
  const html = await (await fetch(url)).text(); if (!html.includes("/assets/")) throw new Error("Built UI is missing");
  const source = (await (await fetch(url + "/api/sources")).json()).active; if (!source) throw new Error("Sample source is missing");
  const save = await fetch(url + "/api/dashboards", { method: "POST", headers: { "content-type": "application/json", "x-sc-source": source }, body: JSON.stringify({ id: "recovery-proof", spec: { title: "Restored company dashboard", tiles: [] } }) });
  if (!save.ok) throw new Error(await save.text());
  docker(["stop", name]);
  const archive = execFileSync("docker", ["run", "--rm", "-v", `${volume}:/data`, "--entrypoint", "tar", image, "-C", "/data", "-czf", "-", "."], { maxBuffer: 50 * 1024 * 1024 });
  execFileSync("docker", ["run", "--rm", "-i", "-v", `${recovery}:/data`, "--entrypoint", "tar", image, "-C", "/data", "-xzf", "-"], { input: archive });
  const recoveredUrl = await launch(restored, recovery);
  const document = await (await fetch(recoveredUrl + "/api/dashboards/recovery-proof", { headers: { "x-sc-source": source } })).json();
  if (document.spec?.title !== "Restored company dashboard" || document.revision !== 1) throw new Error("Restored save did not survive");
  if (!(await fetch(recoveredUrl + "/api/setup/guide")).ok) throw new Error("Packaged guide is missing");
  process.stdout.write("Docker smoke test passed: non-root read-only runtime, built UI, sample source, save, stopped-volume backup and restore into a new container.\n");
} finally {
  for (const container of [name, restored]) try { docker(["rm", "-f", container]); } catch {}
  for (const storage of [volume, recovery]) try { docker(["volume", "rm", storage]); } catch {}
}
