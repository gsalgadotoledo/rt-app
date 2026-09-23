import "@gsalgadotoledo/rt-app-admin-ui/themes.css";
import {themes} from "@gsalgadotoledo/rt-app-admin-ui/themes";
import SubscriptionsAdmin from '@gsalgadotoledo/rt-app-subscriptions/admin';
import ObserverPanel from '@gsalgadotoledo/rt-app-observer/admin';
import {BrowserRouter,Link,useLocation,useNavigate} from 'react-router-dom';
import {browserApiUrl} from '@gsalgadotoledo/rt-app-config';
declare const __RT_APP_CONFIG__: import('@gsalgadotoledo/rt-app-config').PublicConfig;
import AwsMonitorPanel from "@gsalgadotoledo/rt-app-aws/admin";
import React, { useState, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import type { Api } from "@gsalgadotoledo/rt-app-admin-ui";
import { ModuleWorkspace } from "@gsalgadotoledo/rt-app-admin-ui";
import ContentPanel from "@gsalgadotoledo/rt-app-content/admin";
import AuthOverview from "@gsalgadotoledo/rt-app-auth/settings";
import UsersPanel from "@gsalgadotoledo/rt-app-users/admin";
import TasksPanel from "@gsalgadotoledo/rt-app-tasks/admin";
import PermissionsPanel from "@gsalgadotoledo/rt-app-acl/admin";
import { SetupWizard } from "./setup";
import { RootLogin } from "./root-login";
import "./style.css";
const components: Record<string, React.ComponentType<any>> = {
  "aws-monitor": AwsMonitorPanel,
  observer: ObserverPanel,
  subscriptions: SubscriptionsAdmin,
  content: ContentPanel,
  "auth-settings": AuthOverview,
  users: UsersPanel,
  tasks: TasksPanel,
  permissions: PermissionsPanel,
};
const API = browserApiUrl(__RT_APP_CONFIG__);
function AdminApp({
  extensions = {},
}: { extensions?: Record<string, React.ComponentType<any>> } = {}) {
  const [startup, setStartup] = useState("loading"),
    [installer, setInstaller] = useState(false),
    [localAccess, setLocalAccess] = useState(false),
    [base, setBase] = useState(API),
    [session, setSession] = useState<any>(),
    [modules, setModules] = useState<any[]>([]),
    [error, setError] = useState("");
  const [menuOpen,setMenuOpen]=useState(false);
  const [theme,setTheme]=useState(()=>{try{return localStorage.getItem('rt-app.admin.theme')??'violet';}catch{return 'violet';}});
  useEffect(()=>{const selected=themes.some(t=>t[0]===theme)?theme:'violet';document.documentElement.dataset.theme=selected;try{localStorage.setItem('rt-app.admin.theme',selected);}catch{}},[theme]);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try { const width = Number(localStorage.getItem("rt-app.admin.sidebar-width")); return width ? Math.max(180, Math.min(440, width)) : 240; }
    catch { return 240; }
  });
  const sidebarDrag = useRef<{x:number;width:number} | null>(null);
  const resizeSidebar = (width:number) => setSidebarWidth(Math.max(180, Math.min(440, width)));
  useEffect(() => {
    try { localStorage.setItem("rt-app.admin.sidebar-width", String(sidebarWidth)); } catch {}
  }, [sidebarWidth]);
  const route = useLocation(), navigate = useNavigate();
  const match = /^\/modules\/([^/]+)\/?$/.exec(route.pathname);
  const page = route.pathname === "/settings/themes" ? "themes" : route.pathname === "/" ? "home" : match ? decodeURIComponent(match[1]) : "not-found";
  useEffect(()=>setMenuOpen(false),[route.pathname]);
  const setPage = (id:string) => navigate(id === "themes" ? "/settings/themes" : id === "home" ? "/" : "/modules/" + encodeURIComponent(id));
  useEffect(() => {
    void fetch(API + "/__dev/setup")
      .then(async (r) => {
        if (r.status === 404) {
          setStartup("ready");
          return;
        }
        if (!r.ok) throw new Error("Unable to check installation");
        const state = await r.json();
        if (state.setupUrl) {
          location.replace(state.setupUrl);
          return;
        }
        if (state.local && !state.installer && !state.installed) {
          if (state.adminAuth === "local") {
            setLocalAccess(true);
            setSession({ user: { id: "rt-app-root", name: "Local administrator", role: "owner", grants: [] } });
            setStartup("ready");
          } else setStartup(state.adminPasswordConfigured ? "ready" : "environment");
          return;
        }
        if (state.installed) {
          if (state.apiUrl) {
            setBase(state.apiUrl);
            setStartup("ready");
            return;
          }
          if (state.loginUrl) {
            location.replace(state.loginUrl);
            return;
          }
        }
        if (state.installer) {
          setInstaller(true);
          setStartup(state.adminPasswordConfigured ? "ready" : "environment");
          return;
        }
        throw new Error("Unknown installation state");
      })
      .catch((e) => {
        setError(e.message);
        setStartup("error");
      });
  }, []);
  const api: Api = async (path, method = "GET", body) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        "content-type": "application/json",
        ...(session?.token ? { authorization: "Bearer " + session.token } : {}),
        ...(installer
          ? {
              "x-setup-token":
                new URLSearchParams(location.hash.slice(1)).get("setup") ?? "",
            }
          : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 401 && session) setSession(undefined);
      throw new Error(data.error ?? "Request failed");
    }
    return data;
  };
  useEffect(() => {
    if (session && !installer)
      void api("/admin/modules")
        .then(setModules)
        .catch((e) => setError(e.message));
  }, [session, installer]);
  if (startup === "loading")
    return (
      <main className="setup-shell">
        <p>Checking installation…</p>
      </main>
    );
  if (startup === "environment")
    return (
      <main className="setup-shell">
        <h1>Configure your environment</h1>
        <p>
          {installer
            ? "Follow README.md: configure AWS credentials and ADMIN_PASSWORD, then restart npm run setup."
            : "Set ADMIN_PASSWORD (16–128 characters) when running npm run dev. Local development does not require AWS credentials."}
        </p>
        <p>
          {installer ? "Credentials are never entered in this wizard." : "Example: ADMIN_PASSWORD='YOUR_16_TO_128_CHARACTER_PASSWORD' npm run dev"}
        </p>
      </main>
    );
  if (startup === "error")
    return (
      <main className="setup-shell">
        <p role="alert">{error}</p>
        <button onClick={() => location.reload()}>Retry</button>
      </main>
    );
  if (!session)
    return (
      <main className="setup-shell">
        <RootLogin api={api} onSession={setSession} />
      </main>
    );
  if (installer) return <SetupWizard token={session.token} />;
  const manifest = modules.find((m) => m.id === page),
    Component = manifest
      ? (extensions[manifest.component] ?? components[manifest.component])
      : undefined;
  const moduleApi: Api = (path, method, body) =>
    api(path === "/" ? path : "/admin/app" + path, method, body);
  return (
    <div className="layout" style={{"--admin-sidebar-width": sidebarWidth + "px"} as React.CSSProperties}>
      <aside className="sidebar">
        <div className="brand">
          RT-APP<small>/ SYS</small>
        </div>
        <button className="admin-menu-toggle" aria-expanded={menuOpen} aria-controls="admin-navigation" onClick={()=>setMenuOpen(!menuOpen)}>{menuOpen?'Close menu':'☰ Menu'}</button>
        <div id="admin-navigation" className={'admin-navigation '+(menuOpen?'is-open':'')}>
        <button onClick={() => setPage("home")}>Overview</button>
        <p className="nav-label">SYSTEM MODULES</p>
        {[...modules].sort((a,b)=>Number(a.id==="aws-monitor")-Number(b.id==="aws-monitor")).map((m) => (
          <button
            key={m.id}
            className={page === m.id ? "selected" : ""}
            onClick={() => setPage(m.id)}
          >
            <span>{m.title}</span><small className="module-package-badge">{m.module ?? m.id}</small>
          </button>
        ))}
        <div className="sidebar-settings"><p className="nav-label">PREFERENCES</p><button className={page==='themes'?'selected':''} onClick={()=>setPage('themes')}>Themes <small className="module-package-badge">admin</small></button></div>
        </div>
        <div className="sidebar-resizer" role="separator" aria-label="Resize sidebar"
          aria-orientation="vertical" aria-valuemin={180} aria-valuemax={440} aria-valuenow={sidebarWidth}
          tabIndex={0} title="Drag to resize sidebar. Double-click to reset."
          onPointerDown={event => { if(event.button !== 0) return; sidebarDrag.current={x:event.clientX,width:sidebarWidth}; event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault(); }}
          onPointerMove={event => { if(sidebarDrag.current) resizeSidebar(sidebarDrag.current.width + event.clientX - sidebarDrag.current.x); }}
          onPointerUp={event => { sidebarDrag.current=null; if(event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
          onPointerCancel={() => { sidebarDrag.current=null; }}
          onLostPointerCapture={() => { sidebarDrag.current=null; }}
          onDoubleClick={() => resizeSidebar(240)}
          onKeyDown={event => { if(["ArrowLeft","ArrowRight","Home","End"].includes(event.key)) { event.preventDefault(); resizeSidebar(event.key==="Home"?180:event.key==="End"?440:sidebarWidth+(event.key==="ArrowRight"?10:-10)); } }}
        />
      </aside>
      <div className="main">
        <header>
          <div className="admin-page-heading"><nav aria-label="Breadcrumb" className="admin-breadcrumb"><Link to="/">Overview</Link>{page!=="home"&&<><span aria-hidden="true">/</span><Link to={route.pathname} aria-current="page">{page==="themes"?"Themes":manifest?.title??"Page not found"}</Link></>}</nav><h1>{page==="home"?"System console":page==="themes"?"Themes":manifest?.title??"Page not found"}</h1></div>
          {!localAccess && <button
            onClick={() => {
              setSession(undefined);
              setModules([]);
              setPage("home");
            }}
          >
            Sign out
          </button>}
        </header>
        <main>
          {error && <p className="error">{error}</p>}
          {page === "home" ? (
            <section className="overview">

              <p>Manage modules, access control, infrastructure and application content.</p>
              <div className="module-grid">
                {modules.map((m) => (
                  <button key={m.id} onClick={() => setPage(m.id)}>
                    <span>{m.title}</span><small className="module-package-badge">{m.module ?? m.id}</small>
                  </button>
                ))}
              </div>
            </section>
          ) : page==='themes' ? (
            <section><p className="hint">Choose a theme for this browser. Application sites keep their own design.</p><div className="theme-grid">{themes.map(([id,title,description])=><button key={id} className={'theme-option '+(theme===id?'selected':'')} aria-pressed={theme===id} onClick={()=>setTheme(id)}><span className={'theme-preview '+id}><i/><i/><i/></span><strong>{title}</strong><span>{description}</span><small>{theme===id?'Selected':'Use theme'}</small></button>)}</div></section>
          ) : Component ? (
            <ModuleWorkspace
              key={page}
              api={moduleApi}
              manifest={manifest}
              user={session.user}

            >
              <Component
                api={moduleApi}
                manifest={manifest}
                user={session.user}
              />
            </ModuleWorkspace>
          ) : (
            <p>Page not found. <button onClick={() => setPage("home")}>Back to overview</button></p>
          )}
        </main>
      </div>
    </div>
  );
}
export function mountAdmin(
  element: HTMLElement,
  extensions: Record<string, React.ComponentType<any>> = {},
) {
  createRoot(element).render(<App extensions={extensions} />);
}

export function App(props:{extensions?:Record<string,React.ComponentType<any>>}) { return <BrowserRouter><AdminApp {...props}/></BrowserRouter>; }
