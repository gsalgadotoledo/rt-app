import React, { useEffect, useRef, useState } from "react";

interface PowerService {
  id: string;
  label: string;
  kind: string;
  state: string;
  pid: number | null;
  cpu: number;
  memoryMb: number;
  runtime?: string | null;
  background?: boolean;
  url?: string | null;
  ports?: number[];
  uptimeSeconds?: number | null;
  error?: string | null;
  admin?: { kind: string; name?: string; description?: string };
}

function uptime(seconds?: number | null) {
  if (!seconds) return null;
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}
const glyph = (d: string) => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;

const ACTIVE = ["waiting", "starting", "running", "stopping"];
const TRANSITION = ["waiting", "starting", "stopping"];
/** Memory above these values (MB) turns the gauge amber, then red. */
export const MEMORY_WARN = 400;
export const MEMORY_HOT = 800;

/**
 * A small dial ("relojito") for a service's memory. The needle sweeps 0–1 GB (or further when the
 * service uses more) and the color moves to amber and red as it climbs.
 */
export function MemoryGauge({ mb, cpu, active, size = 34 }: { mb: number; cpu?: number; active: boolean; size?: number }) {
  const max = Math.max(1024, Math.ceil(mb / 512) * 512);
  const ratio = active ? Math.min(mb / max, 1) : 0;
  const level = !active ? "idle" : mb >= MEMORY_HOT ? "hot" : mb >= MEMORY_WARN ? "warn" : "ok";
  const angle = -90 + ratio * 180;
  const label = active ? `${mb.toFixed(0)} MB${cpu !== undefined ? ` · CPU ${cpu.toFixed(1)}%` : ""}` : "Not running";
  return (
    <span className={`rt-gauge rt-gauge-${level}`} title={`Memory: ${label}`} role="img" aria-label={`Memory ${label}`}>
      <svg width={size} height={size * 0.62} viewBox="0 0 40 25" aria-hidden="true">
        <path d="M4 22a16 16 0 0 1 32 0" className="rt-gauge-track" />
        <path d="M4 22a16 16 0 0 1 32 0" className="rt-gauge-fill" pathLength={100} strokeDasharray={`${ratio * 100} 100`} />
        <line x1="20" y1="22" x2="20" y2="9" className="rt-gauge-needle" style={{ transform: `rotate(${angle}deg)` }} />
        <circle cx="20" cy="22" r="2.2" className="rt-gauge-hub" />
      </svg>
      <small>{active ? `${mb.toFixed(0)}M` : "—"}</small>
    </span>
  );
}

/**
 * The big Start/Stop toggle for a project (or the shared services). The chevron opens a compact
 * list of every service with its own switch and memory gauge.
 */
