import { useEffect, useRef, type ReactNode } from "react";
export function StudioDialog({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const d = ref.current!; d.showModal(); return () => d.close(); }, []);
  return <dialog ref={ref} className={`studio-dialog iv${wide ? " wide" : ""}`} aria-label={title} onCancel={e => { e.preventDefault(); onClose(); }}>
    <div className="iv-head"><span className="iv-step">{title}</span><span className="spacer" /><button className="link" onClick={onClose}>Close</button></div>{children}
  </dialog>;
}
