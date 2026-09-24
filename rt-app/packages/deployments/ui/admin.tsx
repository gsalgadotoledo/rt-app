import React, { useEffect, useState } from "react";
import type { Api } from "@gsalgadotoledo/rt-app-admin-ui";
import "./style.css";

/**
 * Admin → Deployments. Choose a provider per role and environment, enter API keys and runtime
 * secrets (stored locally, pushed to GitHub environments), plan, apply and follow status.
 * Available while the admin runs locally; deployed admins show how to reach it.
 */
export default function Deployments({ api }: { api: Api }) {
  const [data, setData] = useState<any>();
  const [environment, setEnvironment] = useState("stage");
  const [draft, setDraft] = useState<any>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [plans, setPlans] = useState<any[]>();
  const [results, setResults] = useState<any[]>();
  const [statuses, setStatuses] = useState<any[]>();
  const [unavailable, setUnavailable] = useState(false);

  async function load() {
    try {
      const next = await api("/__dev/deploy");
      setData(next);
      setDraft(structuredClone(next.deploy));
    } catch (e) {
      const text = (e as Error).message;
      if (/not found|403|404|Origin not allowed/i.test(text)) setUnavailable(true);
      else setError(text);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function action(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await work();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (unavailable)
    return (
      <section className="deployments">
        <p>Deployments are configured from local development: run <code>npm run dev</code> and open this page on localhost, or use <code>rta deploy</code> in a terminal.</p>
      </section>
    );
  if (!data || !draft) return error ? <p role="alert">{error}</p> : <p className="hint">Loading deployments…</p>;

  const targets = draft.environments[environment] ?? {};
  const providerOf = (id: string) => data.providers.find((p: any) => p.id === id);
  const setTarget = (role: string, value: any) => {
    const next = structuredClone(draft);
    next.environments[environment] ??= {};
    if (value) next.environments[environment][role] = value;
    else delete next.environments[environment][role];
    setDraft(next);
  };
  const dirty = JSON.stringify(draft) !== JSON.stringify(data.deploy);
  const credentials = data.credentials[environment] ?? [];
  const runtime = data.runtime[environment] ?? [];
  const branch = data.environments.find((e: any) => e.id === environment)?.branch;

  return (
    <section className="deployments">
      <p className="hint">
        Pick where each part of the app runs. A merge into <code>{branch}</code> deploys <strong>{environment}</strong> through the GitHub workflow
        {data.repository ? <> of <code>{data.repository}</code></> : <> (connect GitHub first: <code>rta github connect</code>)</>}.
        Keys are stored in <code>.rt-app/credentials.json</code> on this machine (never committed) and pushed as GitHub environment secrets.
      </p>
      <nav className="tabs">
        {data.environments.map((e: any) => (
          <button key={e.id} className={environment === e.id ? "active" : ""} onClick={() => { setEnvironment(e.id); setPlans(undefined); setResults(undefined); setStatuses(undefined); }}>
            {e.id} <small>· {e.branch}</small>
          </button>
        ))}
      </nav>
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}

      <h3>Where each role runs</h3>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Role</th><th>Provider</th><th>Settings</th></tr></thead>
          <tbody>
            {data.roles.map((role: any) => {
              const target = targets[role.id];
              const provider = target && providerOf(target.provider);
              return (
                <tr key={role.id}>
                  <td><strong>{role.label}</strong></td>
                  <td>
                    <select aria-label={role.label + " provider"} value={target?.provider ?? ""} onChange={(e) => setTarget(role.id, e.target.value ? { provider: e.target.value } : undefined)}>
                      <option value="">Not deployed</option>
                      {data.providers.filter((p: any) => p.roles.includes(role.id)).map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                    {provider?.notes && <small className="provider-note">{provider.notes}</small>}
                  </td>
                  <td className="provider-settings">
                    {(provider?.settings ?? []).map((spec: any) => (
                      <label key={spec.key}>
                        {spec.label}
                        {spec.options ? (
                          <select value={String(target.settings?.[spec.key] ?? spec.default ?? "")} onChange={(e) => setTarget(role.id, { ...target, settings: { ...target.settings, [spec.key]: spec.type === "number" ? Number(e.target.value) : e.target.value } })}>
                            {spec.options.map((o: string) => <option key={o}>{o}</option>)}
                          </select>
                        ) : spec.type === "boolean" ? (
                          <input type="checkbox" checked={Boolean(target.settings?.[spec.key] ?? spec.default)} onChange={(e) => setTarget(role.id, { ...target, settings: { ...target.settings, [spec.key]: e.target.checked } })} />
                        ) : (
                          <input type={spec.type === "number" ? "number" : "text"} value={String(target.settings?.[spec.key] ?? spec.default ?? "")} onChange={(e) => setTarget(role.id, { ...target, settings: { ...target.settings, [spec.key]: spec.type === "number" ? Number(e.target.value) : e.target.value } })} />
                        )}
                      </label>
                    ))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="deploy-actions">
        <button className="primary" disabled={busy || !dirty} onClick={() => void action(async () => { await api("/__dev/deploy", "PUT", { deploy: draft }); await load(); setMessage("Saved in rt-app.settings.json. Commit it so the workflow uses it."); })}>Save targets</button>
        {dirty && <button disabled={busy} onClick={() => setDraft(structuredClone(data.deploy))}>Discard changes</button>}
      </div>

      <h3>API keys · {environment}</h3>
      {!credentials.length && <p className="hint">Choose a provider above to see the keys it needs.</p>}
      {credentials.map((p: any) => (
        <article key={p.provider} className="credential-group">
          <h4>{providerOf(p.provider)?.name} <a href={providerOf(p.provider)?.website} target="_blank" rel="noreferrer">website ↗</a></h4>
          {p.credentials.map((c: any) => (
            <SecretField key={c.key} label={c.label + (c.optional ? " (optional)" : "")} name={c.key} present={c.present} link={c.url} busy={busy}
              onSave={(value) => action(async () => { await api("/__dev/deploy/credentials", "PUT", { environment, key: c.key, value }); await load(); setMessage(value ? `${c.key} saved for ${environment}.` : `${c.key} removed.`); })} />
          ))}
        </article>
      ))}

      <h3>Runtime secrets · {environment}</h3>
      <p className="hint">Used by the API process in portable deployments. DATABASE_URL comes from the database role when one is configured.</p>
      <article className="credential-group">
        {runtime.map((s: any) =>
          s.key === "JWT_SECRET" ? (
            <div key={s.key} className="secret-field">
              <span><code>{s.key}</code> {s.present ? "✓ set" : "✗ missing"}</span>
              <button disabled={busy} onClick={() => void action(async () => { await api("/__dev/deploy/generate", "POST", { environment, key: s.key }); await load(); setMessage("New signing key generated. Existing sessions of this environment end after the next deploy."); })}>{s.present ? "Regenerate" : "Generate"}</button>
            </div>
          ) : s.key === "ADMIN_PASSWORD_VERIFIER" ? (
            <SecretField key={s.key} label="Admin password (stored as a hash)" name={s.key} present={s.present} busy={busy}
              onSave={(password) => action(async () => { await api("/__dev/deploy/generate", "POST", { environment, key: s.key, password }); await load(); setMessage("Admin password set for " + environment + "."); })} />
          ) : (
            <SecretField key={s.key} label={s.key === "SMTP_URL" ? "SMTP URL (smtps://user:pass@host)" : s.key === "MAIL_FROM" ? "Sender (Name <address>)" : s.key} name={s.key} present={s.present} busy={busy}
              onSave={(value) => action(async () => { await api("/__dev/deploy/credentials", "PUT", { environment, key: s.key, value }); await load(); })} />
          ),
        )}
      </article>

      <h3>Deploy</h3>
      <div className="deploy-actions">
        <button disabled={busy || dirty} onClick={() => void action(async () => setPlans((await api("/__dev/deploy/plan", "POST", { environment })).plans))}>Plan</button>
        <button className="primary" disabled={busy || dirty || !plans?.length} onClick={() => void action(async () => { setResults((await api("/__dev/deploy/apply", "POST", { environment })).results); setMessage("Applied. Follow the provider dashboards for build logs."); })}>Apply now</button>
        <button disabled={busy} onClick={() => void action(async () => setStatuses((await api("/__dev/deploy/status?environment=" + environment)).statuses))}>Status</button>
        <button disabled={busy || !data.repository} onClick={() => void action(async () => { const r = await api("/__dev/deploy/github", "POST", { environment }); setMessage(`GitHub ${r.repository}: ${environment} secrets ${(r.secrets[environment] ?? []).join(", ") || "none"} synced.`); })}>Sync to GitHub</button>
      </div>
      {dirty && <p className="hint">Save the targets before planning.</p>}
      {plans && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Role</th><th>Provider</th><th>Action</th><th>Resource</th><th>Detail</th></tr></thead>
            <tbody>{plans.flatMap((p) => p.actions.map((a: any, i: number) => <tr key={p.role + i}><td>{p.role}</td><td>{p.provider}</td><td><span className={"plan-action " + a.action}>{a.action}</span></td><td>{a.resource}</td><td>{a.detail}</td></tr>))}</tbody>
          </table>
          {!plans.length && <p className="empty">Nothing to deploy with providers here (no roles, or AWS only: AWS deploys through Terraform).</p>}
        </div>
      )}
      {results && <ul className="deploy-results">{results.map((r) => <li key={r.role}><strong>{r.role}</strong> · {r.provider} · {r.url ? <a href={r.url} target="_blank" rel="noreferrer">{r.url}</a> : "no public URL"}</li>)}</ul>}
      {statuses && <ul className="deploy-results">{statuses.map((s) => <li key={s.role}><strong>{s.role}</strong> · {s.provider} · <span className={"plan-action " + s.state}>{s.state}</span> {s.url ?? s.detail ?? ""}</li>)}</ul>}
    </section>
  );
}

/** Write-only secret input: shows whether a value exists, never the value itself. */
function SecretField({ label, name, present, link, busy, onSave }: { label: string; name: string; present: boolean; link?: string; busy: boolean; onSave: (value: string) => Promise<void> | void }) {
  const [value, setValue] = useState("");
  return (
    <form className="secret-field" onSubmit={(e) => { e.preventDefault(); void Promise.resolve(onSave(value)).then(() => setValue("")); }}>
      <label>
        <span><code>{name}</code> · {label} {present ? "✓ set" : "✗ missing"} {link && <a href={link} target="_blank" rel="noreferrer">create key ↗</a>}</span>
        <input type="password" autoComplete="off" value={value} placeholder={present ? "Replace value" : "Paste value"} onChange={(e) => setValue(e.target.value)} />
      </label>
      <button disabled={busy || !value}>Save</button>
      {present && <button type="button" disabled={busy} onClick={() => void onSave("")}>Remove</button>}
    </form>
  );
}