export function ProjectPower({
  services,
  busy,
  label,
  onToggleAll,
  onRestartAll,
  onAction,
  onOpen,
  onOpenUrl,
  onBackground,
  onAdmin,
}: {
  services: PowerService[];
  busy: boolean;
  label: string;
  onToggleAll: (action: "start" | "stop") => void;
  onRestartAll: () => void;
  onAction: (action: "start" | "stop" | "restart", id: string) => void;
  onOpen: (id: string) => void;
  onOpenUrl?: (id: string) => void;
  onBackground?: (id: string, enabled: boolean) => void;
  onAdmin?: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const long = services.filter((s) => s.kind !== "task");
  const activeCount = services.filter((s) => s.pid && ACTIVE.includes(s.state)).length;
  const on = long.some((s) => ACTIVE.includes(s.state));
  const transitioning = services.some((s) => TRANSITION.includes(s.state));
  const hot = services.some((s) => s.pid && s.memoryMb >= MEMORY_HOT);
  const totalMb = services.reduce((sum, s) => sum + (s.pid ? s.memoryMb : 0), 0);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const state = transitioning ? (services.some((s) => s.state === "stopping") ? "Stopping…" : "Starting…") : on ? "Running" : "Stopped";
  return (
    <div className={`rt-power${on ? " on" : ""}${transitioning ? " busy" : ""}${hot ? " hot" : ""}`} ref={root}>
      <button
        className="rt-power-main"
        role="switch"
        aria-checked={on}
        aria-label={`${on ? "Stop" : "Start"} ${label}`}
        title={`${on ? "Stop" : "Start"} ${label}`}
        disabled={busy || !services.length}
        onClick={() => onToggleAll(on ? "stop" : "start")}
      >
        <span className="rt-power-icon" aria-hidden="true">
          <svg width="30" height="30" viewBox="0 0 24 24">
            {on ? <rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" /> : <path d="M8 5l12 7-12 7z" fill="currentColor" />}
          </svg>
        </span>
        <span className="rt-power-text">
          <strong>{on ? "Stop" : "Start"}</strong>
          <small>
            <i className="rt-power-dot" aria-hidden="true" />
            {state} · {activeCount}/{services.length}
            {totalMb > 0 ? ` · ${totalMb.toFixed(0)} MB` : ""}
          </small>
        </span>
      </button>
      <button className="rt-power-more" aria-label="Services" aria-expanded={open} aria-haspopup="dialog" title="Services" onClick={() => setOpen(!open)}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d={open ? "M6 15l6-6 6 6" : "M6 9l6 6 6-6"} />
        </svg>
        {hot && <i className="rt-power-alert" title="A service is using a lot of memory" />}
      </button>
      {open && (
        <div className="rt-power-popover" role="dialog" aria-label={`${label} services`}>
          <header>
            <strong>Services</strong>
            <span>
              {activeCount} running{totalMb > 0 ? ` · ${totalMb.toFixed(0)} MB` : ""}
            </span>
            <button disabled={busy || !on} onClick={onRestartAll} title="Restart every running service">
              ↻ Restart all
            </button>
          </header>
          <ul>
            {services.map((s) => {
              const running = ACTIVE.includes(s.state);
              const heavy = Boolean(s.pid) && s.memoryMb >= MEMORY_WARN;
              const up = s.pid ? uptime(s.uptimeSeconds) : null;
              return (
                <li key={s.id} className={heavy ? "heavy" : undefined}>
                  <i className={`rt-power-state state-${s.state}`} aria-hidden="true" />
                  <div className="rt-power-info">
                    <div className="rt-power-line">
                      <button className="rt-power-name" title="Open output" onClick={() => { setOpen(false); onOpen(s.id); }}>{s.label}</button>
                      {s.runtime && <span className="rt-runtime-badge">{s.runtime}</span>}
                      {s.url && (onOpenUrl
                        ? <button className="rt-power-url" disabled={!running} title={running ? `Open ${s.url}` : `${s.label} is ${s.state}`} onClick={() => onOpenUrl(s.id)}>{s.url.replace(/^https?:\/\//, "")} ↗</button>
                        : <span className="rt-power-url">{s.url.replace(/^https?:\/\//, "")}</span>)}
                    </div>
                    <small className="rt-power-meta">
                      <span className={`rt-power-status state-${s.state}`}>{s.state}</span>
                      {s.pid ? <span>PID {s.pid}</span> : null}
                      {s.pid ? <span>CPU {s.cpu.toFixed(1)}%</span> : null}
                      {s.pid ? <span>{s.memoryMb.toFixed(0)} MB</span> : null}
                      {up && <span>up {up}</span>}
                      {!s.url && s.ports?.length ? <span>ports {s.ports.join(", ")}</span> : null}
                      {s.background && <span title="Runs at login in the background">at login</span>}
                    </small>
                    {s.error && <small className="rt-power-error" title={s.error}>{s.error}</small>}
                  </div>
                  <MemoryGauge mb={s.memoryMb} cpu={s.cpu} active={Boolean(s.pid)} />
                  <span className="rt-power-actions">
                    <button title="Logs" aria-label={`Logs of ${s.label}`} onClick={() => { setOpen(false); onOpen(s.id); }}>{glyph("M5 6h14 M5 12h14 M5 18h9")}</button>
                    <button title="Restart" aria-label={`Restart ${s.label}`} disabled={busy || s.background || !running} onClick={() => onAction("restart", s.id)}>{glyph("M20 7v5h-5 M20 12a8 8 0 1 0-2 5")}</button>
                    {onAdmin && s.admin && s.admin.kind !== "none" && <button title={s.admin.kind === "install" ? `Install ${s.admin.name ?? "admin"}` : "Open the web admin"} aria-label={`Admin of ${s.label}`} disabled={busy} onClick={() => onAdmin(s.id)}>{glyph("M4 5h16v11H4z M8 20h8 M12 16v4")}</button>}
                    {onBackground && <button className={s.background ? "on" : undefined} title={s.background ? "Runs at login · click to turn off" : "Run at login (background)"} aria-pressed={Boolean(s.background)} aria-label={`Run ${s.label} at login`} disabled={busy} onClick={() => onBackground(s.id, !s.background)}>{glyph("M12 3v8 M6.3 7.5a8 8 0 1 0 11.4 0")}</button>}
                  </span>
                  <label className="rt-switch rt-switch-sm" title={s.background ? "Runs at login" : running ? "Stop" : "Start"}>
                    <input
                      type="checkbox"
                      role="switch"
                      aria-label={`${running ? "Stop" : "Start"} ${s.label}`}
                      checked={running || Boolean(s.background)}
                      disabled={busy || s.background || ["starting", "stopping"].includes(s.state)}
                      onChange={() => onAction(running ? "stop" : "start", s.id)}
                    />
                    <span aria-hidden="true" />
                  </label>
                </li>
              );
            })}
            {!services.length && <li className="rt-power-empty">No services yet.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
