import React, { useEffect, useState } from "react";
import type { Api } from "@gsalgadotoledo/rt-app-admin-ui";
export default function HealthPanel({ api }: { api: Api }) {
  const [report, setReport] = useState<any>(),
    [error, setError] = useState(""),
    [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    api("/health/report")
      .then((value) => {
        if (active) {
          setReport(value);
          setError("");
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [refresh]);
  return (
    <section>
      <div className="section-head">
        <h2>Service health</h2>
        <button onClick={() => setRefresh((n) => n + 1)}>Refresh</button>
      </div>
      <p className="hint">
        Dependency checks are cached for 10 seconds. An external monitor must
        poll /health/ready to detect a stopped API; an offline application
        cannot report its own outage.
      </p>
      {error && <p role="alert">{error}</p>}
      {report && (
        <>
          <p>
            {report.ok ? "Ready" : "Not ready"} · {report.at}
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Dependency</th>
                  <th>Status</th>
                  <th>Required</th>
                  <th>Latency</th>
                </tr>
              </thead>
              <tbody>
                {report.checks.map((check: any) => (
                  <tr key={check.id}>
                    <td>{check.id}</td>
                    <td>{check.status}</td>
                    <td>{String(check.required)}</td>
                    <td>{check.durationMs} ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
