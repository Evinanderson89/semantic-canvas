import { useEffect, useRef, useState } from "react";
import { StudioDialog } from "./StudioDialog.tsx";
import { readResponse } from "./http.ts";
import {
  buildSampleWorkbookPayload,
  formatSpreadsheetMatchRate,
  SAMPLE_WORKBOOKS,
  type SampleWorkbookId,
  type SampleWorkbookMeta,
  type SpreadsheetColumnProfile,
  type SpreadsheetColumnRole,
  type SpreadsheetDetectedJoin,
  type SpreadsheetJoinFanoutImpact,
  type SpreadsheetJoinResolution,
  type SpreadsheetPreview,
  type SpreadsheetSheetPreview,
} from "../modeler/spreadsheetTypes.ts";

export function isCurrencyMetricHint(
  metricColumn: string,
  metricLabel: string,
  sheets?: SpreadsheetSheetPreview[] | null,
  leftTable?: string,
): boolean {
  const leftSheet = leftTable ? sheets?.find((s) => s.tableName === leftTable) : undefined;
  const matchedCol = leftSheet?.columns.find((c) => c.name === metricColumn);
  if (matchedCol) return matchedCol.formatHint === "currency";
  return /\$|usd|eur|gbp|sales|rev|revenue|mrr|arr|cost|spend|price|amount|profit|budget/i.test(
    `${metricColumn} ${metricLabel}`,
  );
}

export function formatFanoutNumber(value: number, currency: boolean): string {
  if (!Number.isFinite(value)) return String(value);
  const isInt = Math.abs(value - Math.round(value)) < 1e-6;
  if (currency) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: isInt ? 0 : 2,
      maximumFractionDigits: isInt ? 0 : 2,
    }).format(value);
  }
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: isInt ? 0 : 2,
  });
}

export function formatFanoutImpactSummary(impact: SpreadsheetJoinFanoutImpact, currency: boolean): string {
  return `joining raw rows would inflate ${impact.metricLabel} from ${formatFanoutNumber(impact.trueTotal, currency)} to ${formatFanoutNumber(impact.inflatedTotal, currency)} (+${formatFanoutNumber(impact.delta, currency)} double-count)`;
}

export function effectiveJoinResolution(join: SpreadsheetDetectedJoin): SpreadsheetJoinResolution {
  if (!join.include || join.resolution === "exclude") return "exclude";
  if (join.resolution === "one_to_many") return "one_to_many";
  return "deduplicate";
}

export function applyJoinResolution(
  join: SpreadsheetDetectedJoin,
  resolution: SpreadsheetJoinResolution,
): SpreadsheetDetectedJoin {
  if (resolution === "deduplicate") {
    return { ...join, include: true, resolution: "deduplicate" };
  }
  if (resolution === "one_to_many") {
    return { ...join, include: true, resolution: "one_to_many" };
  }
  return { ...join, include: false, resolution: "exclude" };
}

const JOIN_RESOLUTION_OPTIONS: { value: SpreadsheetJoinResolution; label: string }[] = [
  { value: "deduplicate", label: "Deduplicate key (1 row per ID)" },
  { value: "one_to_many", label: "Keep all rows as 1:N (block fan-out sums)" },
  { value: "exclude", label: "Skip join" },
];

