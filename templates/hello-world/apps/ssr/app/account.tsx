'use client';
import branding from '../branding.json';
import {useEffect,useRef,useState} from 'react';
import {browserApiUrl,type PublicConfig} from '@gsalgadotoledo/rt-app-config';
import AuthPanel from '@gsalgadotoledo/rt-app-auth/admin';
import SecurityPanel from '@gsalgadotoledo/rt-app-auth/security';
import {createSessionClient} from '@gsalgadotoledo/rt-app-auth/client';
export default function Account({config}:{config:PublicConfig}) {
  const dialog=useRef<HTMLDialogElement>(null);
  // The session lives in memory for this page (as before); the client refreshes the access token
  // in the background and signs out only when the refresh token is rejected.
  const [sessions]=useState(()=>createSessionClient({baseUrl:browserApiUrl(config),storageKey:'rt-app.ssr.session',storage:null}));
  const [session,setSessionState]=useState<any>();const [error,setError]=useState('');
  useEffect(()=>sessions.subscribe(setSessionState),[sessions]);
  const setSession=(value:any)=>sessions.set(value);
  const api=(path:string,method='GET',body?:unknown)=>sessions.api(path,method,body);
  return <nav aria-label="Account"><button className="account-link" onClick={()=>dialog.current?.showModal()}>{session?'My account':'Sign in'} ↗</button>
    <dialog ref={dialog} className="account-dialog" aria-label="Account">
      <div className="dialog-toolbar"><span>{branding.name} / ACCOUNT</span><button aria-label="Close" onClick={()=>dialog.current?.close()}>×</button></div>
      {error&&<p role="alert">{error}</p>}
      {session?<section><h2>Hello, {session.user?.name??'there'}</h2><SecurityPanel api={api} onReauthenticate={()=>setSession(undefined)}/><button onClick={async()=>{try{await api('/auth/logout','POST',{});}catch(e){setError((e as Error).message);}finally{setSession(undefined);dialog.current?.close();}}}>Sign out</button></section>:<AuthPanel api={api} onSession={value=>{setSession(value);dialog.current?.close();}} devMailbox={config.environment==='local'}/>}
    </dialog>
  </nav>;
}
