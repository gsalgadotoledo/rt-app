import React, { useEffect, useState } from "react";
import type { PanelProps } from "@gsalgadotoledo/rt-app-admin-ui";
export function AwsSettings({ api }: PanelProps) {
  const [settings, setSettings] = useState<any>(),
    [mode, setMode] = useState("role"),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    void api("/infra/settings")
      .then((s) => {
        setSettings(s);
        setMode(s.values.mode);
      })
      .catch((e) => setMessage(e.message));
  }, []);
  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget,
      data = Object.fromEntries(new FormData(form));
    const credentials =
      data.accessKeyId || data.secretAccessKey
        ? {
            accessKeyId: data.accessKeyId,
            secretAccessKey: data.secretAccessKey,
            ...(data.sessionToken ? { sessionToken: data.sessionToken } : {}),
          }
        : undefined;
    form.reset();
    setBusy(true);
    setMessage("");
    try {
      setSettings(
        await api("/infra/settings", "PUT", {
          version: settings.version,
          mode,
          region: data.region,
          ...(credentials ? { credentials } : {}),
        }),
      );
      setMessage(
        "Configuration saved. Keys are not returned to the browser.",
      );
    } catch (e: any) {
      setMessage(e.message);
    } finally {
      setBusy(false);
    }
  }
  if(settings?.managedByTerraform) return <section><h1>AWS infrastructure</h1><p>Managed by Terraform. Update infra/aws and merge into the deployment branch to deploy. Lambda does not create resources outside Terraform state.</p></section>;
  return (
    <section>
      <p className="eyebrow">INFRA / AWS</p>
      <h1>AWS connection</h1>
      <form className="profile-card" key={settings?.version} onSubmit={save}>
        <h2>Provider settings</h2>
        {settings?.simulation && (
          <p className="notice">
            Local simulation: no requests are sent to AWS and real keys are not accepted.
          </p>
        )}
        <label>
          Authentication
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="role">Execution role (recommended)</option>
            <option value="keys" disabled={settings?.simulation}>
              Access key stored in Secrets Manager
            </option>
          </select>
        </label>
        <label>
          Region
          <input
            name="region"
            defaultValue={settings?.values.region ?? "us-east-1"}
            required
            pattern="[a-z]{2}(-[a-z]+)+-[0-9]"
          />
        </label>
        {mode === "keys" && (
          <>
            <p className="hint">
              Use a restricted IAM user, never a console password or root credentials. Leave the fields empty to keep the saved version.
            </p>
            <p>
              Credentials:{" "}
              {settings?.credentialsConfigured
                ? "configured"
                : "not configured"}
            </p>
            <label>
              Access key ID
              <input name="accessKeyId" autoComplete="off" />
            </label>
            <label>
              Secret access key
              <input
                name="secretAccessKey"
                type="password"
                autoComplete="new-password"
              />
            </label>
            <label>
              Session token (optional)
              <input name="sessionToken" type="password" autoComplete="off" />
            </label>
          </>
        )}
        <p className="hint">
          The deployment role needs access to the secret before keys can be saved. The application's data connection uses its own configuration.
        </p>
        <button className="primary" disabled={busy || !settings}>
          Save configuration
        </button>{" "}
        <button
          type="button"
          disabled={busy || !settings}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await api("/infra/test", "POST", {});
              setMessage(
                `${r.simulation ? "SIMULATION · " : ""}Account: ${r.account} · ${r.arn} · ${r.region}`,
              );
            } catch (e: any) {
              setMessage(e.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          Test saved connection
        </button>
        {message && (
          <p role="status" className="notice">
            {message}
          </p>
        )}
      </form>
    </section>
  );
}
export default function InfraPanel({ api }: PanelProps) {
  const [plans, setPlans] = useState<any[]>([]),
    [plan, setPlan] = useState<any>(),
    [confirmation, setConfirmation] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [cursor, setCursor] = useState<string>();
  async function load(next?: string) {
    try {
      const r = await api(
        "/infra/plans" + (next ? `?cursor=${encodeURIComponent(next)}` : ""),
      );
      setPlans(r.items);
      setCursor(r.cursor);
    } catch (e: any) {
      setMessage(e.message);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  async function preview(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const p = await api(
        "/infra/plans",
        "POST",
        Object.fromEntries(new FormData(e.currentTarget)),
      );
      setPlan(p);
      setConfirmation("");
      await load();
    } catch (e: any) {
      setMessage(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section>
      <p className="eyebrow">INFRA / AWS</p>
      <h1>Build your infrastructure</h1>
      <p className="lead">The same module, available from code or the admin.</p>
      <div className="editor">
        <form onSubmit={preview}>
          <h2>New resource</h2>
          <label>
            Type
            <select name="kind">
              <option value="queue">Standard SQS queue</option>
              <option value="table">DynamoDB table</option>
            </select>
          </label>
          <label>
            Name
            <input
              name="name"
              placeholder="rt-app-my-resource"
              required
              pattern="rt-app-[a-z0-9-]{3,60}"
            />
          </label>
          <p className="hint">
            Generate a plan first. This step does not create the resource.
          </p>
          <button className="primary" disabled={busy}>
            Preview plan
          </button>
        </form>
        {plan && (
          <div className="profile-card">
            <h2>{plan.simulation ? "Simulated plan" : "AWS plan"}</h2>
            <p>
              <strong>{plan.spec.name}</strong> · {plan.spec.kind}
            </p>
            <p>
              Account: {plan.identity.account}
              <br />
              Region: {plan.region}
            </p>
            <p>{plan.summary}</p>
            <p className="notice">
              {plan.simulation
                ? "No real infrastructure will be created."
                : plan.costNotice}
            </p>
            <span className="badge">{plan.state}</span>
            {plan.state === "planned" && (
              <>
                <label>
                  Type {plan.spec.name} to confirm
                  <input
                    value={confirmation}
                    onChange={(e) => setConfirmation(e.target.value)}
                    autoComplete="off"
                  />
                </label>
                <button
                  className="primary"
                  disabled={busy || confirmation !== plan.spec.name}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      setPlan(
                        await api(`/infra/plans/${plan.id}/apply`, "POST", {
                          confirmation,
                        }),
                      );
                      await load();
                    } catch (e: any) {
                      setMessage(e.message);
                      await load();
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {plan.simulation
                    ? "Run simulation"
                    : "Create AWS resource"}
                </button>
              </>
            )}
            {plan.result && (
              <p>
                {plan.result.id}
                <br />
                {plan.result.status}
              </p>
            )}
          </div>
        )}
      </div>
      {message && (
        <p className="error" role="status">
          {message}
        </p>
      )}
      <h2 className="section-title">Saved plans</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Region</th>
              <th>Status</th>
              <th>Environment</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {plans.map((p) => (
              <tr key={p.id}>
                <td>{p.spec.name}</td>
                <td>{p.spec.kind}</td>
                <td>{p.region}</td>
                <td>{p.state}</td>
                <td>{p.simulation ? "Simulation" : "AWS"}</td>
                <td>
                  <button
                    onClick={() => {
                      setPlan(p);
                      setConfirmation("");
                    }}
                  >
                    View plan
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!plans.length && <p className="empty">No plans yet.</p>}
      </div>
      <div className="pagination">
        <button onClick={() => void load()}>First page</button>
        <button disabled={!cursor} onClick={() => void load(cursor)}>
          Next →
        </button>
      </div>
    </section>
  );
}

export {InstallationGuide} from "./install";
