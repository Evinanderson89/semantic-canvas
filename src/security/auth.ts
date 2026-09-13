import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Express, Request, Response, NextFunction } from "express";
import * as oidc from "openid-client";
import YAML from "yaml";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";

const bindingSchema = z.object({ subject: z.string().min(1).optional(), group: z.string().min(1).optional(),
  role: z.enum(["viewer", "editor", "admin"]), principal: z.string().min(1), sources: z.array(z.string().min(1)).min(1),
}).strict().refine(b => Boolean(b.subject) !== Boolean(b.group), "Use exactly one subject or group per binding");
/** Applied to any verified identity that matches no binding, so self-service Gateway users outside every bound group can still open Canvas. */
const defaultGrantSchema = z.object({ role: z.enum(["viewer", "editor", "admin"]), principal: z.string().min(1), sources: z.array(z.string().min(1)).min(1) }).strict();
export const accessSchema = z.object({ groupsClaim: z.string().min(1).default("groups"), default: defaultGrantSchema.optional(), bindings: z.array(bindingSchema).min(1).max(1000) }).strict();
export type AccessConfig = z.infer<typeof accessSchema>;
/** Every binding and the optional default must name a principal the RLS policy file defines; called at startup before any request is served. */
export function checkAccessPrincipals(access: AccessConfig | undefined, principals: Record<string, unknown>) {
  for (const binding of access?.bindings ?? []) if (!principals[binding.principal]) throw new Error("An access binding references an unknown RLS principal");
  if (access?.default && !principals[access.default.principal]) throw new Error("The access default references an unknown RLS principal");
}
export interface Identity { id: string; name: string; role: "viewer" | "editor" | "admin"; principal: string; sources: string[];
  /** Rules the gateway signed onto this request; every query is filtered by them or refused. */
  policy?: GatewayPolicyRule[] }
interface Session { identity: Identity; csrf: string; expires: number }
interface LoginAttempt { verifier: string; state: string; nonce: string; expires: number }
export interface AuthConfig { mode: "local" | "team" | "gateway"; jwksUri?: string; portalUrl?: string; publicUrl?: string; issuer?: string; clientId?: string; clientSecret?: string; scopes: string; sessionSeconds: number; access?: AccessConfig;
  /** Shared with the gateway's control API; verifies the data policy it signs onto each request (gateway-platform/docs/policy.md). Absent: policies are not read. */
  policySecret?: string }
/** A row-level rule the gateway delivered for this request. */
export interface GatewayPolicyRule { field: string; mode: "only" | "not"; values: string[] }

/**
 * The gateway's x-gateway-policy header (base64url JSON) and its HMAC-SHA256
 * signature, as produced by gateway-platform's control API. Returns the rules
 * only when the signature verifies, the policy is for this subject, and it
 * has not expired; anything else is no policy at all, never a partial one.
 */
