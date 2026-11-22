import { useLayoutEffect, useRef, type ReactNode } from "react";

export function StudioDialog({
  title,
  onClose,
  onEscape,
  children,
  wide = false,
  className = "",
}: {
  title: string;
  onClose: () => void;
  /** Return true when an inner mode handled Escape so the dialog stays open. */
  onEscape?: () => boolean;
  children: ReactNode;
  wide?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const d = ref.current!;
    d.showModal();
    return () => d.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`studio-dialog iv${wide ? " wide" : ""} ${className}`}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        if (onEscape?.()) return;
        onClose();
      }}
    >
      <div className="iv-head">
        <span className="iv-step">{title}</span>
        <span className="spacer" />
        <button type="button" className="link" onClick={onClose}>
          Close
        </button>
      </div>
      {children}
    </dialog>
  );
}
