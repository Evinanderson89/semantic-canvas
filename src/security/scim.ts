import { randomUUID, timingSafeEqual } from "node:crypto";
import { writeFile } from "node:fs/promises";
import express, { type Request, type Response, type Router } from "express";
import type { CompanyAuth } from "./auth.ts";

export interface ScimUser {
  id: string;
  userName: string;
  externalId?: string;
  displayName: string;
  active: boolean;
  groups: string[];
  roles: string[];
}

export interface ScimGroupMember {
  value: string;
  display?: string;
}

export interface ScimGroup {
  id: string;
  displayName: string;
  members: ScimGroupMember[];
}

export interface ScimRouterDeps {
  auth: CompanyAuth;
  token?: string;
  storagePath?: string;
  onAudit?: (event: string, data?: Record<string, unknown>) => void;
  onChange?: (state: { users: ScimUser[]; groups: ScimGroup[] }) => void | Promise<void>;
}

const LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";
const USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
const GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";

function scimError(res: Response, status: number, detail: string) {
  return res.status(status).json({
    schemas: [ERROR_SCHEMA],
    status: String(status),
    detail,
    error: detail,
  });
}

function normalizeStringList(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const item of input) {
    const val = typeof item === "string" ? item.trim() : typeof item?.value === "string" ? item.value.trim() : typeof item?.display === "string" ? item.display.trim() : "";
    if (val && !out.includes(val)) out.push(val);
  }
  return out;
}

function normalizeMembers(input: unknown): ScimGroupMember[] {
  if (!Array.isArray(input)) return [];
  const out: ScimGroupMember[] = [];
  for (const item of input) {
    const value = typeof item === "string" ? item.trim() : typeof item?.value === "string" ? item.value.trim() : "";
    if (!value || out.some(m => m.value === value)) continue;
    const display = typeof item?.display === "string" && item.display.trim() ? item.display.trim() : undefined;
    out.push(display ? { value, display } : { value });
  }
  return out;
}

function parseActive(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.toLowerCase() === "false") return false;
    if (value.toLowerCase() === "true") return true;
  }
  return fallback;
}

function formatUser(user: ScimUser) {
  return {
    schemas: [USER_SCHEMA],
    id: user.id,
    userName: user.userName,
    ...(user.externalId ? { externalId: user.externalId } : {}),
    displayName: user.displayName,
    active: user.active,
    groups: user.groups,
    roles: user.roles,
  };
}

function formatGroup(group: ScimGroup) {
  return {
    schemas: [GROUP_SCHEMA],
    id: group.id,
    displayName: group.displayName,
    members: group.members,
  };
}

function formatList<T>(resources: T[]) {
  return {
    schemas: [LIST_SCHEMA],
    totalResults: resources.length,
    startIndex: 1,
    itemsPerPage: resources.length,
    Resources: resources,
  };
}

function revokeUserSessions(auth: CompanyAuth, user: ScimUser): number {
  const primary = user.externalId || user.userName || user.id;
  let removed = auth.revokeSubject(primary);
  for (const alt of [user.userName, user.id]) {
    if (alt && alt !== primary && auth.sessions.size > 0) removed += auth.revokeSubject(alt);
  }
  return removed;
}

