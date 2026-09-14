import { useLayoutEffect, useRef, type ReactNode } from "react";
export function StudioDialog({ title, onClose, children, wide = false, className = "" }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => { const d = ref.current!; d.showModal(); return () => d.close(); }, []);
  return <dialog ref={ref} className={`studio-dialog iv${wide ? " wide" : ""} ${className}`} aria-label={title} onCancel={e => { e.preventDefault(); onClose(); }}>
    <div className="iv-head"><span className="iv-step">{title}</span><span className="spacer" /><button className="link" onClick={onClose}>Close</button></div>{children}
  </dialog>;
}
