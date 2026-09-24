import React, { useEffect, useState } from "react";
import type { Api } from "@gsalgadotoledo/rt-app-admin-ui";

/** Server-side search with bounded reads; empty pages may still have a next cursor. */
export function LogSearch({ api, day, refreshSignal = 0 }: { api: Api; day: string; refreshSignal?: number }) {
  const empty = {
    level: "",
    category: "",
    requestId: "",
    sessionId: "",
    text: "",
  };
  const [draft, setDraft] = useState(empty),
    [query, setQuery] = useState(empty),
    [cursor, setCursor] = useState<string>(),
    [page, setPage] = useState<any>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    setCursor(undefined);
  }, [day]);
  useEffect(() => {
    let active = true;
    setBusy(true);
    setError("");
    setPage(undefined);
    const params = new URLSearchParams({
      day,
      ...query,
      ...(cursor ? { cursor } : {}),
    });
    api("/observer/logs?" + params)
      .then((result) => {
        if (active) setPage(result);
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [day, query, cursor, revision, refreshSignal]);
  return (
    <article className="observer-box">
      <h2>Search logs</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setCursor(undefined);
          setQuery({ ...draft });
          setRevision((n) => n + 1);
        }}
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))",
          gap: 12,
          alignItems: "end",
        }}
      >
        <label>
          Level
          <select
            value={draft.level}
            onChange={(e) => setDraft({ ...draft, level: e.target.value })}
          >
            <option value="">Info, warning, error</option>
            {["info", "warn", "error", "debug"].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        {(["category", "requestId", "sessionId", "text"] as const).map(
          (field) => (
            <label key={field}>
              {
                {
                  category: "Category",
                  requestId: "Request ID",
                  sessionId: "Session ID",
                  text: "Search text",
                }[field]
              }
              <input
                maxLength={200}
                value={draft[field]}
                onChange={(e) =>
                  setDraft({ ...draft, [field]: e.target.value })
                }
              />
            </label>
          ),
        )}
        <button disabled={busy} type="submit">
          {busy ? "Searching…" : "Search"}
        </button>
      </form>
      <p className="hint">
        Selected UTC day. Each page reads a bounded batch; continue even if a
        filtered page is empty. Session IDs are opaque correlation labels, never
        login tokens.
      </p>
      {error && <p role="alert">{error}</p>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {[
                "Time",
                "Level",
                "Category",
                "Request / session",
                "Message",
                "Details",
              ].map((title) => (
                <th key={title}>{title}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(page?.events ?? []).map((event: any) => (
              <tr key={event.id}>
                <td>{event.at}</td>
                <td>{event.level}</td>
                <td>{event.category ?? "—"}</td>
                <td>
                  <code>{event.requestId ?? "—"}</code>
                  <br />
                  <small>{event.sessionId ?? ""}</small>
                </td>
                <td>{event.message}</td>
                <td>
                  <details>
                    <summary>View data</summary>
                    <pre
                      style={{
                        maxWidth: 480,
                        whiteSpace: "pre-wrap",
                        overflowWrap: "anywhere",
                      }}
                    >
                      {JSON.stringify(event.data, null, 2)}
                    </pre>
                  </details>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {page && !page.events.length && <p>No matching logs on this page.</p>}
      <div className="pagination">
        <button disabled={busy || !cursor} onClick={() => setCursor(undefined)}>
          First page
        </button>
        <button
          disabled={busy || !page?.cursor}
          onClick={() => setCursor(page.cursor)}
        >
          Next →
        </button>
      </div>
    </article>
  );
}
