import { expect, it } from "vitest";
import { isNumeric } from "../src/semantic/model.ts";
import { normalizeType } from "../src/modeler/propose.ts";

it("recognizes scalar numeric types used by Snowflake and DuckDB", () => {
  for (const type of ["NUMBER", " number (38, 2) ", "DEC", "DECIMAL(18, 2)", "NUMERIC(10,0)",
    "TINYINT", "BYTEINT", "SMALLINT", "INTEGER", "BIGINT", "HUGEINT", "UTINYINT", "USMALLINT", "UINTEGER", "UBIGINT", "UHUGEINT",
    "INT1", "INT2", "INT4", "INT8", "INT16", "UINT8", "UINT16", "UINT32", "UINT64", "UINT128",
    "FLOAT", "FLOAT4", "FLOAT8", "DOUBLE PRECISION", "REAL", "DECFLOAT"]) {
    expect(isNumeric({ name: "value", type }), type).toBe(true);
    expect(["integer", "double"], type).toContain(normalizeType(type));
  }
});

it("does not infer a scalar measure from arrays, containers or a type-name substring", () => {
  for (const type of ["INTEGER[]", "DOUBLE[3]", "DECIMAL(12,2)[]", "ARRAY(NUMBER)", "MAP(VARCHAR, INTEGER)",
    "STRUCT(amount DOUBLE)", "INTERVAL", "REALITY", "NUMBER_CODE", "INTENSITY", "BOOLEAN", "VARCHAR", "VARIANT", "JSON"]) {
    expect(isNumeric({ name: "value", type }), type).toBe(false);
    expect(["integer", "double"], type).not.toContain(normalizeType(type));
  }
});

it("retains explicit zero scale for Modeler key inference without coercing fractional types", () => {
  expect(normalizeType(" number (38, 0) ")).toBe("integer");
  expect(normalizeType("NUMERIC(20,0)")).toBe("integer");
  expect(normalizeType("NUMBER(18,2)")).toBe("double");
  expect(normalizeType("DECFLOAT")).toBe("double");
});
