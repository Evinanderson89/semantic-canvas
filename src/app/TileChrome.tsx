
/** The small action row every tile carries in the reference layout. */
export function TileActions({ onExpand, onRemove, sql }: {
  onExpand?: () => void; onRemove?: () => void; sql?: string;
}) {
  const copy = () => sql && navigator.clipboard?.writeText(sql);
  return (
    <span className="actions">
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
