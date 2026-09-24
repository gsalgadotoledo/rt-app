import React, { useEffect, useState } from "react";
import type { Api } from "@gsalgadotoledo/rt-app-admin-ui";
const empty = {
  key: "",
  description: "",
  enabled: false,
  public: false,
  rollout: 100,
  subjects: [],
  version: null,
};
export default function FlagsPanel({ api }: { api: Api }) {
  const [page, setPage] = useState<any>({ items: [] }),
    [cursor, setCursor] = useState<string>(),
    [flag, setFlag] = useState<any>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    api(
      "/feature-flags" +
        (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""),
    )
      .then((data) => {
        if (active) setPage(data);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [cursor, refresh]);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      setFlag(
        await api(
          "/feature-flags/" + encodeURIComponent(flag.key),
          "PUT",
          flag,
        ),
      );
      setRefresh((n) => n + 1);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section>
      <div className="section-head">
        <h2>Feature flags</h2>
        <button onClick={() => setFlag({ ...empty })}>New flag</button>
      </div>
      <p className="hint">
        Server-controlled rollouts. Public flags affect presentation; they never
        replace permissions or subscription limits.
      </p>
      {error && <p role="alert">{error}</p>}
      {!flag ? (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Key</th>
                  <th>Enabled</th>
                  <th>Rollout</th>
                  <th>Public</th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((item: any) => (
                  <tr key={item.key}>
                    <td>
                      <button onClick={() => setFlag(item)}>{item.key}</button>
                    </td>
                    <td>{String(item.enabled)}</td>
                    <td>{item.rollout}%</td>
                    <td>{String(item.public)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button disabled={!cursor} onClick={() => setCursor(undefined)}>
            First page
          </button>
          <button
            disabled={!page.cursor}
            onClick={() => setCursor(page.cursor)}
          >
            Next →
          </button>
        </>
      ) : (
        <form
          onSubmit={save}
          style={{ display: "grid", gap: 14, maxWidth: 640 }}
        >
          <button type="button" onClick={() => setFlag(undefined)}>
            ← Flags
          </button>
          <label>
            Key
            <input
              required
              readOnly={flag.version !== null}
              value={flag.key}
              onChange={(e) => setFlag({ ...flag, key: e.target.value })}
            />
          </label>
          <label>
            Description
            <input
              value={flag.description}
              onChange={(e) =>
                setFlag({ ...flag, description: e.target.value })
              }
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={flag.enabled}
              onChange={(e) => setFlag({ ...flag, enabled: e.target.checked })}
            />{" "}
            Enabled
          </label>
          <label>
            <input
              type="checkbox"
              checked={flag.public}
              onChange={(e) => setFlag({ ...flag, public: e.target.checked })}
            />{" "}
            Available to frontend
          </label>
          <label>
            Percentage rollout
            <input
              type="number"
              min={0}
              max={100}
              value={flag.rollout}
              onChange={(e) =>
                setFlag({ ...flag, rollout: Number(e.target.value) })
              }
            />
            <small>
              For example, 10 enables approximately 10% of stable subject IDs.
            </small>
          </label>
          <label>
            Always-enabled subject IDs
            <textarea
              value={flag.subjects.join("\n")}
              onChange={(e) =>
                setFlag({
                  ...flag,
                  subjects: e.target.value.split("\n").filter(Boolean),
                })
              }
            />
            <small>
              One opaque user or tenant ID per line; only applies when the flag
              is enabled.
            </small>
          </label>
          <button disabled={busy}>{busy ? "Saving…" : "Save flag"}</button>
        </form>
      )}
    </section>
  );
}
