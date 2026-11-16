/** Scalar numeric warehouse types. Whole-type matching excludes lists, arrays,
 * structs and similarly named user types. This classifies metadata only: it
 * does not cast values or reduce the precision of a warehouse expression. */
export function numericType(raw: string): "integer" | "double" | null {
  const type = raw.trim().toLowerCase().replace(/\s+/g, " ");
  if (/^(?:u?(?:tinyint|smallint|integer|bigint|hugeint)|int|int1|int2|int4|int8|int16|uint8|uint16|uint32|uint64|uint128|byteint|short|signed|long|int32|int64|int128|serial|smallserial|bigserial)$/.test(type)) return "integer";
  if (/^(?:float|float4|float8|real|double(?: precision)?|decfloat)$/.test(type)) return "double";
  const fixed = /^(number|numeric|decimal|dec)(?:\s*\(\s*\d+\s*(?:,\s*(\d+)\s*)?\))?$/.exec(type);
  if (fixed) {
    // Preserve explicit integral evidence. An omitted scale depends on the
    // warehouse dialect, so it does not by itself establish an integer key.
    return fixed[2] !== undefined && Number(fixed[2]) === 0 ? "integer" : "double";
  }
  return null;
}
