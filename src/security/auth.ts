import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Express, Request, Response, NextFunction } from "express";
import * as oidc from "openid-client";
import YAML from "yaml";
import { z } from "zod";

const bindingSchema = z.object({ subject: z.string().min(1).optional(), group: z.string().min(1).optional(),
  role: z.enum(["viewer", "editor", "admin"]), principal: z.string().min(1), sources: z.array(z.string().min(1)).min(1),
}).strict().refine(b => Boolean(b.subject) !== Boolean(b.group), "Use exactly one subject or group per binding");
export const accessSchema = z.object({ groupsClaim: z.string().min(1).default("groups"), bindings: z.array(bindingSchema).min(1).max(1000) }).strict();
export type AccessConfig = z.infer<typeof accessSchema>;
export interface Identity { id: string; name: string; role: "viewer" | "editor" | "admin"; principal: string; sources: string[] }
interface Session { identity: Identity; csrf: string; expires: number }
interface LoginAttempt { verifier: string; state: string; nonce: string; expires: number }
export interface AuthConfig { mode: "local" | "team"; publicUrl?: string; issuer?: string; clientId?: string; clientSecret?: string; scopes: string; sessionSeconds: number; access?: AccessConfig }
const token = () => randomBytes(32).toString("base64url");
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const cookie = (req: Request, name: string) => req.headers.cookie?.split(";").map(x => x.trim()).find(x => x.startsWith(`${name}=`))?.slice(name.length + 1);
export const identityOf = (req: Request): Identity | undefined => (req as any).identity;
export const canUseSource = (identity: Identity | undefined, source: string) => !identity || identity.sources.includes("*") || identity.sources.includes(source);
export function mapIdentity(claims: Record<string, unknown>, issuer: string, access: AccessConfig): Identity | null {
  if (typeof claims.sub !== "string" || !claims.sub) return null;
  const groups = Array.isArray(claims[access.groupsClaim]) ? claims[access.groupsClaim] as unknown[] : [];
  // Explicit ordered policy. No implicit administrator or domain-wide access.
  const binding = access.bindings.find(b => b.subject ? b.subject === claims.sub : groups.includes(b.group));
  return binding ? { id: digest(`${issuer}\0${claims.sub}`), name: String(claims.name ?? "Team member").slice(0, 150), role: binding.role, principal: binding.principal, sources: binding.sources } : null;
}
export async function loadAuthConfig(env = process.env): Promise<AuthConfig> {
  const mode = env.SC_MODE ?? "local";
  if (mode !== "local" && mode !== "team") throw new Error("SC_MODE must be local or team");
  const config: AuthConfig = { mode, scopes: env.SC_OIDC_SCOPES ?? "openid profile email", sessionSeconds: Number(env.SC_SESSION_SECONDS ?? 3600) };
  if (!Number.isInteger(config.sessionSeconds) || config.sessionSeconds < 300 || config.sessionSeconds > 28800) throw new Error("SC_SESSION_SECONDS must be between 300 and 28800");
  if (mode === "local") return config;
  for (const key of ["SC_PUBLIC_URL", "SC_OIDC_ISSUER", "SC_OIDC_CLIENT_ID", "SC_OIDC_CLIENT_SECRET", "SC_ACCESS_PATH"]) if (!env[key]) throw new Error(`${key} is required in team mode`);
  const url = new URL(env.SC_PUBLIC_URL!), issuer = new URL(env.SC_OIDC_ISSUER!);
  if (url.protocol !== "https:" || issuer.protocol !== "https:") throw new Error("Team sign-in requires HTTPS for the public URL and identity provider");
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password || issuer.username || issuer.password || issuer.search || issuer.hash) throw new Error("Use a public origin without a path and a valid OIDC issuer URL");
  if (!config.scopes.split(/\s+/).includes("openid")) throw new Error("SC_OIDC_SCOPES must include openid");
  return { ...config, publicUrl: url.origin, issuer: issuer.href, clientId: env.SC_OIDC_CLIENT_ID, clientSecret: env.SC_OIDC_CLIENT_SECRET,
    access: accessSchema.parse(YAML.parse(await readFile(env.SC_ACCESS_PATH!, "utf8"))) };
}

