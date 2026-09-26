import React, { useEffect, useRef, useState } from "react";

export interface TerraformRunError { summary: string; file: string | null; line: number | null }
export interface TerraformRun {
  id: string;
  command: string;
  state: "running" | "succeeded" | "failed";
  exitCode?: number;
  startedAt: string;
  finishedAt?: string;
  errors?: TerraformRunError[];
  output?: string;
}
export interface TerraformStack { id: string; path: string; name: string; project: string; projectPath: string; lastRun: TerraformRun | null }
export interface TerraformVariable { name: string; file: string; description: string; type: string; required: boolean; sensitive: boolean; links: string[]; present: boolean; value?: string }
export interface TerraformGlobal { key: string; description: string; url?: string; secret: boolean; present: boolean }
export interface TerraformClient {
  terraform?: {
    stacks(): Promise<TerraformStack[]>;
    variables(id: string): Promise<TerraformVariable[]>;
    setVariables(id: string, values: Record<string, string>): Promise<TerraformVariable[]>;
    globals(): Promise<TerraformGlobal[]>;
    setGlobals(values: Record<string, string>): Promise<TerraformGlobal[]>;
    run(id: string, command: string): Promise<{ id: string }>;
    getRun(id: string, runId: string): Promise<TerraformRun | undefined>;
    history(id: string): Promise<TerraformRun[]>;
    openLink(url: string): Promise<void>;
  };
}

const ACTIONS: [string, string, string][] = [
  ["init", "Init", "Download providers and modules (needed once, and after changing versions)."],
  ["fmt", "Format check", "terraform fmt -check: style (lint)."],
  ["validate", "Validate", "Syntax and references."],
  ["test", "Test", "Run *.tftest.hcl unit tests."],
];

