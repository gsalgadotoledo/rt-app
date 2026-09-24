import React, { useEffect, useState } from "react";

export interface DeployInfo {
  providers: { id: string; name: string; roles: string[]; website: string; notes?: string; credentials: { key: string; optional?: boolean }[] }[];
  roles: { id: string; label: string }[];
  environments: { id: string; branch: string; targets: Record<string, { provider: string }> }[];
  credentials: Record<string, { provider: string; missing: string[] }[]>;
  repository: string | null;
}

export interface DeployClient {
  deployInfo?(): Promise<DeployInfo>;
  connectGithub?(): Promise<{ repository: string; created: boolean }>;
  openDeployments?(): Promise<void>;
}

/**
 * Deploy overview of the selected project: where each role runs per environment, missing API
 * keys and the GitHub repository. Keys and plans are edited in the admin (Deployments page).
 */
export function DeployPanel({ client, onClose }: { client: DeployClient; onClose: () => void }) {
  const [info, setInfo] = useState<DeployInfo>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      setInfo(await client.deployInfo!());
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    void load();
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
    }
  }

  const name = (id: string) => info?.providers.find((p) => p.id === id)?.name ?? id;
  return (
    <section className="rt-deploy-panel" aria-label="Deploy">
      <div className="rt-services-toolbar">
        <h3>Deploy</h3>
        {client.openDeployments && <button disabled={busy} onClick={() => void act(() => client.openDeployments!())}>Configure in admin</button>}
        {client.connectGithub && !info?.repository && <button disabled={busy} onClick={() => void act(() => client.connectGithub!())}>Create GitHub repo</button>}
        <button onClick={onClose}>Back to services</button>
      </div>
      {error && <p role="alert" className="rt-services-error">{error}</p>}
      {info && (
        <>
          <p>
            {info.repository ? <>GitHub <strong>{info.repository}</strong> · merges to develop, stage and main deploy each environment.</> : <>Not on GitHub yet: create the repository to deploy on merge.</>}
            {" "}Start the project (admin running) to edit keys, plan and apply in Deployments.
          </p>
          <div className="rt-services-table">
            <table>
              <thead><tr><th>Role</th>{info.environments.map((e) => <th key={e.id}>{e.id} <small>({e.branch})</small></th>)}</tr></thead>
              <tbody>
                {info.roles.map((role) => (
                  <tr key={role.id}>
                    <td>{role.label}</td>
                    {info.environments.map((e) => <td key={e.id}>{e.targets[role.id] ? name(e.targets[role.id].provider) : <span className="rt-muted">—</span>}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {info.environments.map((e) => {
            const missing = (info.credentials[e.id] ?? []).flatMap((p) => p.missing.map((key) => `${name(p.provider)}: ${key}`));
            return missing.length ? <p key={e.id} className="rt-services-error">{e.id}: missing {missing.join(", ")}</p> : null;
          })}
          <h4>Available providers</h4>
          <div className="rt-services-catalog">
            {info.providers.map((p) => (
              <article key={p.id}>
                <strong>{p.name}</strong>
                <span>{p.roles.join(" · ")}</span>
                {p.notes && <small>{p.notes}</small>}
                <small>{p.credentials.length ? "Keys: " + p.credentials.map((c) => c.key + (c.optional ? " (optional)" : "")).join(", ") : "No API key: Terraform pipeline"}</small>
              </article>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