export function readGatewayPolicy(body: string | undefined, sig: string | undefined, secret: string, sub: string, now = Date.now()): GatewayPolicyRule[] | null {
  if (!body || !sig) return null;
  const want = createHmac("sha256", secret).update(body).digest();
  let got: Buffer;
  try { got = Buffer.from(sig, "base64url"); } catch { return null; }
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  let payload: any;
  try { payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { return null; }
  if (payload?.v !== 1 || payload.sub !== sub || typeof payload.exp !== "number" || payload.exp * 1000 < now || !Array.isArray(payload.rules)) return null;
  const rules: GatewayPolicyRule[] = [];
  for (const r of payload.rules) {
    if (!r || typeof r.field !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/.test(r.field) || (r.mode !== "only" && r.mode !== "not") || !Array.isArray(r.values) || r.values.some((v: unknown) => typeof v !== "string")) return null;
    rules.push({ field: r.field, mode: r.mode, values: r.values });
  }
  return rules;
}
const token = () => randomBytes(32).toString("base64url");
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const cookie = (req: Request, name: string) => req.headers.cookie?.split(";").map(x => x.trim()).find(x => x.startsWith(`${name}=`))?.slice(name.length + 1);
export const identityOf = (req: Request): Identity | undefined => (req as any).identity;
export const canUseSource = (identity: Identity | undefined, source: string) => !identity || identity.sources.includes("*") || identity.sources.includes(source);
export function mapIdentity(claims: Record<string, unknown>, issuer: string, access: AccessConfig): Identity | null {
  if (typeof claims.sub !== "string" || !claims.sub) return null;
  const groups = Array.isArray(claims[access.groupsClaim]) ? claims[access.groupsClaim] as unknown[] : [];
  // Explicit ordered policy: the first matching binding wins, then the optional default. No implicit administrator or domain-wide access.
  const grant = access.bindings.find(b => b.subject ? b.subject === claims.sub : groups.includes(b.group)) ?? access.default;
  return grant ? { id: digest(`${issuer}\0${claims.sub}`), name: String(claims.name ?? "Team member").slice(0, 150), role: grant.role, principal: grant.principal, sources: grant.sources } : null;
}
export async function loadAuthConfig(env = process.env): Promise<AuthConfig> {
  const mode = env.SC_MODE ?? "local";
  if (mode !== "local" && mode !== "team" && mode !== "gateway") throw new Error("SC_MODE must be local, team, or gateway");
  const config: AuthConfig = { mode, scopes: env.SC_OIDC_SCOPES ?? "openid profile email", sessionSeconds: Number(env.SC_SESSION_SECONDS ?? 3600) };
  if (!Number.isInteger(config.sessionSeconds) || config.sessionSeconds < 300 || config.sessionSeconds > 28800) throw new Error("SC_SESSION_SECONDS must be between 300 and 28800");
  if (mode === "local") return config;
  if (mode === "gateway") {
    for (const key of ["SC_PUBLIC_URL", "SC_OIDC_ISSUER", "SC_OIDC_CLIENT_ID", "SC_GATEWAY_JWKS_URI", "SC_GATEWAY_PORTAL_URL", "SC_ACCESS_PATH"]) if (!env[key]) throw new Error(`${key} is required in gateway mode`);
    const url = new URL(env.SC_PUBLIC_URL!), issuer = new URL(env.SC_OIDC_ISSUER!), portal = new URL(env.SC_GATEWAY_PORTAL_URL!), jwks = new URL(env.SC_GATEWAY_JWKS_URI!);
    const local = url.hostname.endsWith(".localhost") && portal.hostname.endsWith(".localhost") && issuer.hostname === "localhost";
    if (!local && [url, issuer, portal, jwks].some(u => u.protocol !== "https:")) throw new Error("Gateway sign-in requires HTTPS outside the localhost development stack");
    if ([url, issuer, portal, jwks].some(u => !["http:", "https:"].includes(u.protocol) || u.username || u.password || u.search || u.hash) || url.pathname !== "/" || portal.pathname !== "/") throw new Error("Use valid Gateway origins and identity provider URLs");
    return { ...config, publicUrl: url.origin, issuer: env.SC_OIDC_ISSUER, clientId: env.SC_OIDC_CLIENT_ID, jwksUri: jwks.href, portalUrl: portal.origin,
      policySecret: env.SC_GATEWAY_POLICY_SECRET?.trim() || undefined,
      access: accessSchema.parse(YAML.parse(await readFile(env.SC_ACCESS_PATH!, "utf8"))) };
  }
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
  /** Gateway mode has no server sessions; remember who last presented a valid token so background work can tell whether they still hold access. */
  private lastVerified = new Map<string, { identity: Identity; exp: number }>();
  private provider?: oidc.Configuration;
  private gatewayKeys?: ReturnType<typeof createRemoteJWKSet>;
  private gatewayCsrfSecret = token();
  constructor(readonly config: AuthConfig, private audit: (event: string, data?: Record<string, string | number | boolean>) => void = () => {}) {}
  async start() {
    if (this.config.mode === "gateway") this.gatewayKeys = createRemoteJWKSet(new URL(this.config.jwksUri!), { timeoutDuration: 5000 });
    if (this.config.mode === "team") this.provider = await oidc.discovery(new URL(this.config.issuer!), this.config.clientId!, this.config.clientSecret!, undefined, { timeout: 10 });
  }
  private prune() { const now = Date.now(); for (const [k, v] of this.sessions) if (v.expires < now) this.sessions.delete(k); for (const [k, v] of this.attempts) if (v.expires < now) this.attempts.delete(k); for (const [k, v] of this.lastVerified) if (v.exp < now) this.lastVerified.delete(k); }
  /** The owner's identity while they still hold access: an unexpired team session, or in gateway mode a token verified since the server started that has not expired. */
  currentIdentity(ownerId: string): Identity | null {
    const now = Date.now();
    if (this.config.mode === "gateway") { const seen = this.lastVerified.get(ownerId); if (seen && seen.exp <= now) this.lastVerified.delete(ownerId); return seen && seen.exp > now ? seen.identity : null; }
    if (this.config.mode === "team") return [...this.sessions.values()].find(s => s.expires > now && s.identity.id === ownerId)?.identity ?? null;
    return null;
  }
  session(req: Request) { if (this.config.mode === "gateway") { const session = (req as any).gatewaySession as Session | undefined; return session && session.expires > Date.now() ? session : undefined; } const key = cookie(req, "__Host-sc_session"); const session = key ? this.sessions.get(digest(key)) : undefined; return session && session.expires > Date.now() ? session : undefined; }
  issue(identity: Identity, res: Response) {
    this.prune(); if (this.sessions.size >= 5000) throw new Error("Session capacity reached");
    const key = token(), session = { identity, csrf: token(), expires: Date.now() + this.config.sessionSeconds * 1000 };
    this.sessions.set(digest(key), session);
    res.cookie("__Host-sc_session", key, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: this.config.sessionSeconds * 1000 });
    return session;
  }
  mount(app: Express) {
    if (this.config.mode === "gateway" && !this.config.policySecret) console.error(JSON.stringify({ event: "auth.policy_secret_missing", level: "warn", message: "SC_GATEWAY_POLICY_SECRET is not set: a data policy the gateway delivers cannot be verified, and any request carrying one is refused." }));
    if (this.config.mode === "gateway") app.use("/api", (req, res, next) => {
      // A policy we cannot verify is not one we may ignore: refusing is the only honest answer.
      if (!this.config.policySecret && (req.header("x-gateway-policy") || req.header("x-gateway-policy-sig"))) return res.status(503).json({ error: "The gateway sent a data policy for this request, but this app has no secret to verify it. Ask an administrator to set SC_GATEWAY_POLICY_SECRET." });
      // The portal sends the Gateway token as a cookie; the gateway CLI and other
      // non-browser clients send the same token as a bearer. Envoy has already
      // verified either form; we verify again here and never trust proxy headers.
      const bearer = /^Bearer\s+(\S+)$/i.exec(req.header("authorization") ?? "")?.[1];
      const raw = cookie(req, "gw_session") ?? bearer;
      if (!raw || !this.gatewayKeys) return next();
      void (async () => {
        try {
          const { payload } = await jwtVerify(decodeURIComponent(raw), this.gatewayKeys!, { issuer: this.config.issuer, audience: this.config.clientId, algorithms: ["RS256", "ES256"], requiredClaims: ["sub", "exp"] });
          let identity = mapIdentity(payload, this.config.issuer!, this.config.access!);
          if (identity && this.config.policySecret) {
            // The gateway strips these from clients and only ext_authz adds them; the signature makes that trust explicit here.
            const rules = readGatewayPolicy(req.header("x-gateway-policy"), req.header("x-gateway-policy-sig"), this.config.policySecret, String(payload.sub));
            if (rules) identity = { ...identity, policy: rules };
          }
          if (identity) {
            (req as any).gatewaySession = { identity, csrf: digest(`${this.gatewayCsrfSecret}\0${raw}`), expires: Number(payload.exp) * 1000 } satisfies Session;
            if (this.lastVerified.size >= 5000) this.prune();
            this.lastVerified.set(identity.id, { identity, exp: Number(payload.exp) * 1000 });
          }
        } catch { /* An invalid token remains unauthenticated; proxy headers never confer access. */ }
        next();
      })();
    });
    app.get("/api/auth/session", (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      if (this.config.mode === "local") return res.json({ mode: "local", authenticated: true, canEdit: true, canAdmin: true });
      const session = this.session(req);
      return res.json(session ? { mode: "team", authenticated: true, gatewayUrl: this.config.mode === "gateway" ? this.config.portalUrl : undefined, user: { id: session.identity.id, name: session.identity.name, role: session.identity.role }, csrf: session.csrf, canEdit: session.identity.role !== "viewer", canAdmin: session.identity.role === "admin", expiresAt: session.expires, ...(session.identity.policy?.length ? { policy: session.identity.policy } : {}) } : { mode: "team", authenticated: false, gatewayUrl: this.config.mode === "gateway" ? this.config.portalUrl : undefined });
    });
    app.get("/api/auth/login", async (_req, res) => {
      // The portal owns the session: its refresh route renews an expired token
      // when it can, otherwise starts sign-in, and either way returns here.
      if (this.config.mode === "gateway") return res.redirect(`${this.config.portalUrl}/auth/refresh?next=${encodeURIComponent(this.config.publicUrl ?? "/")}`);
      if (!this.provider) return res.status(404).end();
      // Unauthenticated callers must not be able to exhaust sign-in: at capacity the oldest pending attempt is evicted.
      this.prune(); while (this.attempts.size >= 1000) this.attempts.delete(this.attempts.keys().next().value!);
      try {
        const key = token(), verifier = oidc.randomPKCECodeVerifier(), nonce = oidc.randomNonce(), state = oidc.randomState();
        this.attempts.set(digest(key), { verifier, nonce, state, expires: Date.now() + 5 * 60_000 });
        res.cookie("__Host-sc_login", key, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 5 * 60_000 });
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
      // Behind Gateway the portal owns the session: clearing the access cookie here would leave the portal's refresh cookie, and the next click on "Continue with company sign-in" would silently issue a new token to whoever is at the keyboard. The browser is sent to the portal's sign-out, which revokes the refresh token at the identity provider and clears both cookies.
      if (this.config.mode === "gateway") { res.clearCookie("gw_session", { domain: new URL(this.config.portalUrl!).hostname, path: "/", httpOnly: true, secure: this.config.publicUrl!.startsWith("https:"), sameSite: "lax" }); return res.json({ ok: true, redirect: `${this.config.portalUrl}/auth/logout` }); }
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
    const route = req.path.toLowerCase().replace(/^\/api(?=\/)/, "");
    // Tables Ingest registers (/sources/:id/connected) are an editor surface; publishing them into the governed catalogue stays admin-only, as does everything else under /sources/.
    // Proposed metrics (/sources/:id/metrics) are an editor surface too; publishing one is admin-only.
    const connected = /^\/sources\/[^/]+\/(connected|metrics)(\/|$)/.test(route), publish = /^\/sources\/[^/]+\/(connected|metrics)\/[^/]+\/publish$/.test(route);
    const admin = /^\/(sources\/|operations|setup|modeler)/.test(route) && (!connected || publish) || route === "/sources" && req.method !== "GET" || route === "/agent/key";
    const write = (route.startsWith("/dashboards") || /^\/library(\/|$)/.test(route) || connected) && !["GET", "HEAD", "OPTIONS"].includes(req.method);
    if (admin && session.identity.role !== "admin" || write && session.identity.role === "viewer") return res.status(403).json({ error: "Your workspace role does not allow this action" });
    // Headers never select a different principal in team mode.
    next();
  };
  forwarded(req: Request) {
    const session = this.session(req);
    return session ? { cookie: this.config.mode === "gateway" ? `gw_session=${cookie(req, "gw_session")}` : `__Host-sc_session=${cookie(req, "__Host-sc_session")}`, csrf: session.csrf, host: new URL(this.config.publicUrl!).host, origin: this.config.publicUrl! } : undefined;
  }
}