export function createScimRouter(deps: ScimRouterDeps): Router & { users: Map<string, ScimUser>; groups: Map<string, ScimGroup> } {
  const router = express.Router();
  const users = new Map<string, ScimUser>();
  const groups = new Map<string, ScimGroup>();

  const persist = async () => {
    const state = { users: [...users.values()], groups: [...groups.values()] };
    if (deps.storagePath) await writeFile(deps.storagePath, JSON.stringify(state, null, 2), "utf8");
    await deps.onChange?.(state);
  };

  const syncGroupToUsers = (group: ScimGroup) => {
    const memberIds = new Set(group.members.map(m => m.value));
    for (const user of users.values()) {
      const isMember = memberIds.has(user.id) || memberIds.has(user.userName) || (user.externalId !== undefined && memberIds.has(user.externalId));
      const hasGroup = user.groups.includes(group.displayName);
      if (isMember && !hasGroup) user.groups.push(group.displayName);
      if (!isMember && hasGroup) user.groups = user.groups.filter(g => g !== group.displayName);
    }
  };

  router.use(express.json());

  router.use((req: Request, res: Response, next) => {
    res.setHeader("Cache-Control", "no-store");
    const configured = (deps.token !== undefined ? deps.token : (process.env.SC_SCIM_TOKEN ?? "")).trim();
    if (!configured) return scimError(res, 404, "SCIM provisioning is not configured");
    const match = /^Bearer\s+(\S+)$/i.exec(req.header("authorization") ?? "");
    if (!match) {
      deps.onAudit?.("scim.auth_failed", { reason: "missing_token" });
      return scimError(res, 401, "Missing SCIM bearer token");
    }
    const got = Buffer.from(match[1], "utf8");
    const want = Buffer.from(configured, "utf8");
    if (got.length !== want.length || !timingSafeEqual(got, want)) {
      deps.onAudit?.("scim.auth_failed", { reason: "invalid_token" });
      return scimError(res, 401, "Invalid SCIM bearer token");
    }
    next();
  });

  router.get("/Users", (req, res) => {
    let list = [...users.values()];
    const filter = typeof req.query.filter === "string" ? req.query.filter.trim() : "";
    const eqMatch = /^(\w+)\s+eq\s+"([^"]*)"$/i.exec(filter);
    if (eqMatch) {
      const [, attr, val] = eqMatch;
      list = list.filter(u => {
        if (attr.toLowerCase() === "username") return u.userName.toLowerCase() === val.toLowerCase();
        if (attr.toLowerCase() === "externalid") return u.externalId === val;
        return (u as unknown as Record<string, unknown>)[attr] === val;
      });
    }
    res.json(formatList(list.map(formatUser)));
  });

  router.get("/Users/:id", (req, res) => {
    const user = users.get(req.params.id);
    if (!user) return scimError(res, 404, "User not found");
    res.json(formatUser(user));
  });

  router.post("/Users", async (req, res) => {
    const body = req.body ?? {};
    const userName = typeof body.userName === "string" ? body.userName.trim() : "";
    if (!userName) return scimError(res, 400, "userName is required");
    if ([...users.values()].some(u => u.userName.toLowerCase() === userName.toLowerCase())) {
      return scimError(res, 409, "User already exists");
    }
    const user: ScimUser = {
      id: typeof body.id === "string" && body.id.trim() ? body.id.trim() : randomUUID(),
      userName,
      externalId: typeof body.externalId === "string" && body.externalId.trim() ? body.externalId.trim() : undefined,
      displayName: typeof body.displayName === "string" && body.displayName.trim() ? body.displayName.trim() : userName,
      active: parseActive(body.active, true),
      groups: normalizeStringList(body.groups),
      roles: normalizeStringList(body.roles),
    };
    users.set(user.id, user);
    if (!user.active) revokeUserSessions(deps.auth, user);
    deps.onAudit?.("scim.user_created", { id: user.id, userName: user.userName, active: user.active });
    await persist();
    res.status(201).json(formatUser(user));
  });

  const applyUserAttributes = (user: ScimUser, attrs: Record<string, unknown>) => {
    if (typeof attrs.userName === "string" && attrs.userName.trim()) user.userName = attrs.userName.trim();
    if (typeof attrs.externalId === "string") user.externalId = attrs.externalId.trim() || undefined;
    if (typeof attrs.displayName === "string" && attrs.displayName.trim()) user.displayName = attrs.displayName.trim();
    if ("active" in attrs) user.active = parseActive(attrs.active, user.active);
    if ("groups" in attrs) user.groups = normalizeStringList(attrs.groups);
    if ("roles" in attrs) user.roles = normalizeStringList(attrs.roles);
  };

  router.put("/Users/:id", async (req, res) => {
    const user = users.get(req.params.id);
    if (!user) return scimError(res, 404, "User not found");
    applyUserAttributes(user, req.body ?? {});
    if (!user.active) revokeUserSessions(deps.auth, user);
    deps.onAudit?.("scim.user_updated", { id: user.id, userName: user.userName, active: user.active });
    await persist();
    res.json(formatUser(user));
  });

  router.patch("/Users/:id", async (req, res) => {
    const user = users.get(req.params.id);
    if (!user) return scimError(res, 404, "User not found");
    const body = req.body ?? {};
    const ops = Array.isArray(body.Operations) ? body.Operations : Array.isArray(body.operations) ? body.operations : null;
    if (ops) {
      for (const op of ops) {
        const kind = String(op?.op ?? "replace").toLowerCase();
        const path = typeof op?.path === "string" ? op.path.trim() : "";
        if (kind === "remove" && path) {
          applyUserAttributes(user, { [path]: [] });
        } else if (path) {
          applyUserAttributes(user, { [path]: op.value });
        } else if (op?.value && typeof op.value === "object") {
          applyUserAttributes(user, op.value as Record<string, unknown>);
        }
      }
    } else {
      applyUserAttributes(user, body);
    }
    if (!user.active) revokeUserSessions(deps.auth, user);
    deps.onAudit?.("scim.user_updated", { id: user.id, userName: user.userName, active: user.active });
    await persist();
    res.json(formatUser(user));
  });

  router.delete("/Users/:id", async (req, res) => {
    const user = users.get(req.params.id);
    if (!user) return scimError(res, 404, "User not found");
    users.delete(user.id);
    for (const group of groups.values()) {
      group.members = group.members.filter(m => m.value !== user.id && m.value !== user.userName && m.value !== user.externalId);
    }
    revokeUserSessions(deps.auth, user);
    deps.onAudit?.("scim.user_deleted", { id: user.id, userName: user.userName });
    await persist();
    res.status(204).end();
  });

  router.get("/Groups", (req, res) => {
    let list = [...groups.values()];
    const filter = typeof req.query.filter === "string" ? req.query.filter.trim() : "";
    const eqMatch = /^displayName\s+eq\s+"([^"]*)"$/i.exec(filter);
    if (eqMatch) list = list.filter(g => g.displayName.toLowerCase() === eqMatch[1].toLowerCase());
    res.json(formatList(list.map(formatGroup)));
  });

  router.get("/Groups/:id", (req, res) => {
    const group = groups.get(req.params.id);
    if (!group) return scimError(res, 404, "Group not found");
    res.json(formatGroup(group));
  });

  router.post("/Groups", async (req, res) => {
    const body = req.body ?? {};
    const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
    if (!displayName) return scimError(res, 400, "displayName is required");
    const group: ScimGroup = {
      id: typeof body.id === "string" && body.id.trim() ? body.id.trim() : randomUUID(),
      displayName,
      members: normalizeMembers(body.members),
    };
    groups.set(group.id, group);
    syncGroupToUsers(group);
    deps.onAudit?.("scim.group_created", { id: group.id, displayName: group.displayName });
    await persist();
    res.status(201).json(formatGroup(group));
  });

  router.patch("/Groups/:id", async (req, res) => {
    const group = groups.get(req.params.id);
    if (!group) return scimError(res, 404, "Group not found");
    const body = req.body ?? {};
    const ops = Array.isArray(body.Operations) ? body.Operations : Array.isArray(body.operations) ? body.operations : null;
    if (ops) {
      for (const op of ops) {
        const kind = String(op?.op ?? "replace").toLowerCase();
        const path = typeof op?.path === "string" ? op.path.trim() : "";
        const memberFilter = /^members\[value\s+eq\s+"([^"]+)"\]$/i.exec(path);
        if (kind === "remove" && memberFilter) {
          group.members = group.members.filter(m => m.value !== memberFilter[1]);
        } else if (kind === "remove" && path.toLowerCase() === "members") {
          const toRemove = new Set(normalizeMembers(op.value).map(m => m.value));
          group.members = toRemove.size > 0 ? group.members.filter(m => !toRemove.has(m.value)) : [];
        } else if (kind === "add" && (!path || path.toLowerCase() === "members")) {
          const added = normalizeMembers(op.value?.members ?? op.value);
          for (const m of added) if (!group.members.some(existing => existing.value === m.value)) group.members.push(m);
        } else if (path.toLowerCase() === "displayname" && typeof op.value === "string" && op.value.trim()) {
          group.displayName = op.value.trim();
        } else if (path.toLowerCase() === "members") {
          group.members = normalizeMembers(op.value);
        } else if (!path && op.value && typeof op.value === "object") {
          if (typeof op.value.displayName === "string" && op.value.displayName.trim()) group.displayName = op.value.displayName.trim();
          if ("members" in op.value) group.members = normalizeMembers(op.value.members);
        }
      }
    } else {
      if (typeof body.displayName === "string" && body.displayName.trim()) group.displayName = body.displayName.trim();
      if ("members" in body) group.members = normalizeMembers(body.members);
    }
    syncGroupToUsers(group);
    deps.onAudit?.("scim.group_updated", { id: group.id, displayName: group.displayName });
    await persist();
    res.json(formatGroup(group));
  });

  router.delete("/Groups/:id", async (req, res) => {
    const group = groups.get(req.params.id);
    if (!group) return scimError(res, 404, "Group not found");
    groups.delete(group.id);
    for (const user of users.values()) {
      user.groups = user.groups.filter(g => g !== group.displayName);
    }
    deps.onAudit?.("scim.group_deleted", { id: group.id, displayName: group.displayName });
    await persist();
    res.status(204).end();
  });

  return Object.assign(router, { users, groups });
}
