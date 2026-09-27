import React, { useEffect, useState } from "react";
import { ActionMenu, type MenuAction } from "./ActionMenu.js";

export interface ProjectApp { id: string; name: string; label: string; kind: string; kindLabel: string; location: string; serviceId: string | null; serviceLabel: string | null; actions: { action: string; script: string; label: string }[]; builds: { path: string; name: string; builtAt: string }[] }
export interface Repository { remote: string; url: string; provider: string; host: string; path: string; branch: string | null; branchUrl: string | null }
export interface LauncherClient {
  apps?(): Promise<ProjectApp[]>;
  launchApp?(id: string, action: string): Promise<{ id: string }>;
  openAppBuild?(id: string, index: number): Promise<void>;
  repository?(): Promise<Repository | null>;
  openRepository?(target: "repo" | "branch"): Promise<void>;
  openProjectLocation?(target: "folder" | "vscode" | "cursor" | "editor", path: string): Promise<void>;
}

const ACTIVE = ["waiting", "starting", "running", "stopping"];
const clean = (message: string) => message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

const KIND_ICON: Record<string, string> = {
  electron: "M12 8.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z M12 3c5 0 9 4 9 9s-4 9-9 9-9-4-9-9 4-9 9-9z M5.5 7.5c3.5-1 9 1 11.5 5.5s2 8.5-1 9 M18.5 7.5c-3.5-1-9 1-11.5 5.5s-2 8.5 1 9",
  tauri: "M12 3l8 4.5v9L12 21l-8-4.5v-9z M9 10a3 3 0 1 0 6 4",
  expo: "M4 20L12 5l8 15 M7.5 14h9",
  "react-native": "M12 10.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z M12 7c5.5 0 10 2.2 10 5s-4.5 5-10 5S2 14.8 2 12s4.5-5 10-5z M7.7 9.5c2.7-4.8 6.5-7.8 8.9-6.4s1.9 6.2-.8 10.9-6.5 7.8-8.9 6.4-1.9-6.2.8-10.9z",
  capacitor: "M6 3h12v18H6z M10 18h4",
};
const REPO_ICON: Record<string, string> = {
  github: "M12 2a10 10 0 0 0-3.2 19.5c.5.1.7-.2.7-.5v-1.8c-2.8.6-3.4-1.2-3.4-1.2-.4-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.6 2.4 1.1 3 .8.1-.7.4-1.1.6-1.4-2.2-.2-4.6-1.1-4.6-5 0-1.1.4-2 1-2.7-.1-.3-.4-1.3.1-2.7 0 0 .8-.3 2.8 1a9.6 9.6 0 0 1 5 0c1.9-1.3 2.8-1 2.8-1 .5 1.4.2 2.4.1 2.7.6.7 1 1.6 1 2.7 0 3.9-2.4 4.7-4.6 5 .4.3.7.9.7 1.9V21c0 .3.2.6.7.5A10 10 0 0 0 12 2z",
  gitlab: "M12 21l-9-7 2-9 3 6h8l3-6 2 9z",
  bitbucket: "M3 4h18l-2.5 16h-13z M9 10h6l-1 5h-4z",
  git: "M6 3v12 M6 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6z M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M18 9c0 5-6 4-12 6",
};
const glyph = (d: string, filled = false) => <svg width="15" height="15" viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke={filled ? "none" : "currentColor"} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;
const PROVIDER_LABEL: Record<string, string> = { github: "GitHub", gitlab: "GitLab", bitbucket: "Bitbucket", azure: "Azure DevOps", git: "Repository" };

/**
 * Shortcut buttons after the web "Open …" buttons: one per desktop/mobile app found in the project
 * (runs its service or script, opens a packaged build), the project folder and the git remote.
 */
