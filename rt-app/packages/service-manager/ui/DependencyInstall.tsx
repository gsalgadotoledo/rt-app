import React, { useEffect, useRef, useState } from "react";

export interface InstallJob { path: string; state: "running" | "succeeded" | "failed"; log: string[]; exitCode?: number; manager?: string }
export interface InstallClient {
  installDependencies?(path: string): Promise<InstallJob>;
  installStatus?(path: string): Promise<InstallJob | null>;
}

/** Errors that mean the project's npm dependencies are missing or out of date. */
export const needsInstall = (message: string) => /run (?:npm|pnpm|yarn) install|Missing workspace|Cannot find module|node_modules|npm query/i.test(message);

/**
 * Offer to run `npm install` for a project that could not be opened because its dependencies are
 * missing; shows the live log and opens the project when the install succeeds.
 */
export function DependencyInstall({ client, path, name, error, onInstalled, onDismiss }: { client: InstallClient; path: string; name: string; error: string; onInstalled(): void; onDismiss(): void }) {
  const [job, setJob] = useState<InstallJob | null>(null);
  const [failure, setFailure] = useState("");
  const log = useRef<HTMLPreElement>(null);
  useEffect(() => { void client.installStatus?.(path).then((j) => { if (j?.state === "running") setJob(j); }); }, [path]);
  useEffect(() => {
    if (job?.state !== "running") return;
    const timer = setInterval(async () => {
      const next = await client.installStatus?.(path);
      if (!next) return;
      setJob(next);
      if (next.state === "succeeded") onInstalled();
    }, 800);
    return () => clearInterval(timer);
  }, [job?.state, path]);
  useEffect(() => { if (log.current) log.current.scrollTop = log.current.scrollHeight; }, [job?.log.length]);
  async function install() {
    setFailure("");
    try { setJob(await client.installDependencies!(path)); } catch (e) { setFailure((e as Error).message); }
  }
  const running = job?.state === "running";
  return (
    <section className={`rt-install-deps${job?.state === "failed" ? " failed" : ""}`} role="alert">
      <div className="rt-install-deps-head">
        <span className="rt-install-deps-icon" aria-hidden="true">{running ? <i className="rt-install-spinner" /> : job?.state === "failed" ? "!" : "⬇"}</span>
        <div>
          <strong>{running ? `Installing dependencies for ${name}…` : job?.state === "failed" ? `${job.manager ?? "npm"} install failed` : `${name} needs its dependencies installed`}</strong>
          <small title={error}>{running ? path : job?.state === "failed" ? "Check the log below, fix the problem and try again." : `Its packages are not installed yet, so its services cannot be read. This runs ${error.match(/run (npm|pnpm|yarn) install/)?.[1] ?? "npm"} install in the project.`}</small>
        </div>
        {client.installDependencies && !running && <button className="rt-primary" onClick={() => void install()}>{job?.state === "failed" ? "Try again" : "Install dependencies"}</button>}
        {!running && <button onClick={onDismiss}>Dismiss</button>}
      </div>
      {failure && <p className="rt-services-error">{failure}</p>}
      {job && <pre ref={log} className="rt-install-deps-log">{job.log.join("\n")}</pre>}
      {!client.installDependencies && <p className="rt-wizard-note">Run <code>{error.match(/run (npm|pnpm|yarn) install/)?.[1] ?? "npm"} install</code> in {path}, then open the project again.</p>}
    </section>
  );
}
