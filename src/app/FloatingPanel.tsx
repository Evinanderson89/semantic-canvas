import { useLayoutEffect, useRef, type HTMLAttributes, type RefObject } from "react";

/** Keep disclosures in their DOM/accessibility context but above clipping and
 * transformed canvas ancestors. Only open panels track moving canvas anchors. */
export function FloatingPanel({ anchor, align = "start", anchorTop = false, onDismiss, focusOnOpen = false, style, children, ...props }:
  HTMLAttributes<HTMLDivElement> & { anchor: RefObject<HTMLElement | null>; align?: "start" | "end"; anchorTop?: boolean; onDismiss?: () => void; focusOnOpen?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const dismiss = useRef(onDismiss); dismiss.current = onDismiss;
  useLayoutEffect(() => {
    const panel = ref.current!;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.showPopover();
    let frame = 0;
    const position = () => {
      const target = anchor.current;
      if (!target?.isConnected) { dismiss.current?.(); return; }
      const margin = 12, gap = 8;
      const width = document.documentElement.clientWidth, height = window.innerHeight;
      const maxHeight = `${Math.max(0, height - margin * 2)}px`;
      if (panel.style.maxHeight !== maxHeight) panel.style.maxHeight = maxHeight;
      const a = target.getBoundingClientRect(), p = panel.getBoundingClientRect();
      const below = anchorTop ? a.top + 44 : a.bottom + gap;
      const preferredY = below + p.height <= height - margin ? below : a.top - p.height - gap;
      const x = Math.max(margin, Math.min(align === "end" ? a.right - p.width : a.left, width - p.width - margin));
      const y = Math.max(margin, Math.min(preferredY, height - p.height - margin));
      if (panel.style.left !== `${x}px`) panel.style.left = `${x}px`;
      if (panel.style.top !== `${y}px`) panel.style.top = `${y}px`;
      frame = requestAnimationFrame(position);
    };
    position();
    if (focusOnOpen) panel.querySelector<HTMLElement>("button,input,select,textarea,[tabindex='0']")?.focus({ preventScroll: true });
    const outside = (e: PointerEvent) => {
      if (!panel.contains(e.target as Node) && !anchor.current?.contains(e.target as Node)) dismiss.current?.();
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dismiss.current) { e.stopPropagation(); dismiss.current(); previous?.focus({ preventScroll: true }); }
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape);
      if (panel.contains(document.activeElement)) previous?.focus({ preventScroll: true });
      if (panel.isConnected && panel.matches(":popover-open")) panel.hidePopover();
    };
  }, [anchor, align, anchorTop, focusOnOpen]);
  return <div {...props} ref={ref} popover="manual" style={{ ...style, position: "fixed", inset: "auto", margin: 0, maxWidth: "calc(100vw - 24px)", minWidth: 0, overflow: "auto", cursor: "default" }}
    onPointerDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}>{children}</div>;
}
