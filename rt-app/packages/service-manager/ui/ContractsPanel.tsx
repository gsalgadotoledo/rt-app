import React, { useEffect, useMemo, useState } from "react";

export interface ContractConfig { id: string; path: string; project: string; name: string; added?: boolean; lastRun: ContractRun | null }
export interface ContractResult { target: string; module: string; file?: string; name: string; tags: string[]; status: "passed" | "failed" | "missing" | "unrecorded" | "skipped"; message?: string; ms: number }
export interface ContractRun {
  id: string;
  state: "running" | "passed" | "failed" | "error";
  startedAt: string;
  finishedAt?: string;
  targets: string[];
  filter: string;
  record: boolean;
  recorded: number;
  current?: string | null;
  error?: string | null;
  results?: ContractResult[];
  summary?: Record<string, Record<string, number>>;
}
interface CaseView { name: string; tags: string[]; init: string; create: string; steps: { call: string; expect: string; note: string }[] }
export interface ContractDescription {
  path: string;
  reference: string;
  targets: { name: string; host: boolean; api: boolean }[];
  contracts: { file: string; relative: string; module: string; title: string; kind: string; description: string; error?: string; cases: CaseView[] }[];
}
export interface ContractsClient {
  contracts?: {
    configs(): Promise<ContractConfig[]>;
    describe(id: string): Promise<ContractDescription>;
    run(id: string, options: { targets: string[]; filter: string; record: boolean }): Promise<{ id: string }>;
    getRun(id: string, runId: string): Promise<ContractRun | undefined>;
    history(id: string): Promise<ContractRun[]>;
    add(): Promise<ContractConfig[]>;
    remove(id: string): Promise<ContractConfig[]>;
    openFile(id: string, file: string): Promise<void>;
  };
}

const ICON: Record<string, string> = { passed: "✓", failed: "✗", missing: "○", unrecorded: "?", skipped: "–" };
const LABEL: Record<string, string> = { passed: "passed", failed: "failed", missing: "not implemented", unrecorded: "no expectation recorded", skipped: "skipped" };

/**
 * Language contracts: every case of a module (inputs → expected outputs) run against each
 * implementation (TypeScript, Python, Go, Lambda modes), shown as a matrix with the failures.
 */
