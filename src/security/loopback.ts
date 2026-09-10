import { request } from "node:http";

/** Node fetch can discard Host overrides. Internal tools need the public Host for
 * the same origin check as a browser, while keeping session cookies on loopback. */
export function loopbackRequest(url: string, init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal } = {}): Promise<Response> {
  const target = new URL(url);
  if (target.protocol !== "http:" || target.hostname !== "127.0.0.1") throw new Error("Internal requests must stay on loopback");
  return new Promise((resolve, reject) => {
    const req = request(target, { method: init.method, headers: init.headers, signal: init.signal }, incoming => {
      const chunks: Buffer[] = []; let size = 0;
      incoming.on("data", chunk => { size += chunk.length; if (size > 32 * 1024 * 1024) { incoming.destroy(new Error("Internal response exceeds 32 MB")); return; } chunks.push(chunk); });
      incoming.on("error", reject);
      incoming.on("end", () => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(incoming.headers)) for (const item of Array.isArray(value) ? value : value ? [value] : []) headers.append(key, item);
        resolve(new Response(Buffer.concat(chunks), { status: incoming.statusCode, headers }));
      });
    });
    req.on("error", reject); req.end(init.body);
  });
}
