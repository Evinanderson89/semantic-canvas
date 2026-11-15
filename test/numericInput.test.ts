import { expect, it } from "vitest";
import { numericInput } from "../src/format/numericInput.ts";

it("preserves large integer bounds and ordinary numbers without converting an empty bound to zero", () => {
  expect(numericInput("")).toBeUndefined();
  expect(numericInput("0")).toBe(0);
  expect(numericInput("10.25")).toBe(10.25);
  expect(numericInput("9007199254740991")).toBe(9007199254740991);
  for (const raw of ["9007199254740992", "9007199254740993", "-9007199254740993", "9.007199254740993e15", "18446744073709551615"]) {
    expect(numericInput(raw)).toBe(raw);
  }
});
