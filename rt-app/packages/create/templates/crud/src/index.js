import { randomUUID } from 'node:crypto';
import { HttpError, Conflict, auditCreate, auditUpdate, auditDelete, auditRestore } from '@gsalgadotoledo/rt-app-contracts';
import schema from './schema.json' with {type:'json'};
import { search } from './search.js';
import { actions } from './actions.js';
import { migrations } from './migrations.js';
import { seeds } from './seeds.js';

// This source belongs to your application. Extend validation, hooks and endpoints here.
export default function feature(store) {
  const pk = 'CRUD#' + schema.name;
  const view = row => ({...row.data, version: row.version});
  async function get(id, trash = false) {
    const row = await store.get(pk, id);
    if (!row || Boolean(row.data.deletedAt)!==trash) throw new HttpError(404, "Record not found");
    return row;
  }
  function validate(body, partial = false) {
    const data = {};
    const allowed = new Set([...schema.fields.map(f => f.name), ...(partial ? ['version'] : [])]);
    for (const name of Object.keys(body)) if (!allowed.has(name)) throw new HttpError(400, "Unsupported field: " + name);
    for (const field of schema.fields) {
      const value = body[field.name];
      if (value === undefined) {
        if (!partial && field.required) throw new HttpError(400, "Required field: " + field.name);
        continue;
      }
      if (typeof value !== field.type || (field.type === 'number' && !Number.isFinite(value)) ||
          (field.type === 'string' && (value.length > 1000 || (field.required && !value.trim()))))
        throw new HttpError(400, "Invalid field: " + field.name);
      data[field.name] = field.type === 'string' ? value.trim() : value;
    }
    return data;
  }
  const endpoint = (method, suffix, action, handle) => ({method, path:'/' + schema.name + suffix,
    resource:schema.name + '.' + action, access:'permission', explicitGrant:true, handle});
  return {
    id:schema.name,
    migrations,
    seeds,
    admin:{id:schema.name, title:schema.title, group:'application', resource:schema.name+'.list',
      path:'/'+schema.name, component:schema.name, fields:['id',...schema.fields.map(f=>f.name),'version'],
      actions:['list','read','create','edit','delete','restore',...schema.actions]},
    endpoints:[
      endpoint('GET','','list',c=>search(store,pk,c.request.query,schema.fields,view)),
      endpoint('GET','/:id','read',async c=>view(await get(c.params.id,c.request.query.trash==="true"))),
      endpoint('POST','','create',async c=>{
        const values=validate(c.request.body); const id=randomUUID(), now=new Date().toISOString();
        const row={pk,sk:id,version:1,data:{...values,id,...auditCreate(c.actor.id)}};
        await store.transact([{row,expected:null}]); return view(row);
      }),
      endpoint('PATCH','/:id','edit',async c=>{
        const values=validate(c.request.body,true), row=await get(c.params.id);
        if (c.request.body.version !== row.version) throw new Conflict();
        const next={...row,version:row.version+1,data:{...row.data,...values,...auditUpdate(c.actor.id)}};
        await store.transact([{row:next,expected:row.version}]); return view(next);
      }),
      endpoint('DELETE','/:id','delete',async c=>{
        const row=await get(c.params.id);
        if(c.request.body.version !== row.version) throw new Conflict();
        const next={...row,version:row.version+1,data:{...row.data,...auditDelete(c.actor.id)}};
        await store.transact([{row:next,expected:row.version}]); return {ok:true};
      }),
      endpoint('POST','/:id/restore','restore',async c=>{
        const row=await get(c.params.id,true);
        if(c.request.body.version!==row.version)throw new Conflict();
        const next={...row,version:row.version+1,data:{...row.data,...auditRestore(c.actor.id)}};
        await store.transact([{row:next,expected:row.version}]);return view(next);
      }),
      ...schema.actions.map(action=>endpoint('POST','/:id/actions/'+action,action,async c=>{
        const row=await get(c.params.id);
        if(c.request.body.version !== row.version) throw new Conflict();
        return actions[action]({store,row,context:c});
      })),
    ],
  };
}
