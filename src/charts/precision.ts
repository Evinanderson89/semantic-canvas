/** Canonical decimal text, without casting its coefficient to a Number. */
function decimal(text: string): { digits: string; exponent: number; key: string } | null {
  const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:e([+-]?\d+))?$/i.exec(text.trim());
  if (!match) return null;
  const fraction = match[3] ?? match[4] ?? "";
  let digits = `${match[2] ?? ""}${fraction}`.replace(/^0+/, "");
  if (!digits) return { digits: "0", exponent: 0, key: "0" };
  const trailing = digits.length - digits.replace(/0+$/, "").length;
  digits = digits.slice(0, digits.length - trailing);
  const exponent = Number(match[5] ?? 0) - fraction.length + trailing;
  return { digits, exponent, key: `${match[1] === "-" ? "-" : ""}${digits}e${exponent}` };
}

/** A display/calculation limitation, not evidence of bad warehouse data.
 * Safe integers and ordinary decimal text stay usable. High-precision text,
 * underflow, and integers beyond the safe range require source-side comparison.
 * This does not certify exact binary arithmetic for every other value. */
export function hasPrecisionRisk(value: unknown): boolean {
  if (typeof value !== "string" && typeof value !== "number") return false;
  const number = Number(value);
  if (!Number.isFinite(number)) return false; // handled by invalid-value checks
  if (Number.isInteger(number) && !Number.isSafeInteger(number)) return true;
  if (typeof value === "number") return false; // cannot reconstruct lost input digits
  const exact = decimal(value);
  if (!exact) return false;
  return exact.key !== decimal(String(number))?.key || exact.exponent < 0 && exact.digits.length > 15;
}
