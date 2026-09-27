import React, { useEffect, useState } from "react";
import type { Api } from "@gsalgadotoledo/rt-app-admin-ui";

/**
 * Admin → Service keys: credentials for backends (an agent server metering credits) that must
 * not hold ADMIN_PASSWORD. A key reaches only the /service/ endpoints of its scopes. The token is
 * shown once, right after creating or rotating a key; only its hash is stored.
 */
export default function ServiceKeysPanel({ api }: { api: Api }) {
  const [data, setData] = useState<{ items: any[]; scopes: string[] }>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState<{ id: string; token: string }>();
  const [form, setForm] = useState({ id: "", description: "", scopes: [] as string[], rateLimit: "" });

  const load = () =>
    api("/service-keys")
      .then((d) => {
        setData(d);
        setForm((f) => (f.scopes.length ? f : { ...f, scopes: d.scopes.includes("subscriptions.meter") ? ["subscriptions.meter"] : [] }));
      })
      .catch((e: Error) => setError(e.message));
  useEffect(() => void load(), []);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const create = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const result = await api("/service-keys", "POST", {
        id: form.id.trim() || undefined,
        description: form.description,
        scopes: form.scopes,
        rateLimit: form.rateLimit ? Number(form.rateLimit) : undefined,
      });
      setToken({ id: result.key.id, token: result.token });
      setForm({ ...form, id: "", description: "" });
    });
  };
  const rotate = (id: string) =>
    confirm(`Rotate ${id}? The current token stops working immediately.`) &&
    void run(async () => {
      const result = await api("/service-keys/" + encodeURIComponent(id) + "/rotate", "POST", {});
      setToken({ id, token: result.token });
    });
  const revoke = (id: string) =>
    confirm(`Revoke ${id}? Requests with it are rejected from now on.`) &&
    void run(async () => {
      await api("/service-keys/" + encodeURIComponent(id) + "/revoke", "POST", {});
    });
  const when = (ms: number | null) => (ms === null ? "—" : new Date(ms).toLocaleString());

  if (!data) return error ? <p role="alert">{error}</p> : <p className="hint">Loading service keys…</p>;
  return (
    <section className="service-keys">
      <p>
        Service keys let a backend call only the <code>/service/</code> endpoints of its scopes (for example{" "}
        <code>subscriptions.meter</code>: usage, pre-flight, reservations and debits of an account) without the admin password.
        Send it as <code>Authorization: Bearer rtsk_…</code>.
      </p>
      {error && <p role="alert">{error}</p>}
      {token && (
        <div role="status" className="service-key-token">
          <strong>Copy the token of {token.id} now; it is not shown again.</strong>
          <input readOnly value={token.token} onFocus={(e) => e.currentTarget.select()} aria-label="New service key token" />
          <button type="button" onClick={() => void navigator.clipboard?.writeText(token.token)}>Copy</button>
          <button type="button" onClick={() => setToken(undefined)}>Done</button>
        </div>
      )}
      <table>
        <thead>
          <tr><th>Key</th><th>Scopes</th><th>Limit / min</th><th>Source</th><th>Last used</th><th>Status</th><th /></tr>
        </thead>
        <tbody>
          {data.items.map((k) => (
            <tr key={k.id}>
              <td><strong>{k.description || k.id}</strong><br /><small><code>{k.prefix}…</code></small></td>
              <td>{k.scopes.join(", ")}</td>
              <td>{k.rateLimit}</td>
              <td>{k.source === "env" ? "Configuration" : `Admin · ${when(k.createdAt)}`}</td>
              <td>{when(k.lastUsedAt)}</td>
              <td>{k.active ? (k.rotatedAt ? `Active · rotated ${when(k.rotatedAt)}` : "Active") : `Revoked ${when(k.revokedAt)}`}</td>
              <td>
                {k.source === "admin" && k.active && (
                  <>
                    <button disabled={busy} onClick={() => rotate(k.id)}>Rotate</button>{" "}
                    <button disabled={busy} onClick={() => revoke(k.id)}>Revoke</button>
                  </>
                )}
              </td>
            </tr>
          ))}
          {!data.items.length && <tr><td colSpan={7}>No service keys yet.</td></tr>}
        </tbody>
      </table>
      <form onSubmit={create} className="service-key-form">
        <h3>New service key</h3>
        <label>Description<input required maxLength={200} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Agent server (production)" /></label>
        <label>ID · optional<input maxLength={64} pattern="[A-Za-z0-9_-]{1,64}" value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value })} placeholder="agent-server" /><small>Shown in audit entries as service:&lt;id&gt;. Random when empty.</small></label>
        <fieldset>
          <legend>Scopes</legend>
          {data.scopes.map((scope) => (
            <label key={scope}>
              <input type="checkbox" checked={form.scopes.includes(scope)} onChange={(e) => setForm({ ...form, scopes: e.target.checked ? [...form.scopes, scope] : form.scopes.filter((s) => s !== scope) })} /> {scope}
            </label>
          ))}
        </fieldset>
        <label>Requests per minute · optional<input type="number" min={1} max={100000} step={1} value={form.rateLimit} onChange={(e) => setForm({ ...form, rateLimit: e.target.value })} placeholder="600" /></label>
        <button disabled={busy || !form.scopes.length || !form.description.trim()}>Create key</button>
        <p className="hint">Rotate to replace a leaked token at once; for a rotation without downtime create a second key, deploy it, then revoke the first. Keys configured in RT_APP_SERVICE_KEYS are changed in the configuration.</p>
      </form>
    </section>
  );
}
