import {CurrencyPicker} from './currency.js';
import {formatMoney, currencyDecimals} from '@gsalgadotoledo/rt-app-subscriptions/currency';
import React, {useState} from 'react';
import {planIdFromName} from '@gsalgadotoledo/rt-app-subscriptions/plan-id';
import type {Api} from '@gsalgadotoledo/rt-app-admin-ui';
const help: Record<string,[string,string]> = {
 id:['Plan ID','Stable identifier in the API. Example: max. Keep this ID once saved.'],
 family:['Family','Groups versions of the same offer. Example: starter, pro or max.'],
 name:['Name','Public name shown to users and in Stripe. Example: Max.'],
 description:['Description','Short explanation of the offer. Example: Higher limits for growing teams.'],
 amount:['Price · minor currency units','2000 means USD 20.00; 500000 means COP 5,000.00. No exchange-rate conversion.'],
 currency:['Currency','Currency used for billing. Example: usd or cop.'],
 periodDays:['Billing period · days','30 means an exact 30-day recurring period, not a calendar month.'],
 credits:['Period credits','Included credits in one billing period. Example: 50,000 every 30 days.'],
 dailyLimit:['Daily limit','Maximum credits in each daily window. Example: 5,000; extra credits do not bypass this cap.'],
 weeklyLimit:['Weekly limit','Maximum credits in each weekly window. Example: 25,000.'],
 daySeconds:['Daily window · seconds','86,400 = 24 hours. Window starts at the subscription period start, not at midnight.'],
 weekSeconds:['Weekly window · seconds','604,800 = 7 days. Counters reset when the next window is used.'],
};
export function PlansEditor({settings,setSettings,api,busy,onAction}: {settings:any;setSettings:(s:any)=>void;api:Api;busy:boolean;onAction:(fn:()=>Promise<void>)=>Promise<void>}) {
 const [selected,setSelected]=useState<string>(), [tab,setTab]=useState('general'), [secret,setSecret]=useState(''), [history,setHistory]=useState<any>(), [synced,setSynced]=useState(''), [showArchived,setShowArchived]=useState(false);
 const plans=settings.values.plans, index=plans.findIndex((p:any)=>p.id===selected), plan=plans[index];
 const change=(field:string,value:any)=> {
   const next={...plan,[field]:value};
   if(field==='name' && !plan.version) {
     next.id=planIdFromName(value,plans.filter((_:any,i:number)=>i!==index).map((p:any)=>p.id));
     if(plan.family===plan.id) next.family=next.id;
     setSelected(next.id);
   }
   setSettings({...settings,values:{...settings.values,plans:plans.map((p:any,i:number)=>i===index?next:p)}});
 };
 async function save(sync=!!plan.stripeManaged || !!plan.stripeProductId, draft=settings) {
   setSynced('');
   let saved=settings;
   if(!settings.catalogOperation) saved=await api('/subscriptions/admin/settings','PUT',draft);
   setSettings(saved);
   if(sync) {
     try {saved=await api('/subscriptions/admin/plans/'+encodeURIComponent(plan.id)+'/publish','POST',{version:saved.version,secretKey:secret || undefined}); setSettings(saved); setSynced('Stripe synchronized. Existing subscriptions keep their previous version.');}
     finally {setSecret(''); setSettings(await api('/subscriptions/admin/settings'));}
   } else setSynced('Saved. Version is updated automatically when plan details change.');
 }
 async function restore(fromVersion:string) {
   let saved=await api('/subscriptions/admin/plans/'+encodeURIComponent(plan.id)+'/restore','POST',{version:settings.version,fromVersion});
   setSettings(saved);
   setHistory(await api('/subscriptions/admin/plans/'+encodeURIComponent(plan.id)+'/history'));
   setSynced('Version '+fromVersion+' restored as a new version. Existing subscribers keep their version. Availability is unchanged.');
   if(plan.stripeManaged || plan.stripeProductId) {
     try {saved=await api('/subscriptions/admin/plans/'+encodeURIComponent(plan.id)+'/publish','POST',{version:saved.version,secretKey:secret || undefined});setSettings(saved);}
     finally {setSecret('');setSettings(await api('/subscriptions/admin/settings'));}
   }
 }
 async function archive() {
   const archived=!plan.archived;
   const draft={...settings,values:{...settings.values,plans:plans.map((p:any,i:number)=>i===index?{...p,archived,enabled:false}:p)}};
   await save(!!plan.stripeManaged || !!plan.stripeProductId,draft);
   setShowArchived(archived);
 }
 const field=(key:string,p:any,update:(v:any)=>void,opts:{readOnly?:boolean;product?:boolean}={})=><label key={key}>{opts.product && key === "id" ? "Product ID" : help[key]?.[0]??key}<input readOnly={opts.readOnly} type={['amount','periodDays','credits','dailyLimit','weeklyLimit','daySeconds','weekSeconds'].includes(key)?'number':'text'} min={0} step={1} value={p[key]??''} onChange={e=>update(e.target.type==='number'?Number(e.target.value):e.target.value)} /><small>{opts.product && key==='id'?'Product identifier consumed by your API. Example: api.':opts.product && key==='name'?'Name of this metered feature. Example: API credits.':key==='id' && !opts.product ? (!plan.version ? 'Generated from the name while creating this plan. Example: Team Plus → team-plus. Duplicate names get a numeric suffix.' : 'Fixed after the first save so subscriptions and Stripe references stay valid. Renaming changes the display name and creates a new version.') : help[key]?.[1]}</small></label>;
 if(!plan) return <section>
  <div className="plan-toolbar"><h2>Plans</h2><button disabled={busy} onClick={()=>{const id=planIdFromName('New plan',plans.map((p:any)=>p.id)); setSettings({...settings,values:{...settings.values,plans:[...plans,{id,family:id,name:'New plan',amount:0,currency:'usd',periodDays:30,enabled:false,products:[{id:'api',name:'API credits',credits:1000,dailyLimit:100,weeklyLimit:500,daySeconds:86400,weekSeconds:604800}]}]}});setSelected(id);setTab('general');setSynced('');}}>New plan</button></div>
  <p>Select a plan to edit its pricing, credits, reset windows and Stripe publication.</p>
  {settings.catalogOperation && <p role="alert">Stripe synchronization pending for {settings.catalogOperation.planId}. Open that plan and resume.</p>}
  <label><input type="checkbox" checked={showArchived} onChange={e=>setShowArchived(e.target.checked)}/> Show archived plans</label>
  <table><thead><tr><th>Plan / family</th><th>Version</th><th>Price</th><th>Availability</th><th>Stripe</th></tr></thead><tbody>{plans.filter((p:any)=>showArchived || !p.archived).map((p:any)=><tr key={p.id}><td><button onClick={()=>{setSelected(p.id);setTab('general');setHistory(undefined);setSynced('');}}>{p.name}</button><small> {p.family??p.id}</small></td><td>{p.version??'0.0.1'}</td><td>{formatMoney(p.amount,p.currency)} / {p.periodDays} days</td><td>{p.archived?'Archived':p.enabled?'Enabled':'Disabled'}</td><td>{p.stripeProductId?'Published':'Not published'}</td></tr>)}</tbody></table>
 </section>;
 return <section>
  <div className="plan-toolbar"><button onClick={()=>{setSelected(undefined);setSecret('');}}>← Plans</button><h2>{plan.name} <small>v{plan.version??'0.0.1'}</small></h2></div>
  <nav className="tabs" aria-label="Plan details">{['general','pricing','limits','metadata','stripe','history'].map(t=><button className={tab===t?'active':''} key={t} onClick={()=>{setTab(t); if(t==='history') void onAction(async()=>setHistory(await api('/subscriptions/admin/plans/'+encodeURIComponent(plan.id)+'/history')));}}>{t.charAt(0).toUpperCase()+t.slice(1)}</button>)}</nav>
  {synced && <p role="status">{synced}</p>}
  <div className="subscription-plan">
   {tab==='general' && <>{['name','id','family','description'].map(k=>field(k,plan,v=>change(k,v),{readOnly:k==='id'}))}<label><input type="checkbox" disabled={plan.archived} checked={plan.enabled} onChange={e=>change('enabled',e.target.checked)}/> Enabled<small>Visible for new selections. Disabling does not cancel existing subscribers. Publish to update Stripe too.</small></label>{plan.version && <div><button disabled={busy || !!settings.catalogOperation} onClick={()=>void onAction(archive)}>{plan.archived?'Unarchive plan':'Archive plan'}</button><p>Archiving hides the plan from new selections and the default list. Existing subscriptions continue. Unarchiving keeps it disabled until you enable it.</p></div>}</>}
   {tab==='pricing' && <>{['amount','currency','periodDays'].map(k=>k==='currency'?<CurrencyPicker key={k} value={plan.currency} onChange={v=>change(k,v)}/>:field(k,plan,v=>change(k,v)))}<p>Price preview: {formatMoney(plan.amount,plan.currency)} every {plan.periodDays} days. {10 ** currencyDecimals(plan.currency)} minor units = 1 {plan.currency.toUpperCase()}. Stripe availability depends on your account. Changes create the next version on save.</p></>}
   {tab==='limits' && <><p>A product is a metered feature included in this plan. Its ID matches the product your backend consumes.</p>{plan.products.map((p:any,j:number)=><fieldset className="plan-product" key={j}><legend>{p.name}</legend>{['id','name','credits','dailyLimit','weeklyLimit','daySeconds','weekSeconds'].map(k=>field(k,p,v=>change('products',plan.products.map((x:any,n:number)=>n===j?{...x,[k]:v}:x)),{product:true}))}</fieldset>)}<button onClick={()=>change('products',[...plan.products,{id:'product-'+(plan.products.length+1),name:'New feature',credits:100,dailyLimit:10,weeklyLimit:50,daySeconds:86400,weekSeconds:604800}])}>Add metered product</button></>}
   {tab==='metadata' && <><p>Custom Stripe metadata (text values only). Example: audience = teams. Do not store secrets or personal data here. Reserved fields B_version, State and family are generated automatically.</p>{Object.entries(plan.metadata??{}).map(([key,value])=><label key={key}>{key}<input value={String(value)} onChange={e=>change('metadata',{...plan.metadata,[key]:e.target.value})}/><button onClick={()=>{const next={...plan.metadata};delete next[key];change('metadata',next);}}>Remove</button></label>)}<MetadataAdd onAdd={(key,value)=>change('metadata',{...plan.metadata,[key]:value})}/></>}
   {tab==='stripe' && <><p>Save & sync creates the new Stripe Product and recurring Price, then archives the previous version. Existing subscriptions are not migrated or canceled.</p><p>Metadata: B_version = {plan.version??'0.0.1'} · family = {plan.family??plan.id} · State = {plan.enabled?'Enabled':'Disabled'}. Stripe active is updated too.</p><p>Product: {plan.stripeProductId??'Not published'}<br/>Price: {plan.stripePriceId??'Not published'}</p><label>Stripe secret / restricted key (optional)<input type="password" autoComplete="off" value={secret} onChange={e=>setSecret(e.target.value)} placeholder="Use server STRIPE_SECRET_KEY by default"/><small>Used for this publication only; never saved in settings or browser storage. Use a test key first. The key needs Products and Prices read/write access.</small></label><p>For customer payments, configure STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_WEBHOOK_SECRET and the Stripe billing adapter on the server. Publishing alone does not switch the payment adapter ({settings.provider}). Once published, future saves also synchronize automatically; configure the server key for that, or enter the temporary key again here.</p><button disabled={busy} onClick={()=>void onAction(()=>save(true))}>{settings.catalogOperation?'Resume Stripe sync':'Save & sync Stripe'}</button></>}
   {tab==='history' && <><p>Changes automatically create a new version on save. Restore copies a previous configuration into a new version, preserving the entire history and current availability. Existing subscriptions keep their version.</p>{history && !history.items.length && <p>No previous versions yet. Edit and save the plan to create its first revision.</p>}{history?.items.map((r:any)=><p key={r.sk}>v{r.sk} · {r.data.name} · {formatMoney(r.data.amount,r.data.currency)} · {r.data.periodDays} days <button disabled={busy || !!settings.catalogOperation} onClick={()=>void onAction(()=>restore(r.sk))}>Restore as new version</button></p>)}{history?.cursor && <button onClick={()=>void onAction(async()=>setHistory(await api('/subscriptions/admin/plans/'+encodeURIComponent(plan.id)+'/history?cursor='+encodeURIComponent(history.cursor))))}>Next versions</button>}</>}
  </div>
  {tab!=='stripe' && tab!=='history' && <button disabled={busy || !!settings.catalogOperation} onClick={()=>void onAction(()=>save())}>{plan.stripeManaged || plan.stripeProductId ? "Save & sync Stripe" : "Save changes"}</button>}
 </section>;
}
function MetadataAdd({onAdd}:{onAdd:(key:string,value:string)=>void}) {
 const [key,setKey]=useState(''),[value,setValue]=useState('');
 return <div className="plan-product"><label>Metadata key<input maxLength={40} value={key} onChange={e=>setKey(e.target.value)}/></label><label>Value<input maxLength={500} value={value} onChange={e=>setValue(e.target.value)}/></label><button disabled={!key.trim()} onClick={()=>{onAdd(key.trim(),value);setKey('');setValue('');}}>Add metadata</button></div>;
}
