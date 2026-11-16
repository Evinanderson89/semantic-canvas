/** Bucket timestamps without an offset are warehouse calendar coordinates.
 * Interpret them consistently in UTC; explicit offsets retain their instant. */
export function coerceDate(value: unknown): unknown {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:[T ]|$)/.test(value)) return value;
  const normalized = value.replace(" ", "T");
  const date = new Date(normalized.length === 10 ? `${normalized}T00:00:00Z`
    : /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized) ? normalized : `${normalized}Z`);
  return Number.isFinite(+date) ? date : value;
}

/** Numeric warehouse strings are supported; JS coercions such as false → 0
 * and empty text → 0 are not measurements. */
export function numericValue(value: unknown): number | null {
  return (typeof value === "number" || typeof value === "string" && value.trim() !== "") && Number.isFinite(Number(value)) ? Number(value) : null;
}

export function componentValue(value: unknown): number {
  const number = numericValue(value);
  if (number === null)
    throw new Error("This chart needs a finite value for every component. Use a table to inspect missing or invalid values.");
  return number;
}

export function donutSegments(values: unknown[]) {
  const numbers = values.map(componentValue);
  if (numbers.some(value => value < 0) || !numbers.some(value => value > 0))
    throw new Error("A donut needs non-negative values with a positive total. Use a bar or table for these values.");
  // Scale first so large finite values cannot overflow the total.
  const largest = Math.max(...numbers), scaled = numbers.map(value => value / largest);
  const total = scaled.reduce((sum, value) => sum + value, 0);
  let accumulated = 0;
  return numbers.map((value, i) => {
    const start = accumulated / total;
    accumulated += scaled[i];
    return { start, end: accumulated / total, value };
  });
}
