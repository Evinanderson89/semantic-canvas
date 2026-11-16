import type { Request, Response, NextFunction } from "express";

export type LimitClass = "ai" | "query" | "general";
export type RateLimits = Record<LimitClass, number>;
const DEFAULTS: RateLimits = { ai: 30, query: 600, general: 1200 };
const VARIABLES: Record<LimitClass, string> = { ai: "SC_RATE_AI_PER_MINUTE", query: "SC_RATE_QUERY_PER_MINUTE", general: "SC_RATE_API_PER_MINUTE" };

/** Requests per signed-in account per minute. 0 disables one class. Invalid
 * values stop startup: a mistyped limit must not silently become unlimited. */
export function loadRateLimits(env: Record<string, string | undefined> = process.env): RateLimits {
  const limits = { ...DEFAULTS };
  for (const key of Object.keys(VARIABLES) as LimitClass[]) {
    const raw = env[VARIABLES[key]];
    if (raw === undefined || raw.trim() === "") continue;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0 || value > 100_000) throw new Error(`${VARIABLES[key]} must be a whole number from 0 to 100000`);
    limits[key] = value;
  }
  return limits;
}

/** Provider calls cost money and warehouse queries cost compute; everything else shares a broad allowance. */
export function limitClass(method: string, path: string): LimitClass {
  const route = path.toLowerCase().replace(/^\/api(?=\/)/, "");
  if (method === "POST" && (/^\/agent\/(chat|explain|beautify|dashboard-story)$/.test(route) || route === "/reference/analyze")) return "ai";
  if (method === "POST" && route === "/query" || method === "GET" && /^\/(profile|values|extent|stats)$/.test(route)) return "query";
  return "general";
}

/** Fixed one-minute windows per account and class, held in this process.
 * This bounds one account's cost and load; it is not a defence against a
 * distributed attack, which belongs at the proxy. */
export function createRateLimiter(limits: RateLimits, now: () => number = Date.now, maxKeys = 20_000) {
  const windowMs = 60_000;
  const counts = new Map<string, { start: number; used: number }>();
  return function take(account: string, kind: LimitClass): { allowed: boolean; retryAfterSeconds: number } {
    const limit = limits[kind];
    if (!limit) return { allowed: true, retryAfterSeconds: 0 };
    const time = now(), key = `${kind}\0${account}`;
    let entry = counts.get(key);
    if (!entry || time - entry.start >= windowMs) {
      if (!entry && counts.size >= maxKeys) {
        for (const [k, v] of counts) if (time - v.start >= windowMs) counts.delete(k);
        // Still full of live windows: drop the oldest so memory stays bounded.
        if (counts.size >= maxKeys) counts.delete(counts.keys().next().value!);
      }
      counts.delete(key); entry = { start: time, used: 0 }; counts.set(key, entry);
    }
    if (entry.used >= limit) return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((entry.start + windowMs - time) / 1000)) };
    entry.used++;
    return { allowed: true, retryAfterSeconds: 0 };
  };
}

const MESSAGES: Record<LimitClass, string> = {
  ai: "You have reached this workspace's AI request limit for the moment. Your dashboard is unchanged; try again shortly.",
  query: "You have reached this workspace's query limit for the moment. Try again shortly.",
  general: "Too many requests from your account. Try again shortly.",
};

/** Mount after the sign-in guard: limits are keyed by the verified account, never by a client-supplied header. */
export function rateLimitMiddleware(limits: RateLimits, accountOf: (req: Request) => string | undefined, onLimited: (kind: LimitClass, account: string) => void = () => {}) {
  const take = createRateLimiter(limits);
  return (req: Request, res: Response, next: NextFunction) => {
    const account = accountOf(req);
    if (!account) return next();
    const kind = limitClass(req.method, req.path), result = take(account, kind);
    if (result.allowed) return next();
    onLimited(kind, account);
    res.setHeader("Retry-After", String(result.retryAfterSeconds));
    return res.status(429).json({ error: MESSAGES[kind] });
  };
}
