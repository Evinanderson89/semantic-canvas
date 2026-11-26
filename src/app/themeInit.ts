export type AppTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "sc:theme";

export function resolveInitialTheme(
  storage?: Pick<Storage, "getItem"> | null,
  prefersDark?: boolean,
): AppTheme {
  try {
    const store = storage === undefined ? (typeof localStorage !== "undefined" ? localStorage : null) : storage;
    const saved = store?.getItem(THEME_STORAGE_KEY);
    if (saved === "dark" || saved === "light") return saved;
  } catch {
    // Ignore storage read errors in restricted browsing contexts.
  }
  const systemDark =
    prefersDark ??
    (typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  return systemDark ? "dark" : "light";
}

export function applyThemeToDocument(
  theme: AppTheme,
  doc: { documentElement?: { dataset?: Record<string, string | undefined> } } | null =
    typeof document !== "undefined" ? document : null,
): void {
  if (doc?.documentElement?.dataset) {
    doc.documentElement.dataset.theme = theme;
  }
}

export function formatSourceDisplayLabel(label?: string | null, id?: string | null): string {
  const trimmed = label?.trim() ?? "";
  if (trimmed.toLowerCase() === "duckglue on duckdb") {
    return "Sample SaaS Warehouse";
  }
  if (!trimmed && id === "duckglue-local") {
    return "Sample SaaS Warehouse";
  }
  if (trimmed.toLowerCase() === "duckglue") {
    return "Sample SaaS Warehouse";
  }
  return trimmed || id || "Sample SaaS Warehouse";
}

if (typeof document !== "undefined") {
  applyThemeToDocument(resolveInitialTheme());
}
