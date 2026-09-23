import React, { useState, useEffect } from "react";
export function SetupWizard({ token }: { token: string }) {
  const [requirements, setRequirements] = useState<any>(),
    [config, setConfig] = useState({
      provider: "aws",
      multiEnvironment: false,
      region: "us-east-1",
      stack: "rt-app-hello",
      mailFrom: "",
      repository: "",
    }),
    [identity, setIdentity] = useState<any>(),
    [confirmation, setConfirmation] = useState(""),
    [job, setJob] = useState<any>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function api(path: string, body?: unknown) {
    const response = await fetch("/api/setup/" + path, {
      method: body ? "POST" : "GET",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + token,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    return result;
  }
  useEffect(() => {
    void api("requirements")
      .then((r) => {
        setRequirements(r);
        setConfig((c) => ({ ...c, ...r.defaults }));
      })
      .catch((e) => setError(e.message));
    void api("status")
      .then(setJob)
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    if (job?.state !== "running") return;
    const timer = setInterval(
      () =>
        void api("status")
          .then(setJob)
          .catch((e) => setError(e.message)),
      2000,
    );
    return () => clearInterval(timer);
  }, [job?.state]);
  async function inspect() {
    setBusy(true);
    setError("");
    try {
      setIdentity(await api("inspect", { config }));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function install() {
    setBusy(true);
    setError("");
    try {
      setJob(
        await api("install", {
          config,
          modules: requirements.modules,
          expectedAccount: identity.account,
          confirmation,
        }),
      );
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="setup-shell">
      <section className="profile-card">
        <p className="eyebrow">RT-APP / AWS INSTALLATION</p>
        <h1>Install your application</h1>
        <p>
          AWS credentials and the root password come from the server
          environment. No admin user database is created.
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {job?.state === "running" || job?.state === "done" ? (
          <>
            <h2>
              {job.state === "done" ? "Installation complete" : "Installing…"}
            </h2>
            {job.messages?.map((m: string, i: number) => (
              <p key={i}>{m}</p>
            ))}
            {job.result?.deployments?.map((d: any) => (
              <p key={d.environment}>
                {d.environment}: <a href={d.adminUrl}>Open admin</a> ·{" "}
                <a href={d.publicUrl}>Open public site</a>
              </p>
            ))}
            {job.result && !job.result.githubConfigured && (
              <p>
                Copy the GitHub Actions variables from .rt-app/installation.json
                into your repository settings.
              </p>
            )}
          </>
        ) : (
          <>
            <h2>1. Prerequisites</h2>
            <p>
              Node: {requirements?.node ?? "checking…"} · Terraform ≥1.11:{" "}
              {requirements?.terraform ? "ready" : "missing"}
            </p>
            <p>
              AWS access is verified when you continue. A verified SES sender is
              required for application emails.
            </p>
            <h2>2. Application settings</h2>
            {(
              [
                ["region", "AWS region"],
                ["stack", "Application name"],
                ["mailFrom", "Verified SES sender"],
                ["repository", "GitHub OWNER/REPO"],
              ] as const
            ).map(([key, label]) => (
              <label key={key}>
                {label}
                <input
                  value={config[key]}
                  onChange={(e) => {
                    setConfig({ ...config, [key]: e.target.value });
                    setIdentity(undefined);
                  }}
                />
              </label>
            ))}
            <label><input type="checkbox" checked={config.multiEnvironment} onChange={e => {setConfig({...config, multiEnvironment:e.target.checked});setIdentity(undefined);}} />
              Multi-environment: develop, stage and production (default: production only)
            </label>
            <button
              disabled={busy || !requirements?.terraform}
              onClick={inspect}
            >
              Verify AWS account
            </button>
            {identity && (
              <>
                <h2>3. Review and install</h2>
                <p>Account: {identity.account}</p>
                <ul>
                  {identity.resources.map((r: string) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
                <p>
                  This creates {config.multiEnvironment ? "develop, stage and production" : "production only"} and may incur AWS costs.
                </p>
                <label>
                  Type {config.stack} to confirm
                  <input
                    value={confirmation}
                    onChange={(e) => setConfirmation(e.target.value)}
                  />
                </label>
                <button
                  className="primary"
                  disabled={busy || confirmation !== config.stack}
                  onClick={install}
                >
                  Install and publish
                </button>
              </>
            )}
            {job?.state === "failed" && (
              <p className="error">
                {job.error}. Review local logs, then retry with the same
                configuration.
              </p>
            )}
          </>
        )}
      </section>
    </main>
  );
}
