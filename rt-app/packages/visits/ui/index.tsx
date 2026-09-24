import React, { useEffect, useState } from "react";
import type { Api } from "@gsalgadotoledo/rt-app-admin-ui";
export default function VisitsPanel({ api }: { api: Api }) {
  const [items, setItems] = useState<any[]>([]),
    [session, setSession] = useState<any>(),
    [path, setPath] = useState("/"),
    [frame, setFrame] = useState(120),
    [playing, setPlaying] = useState(false),
    [error, setError] = useState(""),
    [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    api("/visits")
      .then((data) => {
        if (active) setItems(data.items);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [refresh]);
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(
      () =>
        setFrame((n) => {
          if (n >= session.points.length) {
            setPlaying(false);
            return n;
          }
          return n + 1;
        }),
      150,
    );
    return () => clearInterval(timer);
  }, [playing, session]);
  const open = async (id: string) => {
    try {
      const value = await api("/visits/" + encodeURIComponent(id));
      setSession(value);
      setPath(value.points[0]?.path ?? "/");
      setFrame(value.points.length);
      setPlaying(false);
    } catch (e: any) {
      setError(e.message);
    }
  };
  const points = (session?.points ?? [])
    .slice(0, frame)
    .filter(
      (point: any) =>
        point.path === path && ["move", "click"].includes(point.type),
    );
  const clicks = (session?.points ?? []).filter(
    (point: any) => point.path === path && point.type === "click",
  );
  return (
    <section>
      <div className="section-head">
        <h2>Visit sessions</h2>
        <button onClick={() => setRefresh((n) => n + 1)}>Refresh</button>
      </div>
      <p className="hint">
        Last 10 sessions · 24-hour retention · up to 120 sampled events each.
        Anonymous viewport geometry, not a video or DOM replay. Not a complete
        traffic count.
      </p>
      {error && <p role="alert">{error}</p>}
      {!session ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Started</th>
                <th>Session</th>
                <th>Pages</th>
                <th>Events</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>{new Date(item.startedAt).toLocaleString()}</td>
                  <td>
                    <button onClick={() => open(item.id)}>{item.id}</button>
                  </td>
                  <td>{item.pages.join(", ")}</td>
                  <td>{item.events}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!items.length && (
            <p>Open a public Next.js page and interact to capture a session.</p>
          )}
        </div>
      ) : (
        <>
          <nav>
            <button
              onClick={() => {
                setSession(undefined);
                setPlaying(false);
              }}
            >
              ← Sessions
            </button>
          </nav>
          <div className="observer-toolbar">
            <label>
              Page
              <select value={path} onChange={(e) => setPath(e.target.value)}>
                {[
                  ...new Set<string>(
                    session.points.map((point: any) => point.path),
                  ),
                ].map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            <button
              onClick={() => {
                setFrame(0);
                setPlaying(true);
              }}
            >
              Play sampled path
            </button>
            <button onClick={() => setPlaying(false)}>Pause</button>
            <button
              onClick={async () => {
                try {
                  await api("/visits/" + session.id, "DELETE");
                  setSession(undefined);
                  setRefresh((n) => n + 1);
                } catch (e: any) {
                  setError(e.message);
                }
              }}
            >
              Delete session
            </button>
          </div>
          <label>
            Events: {frame} / {session.points.length}
            <input
              type="range"
              min={0}
              max={session.points.length}
              value={frame}
              onChange={(e) => {
                setPlaying(false);
                setFrame(Number(e.target.value));
              }}
            />
          </label>
          <div className="observer-grid">
            {["Movement path", "Click heatmap"].map((title, index) => (
              <article className="observer-box" key={title}>
                <h3>{title}</h3>
                <svg
                  viewBox="0 0 100 100"
                  role="img"
                  aria-label={title + " for " + path}
                  style={{
                    width: "100%",
                    maxHeight: 420,
                    background: "var(--bg)",
                    border: "1px solid currentColor",
                  }}
                >
                  {index === 0 ? (
                    <>
                      <polyline
                        points={points
                          .map((point: any) => point.x + "," + point.y)
                          .join(" ")}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="0.4"
                      />
                      {points.map((point: any, i: number) => (
                        <circle
                          key={i}
                          cx={point.x}
                          cy={point.y}
                          r={point.type === "click" ? 1.5 : 0.4}
                          fill={
                            point.type === "click" ? "#ee8866" : "currentColor"
                          }
                        />
                      ))}
                    </>
                  ) : (
                    clicks.map((point: any, i: number) => (
                      <circle
                        key={i}
                        cx={point.x}
                        cy={point.y}
                        r={6}
                        fill="#f56e42"
                        opacity={0.22}
                      />
                    ))
                  )}
                </svg>
                <p className="hint">
                  Normalized viewport coordinates. Content and form areas are
                  not captured.
                </p>
              </article>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
