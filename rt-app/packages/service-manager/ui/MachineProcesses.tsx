import React, { useEffect, useState } from "react";

export interface MachineProcess {
  pid: number;
  runtime: string;
  args: string;
  ports: number[];
  cwd: string | null;
  project: string | null;
  managed: boolean;
  launchdLabel: string | null;
  cpu: number;
  memoryMb: number;
  elapsed: string;
}

export interface MachineClient {
  machineProcesses?(): Promise<MachineProcess[]>;
  stopProcess?(pid: number): Promise<unknown>;
  detachAgent?(label: string): Promise<unknown>;
  openPort?(port: number): Promise<void>;
}

/**
 * Every development process of this user (Node, Python, Go, Rust, …), started by the manager or
 * not: ports, folder, background agent. Stop needs a confirmation; background agents can be
 * detached so they no longer start at login.
 */
export function MachineProcesses({ client }: { client: MachineClient }) {
  const [items, setItems] = useState<MachineProcess[]>();
  const [filter, setFilter] = useState("all");
  const [confirm, setConfirm] = useState<number>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    try {
      setItems(await client.machineProcesses!());
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, []);

  async function act(work: () => Promise<unknown>) {
    setBusy(true);
    try {
      await work();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setConfirm(undefined);
    }
  }

  const runtimes = [...new Set((items ?? []).map((p) => p.runtime))];
  const shown = (items ?? []).filter((p) => filter === "all" || p.runtime === filter);
  return (
    <section className="rt-machine" aria-label="Running processes">
      <div className="rt-services-toolbar">
        <h2>Running processes</h2>
        <div className="rt-filter-chips">
          {["all", ...runtimes].map((r) => (
            <button key={r} aria-pressed={filter === r} onClick={() => setFilter(r)}>{r === "all" ? `All (${items?.length ?? 0})` : r}</button>
          ))}
        </div>
      </div>
      <p className="rt-wizard-note">Development processes of your user on this Mac, whether RT-App started them or not. Stopping sends SIGTERM, then SIGKILL after 5 seconds.</p>
      {error && <p role="alert" className="rt-services-error">{error}</p>}
      {!items && <p>Scanning…</p>}
      {items && !shown.length && <p>No development processes running.</p>}
      <div className="rt-services-table">
        <table>
          <thead><tr><th>Process</th><th>Ports</th><th>Folder</th><th>CPU / Memory</th><th /></tr></thead>
          <tbody>
            {shown.map((p) => (
              <tr key={p.pid}>
                <td>
                  <span className="rt-runtime-badge">{p.runtime}</span> <strong>{p.project ?? p.args.split(" ")[0].split("/").pop()}</strong>
                  <small title={p.args}>PID {p.pid} · {p.elapsed} · {p.args.length > 90 ? p.args.slice(0, 90) + "…" : p.args}</small>
                  {p.managed && <small className="rt-tag">managed by RT-App</small>}
                  {p.launchdLabel && <small className="rt-tag">runs at login · {p.launchdLabel}</small>}
                </td>
                <td>{p.ports.length ? p.ports.map((port) => <button key={port} className="rt-services-link" onClick={() => void client.openPort?.(port)}>{port} ↗</button>) : "—"}</td>
                <td><small title={p.cwd ?? ""}>{p.cwd ? p.cwd.replace(/^\/Users\/[^/]+/, "~") : "—"}</small></td>
                <td>{p.cpu.toFixed(1)}% · {p.memoryMb} MB</td>
                <td>
                  {confirm === p.pid ? (
                    <div className="rt-services-controls">
                      <button className="rt-danger" disabled={busy} onClick={() => void act(() => client.stopProcess!(p.pid))}>Yes, stop</button>
                      <button disabled={busy} onClick={() => setConfirm(undefined)}>Cancel</button>
                    </div>
                  ) : (
                    <div className="rt-services-controls">
                      <button disabled={busy} onClick={() => setConfirm(p.pid)}>Stop…</button>
                      {p.launchdLabel && client.detachAgent && <button disabled={busy} title="Stop it and keep it from starting at login (reversible)" onClick={() => void act(() => client.detachAgent!(p.launchdLabel!))}>Remove from login</button>}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