/** Opaque server-side sessions. Tokens and provider responses never reach app JavaScript. */
export class CompanyAuth {
  readonly sessions = new Map<string, Session>();
  private attempts = new Map<string, LoginAttempt>();
  private provider?: oidc.Configuration;
  constructor(readonly config: AuthConfig, private audit: (event: string, data?: Record<string, string | number | boolean>) => void = () => {}) {}
  async start() {
    if (this.config.mode === "team") this.provider = await oidc.discovery(new URL(this.config.issuer!), this.config.clientId!, this.config.clientSecret!, undefined, { timeout: 10 });
  }
  private prune() { const now = Date.now(); for (const [k, v] of this.sessions) if (v.expires < now) this.sessions.delete(k); for (const [k, v] of this.attempts) if (v.expires < now) this.attempts.delete(k); }
  session(req: Request) { const key = cookie(req, "__Host-sc_session"); const session = key ? this.sessions.get(digest(key)) : undefined; return session && session.expires > Date.now() ? session : undefined; }
  issue(identity: Identity, res: Response) {
    this.prune(); if (this.sessions.size >= 5000) throw new Error("Session capacity reached");
    const key = token(), session = { identity, csrf: token(), expires: Date.now() + this.config.sessionSeconds * 1000 };
    this.sessions.set(digest(key), session);
    res.cookie("__Host-sc_session", key, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: this.config.sessionSeconds * 1000 });
    return session;
  }
  mount(app: Express) {
    app.get("/api/auth/session", (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      if (this.config.mode === "local") return res.json({ mode: "local", authenticated: true, canEdit: true, canAdmin: true });
      const session = this.session(req);
      return res.json(session ? { mode: "team", authenticated: true, user: { id: session.identity.id, name: session.identity.name, role: session.identity.role }, csrf: session.csrf, canEdit: session.identity.role !== "viewer", canAdmin: session.identity.role === "admin", expiresAt: session.expires } : { mode: "team", authenticated: false });
    });
    app.get("/api/auth/login", async (_req, res) => {
      if (!this.provider) return res.status(404).end();
      this.prune(); if (this.attempts.size >= 1000) return res.status(429).send("Sign-in is busy. Try again shortly.");
      try {
        const key = token(), verifier = oidc.randomPKCECodeVerifier(), nonce = oidc.randomNonce(), state = oidc.randomState();
        this.attempts.set(digest(key), { verifier, nonce, state, expires: Date.now() + 10 * 60_000 });
        res.cookie("__Host-sc_login", key, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 10 * 60_000 });
        const destination = oidc.buildAuthorizationUrl(this.provider, { redirect_uri: `${this.config.publicUrl}/api/auth/callback`, scope: this.config.scopes, state, nonce,
          code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: "S256" });
        res.setHeader("Cache-Control", "no-store"); res.redirect(destination.href);
      } catch { this.audit("auth.login_failed"); res.status(503).send("Company sign-in is unavailable. Contact your administrator."); }
    });
    app.get("/api/auth/callback", async (req, res) => {
      const key = cookie(req, "__Host-sc_login"), pending = key ? this.attempts.get(digest(key)) : undefined;
      if (key) this.attempts.delete(digest(key));
      res.clearCookie("__Host-sc_login", { path: "/", secure: true, httpOnly: true, sameSite: "lax" });
      res.setHeader("Cache-Control", "no-store");
      if (!this.provider || !pending || pending.expires < Date.now()) return res.status(400).send("Sign-in expired. Return to the app and sign in again.");
      try {
        const tokens = await oidc.authorizationCodeGrant(this.provider, new URL(req.originalUrl, this.config.publicUrl), {
          pkceCodeVerifier: pending.verifier, expectedState: pending.state, expectedNonce: pending.nonce, idTokenExpected: true,
        });
        const claims = tokens.claims();
        const identity = claims && mapIdentity(claims, this.config.issuer!, this.config.access!);
        if (!identity) { this.audit("auth.access_denied"); return res.status(403).send("Your account has no Semantic Canvas access. Ask your administrator to assign a group."); }
        const old = cookie(req, "__Host-sc_session"); if (old) this.sessions.delete(digest(old));
        this.issue(identity, res); this.audit("auth.signed_in", { actor: identity.id, role: identity.role }); res.redirect("/");
      } catch { this.audit("auth.callback_failed"); res.status(400).send("Sign-in could not be verified. Return to the app and try again."); }
    });
    app.post("/api/auth/logout", (req, res) => {
      const session = this.session(req);
      if (session && !this.validCsrf(req, session)) return res.status(403).json({ error: "Reload the page before signing out" });
      const key = cookie(req, "__Host-sc_session"); if (key) this.sessions.delete(digest(key));
      res.clearCookie("__Host-sc_session", { path: "/", secure: true, httpOnly: true, sameSite: "lax" });
      this.audit("auth.signed_out", session ? { actor: session.identity.id } : {}); res.json({ ok: true });
    });
  }
  validCsrf(req: Request, session: Session) { const value = req.header("x-sc-csrf") ?? ""; const a = Buffer.from(value), b = Buffer.from(session.csrf); return a.length === b.length && timingSafeEqual(a, b); }
  guard = (req: Request, res: Response, next: NextFunction) => {
    if (this.config.mode === "local") return next();
    const session = this.session(req); if (!session) return res.status(401).json({ error: "Sign in to your company workspace" });
    (req as any).identity = session.identity;
    res.setHeader("x-sc-user-id", session.identity.id);
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && !this.validCsrf(req, session)) return res.status(403).json({ error: "Your session needs a fresh page. Reload and try again." });
    const route = req.path.replace(/^\/api(?=\/)/, "");
    const admin = /^\/(sources\/|operations|setup)/.test(route) || route === "/sources" && req.method !== "GET" || route === "/agent/key";
    const write = route.startsWith("/dashboards") && req.method !== "GET";
    if (admin && session.identity.role !== "admin" || write && session.identity.role === "viewer") return res.status(403).json({ error: "Your workspace role does not allow this action" });
    // Headers never select a different principal in team mode.
    next();
  };
  forwarded(req: Request) {
    const session = this.session(req);
    return session ? { cookie: `__Host-sc_session=${cookie(req, "__Host-sc_session")}`, csrf: session.csrf, host: new URL(this.config.publicUrl!).host, origin: this.config.publicUrl! } : undefined;
  }
}
