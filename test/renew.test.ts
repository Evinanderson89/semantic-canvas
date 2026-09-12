import { describe, expect, it } from "vitest";
import { renewDelay, RENEW_LEAD_MS } from "../src/app/Session.tsx";

describe("silent renewal timing", () => {
  it("fires a minute before expiry", () => { expect(renewDelay(1_000_000 + 15 * 60_000, 1_000_000)).toBe(14 * 60_000); });
  it("never fires sooner than five seconds, even when expiry is imminent or past", () => {
    expect(renewDelay(1_000_000 + 30_000, 1_000_000)).toBe(5_000);
    expect(renewDelay(1_000_000 - 1, 1_000_000)).toBe(5_000);
  });
  it("uses the shared lead so the portal page and the app agree", () => { expect(RENEW_LEAD_MS).toBe(60_000); });
});
