import React, { useEffect, useRef, useState } from "react";
import type { Api, RecordTab } from "@gsalgadotoledo/rt-app-admin-ui";

/**
 * Admin → Users → a user → Bans: the ban in force, Ban / Unban with a required reason (a modal
 * dialog; the reason is kept in the history and never shown to the user) and the append-only
 * history. The server enforces every rule (who may ban whom, validation); the UI only hides
 * what the signed-in administrator cannot do.
 */
export function BansPanel({ api, record, user, onChange }: { api: Api; record: any; user: any; onChange: (record: any) => void }) {
  const [history, setHistory] = useState<any[]>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState<"ban" | "unban">();
  const dialog = useRef<HTMLDialogElement>(null);
  const allowed = (resource: string) => user?.role === "owner" || (Array.isArray(user?.grants) && user.grants.includes(resource));
  const self = record.id === user?.id;
  const canBan = allowed("users.ban") && !self && (record.role !== "owner" || user?.id === "rt-app-root") && (record.role !== "admin" || user?.role === "owner");

  const load = () =>
    allowed("users.bans.read")
      ? api(`/users/${encodeURIComponent(record.id)}/bans`)
          .then((result) => setHistory(result.items))
          .catch((e: Error) => setError(e.message))
      : Promise.resolve();
  useEffect(() => void load(), [record.id]);
  useEffect(() => {
    if (action) dialog.current?.showModal?.();
    else dialog.current?.close?.();
  }, [action]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const until = String(data.get("until") ?? "");
    const body =
      action === "ban"
        ? {
            reason: data.get("reason"),
            // datetime-local has no zone: read it in the browser's zone and send an ISO instant.
            ...(until ? { until: new Date(until).toISOString() } : {}),
            ...(data.get("category") ? { category: data.get("category") } : {}),
          }
        : { reason: data.get("reason") };
    setBusy(true);
    setError("");
    try {
      const updated = await api(`/users/${encodeURIComponent(record.id)}/${action}`, "POST", body);
      setAction(undefined);
      onChange(updated);
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="ban-panel">
      <h2>Account ban</h2>
      {record.banned ? (
        <dl className="ban-status">
          <dt>Status</dt>
          <dd><span className="badge danger">{record.ban?.until ? "Temporarily banned" : "Banned"}</span></dd>
          <dt>Reason</dt>
          <dd>{record.ban?.reason}</dd>
          <dt>Until</dt>
          <dd>{record.ban?.until ? new Date(record.ban.until).toLocaleString() : "Until lifted"}</dd>
          <dt>Category</dt>
          <dd>{record.ban?.category ?? "—"}</dd>
          <dt>Banned by</dt>
          <dd>{record.ban?.by} · {record.ban?.at}</dd>
        </dl>
      ) : (
        <p className="hint">Not banned. A ban ends every session at once and refuses sign-in with “Account suspended”.</p>
      )}
      {canBan && (
        <div className="record-actions">
          <button className="danger" disabled={busy} onClick={() => { setError(""); setAction("ban"); }}>
            {record.banned ? "Update ban" : "Ban"}
          </button>
          {record.banned && <button disabled={busy} onClick={() => { setError(""); setAction("unban"); }}>Unban</button>}
        </div>
      )}
      {!canBan && allowed("users.ban") && <p className="hint">{self ? "You cannot ban your own account." : record.role === "owner" ? "Only the admin root can ban an owner." : "Only an owner can ban an administrator."}</p>}
      {error && !action && <p role="alert" className="error">{error}</p>}
      <dialog ref={dialog} className="ban-dialog" onClose={() => setAction(undefined)} aria-labelledby="ban-dialog-title">
        {action && (
          <form onSubmit={submit}>
            <h2 id="ban-dialog-title">{action === "ban" ? (record.banned ? "Update the ban of " : "Ban ") : "Unban "}{record.name ?? record.email}</h2>
            <label>
              Reason (required, kept in the history)
              <textarea name="reason" required minLength={3} maxLength={500} autoFocus />
            </label>
            {action === "ban" && (
              <>
                <label>
                  Until (optional; empty bans until lifted)
                  <input name="until" type="datetime-local" />
                </label>
                <label>
                  Category (optional)
                  <input name="category" pattern="[a-z][a-z0-9_\-]{0,39}" maxLength={40} placeholder="fraud, spam, abuse…" />
                </label>
                <p className="hint">Every session and access token of this account stops working immediately.</p>
              </>
            )}
            {action === "unban" && <p className="hint">Sign-in is allowed again. Sessions ended by the ban stay ended.</p>}
            {error && <p role="alert" className="error">{error}</p>}
            <div className="dialog-actions">
              <button type="button" disabled={busy} onClick={() => setAction(undefined)}>Cancel</button>
              <button className={action === "ban" ? "danger" : "primary"} disabled={busy}>{action === "ban" ? "Ban account" : "Unban account"}</button>
            </div>
          </form>
        )}
      </dialog>
      {history && (
        <>
          <h3>History</h3>
          {history.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>When</th><th>Action</th><th>Reason</th><th>Until</th><th>Category</th><th>By</th></tr>
                </thead>
                <tbody>
                  {history.map((item) => (
                    <tr key={item.id}>
                      <td>{item.at}</td>
                      <td><span className={`badge ${item.action === "unban" ? "positive" : "danger"}`}>{item.action}</span></td>
                      <td>{item.reason}</td>
                      <td>{item.until ?? "—"}</td>
                      <td>{item.category ?? "—"}</td>
                      <td>{item.actorId}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="hint">No bans recorded.</p>
          )}
        </>
      )}
    </section>
  );
}

/** The Bans record tab for the Users ResourcePanel (users with users.ban or users.bans.read). */
export const bansTab: RecordTab = {
  id: "bans",
  label: "Bans",
  visible: (_record, user) =>
    user?.role === "owner" || (Array.isArray(user?.grants) && (user.grants.includes("users.ban") || user.grants.includes("users.bans.read"))),
  render: (props) => <BansPanel {...props} />,
};

export default BansPanel;
