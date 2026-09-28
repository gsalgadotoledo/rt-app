import React, { useCallback, useEffect, useRef, useState } from "react";

export interface WizardField {
  key: string;
  file: "config" | "secrets";
  label: string;
  secret: boolean;
  optional: boolean;
  help?: string;
  placeholder?: string;
  pattern?: string;
  options?: "aws-profiles";
  choices?: string[];
  present: boolean;
  /** Only for a value that is not a secret. */
  value?: string;
}
export interface WizardStep {
  id: string;
  title: string;
  summary?: string;
  platform?: { name: string; url: string };
  how: string[];
  links: { label: string; url: string }[];
  fields: WizardField[];
  oneOf: string[];
  actions: { id: string; label: string; command: string[]; confirm?: string; help?: string }[];
  /** null: a step of commands alone (nothing to check). */
  done: boolean | null;
}
export interface WizardState {
  wizard: { title: string; files: { config: string; secrets: string }; steps: WizardStep[] } | null;
}
export interface WizardRun {
  id: string;
  label: string;
  command: string;
  state: "running" | "succeeded" | "failed";
  exitCode?: number;
  output: string;
}
export interface WizardClient {
  wizard?: {
    state(): Promise<WizardState>;
    save(values: Record<string, string>): Promise<WizardState>;
    run(step: string, action: string): Promise<{ id: string }>;
    getRun(id: string): Promise<WizardRun>;
  };
  terraform?: { openLink(url: string): Promise<void> };
}

/**
 * The project's deploy setup, step by step (its `deploy.wizard.json`): on the left what the step
 * needs — the values, saved to the project's env files, a secret never shown again — and its
 * commands with their output; on the right where to find each value: the platform's link and the
 * steps to get it.
 */
