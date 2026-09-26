import React, { useState } from "react";

export interface ServiceAdmin {
  kind: "url" | "start" | "install" | "none";
  url?: string;
  tool?: string;
  name?: string;
  description?: string;
}

const ACTIVE = ["waiting", "starting", "running", "stopping"];

/**
 * Row controls: a Start/Stop switch, "View admin" when the service has one, and a small ⋯ menu
 * with the secondary options (restart, logs, run at login).
 */
export function ServiceControls({
  service,
  busy,
  onAction,
  onLogs,
  onBackground,
  onAdmin,
}: {
  service: { id: string; label: string; state: string; background?: boolean; admin?: ServiceAdmin };
  busy: boolean;
  onAction: (action: "start" | "stop" | "restart") => void;
  onLogs: () => void;
  onBackground?: (enabled: boolean) => void;
  onAdmin?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const running = ACTIVE.includes(service.state);
  const admin = service.admin;
  return (
    <div className="rt-service-controls" onClick={(e) => e.stopPropagation()}>
      <label className="rt-switch" title={service.background ? "Runs in the background (at login); turn off Run at login to control it here" : running ? "Stop" : "Start"}>
        <input type="checkbox" role="switch" aria-label={`${running ? "Stop" : "Start"} ${service.label}`} checked={running || Boolean(service.background)} disabled={busy || service.background || ["starting", "stopping"].includes(service.state)} onChange={() => onAction(running ? "stop" : "start")} />
        <span aria-hidden="true" />
      </label>
      {admin && admin.kind !== "none" && onAdmin && (
        <button className="rt-admin-button" disabled={busy} title={admin.kind === "install" ? admin.description : "Open the web admin"} onClick={onAdmin}>
          {admin.kind === "install" ? `Install ${admin.name}` : "View admin"}
        </button>
      )}
      {admin?.kind === "none" && <span className="rt-no-admin" title={admin.description}>No admin</span>}
      <div className="rt-more">
        <button aria-label={`More options for ${service.label}`} aria-expanded={open} onClick={() => setOpen(!open)}>⋯</button>
        {open && (
          <div className="rt-more-menu" role="menu" onMouseLeave={() => setOpen(false)}>
            <button role="menuitem" disabled={busy || service.background} onClick={() => { setOpen(false); onAction("restart"); }}>Restart</button>
            <button role="menuitem" onClick={() => { setOpen(false); onLogs(); }}>Logs</button>
            {onBackground && (
              <label role="menuitemcheckbox" aria-checked={Boolean(service.background)} className="rt-menu-check">
                <input type="checkbox" checked={Boolean(service.background)} disabled={busy} onChange={(e) => { setOpen(false); onBackground(e.target.checked); }} />
                Run at login (background)
              </label>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
