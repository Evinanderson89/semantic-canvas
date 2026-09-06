
/** The small action row every tile carries in the reference layout. */
export function TileActions({ onExpand, onRemove, onExplain, onBeautify, onExport, sql }: {
  onExpand?: () => void; onRemove?: () => void; onExplain?: () => void; onBeautify?: () => void;
  onExport?: () => void; sql?: string;
}) {
  const copy = () => sql && navigator.clipboard?.writeText(sql);
  return (
    <span className="actions">
      {onBeautify && <button title="Beautify" onClick={onBeautify}>
        <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M3 17l7-7" strokeLinecap="round" />
          <path d="M13 3v3M11.5 4.5h3" strokeLinecap="round" />
          <path d="M16.5 8.5v2M15.5 9.5h2" strokeLinecap="round" />
        </svg></button>}
      {onExplain && <button title="Explain this" onClick={onExplain}>
        <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M10 2v4M10 14v4M2 10h4M14 10h4M5 5l2.5 2.5M12.5 12.5 15 15M15 5l-2.5 2.5M7.5 12.5 5 15" strokeLinecap="round" />
        </svg></button>}
      {onExport && <button title="Export" onClick={onExport}>
        <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M10 3v9M6.5 8.5 10 12l3.5-3.5M4 15h12" strokeLinecap="round" strokeLinejoin="round" />
        </svg></button>}
      {sql && <button title="Copy SQL" onClick={copy}>
        <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6">
          <rect x="7" y="3" width="10" height="12" rx="2" /><path d="M13 17H5a2 2 0 0 1-2-2V7" />
        </svg></button>}
      {onExpand && <button title="Expand" onClick={onExpand}>
        <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M12 3h5v5M8 17H3v-5M17 3l-6 6M3 17l6-6" />
        </svg></button>}
      {onRemove && <button title="Remove" onClick={onRemove}>
        <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.7">
          <path d="M5 5l10 10M15 5L5 15" />
        </svg></button>}
    </span>
  );
}
