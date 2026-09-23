import React, {useState} from "react";
import type {Api} from "@gsalgadotoledo/rt-app-admin-ui";
export default function AuthOverview({api}:{api:Api}) {
  const [message,setMessage]=useState(''),[busy,setBusy]=useState(false);
  return (
    <section>
      <p className="eyebrow">AUTHENTICATION</p>
      <h1>Application access</h1>
      <p className="lead">Users, sessions and permissions in one place.</p>
      <div className="stat-grid">
        <article>
          <h3>Users</h3>
          <p>Manage accounts from the Users menu.</p>
        </article>
        <article>
          <h3>Permissions</h3>
          <p>Grant access to resources from each account.</p>
        </article>
        <article>
          <h3>Settings</h3>
          <p>The owner can enable the available sign-in methods.</p>
        </article>
      </div>
      <details>
        <summary>Recover access after losing an authenticator</summary>
        <p>Only the root administrator or an owner can reset MFA. Verify the user's identity first; their active sessions will be invalidated.</p>
        <form onSubmit={async e=>{
          e.preventDefault();const userId=String(new FormData(e.currentTarget).get('userId')??'');setBusy(true);setMessage('');
          try{setMessage((await api('/auth/mfa/reset','POST',{userId})).message);}catch(error:any){setMessage(error.message);}finally{setBusy(false);}
        }}>
          <label>User ID<input name="userId" required maxLength={100}/></label>
          <button disabled={busy}>Reset MFA and invalidate sessions</button>
        </form>
        {message&&<p role="status">{message}</p>}
      </details>
    </section>
  );
}
