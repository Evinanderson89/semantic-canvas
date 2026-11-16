import { expect, it } from "vitest";
import { parseWorkspaceSession, sameWorkspaceAccess } from "../src/app/sessionContract.ts";

const editor = { mode: "team", authenticated: true, user: { id: "editor", name: "Editor", role: "editor" }, csrf: "test-csrf", canEdit: true, canAdmin: false };
it("accepts the server's local, signed-out and company session contracts", () => {
  expect(parseWorkspaceSession({ mode: "local", authenticated: true, canEdit: true, canAdmin: true }).authenticated).toBe(true);
  expect(parseWorkspaceSession({ mode: "team", authenticated: false })).toEqual({ mode: "team", authenticated: false, canEdit: false, canAdmin: false });
  expect(parseWorkspaceSession(editor)).toEqual(editor);
});
it.each([
  ["truthy authentication", { ...editor, authenticated: "false" }],
  ["missing identity", { ...editor, user: undefined }],
  ["empty identity", { ...editor, user: { ...editor.user, id: "" } }],
  ["invalid portal", { ...editor, gatewayUrl: "javascript:alert(1)" }],
  ["invalid expiry", { ...editor, expiresAt: Infinity }],
  ["inconsistent permissions", { ...editor, canAdmin: true }],
  ["invalid policy", { ...editor, policy: [{ field: "dim_users.country", mode: "only", values: [42] }] }],
])("rejects %s before opening a workspace", (_name, value) => {
  expect(() => parseWorkspaceSession(value)).toThrow();
});
it("allows token renewal and display-name updates without resetting the same access scope", () => {
  const before = parseWorkspaceSession({ ...editor, policy: [{ field: "dim_users.country", mode: "only", values: ["DE", "FR"] }] });
  const after = parseWorkspaceSession({ ...editor, csrf: "new-csrf", expiresAt: Date.now() + 60_000, user: { ...editor.user, name: "Renamed" }, policy: [{ field: "dim_users.country", mode: "only", values: ["FR", "DE"] }] });
  expect(sameWorkspaceAccess(before, after)).toBe(true);
  expect(sameWorkspaceAccess(before, parseWorkspaceSession(editor))).toBe(false);
});
