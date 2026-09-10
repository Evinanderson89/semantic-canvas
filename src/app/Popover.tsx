import { useEffect, useId, useRef, useState, type ReactNode } from "react";

/** Small, keyboard-accessible disclosures for occasional studio controls. */
export function Popover({ label, trigger, children, align = "start", className = "" }: {
  label: string; trigger: ReactNode; children: (close: () => void) => ReactNode;
  align?: "start" | "end"; className?: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setOpen(false); button.current?.focus(); }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  return <div className={`studio-popover ${className}`} ref={root}
    onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false); }}>
    <button className="studio-trigger" ref={button} aria-label={label}
      aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>{trigger}</button>
    {open && <div id={id} className={`studio-popover-panel ${align}`} role="group" aria-label={label}>
      {children(() => { setOpen(false); button.current?.focus(); })}
    </div>}
  </div>;
}
