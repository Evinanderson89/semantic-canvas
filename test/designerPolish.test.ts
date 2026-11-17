import { describe, expect, it } from "vitest";
import {
  DEFAULT_FORMAT,
  EDITORIAL_THEMES,
  PALETTES,
  buildChartAnnotations,
  resolveEditorialTheme,
} from "../src/format/format.ts";
import { PRESETS, presetById } from "../src/canvas/presets.ts";
import { serializeSvgElement } from "../src/app/export.ts";

describe("editorial themes and palettes", () => {
  it("provides vibrant broadside default, broadside, swiss, and editorial palettes in PALETTES", () => {
    expect(PALETTES.default).toEqual(["#2563eb", "#059669", "#d97706", "#e11d48", "#7c3aed", "#0891b2"]);
    expect(PALETTES.broadside).toEqual(["#1d4ed8", "#0f766e", "#b45309", "#be123c", "#4338ca", "#334155"]);
    expect(PALETTES.swiss).toEqual(["#dc2626", "#171717", "#525252", "#2563eb", "#ca8a04", "#737373"]);
    expect(PALETTES.editorial).toEqual(["#2f6b96", "#3d7a5a", "#b86b35", "#a84448", "#6d598a", "#4a8580"]);
  });

  it("defines all four editorial themes with expected ground, ink, accent, typography, and palette", () => {
    expect(EDITORIAL_THEMES.broadside).toMatchObject({
      ground: "#ffffff",
      ink: "#111827",
      accent: "#1d4ed8",
      displayFont: '"Bricolage Grotesque", Georgia, serif',
      bodyFont: '"Source Serif 4", Georgia, serif',
      monoFont: '"JetBrains Mono", ui-monospace, monospace',
      palette: "broadside",
    });
    expect(EDITORIAL_THEMES["newsroom-dark"]).toMatchObject({
      ground: "#0f141c",
      surface: "#161d28",
      ink: "#f3f4f6",
      accent: "#38bdf8",
      palette: "cool",
    });
    expect(EDITORIAL_THEMES["swiss-grid"]).toMatchObject({
      ground: "#ffffff",
      surface: "#fafafa",
      ink: "#0a0a0a",
      accent: "#dc2626",
      palette: "swiss",
    });
    expect(EDITORIAL_THEMES["studio-warm"]).toMatchObject({
      ground: "#faf7f2",
      surface: "#f3ede2",
      ink: "#1c1917",
      accent: "#b45309",
      palette: "editorial",
    });
  });

  it("resolves known theme ids and falls back to broadside for unknown or omitted ids", () => {
    expect(resolveEditorialTheme("swiss-grid").id).toBe("swiss-grid");
    expect(resolveEditorialTheme("newsroom-dark").id).toBe("newsroom-dark");
    expect(resolveEditorialTheme("studio-warm").id).toBe("studio-warm");
    expect(resolveEditorialTheme(undefined).id).toBe("broadside");
    expect(resolveEditorialTheme("unknown-theme").id).toBe("broadside");
  });
});

describe("buildChartAnnotations", () => {
  it("keeps safe defaults on DEFAULT_FORMAT", () => {
    expect(DEFAULT_FORMAT.targetValue).toBeNull();
    expect(DEFAULT_FORMAT.targetLabel).toBeNull();
    expect(DEFAULT_FORMAT.annotations).toEqual([]);
  });

  it("normalizes valid target lines and filters invalid callouts or out-of-domain events", () => {
    const res = buildChartAnnotations(
      {
        targetValue: 120000,
        targetLabel: "  Q4 Goal  ",
        annotations: [
          { at: "2026-02", label: "Pricing v2", kind: "launch" },
          { at: "2026-03", label: "Enterprise SLA", kind: "policy" },
          { at: "2026-04", label: "   " },
          { at: "2026-09", label: "Future event", kind: "note" },
        ],
      },
      ["2026-01", "2026-02", "2026-03", "2026-04"],
    );

    expect(res.target).toEqual({
      value: 120000,
      label: "Q4 Goal",
      style: "dashed",
    });
    expect(res.callouts).toEqual([
      { at: "2026-02", label: "Pricing v2", kind: "launch" },
      { at: "2026-03", label: "Enterprise SLA", kind: "policy" },
    ]);
  });

  it("falls back to default target label and handles missing or non-finite targets", () => {
    expect(buildChartAnnotations({ targetValue: 85 }).target).toEqual({
      value: 85,
      label: "Target 85",
      style: "dashed",
    });
    expect(buildChartAnnotations({ targetValue: Number.NaN }).target).toBeNull();
    expect(buildChartAnnotations(undefined)).toEqual({ target: null, callouts: [] });
  });
});

describe("presentation canvas presets", () => {
  it("includes the Executive Slide 16:9 (1600x900) preset", () => {
    const slide = presetById("slide-16x9");
    expect(slide).toEqual({
      id: "slide-16x9",
      label: "Executive Slide 16:9",
      group: "Presentation",
      width: 1600,
      height: 900,
      hint: "1600 × 900 board deck",
    });
    expect(PRESETS).toContainEqual(slide);
  });
});

describe("serializeSvgElement", () => {
  it("extracts svg from a container, adds namespaces, and resolves CSS tokens", () => {
    const container = {
      tagName: "DIV",
      querySelector: (sel: string) =>
        sel === "svg"
          ? {
              tagName: "svg",
              outerHTML:
                '<svg viewBox="0 0 200 100"><line stroke="var(--line)" /><text fill="var(--ink, #000)">Revenue</text><path stroke="var(--accent)" fill="var(--custom, #123456)" /></svg>',
            }
          : null,
    };

    const out = serializeSvgElement(container, { "--accent": "#dc2626" });
    expect(out).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(out).toContain('xmlns:xlink="http://www.w3.org/1999/xlink"');
    expect(out).toContain('stroke="#e5e7eb"');
    expect(out).toContain('fill="#111827"');
    expect(out).toContain('stroke="#dc2626"');
    expect(out).toContain('fill="#123456"');
  });

  it("accepts a direct <svg> element and throws when no <svg> is present", () => {
    const direct = serializeSvgElement({
      tagName: "SVG",
      outerHTML: '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="var(--surface)" /></svg>',
    });
    expect(direct).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(direct).toContain('xmlns:xlink="http://www.w3.org/1999/xlink"');
    expect(direct).toContain('fill="#ffffff"');

    expect(() => serializeSvgElement({ tagName: "DIV", querySelector: () => null })).toThrow(/no <svg>/i);
  });
});
