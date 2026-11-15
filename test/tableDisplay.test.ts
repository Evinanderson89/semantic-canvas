import { expect, it } from "vitest";
import { model, tile } from "./fixtures.ts";
import { compareTableNumbers, tableCell, tableDisplay, tableNumber } from "../src/format/tableDisplay.ts";
import { toCsv } from "../src/app/export.ts";

it("retains governed units and distinguishes percentage points from relative change", () => {
  const display = tableDisplay(model, tile({ metrics: ["revenue", "retention"] }));
  expect(tableCell("123456.78", display.revenue)).toBe("$123,456.78");
  expect(tableCell(.94, display.retention)).toBe("94.0%");
  expect(tableCell(-.016, display.retention__delta)).toBe("−1.6 pp");
  expect(tableCell(-.016, display.retention__pct)).toBe("−1.6%");
  expect(display.retention__prev.label).toContain("Prior period");
  expect(display.retention__delta.label).toContain("Change (pp)");
  const categories = tableDisplay(model, tile({ metrics: ["revenue"], dimensions: ["dim_users.country", "month:fct_sales.sold_on"] }));
  expect(categories.country.label).toBe("Country");
  expect(categories.sold_on_month.label).toBe("Sold on · Month");
  expect(tableCell("001", categories.country)).toBe("001");
  expect(categories.constructor).toBeUndefined();
});

it("preserves categories, unknown values, explicit compact preference and raw CSV", () => {
  const display = tableDisplay(model, tile({ metrics: ["revenue"], format: { number: "compact" } }));
  expect(tableCell(123456, display.revenue)).toBe("123k");
  for (const value of [null, undefined, "", " ", false, true, NaN, Infinity, "invalid"]) expect(tableNumber(value)).toBeNull();
  expect(tableNumber("0")).toBe(0);
  expect(tableCell(null, display.revenue)).toBe("—");
  expect(tableCell("001")).toBe("001");
  expect(tableCell(2026)).toBe("2026");
  const rows = [["001", "123456.78", .94, null]];
  const before = toCsv(["id", "revenue", "retention", "missing"], rows);
  rows.forEach(row => row.forEach(value => tableCell(value, display.revenue)));
  expect(toCsv(["id", "revenue", "retention", "missing"], rows)).toBe(before);
  expect(before).toContain("001,123456.78,0.94,");
});

it("shows high-precision returned text instead of changing it during formatting", () => {
  const display = tableDisplay(model, tile({ metrics: ["revenue", "retention"] }));
  expect(tableCell("9007199254740993", display.revenue)).toBe("9007199254740993");
  expect(tableCell("0.12345678901234567890", display.retention)).toBe("0.12345678901234567890");
  expect(tableCell("1e-400", display.revenue)).toBe("1e-400");
});


it.each([
  ["9007199254740992", "9007199254740993", -1],
  ["-9007199254740993", "-9007199254740992", -1],
  ["0.12345678901234567891", "0.12345678901234567890", 1],
  ["1e-400", "2e-400", -1],
  ["-1e-400", "0", -1],
  ["1e-100000000000000000000", "1e-99999999999999999999", -1],
  ["0.0100", "1e-2", 0],
  ["-0", "+0.000", 0],
  ["9", "100", -1],
  ["0x10", "16", 0],
])("sorts original decimal values %s and %s without rounded ties", (a, b, expected) => {
  expect(compareTableNumbers(a, b)).toBe(expected);
  expect(compareTableNumbers(b, a) || 0).toBe(-expected || 0);
});