export function ContractsPanel({ client }: { client: ContractsClient }) {
  const api = client.contracts!;
  const [configs, setConfigs] = useState<ContractConfig[]>();
  const [selected, setSelected] = useState<string>();
  const [description, setDescription] = useState<ContractDescription>();
  const [chosen, setChosen] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [run, setRun] = useState<ContractRun>();
  const [history, setHistory] = useState<ContractRun[]>([]);
  const [tab, setTab] = useState<"results" | "cases" | "history">("results");
  const [detail, setDetail] = useState<ContractResult>();
  const [confirmRecord, setConfirmRecord] = useState(false);
  const [error, setError] = useState("");
  const config = configs?.find((c) => c.id === selected);

  async function load() {
    try {
      const next = await api.configs();
      setConfigs(next);
      setSelected((current) => (current && next.some((c) => c.id === current) ? current : next[0]?.id));
    } catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (!selected) return;
    setDescription(undefined); setRun(undefined); setDetail(undefined); setConfirmRecord(false);
    void Promise.all([api.describe(selected), api.history(selected)]).then(async ([d, h]) => {
      setDescription(d);
      setChosen(d.targets.map((t) => t.name));
      setHistory(h);
      if (h[0]) setRun(await api.getRun(selected, h[0].id));
      setError("");
    }).catch((e) => setError((e as Error).message));
  }, [selected]);
  useEffect(() => {
    if (!selected || run?.state !== "running") return;
    const timer = setInterval(async () => {
      const next = await api.getRun(selected, run.id);
      if (!next) return;
      setRun(next);
      if (next.state !== "running") {
        setHistory(await api.history(selected));
        if (next.record) setDescription(await api.describe(selected));
        void load();
      }
    }, 800);
    return () => clearInterval(timer);
  }, [selected, run?.id, run?.state]);

  async function start(record: boolean) {
    if (!selected) return;
    setConfirmRecord(false); setDetail(undefined);
    try {
      const { id } = await api.run(selected, { targets: chosen, filter, record });
      setRun(await api.getRun(selected, id));
      setTab("results");
      setError("");
    } catch (e) { setError((e as Error).message); }
  }

  // Matrix rows: module · case, columns: targets of the run.
  const matrix = useMemo(() => {
    const rows = new Map<string, { module: string; name: string; tags: string[]; cells: Record<string, ContractResult> }>();
    for (const r of run?.results ?? []) {
      const key = r.module + "\u0000" + r.name;
      const row = rows.get(key) ?? { module: r.module, name: r.name, tags: r.tags, cells: {} };
      row.cells[r.target] = r;
      rows.set(key, row);
    }
    return [...rows.values()];
  }, [run?.results]);
  const counts = (target: string) => (run?.results ?? []).filter((r) => r.target === target).reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});
  const running = run?.state === "running";
  const totalCases = description?.contracts.reduce((n, c) => n + c.cases.length, 0) ?? 0;

  return (
    <section className="rt-machine rt-terraform rt-contracts" aria-label="Contracts">
      <div className="rt-services-toolbar">
        <h2>Contracts</h2>
        <button onClick={async () => { try { setConfigs(await api.add()); } catch (e) { setError((e as Error).message); } }}>Add contracts.json…</button>
        <button onClick={() => void load()}>Rescan</button>
      </div>
      <p className="rt-wizard-note">Language-neutral cases of each module (inputs, expected outputs and errors) run against every implementation: TypeScript, Python, Go and their Lambda modes. Projects are scanned for <code>contracts.json</code>, <code>spec/contracts.json</code> or <code>rt-app/spec/contracts.json</code>.</p>
      {error && <p role="alert" className="rt-services-error">{error}</p>}
      {!configs && <p>Scanning projects…</p>}
      {configs && !configs.length && <p>No contracts found. Add the <code>contracts.json</code> of a project (for the RT-App core: <code>rt-app/spec/contracts.json</code>).</p>}
      {!!configs?.length && (
        <div className="rt-tf-layout">
          <nav className="rt-tf-stacks" aria-label="Contract configs">
            {configs.map((c) => (
              <button key={c.id} aria-current={c.id === selected ? "page" : undefined} title={c.path} onClick={() => setSelected(c.id)}>
                <span>{c.project}</span>
                <small>{c.name}</small>
                {c.lastRun && <small className={`rt-tf-state rt-tf-${c.lastRun.state === "passed" ? "succeeded" : c.lastRun.state === "running" ? "running" : "failed"}`}>{c.lastRun.state} · {new Date(c.lastRun.startedAt).toLocaleString()}</small>}
              </button>
            ))}
          </nav>
          {config && (
            <div className="rt-tf-detail">
              <header>
                <div><strong>{config.project}</strong><small>{config.path.replace(/^\/Users\/[^/]+/, "~")}</small></div>
                {config.added && <button onClick={async () => setConfigs(await api.remove(config.id))}>Remove</button>}
              </header>
              {!description && <p>Loading contracts…</p>}
              {description && (
                <>
                  <div className="rt-contract-controls">
                    <div className="rt-filter-chips" role="group" aria-label="Targets">
                      {description.targets.map((t) => (
                        <button key={t.name} aria-pressed={chosen.includes(t.name)} title={[t.host && "modules", t.api && "HTTP API"].filter(Boolean).join(" + ")} onClick={() => setChosen(chosen.includes(t.name) ? chosen.filter((x) => x !== t.name) : [...chosen, t.name])}>
                          {t.name}{t.name === description.reference ? " ★" : ""}
                        </button>
                      ))}
                    </div>
                    <input className="rt-contract-filter" placeholder="Filter: case text or tag (edge, security…)" value={filter} onChange={(e) => setFilter(e.target.value)} />
                    <button className="rt-primary" disabled={running || !chosen.length} onClick={() => void start(false)}>{running ? `Running ${run?.current ?? ""}…` : `Run ${totalCases} cases`}</button>
                    {confirmRecord ? (
                      <>
                        <button className="rt-danger" onClick={() => void start(true)}>Yes, record on {description.reference}</button>
                        <button onClick={() => setConfirmRecord(false)}>Cancel</button>
                      </>
                    ) : (
                      <button disabled={running} title="Run the reference implementation and write the outputs of steps without expect into the contract files" onClick={() => setConfirmRecord(true)}>Record…</button>
                    )}
                  </div>
                  {confirmRecord && <p className="rt-tf-warning">Recording writes the reference ({description.reference}) outputs into the contract files for steps that have no expectation. Review the changes in git afterwards.</p>}
                  <div className="rt-contract-tabs" role="tablist">
                    {(["results", "cases", "history"] as const).map((t) => <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>{t === "results" ? "Results" : t === "cases" ? `Cases (${totalCases})` : "History"}</button>)}
                  </div>

                  {tab === "results" && (
                    <>
                      {!run && <p className="rt-wizard-note">No runs yet. Choose targets and press Run.</p>}
                      {run?.error && <p className="rt-services-error">{run.error}</p>}
                      {run && run.record && run.state !== "running" && <p className="rt-wizard-note">Recorded {run.recorded} expectation(s).</p>}
                      {run && (
                        <table className="rt-contract-summary">
                          <thead><tr><th>Target</th><th>✓ passed</th><th>✗ failed</th><th>○ missing</th><th>? unrecorded</th><th>– skipped</th></tr></thead>
                          <tbody>{run.targets.map((t) => { const c = counts(t); return <tr key={t} className={c.failed || c.unrecorded ? "rt-contract-bad" : ""}><td>{t}{run.current === t ? " …" : ""}</td><td>{c.passed ?? 0}</td><td>{c.failed ?? 0}</td><td>{c.missing ?? 0}</td><td>{c.unrecorded ?? 0}</td><td>{c.skipped ?? 0}</td></tr>; })}</tbody>
                        </table>
                      )}
                      {!!matrix.length && (
                        <div className="rt-services-table rt-contract-matrix">
                          <table>
                            <thead><tr><th>Case</th>{run!.targets.map((t) => <th key={t}>{t}</th>)}</tr></thead>
                            <tbody>
                              {matrix.map((row) => (
                                <tr key={row.module + row.name}>
                                  <td><small>{row.module}</small>{row.name}{row.tags.length ? <small className="rt-contract-tags">{row.tags.join(" · ")}</small> : null}</td>
                                  {run!.targets.map((t) => {
                                    const cell = row.cells[t];
                                    return <td key={t}>{cell ? <button className={`rt-contract-cell rt-contract-${cell.status}`} title={cell.message ?? LABEL[cell.status]} onClick={() => setDetail(cell)}>{ICON[cell.status]}</button> : running ? "…" : ""}</td>;
                                  })}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                      {detail && (
                        <div className="rt-tf-run">
                          <div className="rt-tf-run-header"><strong>{detail.target}</strong><span className={`rt-contract-${detail.status}`}>{ICON[detail.status]} {LABEL[detail.status]}</span><small>{detail.module} · {detail.name} · {detail.ms} ms</small></div>
                          <pre className="rt-tf-console">{detail.message ?? "No differences."}{detail.file ? `\n\n${detail.file}` : ""}</pre>
                        </div>
                      )}
                    </>
                  )}

                  {tab === "cases" && (
                    <div className="rt-contract-cases">
                      {description.contracts.map((c) => (
                        <details key={c.file} open={description.contracts.length === 1}>
                          <summary><strong>{c.module}</strong> {c.title && <span>— {c.title}</span>} <small>{c.cases.length} cases · {c.kind}</small> <button className="rt-services-link" onClick={(e) => { e.preventDefault(); void api.openFile(config.id, c.file); }}>{c.relative} ↗</button></summary>
                          {c.error && <p className="rt-services-error">{c.error}</p>}
                          {c.description && <p className="rt-wizard-note rt-contract-description">{c.description}</p>}
                          {c.cases.map((x) => (
                            <div key={x.name} className="rt-contract-case">
                              <div><strong>{x.name}</strong>{x.tags.length ? <small className="rt-contract-tags">{x.tags.join(" · ")}</small> : null}</div>
                              {x.init && <code className="rt-contract-init">init {x.init}</code>}
                              {x.create && <code className="rt-contract-init">create → {x.create}</code>}
                              <table><tbody>{x.steps.map((s, i) => <tr key={i}><td><code>{s.call}</code></td><td>→</td><td><code className={s.expect.startsWith("error") ? "rt-contract-error" : s.expect === "(not recorded)" ? "rt-contract-unrecorded" : ""}>{s.expect}</code>{s.note && <small> — {s.note}</small>}</td></tr>)}</tbody></table>
                            </div>
                          ))}
                        </details>
                      ))}
                    </div>
                  )}

                  {tab === "history" && (
                    <ul className="rt-tf-history">
                      {!history.length && <li className="rt-wizard-note">No runs yet.</li>}
                      {history.map((h) => (
                        <li key={h.id}><button aria-current={run?.id === h.id ? "true" : undefined} onClick={async () => { setRun(await api.getRun(config.id, h.id)); setTab("results"); }}>
                          <strong>{h.record ? "record" : "run"}</strong>
                          <span className={`rt-tf-state rt-tf-${h.state === "passed" ? "succeeded" : "failed"}`}>{h.state}</span>
                          <small>{h.targets.join(", ")}{h.filter ? ` · "${h.filter}"` : ""} · {Object.entries(h.summary ?? {}).map(([t, c]) => `${t} ${c.passed}✓${c.failed ? ` ${c.failed}✗` : ""}`).join(" · ")} · {new Date(h.startedAt).toLocaleString()}</small>
                        </button></li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
