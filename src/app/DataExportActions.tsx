export function DataExportActions({ onSpreadsheet, onCsv, busy, error }: {
  onSpreadsheet: () => void; onCsv: () => void; busy?: boolean; error?: string;
}) {
  return <div className="data-export-actions">
    <button className="primary" disabled={busy} onClick={onSpreadsheet}>{busy ? "Preparing spreadsheet…" : "Download Excel (.xlsx)"}</button>
    <p>Preserves text and long identifiers as text. Includes the query scope and data checks on a separate sheet.</p>
    <button disabled={busy} onClick={onCsv}>Download raw CSV</button>
    <p>CSV has no cell types: spreadsheet apps can interpret formulas and round long values. Use Excel above, or import CSV columns as text.</p>
    <p>Returned rows only, before chart formatting. Query limits still apply.</p>
    {error && <p role="alert" className="err">{error}</p>}
  </div>;
}
