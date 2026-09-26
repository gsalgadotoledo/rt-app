import React, { useEffect, useState } from "react";
import type { ProjectSetup } from "./ServiceManager.js";

export interface WizardClient {
  projectStatus?(id: string, backendId?: string): Promise<ProjectSetup>;
  chooseWorkspace?(): Promise<string>;
  installTools?(ids: string[]): Promise<unknown>;
  createProject?(spec: { name: string; templateId: string; backendId: string }): Promise<unknown>;
}

const STEPS = ["Template", "Backend", "Tools", "Name & folder", "Create"] as const;
const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/**
 * New project, one decision per step: template → backend → tools → name and folder → create.
 * The step bar shows where you are; Back keeps every choice. Creation runs the initializer and
 * streams its output; nothing else of the manager is shown meanwhile.
 */
export function CreateProjectWizard({ client, onClose, onOpen }: { client: WizardClient; onClose: () => void; onOpen: (path: string) => void }) {
  const [step, setStep] = useState(0);
  const [templateId, setTemplateId] = useState("fullstack");
  const [backendId, setBackendId] = useState("node-ts");
  const [name, setName] = useState("");
  const [setup, setSetup] = useState<ProjectSetup>();
  const [error, setError] = useState("");

  // Poll while open: requirement status follows installs, the job log follows creation.
  useEffect(() => {
    if (!client.projectStatus) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await client.projectStatus!(templateId, backendId);
        if (!cancelled) setSetup(next);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) timer = setTimeout(poll, 1000);
      }
    }
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [templateId, backendId, client]);

  async function act(work: () => Promise<unknown>) {
    try {
      await work();
      setSetup(await client.projectStatus!(templateId, backendId));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const running = setup?.job.state === "running";
  const template = setup?.templates.find((t) => t.id === templateId);
  const backend = setup?.backends.find((b) => b.id === backendId);
  const missing = setup?.requirements.filter((r) => r.required && !r.ready) ?? [];
  const created = step === 4 && setup?.job.state === "done" ? setup.job.result?.path : undefined;
  const canContinue = [Boolean(template), Boolean(backend), Boolean(setup) && !missing.length, Boolean(setup?.workspace) && NAME.test(name)][step] ?? false;

  return (
    <section className="rt-project-wizard" aria-label="Create project">
      <div className="rt-wizard-heading">
        <div>
          <p className="rt-services-kicker">NEW PROJECT</p>
          <h2>{STEPS[step]}</h2>
        </div>
        <button disabled={running} onClick={onClose}>Cancel</button>
      </div>

      <ol className="rt-wizard-steps" aria-label="Steps">
        {STEPS.map((label, index) => (
          <li key={label} aria-current={index === step ? "step" : undefined} className={index < step ? "done" : ""}>
            <button disabled={running || index > step || step === 4} onClick={() => setStep(index)}>
              <span>{index < step ? "✓" : index + 1}</span> {label}
            </button>
          </li>
        ))}
      </ol>

      {error && <p role="alert" className="rt-services-error">{error}</p>}

      {step === 0 && (
        <>
          <p className="rt-wizard-note">Choose what to build. Every template starts from the same tested base (API, SPA, SSR, admin); the prompt tells Claude or another LLM what to build on top.</p>
          <div className="rt-template-grid">
            {setup?.templates.map((t) => (
              <button key={t.id} aria-pressed={templateId === t.id} onClick={() => setTemplateId(t.id)}>
                <strong>{t.name}</strong>
                <span>{t.description}</span>
              </button>
            ))}
          </div>
          {template?.prompt && (
            <details className="rt-template-prompt">
              <summary>Template prompt</summary>
              <pre>{template.prompt}</pre>
            </details>
          )}
        </>
      )}

      {step === 1 && (
        <>
          <p className="rt-wizard-note">The language of the API process. The admin, SPA and SSR are the same for every backend.</p>
          <div className="rt-template-grid">
            {setup?.backends.map((b) => (
              <button key={b.id} aria-pressed={backendId === b.id} onClick={() => setBackendId(b.id)}>
                <strong>{b.name}</strong>
                <span>{b.description}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {step === 2 && (
        <>
          <p className="rt-wizard-note">Tools needed by {template?.name ?? "this template"} with {backend?.name ?? "this backend"}. Missing tools install privately through mise; your shell configuration stays unchanged.</p>
          <div className="rt-requirements">
            {setup?.requirements.map((r) => (
              <div key={r.id}>
                <span className={r.ready ? "rt-ready" : "rt-missing"}>{r.ready ? "✓" : "○"}</span>
                <div>
                  <strong>{r.name}</strong>
                  <small>{r.required ? "Required" : "Optional"} · {r.installedVersion || "Not installed"}</small>
                </div>
                <button disabled={running || r.ready} onClick={() => void act(() => client.installTools!([r.id]))}>{r.ready ? "Available" : "Install"}</button>
              </div>
            ))}
          </div>
          {running && <pre className="rt-wizard-log" aria-label="Installation output">{setup?.job.log.join("\n")}</pre>}
        </>
      )}

      {step === 3 && (
        <div className="rt-project-fields">
          <label>
            Project name
            <input autoFocus aria-label="Project name" value={name} onChange={(e) => setName(e.target.value)} placeholder="my-new-app" maxLength={48} />
          </label>
          {name && !NAME.test(name) && <p className="rt-services-error">Use lowercase letters, numbers and hyphens (e.g. my-store).</p>}
          <label>
            Folder
            <div>
              <input aria-label="Workspace folder" readOnly value={setup?.workspace ?? ""} placeholder="Choose where your projects live" />
              <button onClick={() => void act(() => client.chooseWorkspace!())}>Choose…</button>
            </div>
          </label>
          <p className="rt-wizard-summary">
            <strong>{template?.name}</strong> · {backend?.name} → <code>{setup?.workspace || "…"}/{name || "project-name"}</code>
          </p>
          {setup?.initializer && <p className="rt-wizard-note">Runs: <code>{setup.initializer} {name || "<name>"} --template {templateId}</code>. Existing folders are never overwritten.</p>}
        </div>
      )}

      {step === 4 && (
        <>
          {running && <p role="status">Creating {name}… installing dependencies can take a minute.</p>}
          <pre className="rt-wizard-log" aria-label="Project creation output">{setup?.job.log.join("\n")}</pre>
          {setup?.job.state === "error" && <p role="alert" className="rt-services-error">{setup.job.error}</p>}
          {created && (
            <div className="rt-wizard-done">
              <h3>{name} is ready</h3>
              <p>{created}</p>
              <button className="primary" onClick={() => onOpen(created)}>Open project →</button>
            </div>
          )}
        </>
      )}

      <div className="rt-wizard-nav">
        {step > 0 && step < 4 && <button onClick={() => setStep(step - 1)}>← Back</button>}
        {step === 4 && setup?.job.state === "error" && <button onClick={() => setStep(3)}>← Back to name & folder</button>}
        {step < 3 && <button className="primary" disabled={!canContinue} onClick={() => setStep(step + 1)}>Continue →</button>}
        {step === 3 && (
          <button className="primary" disabled={!canContinue || running} onClick={() => { setStep(4); void act(() => client.createProject!({ name, templateId, backendId })); }}>
            Create project
          </button>
        )}
      </div>
    </section>
  );
}
