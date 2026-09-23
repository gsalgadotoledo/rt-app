import React, { useState, useEffect } from "react";
import type { Api } from "@gsalgadotoledo/rt-app-admin-ui";
export default function AuthPanel({
  api,
  onSession,
  devMailbox = false,
}: {
  api: Api;
  onSession: (session: any) => void;
  devMailbox?: boolean;
}) {
  const [methods, setMethods] = useState({
    passwordLogin: true,
    emailCodeLogin: true,
  });
  React.useEffect(() => {
    void api("/auth/methods")
      .then((m) => {
        setMethods(m);
        if (!m.passwordLogin) setMode("code");
      })
      .catch(() => {});
  }, []);
  const [challengeId, setChallengeId] = useState("");
  const [mode, setMode] = useState("login"),
    [email, setEmail] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [mail, setMail] = useState<any[]>([]);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setMessage("");
    const data = Object.fromEntries(new FormData(e.currentTarget));
    setEmail(String(data.email ?? email));
    try {
      const paths: Record<string, string> = {
        login: "/auth/login",
        code: "/auth/code",
        verify: "/auth/code/verify",
        forgot: "/auth/forgot-password",
        reset: "/auth/reset-password",
        mfa: "/auth/mfa/verify",
      };
      const result = await api(paths[mode], "POST", {...data, challengeId});
      if (result.challengeId) setChallengeId(result.challengeId);
      if (result.challenge === 'totp') {setMode('mfa');setMessage("Enter the code from your authenticator.");}
      else if (result.token) {
        onSession(result);
      } else {
        setMessage(result.message);
        if (mode === "code") setMode("verify");
        else if (mode === "forgot") setMode("reset");
        else if (mode === "reset")
          setMode(methods.passwordLogin ? "login" : "code");
      }
    } catch (e: any) {
      setMessage(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-card">
      <p className="eyebrow">WORKSPACE ACCESS</p>
      <h2>
        {
          (
            {
              login: "Sign in",
              code: "Sign in with a code",
              verify: "Check your email",
              forgot: "Reset your password",
              reset: "New password",
              mfa: "Two-step verification",
            } as any
          )[mode]
        }
      </h2>
      <p className="muted">
        {mode === "login"
          ? "Welcome back. Sign in to your account."
          : "Follow the steps to sign in securely."}
      </p>
      <form onSubmit={submit}>
        {mode !== 'mfa' && <label>
          Email
          <input
            name="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="username"
          />
        </label>}
        {["login", "reset"].includes(mode) && (
          <label>
            {mode === "reset" ? "New password" : "Password"}
            <input
              name="password"
              type="password"
              required
              minLength={mode === "reset" ? 12 : undefined}
              maxLength={128}
              autoComplete={
                mode === "reset" ? "new-password" : "current-password"
              }
            />
          </label>
        )}
        {["verify", "reset", "mfa"].includes(mode) && (
          <label>
            6-digit code
            <input
              name="code"
              inputMode="numeric"
              pattern="[0-9]{6}"
              autoComplete="one-time-code"
              required
            />
          </label>
        )}
        {message && (
          <p role="status" className="notice">
            {message}
          </p>
        )}
        <button className="primary wide" disabled={busy}>
          {busy
            ? "Processing…"
            : mode === "login"
              ? "Enter workspace →"
              : mode === "code" || mode === "forgot"
                ? "Send code"
                : "Continue"}
        </button>
      </form>
      <div className="login-links">
        {(mode !== "login" || methods.emailCodeLogin) && (
          <button
            onClick={() => {
              setMode(
                mode === "login"
                  ? "code"
                  : methods.passwordLogin
                    ? "login"
                    : "code",
              );
              setMessage("");
            }}
          >
            {mode === "login" ? "Use an email code" : "Back to sign in"}
          </button>
        )}
        <button
          onClick={() => {
            setMode("forgot");
            setMessage("");
          }}
        >
          Forgot password
        </button>
      </div>
      {devMailbox && (
        <details>
          <summary>Local development inbox</summary>
          <p className="hint">
            Email codes from the local server appear here. No actual emails are sent.
          </p>
          <button
            onClick={() =>
              void api("/__dev/mailbox")
                .then(setMail)
                .catch((e) => setMessage(e.message))
            }
          >
            Refresh inbox
          </button>
          {mail.map((m, i) => (
            <p key={i}>
              {m.email} · {m.purpose} · <strong>{m.code}</strong>
            </p>
          ))}
        </details>
      )}
    </div>
  );
}
