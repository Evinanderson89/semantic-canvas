/** Keep ordinary numeric bounds ergonomic, but never round an integer outside
 * the safe JS range while the user is editing a warehouse filter. The compiler
 * already accepts exact numeric text as a bound. */
export function numericInput(raw: string): number | string | undefined {
  if (raw === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && !(Number.isInteger(value) && !Number.isSafeInteger(value)) ? value : raw;
}
