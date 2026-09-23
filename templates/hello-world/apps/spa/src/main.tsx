import SubscriptionProfile from '@gsalgadotoledo/rt-app-subscriptions/profile';
import {trackPage} from '@gsalgadotoledo/rt-app-observer/browser';
import {BrowserRouter,useLocation,useNavigate,Link} from 'react-router-dom';
import branding from '../branding.json';
import {browserApiUrl} from '@gsalgadotoledo/rt-app-config';
declare const __RT_APP_CONFIG__: import('@gsalgadotoledo/rt-app-config').PublicConfig;
import React, { useEffect, useState, useRef } from "react";
import { createRoot } from "react-dom/client";
import SecurityPanel from "@gsalgadotoledo/rt-app-auth/security";
import AuthPanel from "@gsalgadotoledo/rt-app-auth/admin";
import "./style.css";
const base = browserApiUrl(__RT_APP_CONFIG__);
function App() {
  useEffect(() => { document.title = branding.name; }, []);
  const [home, setHome] = useState<any>(),
    [session, setSession] = useState<any>(),
    [profile, setProfile] = useState<any>(),
    [error, setError] = useState("");
  const route=useLocation(), navigate=useNavigate();
  useEffect(()=>{trackPage(base,'spa',route.pathname);},[route.pathname]);
  useEffect(()=>{const params=new URLSearchParams(location.search);if(params.has('setup_intent')||params.has('payment_intent')){sessionStorage.setItem('rt-app-billing-return',JSON.stringify({setupId:params.get('setup_intent'),payment:params.has('payment_intent')}));navigate('/account',{replace:true});}},[]);
  const accountOpen=route.pathname==="/account"||route.pathname==="/login";
  const setAccountOpen=(open:boolean)=>navigate(open ? "/account" : "/");
  const accountDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = accountDialog.current;
    if (accountOpen && !dialog?.open) dialog?.showModal();
    else if (!accountOpen && dialog?.open) dialog.close();
  }, [accountOpen]);
  async function api(path: string, method = "GET", body?: any) {
    const response = await fetch(base + path, {
      method,
      headers: {
        "content-type": "application/json",
        ...(session ? { authorization: "Bearer " + session.token } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error);
    return value;
  }
  useEffect(() => {
    void api("/")
      .then(setHome)
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    if (session)
      void api("/users/me")
        .then(setProfile)
        .catch((e) => setError(e.message));
  }, [session]);
  return (
    <div className="site-shell">
      <header className="topbar">
        <Link className="brand" to="/" aria-label={branding.name+" · Home"}>{branding.name}</Link>
        <nav aria-label="Account">
          <button className="account-link" aria-haspopup="dialog" onClick={() => setAccountOpen(true)}>
            {session ? "My account" : "Sign in"}<span aria-hidden="true"> ↗</span>
          </button>
        </nav>
      </header>
      <aside className="crm-sidebar"><strong>WORKSPACE</strong><Link to="/" aria-current={route.pathname==="/"?"page":undefined}>▦ Overview</Link><button onClick={() => setAccountOpen(true)}>◎ My account</button><small>{branding.name} Workspace</small></aside>
      <main id="home" className="home">
        {route.pathname!=="/"&&!accountOpen?<section><h1>Page not found</h1><Link to="/">Back to overview</Link></section>:<><div className="home-copy">
          <p className="eyebrow">WORKSPACE / OVERVIEW</p>
          <h1>{home?.title ?? "Welcome"}</h1>
          {home?.content && <p className="description">{home.content}</p>}
          {error && <p role="alert">{error}</p>}
        </div>
        <section className="crm-panels" aria-label="Workspace">
          <article><span className="eyebrow">ACCOUNT</span><h2>{session ? profile?.name ?? session.user?.name ?? "Your profile" : "Welcome to your workspace"}</h2><p>{session ? profile?.email ?? session.user?.email : "Sign in to manage your profile and account security."}</p><button onClick={() => setAccountOpen(true)}>{session ? "Manage account" : "Sign in →"}</button></article>
          <article><span className="eyebrow">GETTING STARTED</span><h2>A place for your work</h2><p>Your application starts here. Add your business modules as your workspace grows.</p><div className="crm-empty">No business modules added yet</div></article>
        </section></>}
      </main>
      <footer><span>{branding.name}</span><span className="footer-line" aria-hidden="true" /></footer>
      <dialog ref={accountDialog} className="account-dialog" aria-label={session ? "My account" : "Sign in"}
        onClose={() => setAccountOpen(false)}>
        <div className="dialog-toolbar">
          <span>{branding.name} / ACCOUNT</span>
          <button aria-label="Close" onClick={() => setAccountOpen(false)}>×</button>
        </div>
        {accountOpen && (session ? (
          <section>
            <h2>Hello, {profile?.name ?? session.user?.name}</h2>
            <p>{profile?.email ?? session.user?.email}</p>
            <SubscriptionProfile api={api}/>
            <SecurityPanel api={api} onReauthenticate={() => {setSession(undefined);setProfile(undefined);}} />
            <button className="sign-out" onClick={async () => {
              try { await api("/auth/logout", "POST", {}); }
              catch (e: any) { setError(e.message); }
              finally { setSession(undefined);setProfile(undefined);setAccountOpen(false); }
            }}>Sign out</button>
          </section>
        ) : (
          <AuthPanel api={api} onSession={value => {setSession(value);setAccountOpen(false);}}
            devMailbox={import.meta.env.DEV} />
        ))}
      </dialog>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<BrowserRouter><App /></BrowserRouter>);
