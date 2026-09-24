import React, {useEffect, useState} from 'react';
import type {PanelProps} from '@gsalgadotoledo/rt-app-admin-ui';
import schema from '../src/schema.json';
// Your module's master/detail UI. Edit this file without touching the core admin.
export default function Panel({api,user}:PanelProps) {
  const [trash,setTrash]=useState(false),[tab,setTab]=useState('edit');
  const [items,setItems]=useState<any[]>([]),[selected,setSelected]=useState<any>(),[creating,setCreating]=useState(false);
  const [filters,setFilters]=useState<Record<string,string>>({}),[applied,setApplied]=useState<Record<string,string>>({});
  const [next,setNext]=useState<string>(),[history,setHistory]=useState<(string|undefined)[]>([undefined]);
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const path='/'+schema.name;
  const allowed=(action:string)=>user.id==='rt-app-root'||(user.grants??[]).includes(schema.name+'.'+action);
  async function load(cursor?:string,query=applied,inTrash=trash) {
    setBusy(true);setError('');
    try {const q=new URLSearchParams(Object.entries(query).filter(([,v])=>v!==''));if(cursor)q.set('cursor',cursor);if(inTrash)q.set('trash','true');
      const page=await api(path+'?'+q);setItems(page.items);setNext(page.cursor);
    } catch(e:any){setError(e.message);}finally{setBusy(false);}
  }
  useEffect(()=>{void load();},[]);
  async function open(item:any){setBusy(true);setError('');try{setSelected(await api(path+'/'+encodeURIComponent(item.id)+(trash?'?trash=true':'')));setCreating(false);setTab("edit");}catch(e:any){setError(e.message);}finally{setBusy(false);}}
  async function save(e:React.FormEvent<HTMLFormElement>){
    e.preventDefault();const form=new FormData(e.currentTarget),data:Record<string,unknown>={};
    for(const field of schema.fields){const value=form.get(field.name);if(!field.required&&value==='')continue;
      data[field.name]=field.type==='boolean'?value==='true':field.type==='number'?Number(value):value;}
    setBusy(true);setError('');
    try{const saved=await api(creating?path:path+'/'+encodeURIComponent(selected.id),creating?'POST':'PATCH',{...data,...(!creating?{version:selected.version}:{})});setSelected(saved);setCreating(false);setHistory([undefined]);await load();}
    catch(e:any){setError(e.message);}finally{setBusy(false);}
  }
  async function remove(){if(!confirm("Move this record to trash?"))return;setBusy(true);setError('');try{await api(path+'/'+encodeURIComponent(selected.id),'DELETE',{version:selected.version});setSelected(undefined);setHistory([undefined]);await load();}catch(e:any){setError(e.message);}finally{setBusy(false);}}
  async function restore(){setBusy(true);try{await api(path+'/'+encodeURIComponent(selected.id)+'/restore','POST',{version:selected.version});setSelected(undefined);setHistory([undefined]);await load();}catch(e:any){setError(e.message);}finally{setBusy(false);}}
  async function action(name:string){setBusy(true);setError('');try{await api(path+'/'+encodeURIComponent(selected.id)+'/actions/'+name,'POST',{version:selected.version});setSelected(await api(path+'/'+encodeURIComponent(selected.id)));await load(history.at(-1));}catch(e:any){setError(e.message);}finally{setBusy(false);}}
  return <section>
    <div className="section-head"><h1>{schema.title}</h1>{!trash&&allowed('create')&&<button disabled={busy} onClick={()=>{setTab("edit");setCreating(true);setSelected(undefined);setError('');}}>Create record</button>}</div>
    <button className="trash-link" disabled={busy} onClick={()=>{const next=!trash;setTrash(next);setSelected(undefined);setCreating(false);setHistory([undefined]);void load(undefined,applied,next);}}>{trash?"← Active records":"Trash"}</button>
    {error&&<p role="alert">{error}</p>}
    <form className="filters" onSubmit={e=>{e.preventDefault();setApplied(filters);setHistory([undefined]);void load(undefined,filters);}}>
      <label>Search<input value={filters.q??''} onChange={e=>setFilters({...filters,q:e.target.value})}/></label>
      <details><summary>Advanced filters</summary><div className="filters">
        {schema.fields.map(field=><label key={field.name}>{field.name}{field.type==='boolean'?<select value={filters[field.name]??''} onChange={e=>setFilters({...filters,[field.name]:e.target.value})}><option value="">All</option><option value="true">Yes</option><option value="false">No</option></select>:field.type==='number'?<><input aria-label={field.name+" minimum"} type="number" step="any" placeholder="Minimum" value={filters[field.name+'__gte']??''} onChange={e=>setFilters({...filters,[field.name+'__gte']:e.target.value})}/><input aria-label={field.name+" maximum"} type="number" step="any" placeholder="Maximum" value={filters[field.name+'__lte']??''} onChange={e=>setFilters({...filters,[field.name+'__lte']:e.target.value})}/></>:<input placeholder="Contains" value={filters[field.name+'__contains']??''} onChange={e=>setFilters({...filters,[field.name+'__contains']:e.target.value})}/>}</label>)}
      </div></details><button disabled={busy}>Search</button><button type="button" disabled={busy} onClick={()=>{setFilters({});setApplied({});setHistory([undefined]);void load(undefined,{});}}>Clear</button>
    </form>
    <p className="hint">Combined filters · {items.length} results on this page. Empty pages may have more data to load.</p>
    <div className="crud-master-detail">
      <div><div className="table-wrap"><table><thead><tr><th>ID</th>{schema.fields.map(f=><th key={f.name}>{f.name}</th>)}<th>Actions</th></tr></thead><tbody>{items.map(item=><tr key={item.id}><td>{allowed('read')?<button className="record-link" disabled={busy} onClick={()=>void open(item)}>{item.id}</button>:item.id}</td>{schema.fields.map(f=><td key={f.name}>{allowed('read')&&['name','title'].includes(f.name)?<button className="record-link" disabled={busy} onClick={()=>void open(item)}>{String(item[f.name]??'—')}</button>:String(item[f.name]??'—')}</td>)}<td>{allowed('read')&&<button disabled={busy} onClick={()=>void open(item)}>Open</button>}</td></tr>)}</tbody></table>{!items.length&&<p className="empty">No results on this page.</p>}</div>
      <div className="pagination"><button disabled={busy||history.length<2} onClick={()=>{const h=history.slice(0,-1);setHistory(h);void load(h.at(-1));}}>Previous</button><button disabled={busy||!next} onClick={()=>{setHistory([...history,next]);void load(next);}}>Next</button></div></div>
      <aside className="crud-detail">{selected||creating?<>
        <h2>{creating?"New record":"Details"}</h2>{selected&&<p className="hint">{selected.id} · version {selected.version}</p>}
        {selected&&<nav className="tabs"><button onClick={()=>setTab('edit')}>Edit record</button><button onClick={()=>setTab('audit')}>Audit</button>{!trash&&schema.actions.length>0&&<button onClick={()=>setTab('actions')}>Actions</button>}</nav>}
        {tab==='audit'&&<dl>{['createdAt','createdBy','updatedAt','updatedBy','deletedAt','deletedBy','restoredAt','restoredBy'].map(key=><div key={key}><dt>{key}</dt><dd>{selected?.[key]??'—'}</dd></div>)}</dl>}
        {tab==='edit'&&<form key={creating?'new':selected.id+':'+selected.version} onSubmit={save}>
          {schema.fields.map(field=><label key={field.name}>{field.name}{field.type==='boolean'?<select name={field.name} required={field.required} disabled={busy||trash||(!creating&&!allowed('edit'))} defaultValue={selected?.[field.name]===undefined?'':String(selected[field.name])}>{!field.required&&<option value="">No value</option>}{field.required&&<option value="" disabled>Select</option>}<option value="true">Yes</option><option value="false">No</option></select>:<input name={field.name} required={field.required} maxLength={1000} type={field.type==='number'?'number':'text'} step="any" disabled={busy||trash||(!creating&&!allowed('edit'))} defaultValue={selected?.[field.name]??''}/>}</label>)}
          {!trash&&(creating?allowed('create'):allowed('edit'))&&<button disabled={busy}>Save</button>}
        </form>}
        {selected&&<div className="login-links">{tab==='edit'&&!trash&&allowed('delete')&&<button disabled={busy} onClick={()=>void remove()}>Move to trash</button>}{trash&&allowed('restore')&&<button disabled={busy} onClick={()=>void restore()}>Restore</button>}{tab==='actions'&&!trash&&schema.actions.filter(allowed).map(name=><button disabled={busy} key={name} onClick={()=>void action(name)}>{name}</button>)}</div>}
      </>:<p className="muted">Open a record to view its details.</p>}</aside>
    </div>
  </section>;
}
