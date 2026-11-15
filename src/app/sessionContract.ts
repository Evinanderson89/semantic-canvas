import { z } from "zod";

const portalUrl = z.string().refine(value => {
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
}, "Invalid sign-in portal URL");
const sessionSchema = z.union([
  z.object({ mode: z.literal("local"), authenticated: z.literal(true), canEdit: z.literal(true), canAdmin: z.literal(true) }),
  z.object({ mode: z.literal("team"), authenticated: z.literal(false), gatewayUrl: portalUrl.optional(), canEdit: z.literal(false).default(false), canAdmin: z.literal(false).default(false) }),
  z.object({ mode: z.literal("team"), authenticated: z.literal(true), canEdit: z.boolean(), canAdmin: z.boolean(), csrf: z.string().min(1),
    gatewayUrl: portalUrl.optional(), expiresAt: z.number().positive().optional(),
    user: z.object({ id: z.string().min(1), name: z.string(), role: z.enum(["viewer", "editor", "admin"]) }),
    policy: z.array(z.object({ field: z.string().min(1), mode: z.enum(["only", "not"]), values: z.array(z.string()) })).optional(),
  }).refine(s => s.canEdit === (s.user.role !== "viewer") && s.canAdmin === (s.user.role === "admin"), "Inconsistent workspace permissions"),
]);

export interface WorkspaceSession {
  mode: "local" | "team"; authenticated: boolean; canEdit: boolean; canAdmin: boolean;
  csrf?: string; gatewayUrl?: string; expiresAt?: number; user?: { id: string; name: string; role: string };
  /** Row-level rules supplied by the authenticated gateway session. */
  policy?: { field: string; mode: "only" | "not"; values: string[] }[];
}
export const parseWorkspaceSession = (value: unknown): WorkspaceSession => sessionSchema.parse(value);

/** New tokens may refresh a session, but a different access context must never inherit its mounted dashboard or caches. */
export function sameWorkspaceAccess(a: WorkspaceSession, b: WorkspaceSession): boolean {
  const scope = (s: WorkspaceSession) => JSON.stringify([s.mode, s.user?.id, s.user?.role, s.canEdit, s.canAdmin,
    (s.policy ?? []).map(rule => JSON.stringify([rule.field, rule.mode, [...new Set(rule.values)].sort()])).sort()]);
  return a.authenticated && b.authenticated && scope(a) === scope(b);
}
