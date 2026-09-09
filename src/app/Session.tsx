import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export interface WorkspaceSession { mode: "local" | "team"; authenticated: boolean; canEdit: boolean; canAdmin: boolean; csrf?: string; user?: { id: string; name: string; role: string } }
const local: WorkspaceSession = { mode: "local", authenticated: true, canEdit: true, canAdmin: true };
const Context = createContext(local);
export const useSession = () => useContext(Context);

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
    original("/api/auth/session").then(async r => { if (!r.ok) throw new Error("Workspace is unavailable"); return r.json(); })
      .then(s => { current = s; if (alive) setSession(s); }).catch(() => { if (alive) setError("We couldn’t reach your workspace. Check the connection and try again."); });
    return () => { alive = false; window.fetch = original; };
  }, []);
  if (!session || !session.authenticated) return <main className="workspace-welcome">
    <span className="eyebrow">Semantic Canvas</span><h1>{session ? "Your company’s metrics.\nA clearer story." : "Opening your workspace"}</h1>
    <p>{error || (session ? "Sign in with your company account to explore, build, and share dashboards." : "Connecting to Semantic Canvas…")}</p>
    {session && <a className="save-button" href="/api/auth/login">Continue with company sign-in →</a>}
    {error && <button onClick={() => location.reload()}>Try again</button>}
  </main>;
  return <Context.Provider value={session}>{children}</Context.Provider>;
}

export async function signOut() {
  window.dispatchEvent(new Event("sc:session-ending"));
  const response = await fetch("/api/auth/logout", { method: "POST" });
  if (!response.ok) { alert("Could not sign out. Reload and try again."); return; }
  for (const key of Object.keys(sessionStorage)) if (key.startsWith("sc:team:")) sessionStorage.removeItem(key);
  location.reload();
}
