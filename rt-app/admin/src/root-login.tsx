import React, { useState } from "react";
import type { Api } from "@gsalgadotoledo/rt-app-admin-ui";
export function RootLogin({
  api,
  onSession,
}: {
  api: Api;
  onSession: (session: any) => void;
}) {
  const [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <section className="profile-card login-card">
      <h1>RT-APP</h1>
      <p className="muted">Admin</p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            onSession(
              await api("/admin/identity/auth/login", "POST", { password }),
            );
            setPassword("");
          } catch (e: any) {
            setError(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Admin password
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            maxLength={128}
          />
        </label>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <button className="primary" disabled={busy}>
          Sign in
        </button>
      </form>
    </section>
  );
}
