import React, { useEffect, useState } from "react";
import type { Api } from "@gsalgadotoledo/rt-app-admin-ui";
import type { FailedMessage } from "../src/index";

/** Broker reads happen only on explicit inspection, never on polling or initial page load. */
export default function QueuePanel({ api }: { api: Api }) {
  const [supported, setSupported] = useState<boolean>(),
    [items, setItems] = useState<FailedMessage[]>([]);
  const [selected, setSelected] = useState<FailedMessage>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  useEffect(() => {
    let active = true;
    api("/queue/status")
      .then((s) => {
        if (active) setSupported(s.supported);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [api]);
  async function inspect() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api("/queue/failed/inspect", "POST", { limit: 10 });
      setItems(result.items);
      setSelected(undefined);
      if (!result.items.length)
        setNotice(
          "No messages returned. Some may be temporarily reserved by another administrator.",
        );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function retry(item: FailedMessage) {
    setBusy(true);
    setError("");
    try {
      await api("/queue/failed/retry", "POST", { token: item.token });
      setItems((old) => old.filter((m) => m.token !== item.token));
      setSelected(undefined);
      setNotice(
        `Message ${item.id} was queued again. The worker will process it.`,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section>
      <div className="section-head">
        <h2>Failed messages</h2>
        <button disabled={busy || !supported} onClick={() => void inspect()}>
          Load up to 10 messages
        </button>
      </div>
      <p className="hint">
        Inspection may reserve messages for 60 seconds. Retry keeps the original
        ID; consumers must handle duplicate deliveries. Loading a batch does not
        retry or delete messages.
      </p>
      {supported === false && (
        <p>
          Failed-message management is not configured for this queue adapter.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {selected ? (
        <>
          <button disabled={busy} onClick={() => setSelected(undefined)}>
            ← Failed messages
          </button>
          <h3>{selected.id}</h3>
          <p>{selected.message?.type ?? "Invalid message"}</p>
          <pre
            style={{
              maxHeight: 320,
              overflow: "auto",
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
            }}
          >
            {JSON.stringify(selected.message?.payload ?? null, null, 2)}
          </pre>
          {selected.expiresAt && (
            <p className="hint">
              Reservation expires:{" "}
              {new Date(selected.expiresAt).toLocaleTimeString()}
            </p>
          )}
          <p>Send this message back to its original queue?</p>
          <button
            disabled={busy || !selected.retryable}
            onClick={() => void retry(selected)}
          >
            Confirm retry
          </button>
        </>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Message ID</th>
                <th>Type</th>
                <th>Reservation expires</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.token}>
                  <td>{item.id}</td>
                  <td>{item.message?.type ?? "Invalid payload"}</td>
                  <td>
                    {item.expiresAt
                      ? new Date(item.expiresAt).toLocaleTimeString()
                      : "—"}
                  </td>
                  <td>
                    <button
                      disabled={busy || !item.retryable}
                      onClick={() => setSelected(item)}
                    >
                      Review & retry
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
