import React, { useEffect, useState } from "react";
import type { PanelProps } from "@gsalgadotoledo/rt-app-admin-ui";
export default function ContentPanel({ api }: PanelProps) {
  const [home, setHome] = useState<any>();
  const [error, setError] = useState("");
  useEffect(() => {
    void api("/").then(setHome).catch(e => setError(e.message));
  }, []);
  return (
    <section>
      <p className="eyebrow">CONTENT / PUBLIC HOME</p>
      <h1>{home?.title}</h1>
      {error && <p role="alert">{error}</p>}
      <p className="lead">{home?.content}</p>
      <p className="hint">
        Edit the title and description in Settings. The public API returns the saved content.
      </p>
    </section>
  );
}
