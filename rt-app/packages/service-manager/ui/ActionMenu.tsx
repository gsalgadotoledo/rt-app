import React, { useEffect, useRef, useState } from "react";

export interface MenuAction { label: string; hint?: string; icon?: React.ReactNode; danger?: boolean; disabled?: boolean; separator?: boolean; onSelect: () => void }

/** A chevron button that opens a small menu of actions; closes on outside click, Escape or choice. */
export function ActionMenu({ label, actions }: { label: string; actions: MenuAction[] }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", escape); };
  }, [open]);
  if (!actions.length) return null;
  return (
    <div className="rt-action-menu" ref={root}>
      <button className="rt-action-menu-toggle" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={open ? "M6 15l6-6 6 6" : "M6 9l6 6 6-6"} /></svg>
      </button>
      {open && (
        <div className="rt-action-menu-list" role="menu">
          {actions.map((a, i) => (
            <React.Fragment key={a.label}>
              {a.separator && i > 0 && <hr />}
              <button role="menuitem" className={a.danger ? "danger" : undefined} title={a.hint} disabled={a.disabled} onClick={() => { setOpen(false); a.onSelect(); }}>
                <span className="rt-action-menu-icon" aria-hidden="true">{a.icon}</span>{a.label}
              </button>
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