export function SpreadsheetJoinsSection({
  joins,
  sheets = null,
  onChange,
}: {
  joins: SpreadsheetDetectedJoin[];
  sheets?: SpreadsheetSheetPreview[] | null;
  onChange: (updater: (prev: SpreadsheetDetectedJoin[]) => SpreadsheetDetectedJoin[]) => void;
}) {
  if (joins.length === 0) return null;
  const includedJoinCount = joins.filter((j) => j.include).length;

  return (
    <div className="sheet-joins-box" aria-label="Detected cross-sheet joins">
      <div className="sheet-joins-head">
        <strong>Auto-detected cross-sheet joins ({includedJoinCount}/{joins.length})</strong>
        <span className="muted sm">Canonical key match &amp; N:1 cardinality check across your Excel tabs</span>
      </div>
      <div className="sheet-joins-list">
        {joins.map((j, idx) => {
          const itemKey = `${j.leftTable}.${j.leftColumn}->${j.rightTable}.${j.rightColumn}`;
          const matchLabel = `${formatSpreadsheetMatchRate(j.matchRate)} matched`;

          const orphanTotal = (j as SpreadsheetDetectedJoin & { orphanLeftDollarTotal?: number; orphanMetricLabel?: string }).orphanLeftDollarTotal;
          const orphanMetricLabel = (j as SpreadsheetDetectedJoin & { orphanLeftDollarTotal?: number; orphanMetricLabel?: string }).orphanMetricLabel;
          const orphanIsCurrency = orphanMetricLabel
            ? isCurrencyMetricHint(orphanMetricLabel, orphanMetricLabel, sheets, j.leftTable)
            : true;

          if (j.rightKeyUnique !== false) {
            return (
              <div key={itemKey} className="sheet-join-entry clean">
                <label className="sheet-join-item">
                  <input
                    type="checkbox"
                    checked={j.include}
                    onChange={(e) =>
                      onChange((prev) => prev.map((x, k) => (k === idx ? { ...x, include: e.target.checked } : x)))
                    }
                  />
                  <span className="mono">{j.leftTable}.{j.leftColumn}</span>
                  <span className="muted">→</span>
                  <span className="mono">{j.rightTable}.{j.rightColumn}</span>
                  {j.unmatchedLeftRows ? (
                    <span className="muted sm">({j.unmatchedLeftRows.toLocaleString("en-US")} unmatched)</span>
                  ) : null}
                  <span className="sheet-join-rate verified">
                    {matchLabel} · ✓ Unique key (N:1 verified)
                  </span>
                </label>
                {j.include && j.unmatchedLeftRows && j.unmatchedLeftRows > 0 && typeof orphanTotal === "number" && orphanTotal > 0 ? (
                  <p className="sheet-join-orphan-warn" role="status">
                    ⚠️ {formatFanoutNumber(orphanTotal, orphanIsCurrency)} of {orphanMetricLabel || "total"} across{" "}
                    {j.unmatchedLeftRows.toLocaleString("en-US")} unmatched {j.leftTable} row{j.unmatchedLeftRows === 1 ? "" : "s"} has no matching{" "}
                    {j.rightTable}.{j.rightColumn} and will group as <strong>Unassigned</strong>.
                  </p>
                ) : null}
              </div>
            );
          }

          const resMode = effectiveJoinResolution(j);
          const rightSheet = sheets?.find((s) => s.tableName === j.rightTable);
          const rightSheetLabel = rightSheet?.sheetName ?? j.rightTable;
          const rightColObj = rightSheet?.columns.find((c) => c.name === j.rightColumn);
          const rightColLabel = rightColObj?.originalHeader || rightColObj?.label || j.rightColumn;
          const dupKeys = j.duplicateKeys ?? [];
          const dupCount = j.duplicateKeyCount ?? (dupKeys.length || 1);
          const keySummary = dupKeys.map((d) => d.key).join(", ");
          const conflictingCols = Array.from(new Set(dupKeys.flatMap((d) => d.conflictingColumns)));
          const currency = j.fanoutImpact
            ? isCurrencyMetricHint(j.fanoutImpact.metricColumn, j.fanoutImpact.metricLabel, sheets, j.leftTable)
            : false;

          return (
            <div key={itemKey} className="sheet-join-entry duplicate">
              <label className="sheet-join-item">
                <input
                  type="checkbox"
                  checked={j.include}
                  onChange={(e) =>
                    onChange((prev) =>
                      prev.map((x, k) =>
                        k === idx ? applyJoinResolution(x, e.target.checked ? "deduplicate" : "exclude") : x,
                      ),
                    )
                  }
                />
                <span className="mono">{j.leftTable}.{j.leftColumn}</span>
                <span className="muted">→</span>
                <span className="mono">{j.rightTable}.{j.rightColumn}</span>
                {j.unmatchedLeftRows ? (
                  <span className="muted sm">({j.unmatchedLeftRows.toLocaleString("en-US")} unmatched)</span>
                ) : null}
                <span className="sheet-join-badges">
                  <span className="sheet-join-rate">{matchLabel}</span>
                  <span
                    className={`sheet-join-guard-pill ${
                      resMode === "deduplicate" ? "guarded" : resMode === "one_to_many" ? "one-to-many" : "paused"
                    }`}
                  >
                    {resMode === "deduplicate"
                      ? "✓ Fan-out prevented (1 row/ID)"
                      : resMode === "one_to_many"
                        ? "1:N guarded (sums blocked)"
                        : "⚠️ Duplicate key paused"}
                  </span>
                </span>
              </label>

              <div
                className={`sheet-join-fanout-card ${j.allExactDuplicates ? "exact" : "conflict"}`}
                role="region"
                aria-label={`Data error caught on ${j.rightTable}.${j.rightColumn}`}
              >
                <div className="sheet-join-fanout-kicker">
                  {j.allExactDuplicates
                    ? "✨ DATA ERROR CAUGHT · EXACT DUPLICATE LOOKUP ROW"
                    : "⚠️ DATA ERROR CAUGHT · CONFLICTING DUPLICATE JOIN KEY"}
                </div>
                <p className="sheet-join-fanout-copy">
                  <strong>
                    Caught {dupCount} duplicate ID{dupCount === 1 ? "" : "s"}
                    {keySummary ? ` (${keySummary})` : ""} in {rightSheetLabel}.{rightColLabel}
                  </strong>
                  {j.fanoutImpact && j.fanoutImpact.delta > 0 ? (
                    <> — {formatFanoutImpactSummary(j.fanoutImpact, currency)}.</>
                  ) : (
                    <> — joining raw rows would multiply matched {j.leftTable} rows (1:N fan-out).</>
                  )}
                </p>
                <p className="sheet-join-fanout-sub">
                  {j.allExactDuplicates
                    ? "All columns on the duplicate lookup row(s) match identically — deduplicating keeps 1 clean row per ID."
                    : `Duplicate rows conflict in ${conflictingCols.length ? conflictingCols.join(", ") : "lookup attributes"} — inspect below and choose how to resolve.`}
                </p>

                {dupKeys.length > 0 && (
                  <details className="sheet-join-dup-drawer">
                    <summary>
                      Inspect duplicate key rows in {rightSheetLabel} ({dupKeys.length})
                    </summary>
                    <ul className="sheet-join-dup-list">
                      {dupKeys.map((dk) => (
                        <li key={dk.key}>
                          <code className="mono">{dk.key}</code> · <strong>{dk.rightRows} rows</strong>
                          {dk.rowNumbers.length > 0
                            ? ` (rows ${dk.rowNumbers.map((n) => `#${n}`).join(", ")})`
                            : ""}{" "}
                          ·{" "}
                          {dk.exactDuplicate ? (
                            <span className="dup-exact-tag">Exact duplicate across all columns</span>
                          ) : (
                            <span className="dup-conflict-tag">
                              Conflicting columns: {dk.conflictingColumns.join(", ")}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}

                <div
                  className="sheet-join-resolutions"
                  role="radiogroup"
                  aria-label={`Join resolution for ${j.leftTable}.${j.leftColumn} to ${j.rightTable}.${j.rightColumn}`}
                >
                  {JOIN_RESOLUTION_OPTIONS.map((opt) => {
                    const active = resMode === opt.value;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        className={`sheet-join-res-pill${active ? " active" : ""}`}
                        onClick={() =>
                          onChange((prev) => prev.map((x, k) => (k === idx ? applyJoinResolution(x, opt.value) : x)))
                        }
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export async function quickImportSampleWorkbook(
  id: SampleWorkbookId,
  opts?: { joinsOverride?: SpreadsheetDetectedJoin[]; customSourceId?: string },
): Promise<{
  sourceId: string;
  label: string;
  tableName: string;
  metrics: string[];
}> {
  const built = await buildSampleWorkbookPayload(id);
  const preview = (await fetch("/api/modeler/spreadsheet/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fileName: built.fileName, format: built.format, content: built.content }),
  }).then(readResponse)) as SpreadsheetPreview;
  const rawJoins = opts?.joinsOverride && opts.joinsOverride.length > 0
    ? opts.joinsOverride
    : (preview.detectedJoins ?? []);
  const preparedJoins = rawJoins.map((j) => {
    if (j.rightKeyUnique === false) {
      const resMode = effectiveJoinResolution(j);
      return {
        ...j,
        include: resMode !== "exclude",
        resolution: resMode,
        cardinality: resMode === "one_to_many" ? ("one_to_many" as const) : ("many_to_one" as const),
      };
    }
    return j;
  });
  const res = await fetch("/api/modeler/spreadsheet/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      fileName: built.fileName,
      format: built.format,
      content: built.content,
      sourceId: opts?.customSourceId ?? built.meta.preferredSourceId,
      label: built.meta.title,
      grain: preview.suggestedGrain,
      timeColumn: preview.suggestedTimeColumn ?? null,
      reportingLag: built.meta.defaultLag,
      choices: preview.columns.map((c) => ({ name: c.name, role: c.role, label: c.label })),
      joins: preparedJoins,
    }),
  }).then(readResponse);
  return {
    sourceId: res.sourceId,
    label: built.meta.title,
    tableName: res.tableName,
    metrics: res.metrics ?? [],
  };
}

const ROLE_META: Record<SpreadsheetColumnRole, { label: string; badge: string; next: SpreadsheetColumnRole }> = {
  date: { label: "📅 Date", badge: "role-date", next: "category" },
  metric: { label: "📈 Metric", badge: "role-metric", next: "category" },
  id: { label: "🔑 Row ID", badge: "role-id", next: "category" },
  category: { label: "🏷️ Filter / Group", badge: "role-category", next: "metric" },
};

const GRAIN_CHIPS = [
  "One sale or order",
  "One customer or account",
  "One monthly summary",
  "One support ticket or event",
];

const LAG_OPTIONS = [
  { days: 0, label: "No, numbers are final right away" },
  { days: 2, label: "Yes, hatch last 2 days as settling" },
  { days: 7, label: "Yes, hatch last 7 days as settling" },
];

function nextRoleFor(col: SpreadsheetColumnProfile, current: SpreadsheetColumnRole): SpreadsheetColumnRole {
  if (col.sqlType === "DATE") return current === "date" ? "category" : "date";
  if (col.sqlType === "DOUBLE" || col.sqlType === "BIGINT") {
    return current === "metric" ? "category" : current === "category" ? "id" : "metric";
  }
  return current === "id" ? "category" : "id";
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function SpreadsheetImport({
  initialSample = null,
  initialFile = null,
  sandboxMode = false,
  onClose,
  onImported,
}: {
  initialSample?: SampleWorkbookId | null;
  initialFile?: File | null;
  sandboxMode?: boolean;
  onClose: () => void;
  onImported: (result: { sourceId: string; label: string; tableName: string; metrics: string[] }) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const autoLoadedSample = useRef<SampleWorkbookId | null>(null);
  const autoLoadedFile = useRef<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState<"preview" | "import" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeSample, setActiveSample] = useState<SampleWorkbookMeta | null>(null);

  const [payload, setPayload] = useState<{ fileName: string; format: "csv" | "xlsx"; content: string } | null>(null);
  const [preview, setPreview] = useState<SpreadsheetPreview | null>(null);
  const [activeSheetIdx, setActiveSheetIdx] = useState(0);
  const [joins, setJoins] = useState<SpreadsheetDetectedJoin[]>([]);
  const [label, setLabel] = useState("");
  const [grain, setGrain] = useState("");
  const [timeColumn, setTimeColumn] = useState<string>("");
  const [reportingLag, setReportingLag] = useState<number>(0);
  const [roles, setRoles] = useState<Record<string, SpreadsheetColumnRole>>({});

  const requestPreview = async (
    next: { fileName: string; format: "csv" | "xlsx"; content: string },
    sampleMeta: SampleWorkbookMeta | null = null,
  ) => {
    setBusy("preview");
    setError(null);
    try {
      const data = (await fetch("/api/modeler/spreadsheet/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(next),
      }).then(readResponse)) as SpreadsheetPreview;
      const primaryIdx = data.sheets && data.sheets.length > 0
        ? Math.max(0, data.sheets.findIndex((s) => s.tableName === data.tableName))
        : 0;
      setPayload(next);
      setPreview(data);
      setActiveSample(sampleMeta);
      setActiveSheetIdx(primaryIdx);
      setJoins(data.detectedJoins ?? []);
      setLabel(sampleMeta?.title ?? data.label);
      setGrain(data.suggestedGrain);
      setTimeColumn(data.suggestedTimeColumn ?? "");
      setReportingLag(sampleMeta?.defaultLag ?? 0);
      setRoles(Object.fromEntries(data.columns.map((c) => [c.name, c.role])));
    } catch (e: any) {
      setError(e?.message ?? "Could not read that spreadsheet. Try a .csv or .xlsx file.");
    } finally {
      setBusy(null);
    }
  };

  const handleFile = async (file?: File | null) => {
    if (!file) return;
    if (file.size > 7 * 1024 * 1024) {
      setError("Spreadsheet exceeds the 7 MB upload limit.");
      return;
    }
    const lower = file.name.toLowerCase();
    if (lower.endsWith(".xlsx")) {
      const buf = await file.arrayBuffer();
      await requestPreview({ fileName: file.name, format: "xlsx", content: arrayBufferToBase64(buf) }, null);
    } else if (lower.endsWith(".csv") || lower.endsWith(".tsv") || file.type.includes("csv") || file.type === "text/plain") {
      const text = await file.text();
      await requestPreview({ fileName: file.name, format: "csv", content: text }, null);
    } else {
      setError("Please upload an Excel (.xlsx) or CSV (.csv / .tsv) spreadsheet.");
    }
  };

  const loadSampleWorkbook = async (id: SampleWorkbookId) => {
    setBusy("preview");
    setError(null);
    try {
      const built = await buildSampleWorkbookPayload(id);
      await requestPreview({ fileName: built.fileName, format: built.format, content: built.content }, built.meta);
    } catch (e: any) {
      setError(e?.message ?? "Could not prepare sample workbook.");
      setBusy(null);
    }
  };

  const instantOpenSample = async (id: SampleWorkbookId) => {
    setBusy("import");
    setError(null);
    try {
      const imported = await quickImportSampleWorkbook(id);
      onImported(imported);
    } catch (e: any) {
      setError(e?.message ?? "Could not import sample workbook.");
    } finally {
      setBusy(null);
    }
  };

  const downloadRawSample = async (id: SampleWorkbookId) => {
    try {
      const built = await buildSampleWorkbookPayload(id);
      let blob: Blob;
      if (built.format === "xlsx") {
        const bin = atob(built.content);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      } else {
        blob = new Blob([built.content], { type: "text/csv;charset=utf-8" });
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = built.fileName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e: any) {
      setError(e?.message ?? "Could not download raw sample.");
    }
  };

  useEffect(() => {
    if (!initialSample || autoLoadedSample.current === initialSample) return;
    autoLoadedSample.current = initialSample;
    void loadSampleWorkbook(initialSample);
  }, [initialSample]);

  useEffect(() => {
    if (!initialFile || autoLoadedFile.current === initialFile) return;
    autoLoadedFile.current = initialFile;
    void handleFile(initialFile);
  }, [initialFile]);

  const handleImport = async () => {
    if (!payload || !preview || busy) return;
    setBusy("import");
    setError(null);
    try {
      const choices = preview.columns.map((c) => ({
        name: c.name,
        role: roles[c.name] ?? c.role,
        label: c.label,
      }));
      const preparedJoins = joins.map((j) => {
        if (j.rightKeyUnique === false) {
          const resMode = effectiveJoinResolution(j);
          return {
            ...j,
            include: resMode !== "exclude",
            resolution: resMode,
            cardinality: resMode === "one_to_many" ? ("one_to_many" as const) : ("many_to_one" as const),
          };
        }
        return j;
      });
      const response = await fetch("/api/modeler/spreadsheet/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...payload,
          sourceId: preview.sourceId,
          label: label.trim() || preview.label,
          grain: grain.trim() || preview.suggestedGrain,
          timeColumn: timeColumn || null,
          reportingLag,
          choices,
          joins: preparedJoins,
        }),
      });
      if (response.status === 400) {
        const body = await response.clone().json().catch(() => null);
        if (body?.error === "duplicate_join_key") {
          if (Array.isArray(body.duplicateJoins) && body.duplicateJoins.length > 0) {
            setJoins(body.duplicateJoins);
          }
          throw new Error(body.message || "Duplicate join key detected — choose Deduplicate or 1:N before importing.");
        }
      }
      const res = await readResponse(response);
      onImported({
        sourceId: res.sourceId,
        label: label.trim() || preview.label,
        tableName: res.tableName,
        metrics: res.metrics ?? [],
      });
    } catch (e: any) {
      setError(e?.message ?? "Could not import this spreadsheet.");
    } finally {
      setBusy(null);
    }
  };

  const sheets = preview?.sheets && preview.sheets.length > 0 ? preview.sheets : null;
  const shownSheet = sheets ? sheets[Math.min(activeSheetIdx, sheets.length - 1)] : null;
  const shownColumns = shownSheet ? shownSheet.columns : (preview?.columns ?? []);
  const shownRows = shownSheet ? shownSheet.previewRows : (preview?.previewRows ?? []);
  const isPrimarySheet = !sheets || (shownSheet ? shownSheet.tableName === preview?.tableName : activeSheetIdx === 0);
  const includedJoinCount = joins.filter((j) => j.include).length;
  const dateCols = preview?.columns.filter((c) => c.sqlType === "DATE") ?? [];
  const metricCount = preview
    ? preview.columns.filter((c) => (roles[c.name] ?? c.role) === "metric" && (c.sqlType === "DOUBLE" || c.sqlType === "BIGINT")).length
    : 0;

  return (
    <StudioDialog title="Drop an Excel or CSV spreadsheet" onClose={onClose} className="sheet-import-dialog">
      <div className="sheet-import-body">
        <input
          ref={inputRef}
          type="file"
          accept=".xlsx,.csv,.tsv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          hidden
          aria-label="Upload Excel or CSV spreadsheet"
          onChange={(e) => {
            void handleFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />

        {!preview ? (
          <>
            <div
              className={`sheet-dropzone${dragging ? " dragging" : ""}`}
              onClick={() => inputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                void handleFile(e.dataTransfer.files?.[0]);
              }}
            >
              <h3>Drop your Excel (.xlsx) or CSV sheet here</h3>
              <p>
                {sandboxMode
                  ? "No SQL, YAML, or database setup required. Processed in an isolated, ephemeral server DuckDB session scoped to your browser—invisible to other sandbox visitors and automatically cleaned up."
                  : "No SQL, YAML, or database setup required. Title rows, Total double-counts, formula errors, wide month columns, and multi-tab joins are cleaned in your workspace DuckDB."}
              </p>
              <div className="sheet-dropzone-actions" onClick={(e) => e.stopPropagation()}>
                <button type="button" className="primary small" disabled={busy !== null} onClick={() => inputRef.current?.click()}>
                  {busy === "preview" ? "Reading spreadsheet…" : "Choose .xlsx or .csv file"}
                </button>
              </div>
            </div>

            <div className="sample-workbooks-section" aria-label="Try a messy real-world sample workbook">
              <div className="sample-workbooks-head">
                <span className="broadside-eyebrow">NO FILE HANDY? TRY A REAL-WORLD MESSY WORKBOOK</span>
                <span className="muted sm">Inspect how ugly corporate traps get cleaned—or download the raw file to check in Excel</span>
              </div>
              <div className="sample-workbooks-grid">
                {SAMPLE_WORKBOOKS.map((wb) => (
                  <article key={wb.id} className="sample-workbook-card">
                    <div className="sample-wb-top">
                      <span className="sample-wb-badge">{wb.badge}</span>
                      <span className="mono muted sm">.{wb.format}</span>
                    </div>
                    <h4>{wb.title}</h4>
                    <p>{wb.summary}</p>
                    <div className="sample-wb-traps" aria-label="Traps automatically cleaned">
                      {wb.trapsFixed.map((trap) => (
                        <span key={trap} className="sample-wb-trap">✓ {trap}</span>
                      ))}
                    </div>
                    <div className="sample-wb-actions">
                      <button
                        type="button"
                        className="review-action"
                        disabled={busy !== null}
                        onClick={() => void loadSampleWorkbook(wb.id)}
                      >
                        Inspect cleaning
                      </button>
                      <button
                        type="button"
                        className="primary small"
                        disabled={busy !== null}
                        onClick={() => void instantOpenSample(wb.id)}
                      >
                        ⚡ Clean &amp; Open
                      </button>
                      <button
                        type="button"
                        className="link sm"
                        disabled={busy !== null}
                        title={`Download raw ${wb.fileName} to inspect in Excel or Numbers`}
                        onClick={() => void downloadRawSample(wb.id)}
                      >
                        ⬇ Raw
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            </div>
            {error && <p className="conn-err" role="alert">{error}</p>}
          </>
        ) : (
          <>
            <div className="mrow-top">
              <div>
                <strong>{preview.label}</strong>
                <span className="muted sm">
                  {" "}· {sheets && sheets.length > 1 ? `${sheets.length} sheets · ` : ""}
                  {(shownSheet?.rowCount ?? preview.rowCount).toLocaleString()} rows · {shownColumns.length} columns
                  {isPrimarySheet ? " · Click any column pill below to adjust its role" : " · Lookup / related sheet"}
                </span>
              </div>
              <div className="story-actions">
                {activeSample && (
                  <button
                    type="button"
                    className="link sm"
                    disabled={busy !== null}
                    onClick={() => void downloadRawSample(activeSample.id)}
                  >
                    ⬇ Download raw .{activeSample.format}
                  </button>
                )}
                <button
                  type="button"
                  className="link"
                  disabled={busy !== null}
                  onClick={() => {
                    setPreview(null);
                    setPayload(null);
                    setActiveSample(null);
                    setJoins([]);
                    setActiveSheetIdx(0);
                    setError(null);
                  }}
                >
                  Choose another file
                </button>
              </div>
            </div>

            {preview.cleaningNotes && preview.cleaningNotes.length > 0 && (
              <div className="sheet-cleaning-banner" role="status">
                <div>
                  <strong>✨ Auto-cleaned messy spreadsheet:</strong>{" "}
                  <span>{preview.cleaningNotes.join(" · ")}</span>
                </div>
                {activeSample && (
                  <details className="sheet-raw-before">
                    <summary>Compare raw messy rows before cleaning</summary>
                    <pre className="mono">{activeSample.rawSnippet.join("\n")}</pre>
                  </details>
                )}
              </div>
            )}

            {sheets && sheets.length > 1 && (
              <div className="sheet-tabs" role="tablist" aria-label="Workbook sheets">
                {sheets.map((sh, idx) => (
                  <button
                    key={sh.tableName}
                    type="button"
                    role="tab"
                    className={`sheet-tab${activeSheetIdx === idx ? " active" : ""}`}
                    aria-selected={activeSheetIdx === idx}
                    onClick={() => setActiveSheetIdx(idx)}
                  >
                    <span>{sh.sheetName}</span>
                    <span className="muted sm">({sh.rowCount.toLocaleString()})</span>
                    {(preview?.tableName ? sh.tableName === preview.tableName : idx === 0) && (
                      <span className="sheet-tab-badge">Primary</span>
                    )}
                  </button>
                ))}
              </div>
            )}

            <div className="sheet-preview-wrap" aria-label="First 5 rows preview">
              <table className="sheet-preview-table">
                <thead>
                  <tr>
                    {shownColumns.map((col) => {
                      const role = isPrimarySheet ? (roles[col.name] ?? col.role) : col.role;
                      const meta = ROLE_META[role];
                      return (
                        <th key={col.name}>
                          <div className="sheet-col-head">
                            <span className="sheet-col-name">{col.originalHeader}</span>
                            <button
                              type="button"
                              className={`sheet-role-pill ${meta.badge}`}
                              disabled={!isPrimarySheet}
                              title={isPrimarySheet ? "Click to change how this column is used" : "Detected automatically for related sheet"}
                              onClick={() => {
                                if (!isPrimarySheet) return;
                                const next = nextRoleFor(col, role);
                                setRoles((prev) => ({ ...prev, [col.name]: next }));
                                if (next === "date") setTimeColumn(col.name);
                              }}
                            >
                              {meta.label}
                            </button>
                          </div>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {shownRows.map((row, rIdx) => (
                    <tr key={rIdx}>
                      {row.map((cell, cIdx) => (
                        <td key={cIdx}>{cell || <span className="muted">—</span>}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <SpreadsheetJoinsSection joins={joins} sheets={sheets} onChange={setJoins} />

            <div className="sheet-questions">
              <div className="sheet-q-card">
                <label htmlFor="sheet-grain">1. What is one row in this sheet?</label>
                <div className="sheet-q-chips">
                  {GRAIN_CHIPS.map((chip) => (
                    <button
                      key={chip}
                      type="button"
                      className="sheet-q-chip"
                      aria-pressed={grain === chip}
                      onClick={() => setGrain(chip)}
                    >
                      {chip}
                    </button>
                  ))}
                </div>
                <input
                  id="sheet-grain"
                  className="txt"
                  value={grain}
                  onChange={(e) => setGrain(e.target.value)}
                  placeholder="e.g. One sale or invoice"
                />
              </div>

              <div className="sheet-q-card">
                <label htmlFor="sheet-date">2. Which column is your main date?</label>
                <select
                  id="sheet-date"
                  className="txt"
                  value={timeColumn}
                  onChange={(e) => setTimeColumn(e.target.value)}
                >
                  <option value="">No date column (snapshot only)</option>
                  {dateCols.map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.originalHeader} ({c.samples[0] ?? "date"})
                    </option>
                  ))}
                </select>
                <label htmlFor="sheet-name">Workspace display name</label>
                <input
                  id="sheet-name"
                  className="txt"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="Q3 Sales Performance"
                />
              </div>

              <div className="sheet-q-card">
                <label>3. Do recent days take time to settle?</label>
                <div className="sheet-q-chips">
                  {LAG_OPTIONS.map((opt) => (
                    <button
                      key={opt.days}
                      type="button"
                      className="sheet-q-chip"
                      aria-pressed={reportingLag === opt.days}
                      onClick={() => setReportingLag(opt.days)}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {error && <p className="conn-err" role="alert">{error}</p>}

            <div className="sheet-footer">
              <span className="muted sm">
                Ready to govern <b>{metricCount + 1} metrics</b>
                {sheets && sheets.length > 1 ? ` across ${sheets.length} sheets` : ""}
                {includedJoinCount > 0 ? ` (${includedJoinCount} auto-join${includedJoinCount === 1 ? "" : "s"})` : ""}
                {" "}· {sandboxMode ? "Isolated to your temporary sandbox session" : "Stored in your workspace DuckDB"}
              </span>
              <div className="story-actions">
                <button type="button" className="link" disabled={busy !== null} onClick={onClose}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="primary small"
                  disabled={busy !== null || !grain.trim()}
                  onClick={() => void handleImport()}
                >
                  {busy === "import" ? "Building governed dashboard…" : "Save & Build Instant Dashboard →"}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </StudioDialog>
  );
}