/** Links inside a description become buttons; everything else stays text. */
function Described({ text, open }: { text: string; open: (url: string) => void }) {
  const parts = text.split(/(https:\/\/[^\s)"']+)/g);
  return <>{parts.map((part, i) => part.startsWith("https://") ? <button key={i} type="button" className="rt-services-link" onClick={() => open(part)}>{new URL(part).hostname} ↗</button> : <React.Fragment key={i}>{part}</React.Fragment>)}</>;
}

/** Modal with every value (per-stack variables or global environment), description and where to find it. */
function ValuesModal({ title, intro, rows, onSave, onClose, open }: {
  title: string;
  intro: string;
  rows: { key: string; label: string; description: string; url?: string; type?: string; required?: boolean; secret: boolean; present: boolean; value?: string }[];
  onSave(values: Record<string, string>): Promise<void>;
  onClose(): void;
  open(url: string): void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(rows.filter((r) => !r.secret && r.value !== undefined).map((r) => [r.key, r.value!])));
  const [cleared, setCleared] = useState<Set<string>>(new Set());
  const [custom, setCustom] = useState({ key: "", value: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save() {
    setBusy(true);
    try {
      const changes: Record<string, string> = {};
      for (const row of rows) {
        if (cleared.has(row.key) && !values[row.key]) changes[row.key] = "";
        else if (row.secret ? Boolean(values[row.key]) : values[row.key] !== undefined && values[row.key] !== (row.value ?? "")) changes[row.key] = values[row.key];
      }
      if (custom.key) changes[custom.key.trim()] = custom.value;
      await onSave(changes);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="rt-modal-backdrop" role="presentation" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="rt-modal" role="dialog" aria-modal="true" aria-label={title}>
        <header><h2>{title}</h2><button type="button" aria-label="Close" onClick={onClose}>✕</button></header>
        <p className="rt-wizard-note">{intro}</p>
        {error && <p role="alert" className="rt-services-error">{error}</p>}
        <div className="rt-tf-fields">
          {!rows.length && <p>This stack declares no variables.</p>}
          {rows.map((row) => (
            <label key={row.key} className="rt-tf-field">
              <span className="rt-tf-field-name"><code>{row.label}</code>{row.required && <em>required</em>}{row.secret && <em>secret</em>}{row.type && row.type !== "string" && <em>{row.type}</em>}{row.present && !cleared.has(row.key) && <em className="rt-tf-set">✓ set</em>}</span>
              <small><Described text={row.description || "No description."} open={open} />{row.url && <> <button type="button" className="rt-services-link" onClick={() => open(row.url!)}>Where to find it ↗</button></>}</small>
              <span className="rt-tf-input">
                {row.type && /^(list|map|object|set|tuple)/.test(row.type)
                  ? <textarea rows={3} spellCheck={false} placeholder={row.present ? "Saved — type to replace (HCL or JSON)" : "HCL or JSON value"} value={values[row.key] ?? ""} onChange={(e) => setValues({ ...values, [row.key]: e.target.value })} />
                  : <input type={row.secret ? "password" : "text"} autoComplete="off" spellCheck={false} placeholder={row.secret && row.present ? "•••••••• saved — type to replace" : ""} value={values[row.key] ?? ""} onChange={(e) => setValues({ ...values, [row.key]: e.target.value })} />}
                {row.present && <button type="button" title="Remove the saved value" onClick={() => { const next = new Set(cleared); next.add(row.key); setCleared(next); setValues({ ...values, [row.key]: "" }); }}>Clear</button>}
              </span>
            </label>
          ))}
          {rows.every((r) => !r.type) && (
            <div className="rt-tf-field">
              <span className="rt-tf-field-name">Other variable</span>
              <span className="rt-tf-input"><input placeholder="NAME" value={custom.key} onChange={(e) => setCustom({ ...custom, key: e.target.value.toUpperCase() })} /><input type="password" placeholder="value" value={custom.value} onChange={(e) => setCustom({ ...custom, value: e.target.value })} /></span>
            </div>
          )}
        </div>
        <footer><button type="button" onClick={onClose}>Cancel</button><button type="button" className="rt-primary" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</button></footer>
      </div>
    </div>
  );
}

/**
 * Terraform stacks of every project (folders with *.tf, `infra/` first): values in a modal, lint,
 * validate, unit tests, plan and apply (only the reviewed plan, with a confirmation) and the run
 * history with its console and errors.
 */
export function TerraformPanel({ client }: { client: TerraformClient }) {
  const tf = client.terraform!;
  const [stacks, setStacks] = useState<TerraformStack[]>();
  const [selected, setSelected] = useState<string>();
  const [history, setHistory] = useState<TerraformRun[]>([]);
  const [run, setRun] = useState<TerraformRun>();
  const [variables, setVariables] = useState<TerraformVariable[]>();
  const [globals, setGlobals] = useState<TerraformGlobal[]>();
  const [modal, setModal] = useState<"stack" | "globals">();
  const [confirmApply, setConfirmApply] = useState(false);
  const [error, setError] = useState("");
  const console_ = useRef<HTMLPreElement>(null);
  const stack = stacks?.find((s) => s.id === selected);
  const open = (url: string) => void tf.openLink(url).catch((e) => setError((e as Error).message));

  async function loadStacks() {
    try {
      const next = await tf.stacks();
      setStacks(next);
      setSelected((current) => current && next.some((s) => s.id === current) ? current : next[0]?.id);
      setGlobals(await tf.globals());
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => { void loadStacks(); }, []);
  useEffect(() => {
    if (!selected) return;
    setRun(undefined); setConfirmApply(false); setVariables(undefined);
    void Promise.all([tf.history(selected), tf.variables(selected)]).then(async ([h, v]) => {
      setHistory(h); setVariables(v);
      if (h[0]) setRun(await tf.getRun(selected, h[0].id));
    }).catch((e) => setError((e as Error).message));
  }, [selected]);
  // Follow a running command.
  useEffect(() => {
    if (!selected || run?.state !== "running") return;
    const timer = setInterval(async () => {
      const next = await tf.getRun(selected, run.id);
      if (!next) return;
      setRun(next);
      if (next.state !== "running") { setHistory(await tf.history(selected)); void loadStacks(); }
    }, 700);
    return () => clearInterval(timer);
  }, [selected, run?.id, run?.state]);
  useEffect(() => { if (console_.current) console_.current.scrollTop = console_.current.scrollHeight; }, [run?.output]);

  async function start(command: string) {
    if (!selected) return;
    setConfirmApply(false);
    try {
      const { id } = await tf.run(selected, command);
      setRun(await tf.getRun(selected, id));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const missing = (variables ?? []).filter((v) => v.required && !v.present);
  const running = run?.state === "running";
  const planReady = history[0]?.command === "plan" && history[0]?.state === "succeeded";
  const projects = [...new Set((stacks ?? []).map((s) => s.project))];

  return (
    <section className="rt-machine rt-terraform" aria-label="Terraform">
      <div className="rt-services-toolbar">
        <h2>Terraform</h2>
        <button onClick={() => setModal("globals")}>Global variables{globals ? ` (${globals.filter((g) => g.present).length})` : ""}</button>
        <button onClick={() => void loadStacks()}>Rescan</button>
      </div>
      <p className="rt-wizard-note">Every folder with <code>.tf</code> files in your projects (convention: <code>infra/</code>). Values are saved on this Mac only (never in the project) and passed as <code>TF_VAR_*</code> and environment variables.</p>
      {error && <p role="alert" className="rt-services-error">{error}</p>}
      {!stacks && <p>Scanning projects…</p>}
      {stacks && !stacks.length && <p>No Terraform found. Add an <code>infra/</code> folder with <code>.tf</code> files to a project. RT-App projects include <code>infra/stripe</code> for subscription plans.</p>}
      {!!stacks?.length && (
        <div className="rt-tf-layout">
          <nav className="rt-tf-stacks" aria-label="Terraform stacks">
            {projects.map((project) => (
              <div key={project}>
                <h3>{project}</h3>
                {stacks.filter((s) => s.project === project).map((s) => (
                  <button key={s.id} aria-current={s.id === selected ? "page" : undefined} title={s.path} onClick={() => setSelected(s.id)}>
                    <span>{s.name}</span>
                    {s.lastRun && <small className={`rt-tf-state rt-tf-${s.lastRun.state}`}>{s.lastRun.command} · {s.lastRun.state}</small>}
                  </button>
                ))}
              </div>
            ))}
          </nav>
          {stack && (
            <div className="rt-tf-detail">
              <header>
                <div><strong>{stack.project} / {stack.name}</strong><small>{stack.path.replace(/^\/Users\/[^/]+/, "~")}</small></div>
                <button onClick={() => setModal("stack")}>Variables{variables ? ` (${variables.filter((v) => v.present).length}/${variables.length})` : ""}</button>
              </header>
              {missing.length > 0 && <p className="rt-tf-warning">Missing required values: {missing.map((v) => v.name).join(", ")}. <button className="rt-services-link" onClick={() => setModal("stack")}>Fill them in</button></p>}
              <div className="rt-tf-actions">
                {ACTIONS.map(([command, label, hint]) => <button key={command} title={hint} disabled={running} onClick={() => void start(command)}>{label}</button>)}
                <span className="rt-tf-separator" />
                <button className="rt-primary" disabled={running} title="terraform plan: shows what would change and saves the plan" onClick={() => void start("plan")}>Plan</button>
                {confirmApply ? (
                  <>
                    <button className="rt-danger" disabled={running} onClick={() => void start("apply")}>Yes, apply the plan</button>
                    <button onClick={() => setConfirmApply(false)}>Cancel</button>
                  </>
                ) : (
                  <button className="rt-danger" disabled={running || !planReady} title={planReady ? "Apply exactly the last plan" : "Run Plan first; Apply applies the reviewed plan"} onClick={() => setConfirmApply(true)}>Apply…</button>
                )}
              </div>
              {confirmApply && <p className="rt-tf-warning">Apply changes real infrastructure with the plan shown below. Review it first.</p>}
              {run && (
                <div className="rt-tf-run">
                  <div className="rt-tf-run-header"><strong>{run.command}</strong><span className={`rt-tf-state rt-tf-${run.state}`}>{run.state === "running" ? "running…" : run.state}{run.exitCode !== undefined && run.state !== "running" ? ` · exit ${run.exitCode}` : ""}</span><small>{new Date(run.startedAt).toLocaleString()}</small></div>
                  {!!run.errors?.length && (
                    <ul className="rt-tf-errors" aria-label="Errors">
                      {run.errors.map((e, i) => <li key={i}><strong>Error:</strong> {e.summary}{e.file && <small> — {e.file}{e.line ? `:${e.line}` : ""}</small>}</li>)}
                    </ul>
                  )}
                  <pre ref={console_} className="rt-tf-console">{(run.output ?? "").split("\n").map((line, i) => <span key={i} className={/Error:/.test(line) ? "rt-tf-line-error" : /Warning:/.test(line) ? "rt-tf-line-warning" : /^\s*[+]/.test(line) ? "rt-tf-line-add" : /^\s*[-]/.test(line) ? "rt-tf-line-remove" : /^\s*[~]/.test(line) ? "rt-tf-line-change" : undefined}>{line + "\n"}</span>)}</pre>
                </div>
              )}
              <h3>History</h3>
              {!history.length && <p className="rt-wizard-note">No runs yet. Start with Init.</p>}
              <ul className="rt-tf-history">
                {history.map((h) => (
                  <li key={h.id}><button aria-current={run?.id === h.id ? "true" : undefined} onClick={async () => setRun(await tf.getRun(stack.id, h.id))}>
                    <strong>{h.command}</strong><span className={`rt-tf-state rt-tf-${h.state}`}>{h.state}</span><small>{new Date(h.startedAt).toLocaleString()}{h.errors?.length ? ` · ${h.errors.length} error${h.errors.length > 1 ? "s" : ""}` : ""}</small>
                  </button></li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      {modal === "stack" && stack && variables && (
        <ValuesModal
          title={`Variables · ${stack.name}`}
          intro="Values for this stack, passed as TF_VAR_<name>. Secrets are stored on this Mac (0600) and never shown again: leave a secret empty to keep it, or use Clear."
          rows={variables.map((v) => ({ key: v.name, label: v.name, description: v.description, type: v.type, required: v.required, secret: v.sensitive, present: v.present, value: v.value }))}
          onSave={async (values) => setVariables(await tf.setVariables(stack.id, values))}
          onClose={() => setModal(undefined)}
          open={open}
        />
      )}
      {modal === "globals" && globals && (
        <ValuesModal
          title="Global variables"
          intro="Environment for every Terraform run (cloud credentials, API keys). Enter them once; each stack uses what it needs. Leave a secret empty to keep it, or use Clear."
          rows={globals.map((g) => ({ key: g.key, label: g.key, description: g.description, url: g.url, secret: g.secret, present: g.present }))}
          onSave={async (values) => setGlobals(await tf.setGlobals(values))}
          onClose={() => setModal(undefined)}
          open={open}
        />
      )}
    </section>
  );
}
