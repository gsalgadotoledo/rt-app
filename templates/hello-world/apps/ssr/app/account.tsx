'use client';
import branding from '../branding.json';
import {useRef,useState} from 'react';
import {browserApiUrl,type PublicConfig} from '@gsalgadotoledo/rt-app-config';
import AuthPanel from '@gsalgadotoledo/rt-app-auth/admin';
import SecurityPanel from '@gsalgadotoledo/rt-app-auth/security';
export default function Account({config}:{config:PublicConfig}) {
  const dialog=useRef<HTMLDialogElement>(null);
  const [session,setSession]=useState<any>();const [error,setError]=useState('');
  async function api(path:string,method='GET',body?:unknown) {
    const response=await fetch(browserApiUrl(config)+path,{method,headers:{'content-type':'application/json',...(session?{authorization:`Bearer ${session.token}`}:{})},body:body===undefined?undefined:JSON.stringify(body)});
    const value=await response.json();if(!response.ok)throw new Error(value.error??'Request failed');return value;
  }
  return <nav aria-label="Account"><button className="account-link" onClick={()=>dialog.current?.showModal()}>{session?'My account':'Sign in'} ↗</button>
    <dialog ref={dialog} className="account-dialog" aria-label="Account">
      <div className="dialog-toolbar"><span>{branding.name} / ACCOUNT</span><button aria-label="Close" onClick={()=>dialog.current?.close()}>×</button></div>
      {error&&<p role="alert">{error}</p>}
      {session?<section><h2>Hello, {session.user?.name??'there'}</h2><SecurityPanel api={api} onReauthenticate={()=>setSession(undefined)}/><button onClick={async()=>{try{await api('/auth/logout','POST',{});}catch(e){setError((e as Error).message);}finally{setSession(undefined);dialog.current?.close();}}}>Sign out</button></section>:<AuthPanel api={api} onSession={value=>{setSession(value);dialog.current?.close();}} devMailbox={config.environment==='local'}/>}
    </dialog>
  </nav>;
}
