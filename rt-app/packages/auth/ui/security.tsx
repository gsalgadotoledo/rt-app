import React,{useEffect,useState} from 'react';
import type {Api} from '@gsalgadotoledo/rt-app-admin-ui';
export default function SecurityPanel({api,onReauthenticate}:{api:Api;onReauthenticate:()=>void}){
 const [enabled,setEnabled]=useState<boolean>(),[setup,setSetup]=useState<any>(),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 useEffect(()=>{void api('/auth/mfa').then(r=>setEnabled(r.enabled)).catch(e=>setError(e.message));},[]);
 async function submit(e:React.FormEvent<HTMLFormElement>){
   e.preventDefault();const form=e.currentTarget,data=Object.fromEntries(new FormData(form));setBusy(true);setError('');
   try {
     if(setup){await api('/auth/mfa/enable','POST',{code:data.code,challengeId:setup.challengeId});setSetup(undefined);onReauthenticate();}
     else {setSetup(await api('/auth/mfa/setup','POST',{password:data.password}));form.reset();}
   }catch(e:any){setError(e.message);}finally{setBusy(false);}
 }
 return <details className="security-panel"><summary>Security · TOTP authenticator</summary>
   {enabled===true?<p>Two-step verification is enabled.</p>:enabled===false?<form onSubmit={submit}>
     {setup?<><p>Add this key manually to your authenticator:</p><code style={{overflowWrap:'anywhere'}}>{setup.secret}</code><p>RT-APP · 6 digits · 30 seconds · SHA-1</p><label>Authenticator code<input name="code" inputMode="numeric" pattern="[0-9]{6}" autoComplete="one-time-code" required /></label></>:<><p>Confirm your password to enable two-step verification.</p><label>Current password<input name="password" type="password" autoComplete="current-password" required maxLength={128}/></label></>}
     <button disabled={busy}>{busy?"Processing…":setup?"Enable and sign in again":"Set up authenticator"}</button>
   </form>:<p>Loading settings…</p>}
   {error&&<p role="alert">{error}</p>}
 </details>;
}
