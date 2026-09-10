import { useState } from "react";
import { Popover } from "./Popover.tsx";

/** Frequent collaboration actions stay visible; editing and export live here. */
export function TileActions({ onExpand, onRemove, onExplain, onBeautify, onExport, sql }: {
  onExpand?: () => void; onRemove?: () => void; onExplain?: () => void; onBeautify?: () => void;
  onExport?: () => void; sql?: string;
}) {
  const [copyError, setCopyError] = useState(false);
  const items = [["Design suggestions", onBeautify], ["Explain this", onExplain], ["Export", onExport], ["Expand", onExpand], ["Remove chart", onRemove]] as const;
  if (!items.some(([, action]) => action) && !sql) return null;
  return <span className="chart-more-actions" onPointerDown={e => e.stopPropagation()}><Popover label="More chart actions" align="end" trigger={<span aria-hidden="true">···</span>}>
    {close => <div className="chart-more-menu">{items.map(([label, action]) => action && <button key={label} onClick={() => { close(); action(); }}>{label}</button>)}
      {sql && <button onClick={async () => { try { await navigator.clipboard.writeText(sql); setCopyError(false); close(); } catch { setCopyError(true); } }}>Copy SQL</button>}
      {copyError && <span role="alert">Could not copy. Try your browser’s clipboard permission.</span>}
    </div>}
  </Popover></span>;
}