export function ProjectLaunchers({ client, project, services, busy, onOpenService, onStop, onError }: { client: LauncherClient; project: string; services: { id: string; state: string }[]; busy: boolean; onOpenService(id: string): void; onStop(id: string): void; onError(message: string): void }) {
  const [apps, setApps] = useState<ProjectApp[]>([]);
  const [repo, setRepo] = useState<Repository | null>(null);
  const [starting, setStarting] = useState<string>();
  useEffect(() => {
    setApps([]); setRepo(null);
    void client.apps?.().then(setApps).catch(() => setApps([]));
    void client.repository?.().then(setRepo).catch(() => setRepo(null));
  }, [project]);
  const running = (app: ProjectApp) => services.find((s) => (s.id === app.serviceId || s.id.startsWith(`run-app-${app.id}-`)) && ACTIVE.includes(s.state));
  async function launch(app: ProjectApp, action: string) {
    setStarting(app.id);
    try { await client.launchApp!(app.id, action); } catch (e) { onError(clean((e as Error).message)); } finally { setStarting(undefined); }
  }
  return <>
    {client.launchApp && apps.map((app) => {
      const live = running(app);
      const primary = app.actions[0];
      const menu: MenuAction[] = [
        ...app.actions.map((a) => ({ label: a.label, hint: `${a.script} · ${app.location}`, icon: glyph("M7 4l13 8-13 8z", true), disabled: busy || starting === app.id, onSelect: () => void launch(app, a.action) })),
        ...app.builds.map((b, i) => ({ label: `Open built app · ${b.name}`, separator: i === 0, hint: b.path, icon: glyph("M4 4h16v16H4z M4 9h16"), onSelect: () => void client.openAppBuild?.(app.id, i).catch((e) => onError(clean((e as Error).message))) })),
        ...(live ? [{ label: "Show output", separator: true, icon: glyph("M5 6h14 M5 12h14 M5 18h9"), onSelect: () => onOpenService(live.id) }, { label: "Stop", danger: true, icon: glyph("M6 6h12v12H6z", true), onSelect: () => onStop(live.id) }] : []),
      ];
      const title = live ? `${app.label} is ${live.state} · click to see its output` : primary ? `Run ${app.label} (${primary.script}${app.serviceId ? ` · service ${app.serviceId}` : ""})` : app.builds.length ? `Open ${app.builds[0].name}` : "No dev script";
      return (
        <span key={app.id} className={`rt-open-group${live ? " live" : ""}`}>
          <button
            className={`rt-open rt-open-app kind-${app.kind}${live ? " running" : ""}`}
            title={title}
            disabled={busy || starting === app.id || (!primary && !app.builds.length && !live)}
            onClick={() => (live ? onOpenService(live.id) : primary ? void launch(app, primary.action) : void client.openAppBuild?.(app.id, 0).catch((e) => onError(clean((e as Error).message))))}
          >
            <span className="rt-open-app-name">{glyph(KIND_ICON[app.kind] ?? KIND_ICON.capacitor)}{app.label}</span>
            <small>{starting === app.id ? "starting…" : live ? `${app.kindLabel} · ${live.state}` : app.kindLabel}</small>
          </button>
          {menu.length > 1 && <ActionMenu label={`${app.label} options`} actions={menu} />}
        </span>
      );
    })}
    {client.openProjectLocation && (
      <button className="rt-open rt-open-tool" title={`Open ${project} in Finder`} onClick={() => void client.openProjectLocation!("folder", project).catch((e) => onError(clean((e as Error).message)))}>
        <span className="rt-open-app-name">{glyph("M3 7h6l2 2h10v11H3z")}Files</span>
      </button>
    )}
    {repo && client.openRepository && (
      <button className="rt-open rt-open-tool" title={`${repo.url}${repo.branch ? ` · branch ${repo.branch}` : ""} (${repo.remote})`} onClick={() => void client.openRepository!("branch").catch((e) => onError(clean((e as Error).message)))}>
        <span className="rt-open-app-name">{glyph(REPO_ICON[repo.provider] ?? REPO_ICON.git, repo.provider === "github")}{PROVIDER_LABEL[repo.provider] ?? repo.host}</span>
        <small>{repo.branch ?? repo.path}</small>
      </button>
    )}
  </>;
}