export function DeployWizard({ client, project }: { client: WizardClient; project: string }) {
  const api = client.wizard!;
  const [state, setState] = useState<WizardState>();
  const [at, setAt] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState<WizardRun>();
  const poll = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const load = useCallback(async (jump = false) => {
    try {
      const next = await api.state();
      setState(next);
      if (jump && next.wizard) {
        const first = next.wizard.steps.findIndex((s) => s.done === false);
        setAt(first < 0 ? next.wizard.steps.length - 1 : first);
      }
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api]);
  useEffect(() => {
    void load(true);
    return () => clearTimeout(poll.current);
  }, [load, project]);

  if (!state) return <section className="rt-wizard"><p>Loading…</p></section>;
  const w = state.wizard;
  if (!w)
    return (
      <section className="rt-wizard rt-wizard-empty">
        <h2>Deploy setup</h2>
        <p>This project has no <code>deploy.wizard.json</code>. Add one at its root to be guided here, step by step, through the values its deploy needs.</p>
        {error && <p className="rt-error">{error}</p>}
      </section>
    );
  const step = w.steps[Math.min(at, w.steps.length - 1)];
  const dirty = step.fields.some((f) => drafts[f.key] !== undefined);
  const open = (url: string) => void client.terraform?.openLink(url).catch((e) => setError((e as Error).message));

  const save = async (): Promise<boolean> => {
    const values = Object.fromEntries(step.fields.filter((f) => drafts[f.key] !== undefined).map((f) => [f.key, drafts[f.key]]));
    if (!Object.keys(values).length) return true;
    setBusy(true);
    try {
      setState(await api.save(values));
      setDrafts((d) => Object.fromEntries(Object.entries(d).filter(([k]) => !(k in values))));
      setError("");
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const follow = (id: string) => {
    clearTimeout(poll.current);
    void api.getRun(id).then((r) => {
      setRun(r);
      if (r.state === "running") poll.current = setTimeout(() => follow(id), 700);
      else void load();
    }).catch((e) => setError((e as Error).message));
  };
  const start = async (action: WizardStep["actions"][number]) => {
    if (action.confirm && !window.confirm(action.confirm)) return;
    if (dirty && !(await save())) return;
    try {
      const { id } = await api.run(step.id, action.id);
      follow(id);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const running = run?.state === "running";

  return (
    <section className="rt-wizard" aria-label={w.title}>
      <header className="rt-wizard-head">
        <h2>{w.title}</h2>
        <small>Saved to <code>{w.files.config}</code> and <code>{w.files.secrets}</code> (only on this machine, 0600)</small>
      </header>
      <ol className="rt-wizard-steps" role="tablist">
        {w.steps.map((s, i) => (
          <li key={s.id}>
            <button role="tab" aria-selected={i === at} className={`${s.done === true ? "done" : ""}${i === at ? " on" : ""}`} onClick={() => setAt(i)}>
              <i aria-hidden="true">{s.done === true ? "✓" : i + 1}</i>
              <span>{s.title}</span>
            </button>
          </li>
        ))}
      </ol>
      <div className="rt-wizard-body">
        <div className="rt-wizard-data">
          <h3>{step.title}</h3>
          {step.summary && <p>{step.summary}</p>}
          {step.oneOf.length > 0 && <p className="rt-wizard-note">One of the marked ones is enough.</p>}
          {step.fields.map((f) => {
            const draft = drafts[f.key];
            const value = draft ?? (f.secret ? "" : f.value ?? "");
            const invalid = Boolean(draft && f.pattern && !new RegExp(f.pattern).test(draft.trim()));
            const set = (v: string) => setDrafts((d) => ({ ...d, [f.key]: v }));
            return (
              <label key={f.key} className={`rt-wizard-field${f.present ? " present" : ""}${invalid ? " invalid" : ""}`}>
                <span>
                  {f.label}
                  {step.oneOf.includes(f.key) ? " ◆" : f.optional ? " (optional)" : ""}
                  <code>{f.key}</code>
                  {f.present && draft === undefined && <em>✓ saved</em>}
                </span>
                {f.options === "aws-profiles" && (f.choices?.length ?? 0) > 0 ? (
                  <select value={value} onChange={(e) => set(e.target.value)}>
                    <option value="">— choose a profile —</option>
                    {f.choices!.map((c) => <option key={c} value={c}>{c}</option>)}
                    {value && !f.choices!.includes(value) && <option value={value}>{value}</option>}
                  </select>
                ) : (
                  <input
                    type={f.secret ? "password" : "text"}
                    autoComplete="off"
                    spellCheck={false}
                    value={value}
                    placeholder={f.secret && f.present ? "•••••••• saved — paste a new one to replace it" : f.placeholder ?? ""}
                    onChange={(e) => set(e.target.value)}
                  />
                )}
                {f.help && <small>{f.help}</small>}
                {invalid && <small className="rt-error">This does not look right.</small>}
              </label>
            );
          })}
          {step.actions.length > 0 && (
            <div className="rt-wizard-actions">
              {step.actions.map((a) => (
                <div key={a.id}>
                  <button className="rt-primary" disabled={busy || running} title={a.command.join(" ")} onClick={() => void start(a)}>{a.label}</button>
                  <code>{a.command.join(" ")}</code>
                  {a.help && <small>{a.help}</small>}
                </div>
              ))}
            </div>
          )}
          {run && (
            <div className={`rt-wizard-run state-${run.state}`}>
              <div><strong>{run.label}</strong> <span>{run.state === "running" ? "running…" : run.state === "succeeded" ? "✓ done" : `failed (exit ${run.exitCode})`}</span></div>
              <pre>{run.output || "…"}</pre>
            </div>
          )}
          {error && <p className="rt-error">{error}</p>}
        </div>
        <aside className="rt-wizard-help" aria-label="Where to find it">
          {step.platform && (
            <button className="rt-wizard-platform" onClick={() => open(step.platform!.url)}>
              Open {step.platform.name} ↗
            </button>
          )}
          {step.how.length > 0 && (
            <>
              <h4>How to get it</h4>
              <ol>{step.how.map((h, i) => <li key={i}>{h}</li>)}</ol>
            </>
          )}
          {step.links.length > 0 && (
            <ul className="rt-wizard-links">
              {step.links.map((l) => <li key={l.url}><button className="rt-services-link" onClick={() => open(l.url)}>{l.label} ↗</button></li>)}
            </ul>
          )}
        </aside>
      </div>
      <footer className="rt-wizard-foot">
        <button disabled={at === 0 || busy} onClick={() => setAt(at - 1)}>← Back</button>
        <span>{w.steps.filter((s) => s.done === true).length}/{w.steps.filter((s) => s.done !== null).length} filled in</span>
        {dirty && <button disabled={busy} onClick={() => void save()}>Save</button>}
        <button className="rt-primary" disabled={busy || at === w.steps.length - 1} onClick={() => void save().then((ok) => ok && setAt(at + 1))}>
          {dirty ? "Save & continue →" : "Continue →"}
        </button>
      </footer>
    </section>
  );
}
