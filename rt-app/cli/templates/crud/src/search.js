import { HttpError } from '@gsalgadotoledo/rt-app-contracts';
// AND field filters, OR global text search. Bounded partition queries, not a full-text index.
export async function search(store, pk, query, fields, view) {
  const types = new Map([['id','string'],...fields.map(f=>[f.name,f.type])]);
  if(query.trash!==undefined&&!['true','false'].includes(query.trash))throw new HttpError(400,"Invalid trash filter");
  const tests=[data=>Boolean(data.deletedAt)===(query.trash==='true')];
  if (query.q && query.q.length>200) throw new HttpError(400,"Search query is too long");
  for(const [key,value] of Object.entries(query)) {
    if(['cursor','q','trash'].includes(key)) continue;
    const [field,op='eq',extra]=key.split('__'), type=types.get(field);
    if(!type || extra || !['eq','contains','gte','lte'].includes(op) ||
       (op==='contains' && type!=='string') || (['gte','lte'].includes(op)&&type!=='number') || value.length>1000)
      throw new HttpError(400,"Unsupported filter: "+key);
    let expected=value;
    if(type==='number') {if(!value.trim()||!Number.isFinite(Number(value))) throw new HttpError(400,"Invalid number");expected=Number(value);}
    if(type==='boolean') {if(!['true','false'].includes(value))throw new HttpError(400,"Invalid boolean");expected=value==='true';}
    tests.push(data=>{
      if(data[field]===undefined)return false;
      if(op==='contains')return data[field].toLowerCase().includes(value.toLowerCase());
      if(op==='gte')return data[field]>=expected;
      if(op==='lte')return data[field]<=expected;
      return data[field]===expected;
    });
  }
  let cursor=query.cursor;
  for(let inspected=0;inspected<10;inspected++) {
    const page=await store.list(pk,cursor);
    const items=page.items.map(view).filter(data=>tests.every(t=>t(data)) && (!query.q || [...types.keys()].some(f=>String(data[f]??'').toLowerCase().includes(query.q.toLowerCase()))));
    cursor=page.cursor;
    if(items.length||!cursor)return {items,cursor};
  }
  return {items:[],cursor};
}
