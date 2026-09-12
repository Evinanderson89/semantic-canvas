import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export interface WorkspaceSession { mode: "local" | "team"; authenticated: boolean; canEdit: boolean; canAdmin: boolean; csrf?: string; gatewayUrl?: string; expiresAt?: number; user?: { id: string; name: string; role: string } }
const local: WorkspaceSession = { mode: "local", authenticated: true, canEdit: true, canAdmin: true };
const Context = createContext(local);
export const useSession = () => useContext(Context);

/** Where "Continue with company sign-in" goes. Behind Gateway the portal
 *  owns sessions: its refresh route renews an expired token when it can and
 *  otherwise starts sign-in, then returns here. Standalone team mode signs
 *  in locally. */
/** Renew a minute before expiry, never sooner than five seconds from now, so a token that is already nearly out still gets one attempt. */
export const RENEW_LEAD_MS = 60_000;
export function renewDelay(expiresAt: number, now: number, lead = RENEW_LEAD_MS): number { return Math.max(5_000, expiresAt - now - lead); }

export function signInHref(session: { gatewayUrl?: string } | null): string {
  const portal = session?.gatewayUrl;
  if (!portal) return "/api/auth/login";
  return `${portal.replace(/\/$/, "")}/auth/refresh?next=${encodeURIComponent(location.href)}`;
}

export function SessionBoundary({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<WorkspaceSession | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const original = window.fetch;
    let current: WorkspaceSession | null = null, alive = true;
    window.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
      if (url.origin !== location.origin || !url.pathname.startsWith("/api/")) return original(input, init);
      const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : {}));
      if (current?.csrf) headers.set("x-sc-csrf", current.csrf);
      const response = await original(input, { ...init, headers });
      const changedAccount = current?.mode === "team" && response.headers.has("x-sc-user-id") && response.headers.get("x-sc-user-id") !== current.user?.id;
      if ((response.status === 401 || changedAccount) && current?.authenticated) {
        window.dispatchEvent(new Event("sc:session-ending"));
        current = { ...current, authenticated: false }; if (alive) setSession(current);
        if (changedAccount) return new Response(JSON.stringify({ error: "Workspace account changed. Sign in again." }), { status: 401, headers: { "content-type": "application/json" } });
      }
      return response;
    };
    // Behind Gateway, Envoy answers 401 itself when the session token is
    // missing or expired, before Canvas sees the request. That is an
    // unauthenticated session, not an outage: show the sign-in, whose link
    // goes through the portal so an expired token can be renewed.
    original("/api/auth/session").then(async r => {
      if (r.status === 401) return { mode: "team", authenticated: false, gatewayUrl: (import.meta as any).env?.VITE_GATEWAY_PORTAL_URL || undefined };
      if (!r.ok) throw new Error("Workspace is unavailable"); return r.json(); })
      .then(s => { current = s; if (alive) setSession(s); }).catch(() => { if (alive) setError("We couldn’t reach your workspace. Check the connection and try again."); });
    return () => { alive = false; window.fetch = original; };
  }, []);
  // Silent renewal behind Gateway. The portal owns the session and renews it
  // on its own pages; a Canvas tab left open would otherwise expire mid-work.
  // A minute before expiry, open the portal's refresh route in a hidden
  // iframe with /auth/renewed as the landing page; it sets the renewed
  // cookies on the shared domain and posts back. Then re-read the session so
  // the new expiry schedules the next renewal. Only messages from the portal
  // origin are honoured, and nothing in the message is trusted beyond "try
  // again now"; the session endpoint remains the source of truth.
  useEffect(() => {
    if (!session?.authenticated || !session.gatewayUrl || !session.expiresAt) return;
    const portal = new URL(session.gatewayUrl), lead = RENEW_LEAD_MS;
    const delay = renewDelay(session.expiresAt, Date.now());
    let frame: HTMLIFrameElement | null = null, done = false;
    const reread = async () => { try { const r = await fetch("/api/auth/session"); if (r.ok) setSession(await r.json()); } catch {} };
    const cleanup = () => { frame?.remove(); frame = null; window.removeEventListener("message", onMessage); };
    const onMessage = (e: MessageEvent) => { if (e.origin !== portal.origin || e.data?.type !== "gateway:session" || done) return; done = true; cleanup(); void reread(); };
    const timer = window.setTimeout(() => {
      window.addEventListener("message", onMessage);
      frame = document.createElement("iframe"); frame.hidden = true; frame.setAttribute("aria-hidden", "true");
      // The portal's landing page answers the frame's own origin, read from the referrer. This page sends no referrer by default (Referrer-Policy: no-referrer), so the frame states its origin explicitly; without it the portal would have nowhere to post and Canvas would only notice at the fallback below.
      frame.referrerPolicy = "strict-origin";
      frame.src = `${portal.origin}/auth/refresh?next=${encodeURIComponent("/auth/renewed")}`;
      document.body.appendChild(frame);
      // If the portal never answers, fall back to re-reading the session at expiry so the sign-in screen appears promptly rather than after a failed request.
      window.setTimeout(() => { if (!done) { done = true; cleanup(); void reread(); } }, lead + 5_000);
    }, delay);
    return () => { window.clearTimeout(timer); cleanup(); };
  }, [session?.authenticated, session?.gatewayUrl, session?.expiresAt]);
  if (!session || !session.authenticated) return <main className="workspace-welcome">
    <span className="eyebrow">Semantic Canvas</span><h1>{session ? "Your company’s metrics.\nA clearer story." : "Opening your workspace"}</h1>
    <p>{error || (session ? "Sign in with your company account to explore, build, and share dashboards." : "Connecting to Semantic Canvas…")}</p>
    {session && <a className="save-button" href={signInHref(session)}>Continue with company sign-in →</a>}
    {error && <button onClick={() => location.reload()}>Try again</button>}
  </main>;
  return <Context.Provider value={session}>{children}</Context.Provider>;
}

export async function signOut() {
  window.dispatchEvent(new Event("sc:session-ending"));
  const response = await fetch("/api/auth/logout", { method: "POST" });
  if (!response.ok) { alert("Could not sign out. Reload and try again."); return; }
  for (const key of Object.keys(sessionStorage)) if (key.startsWith("sc:team:")) sessionStorage.removeItem(key);
  // Behind Gateway the portal finishes the sign-out (it holds the refresh cookie); standalone team mode is done here.
  const { redirect } = await response.json().catch(() => ({ redirect: undefined }));
  if (typeof redirect === "string" && /^https?:\/\//.test(redirect)) location.assign(redirect); else location.reload();
}
