import {randomUUID,createHash} from 'node:crypto';
import {HttpError,type Feature} from '@gsalgadotoledo/rt-app-contracts';
import type {NoSQL} from '@gsalgadotoledo/rt-app-nosql';
export type LogLevel='debug'|'info'|'warn'|'error';
export type EventKind='log'|'request'|'pageview'|'timing';
export interface ViewOptions {url:string;apiUrl?:string;source?:'spa'|'ssr'}
export interface RequestMetric {method:string;url:string;durationMs:number;status:number}
export function safePath(value:string):string {
 const url=new URL(value,'http://observer.local');
 if(!['http:','https:'].includes(url.protocol))throw new TypeError('Observer expects an HTTP URL or path');
 return url.pathname.slice(0,160);
}
export interface ObserverEvent {id:string;at:string;level:LogLevel;kind:EventKind;source:string;message:string;data:Record<string,unknown>}
export interface ObserverOutputHandler {id:string;write(event:Readonly<ObserverEvent>,signal?:AbortSignal):Promise<void>|void}
export interface ObserverOutput {handler:ObserverOutputHandler;enabled?:boolean;levels?:LogLevel[];kinds?:EventKind[];sources?:string[];maxPerMinute?:number}
const secretKey=/password|secret|token|authorization|cookie|credential|email|phone|body|headers|ip|code/i;
export function sanitize(value:unknown,depth=0):unknown {
 if(depth>4)return '[truncated]';
 if(value instanceof Error)return {name:value.name};
 if(typeof value==='string')return value.slice(0,1000).replace(/Bearer\s+\S+/gi,'Bearer [redacted]').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[email]').replace(/((?:password|token|secret|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi,'$1[redacted]');
 if(value===null||typeof value==='number'||typeof value==='boolean')return value;
 if(Array.isArray(value))return value.slice(0,20).map(x=>sanitize(x,depth+1));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).slice(0,30).map(([k,v])=>[k,secretKey.test(k)?'[redacted]':sanitize(v,depth+1)]));
 return String(value);
}
export class Observer {
 readonly outputs:ObserverOutput[];
 readonly console={log:(...values:unknown[])=>this.log(...values),info:(...values:unknown[])=>this.info(...values),debug:(...values:unknown[])=>this.debug(...values),warn:(...values:unknown[])=>this.warn(...values),error:(...values:unknown[])=>this.error(...values)};
 private budgets=new Map<string,{minute:number;count:number}>();
 private inFlight=0;
 readonly health={failed:0,dropped:0};
 constructor(outputs:ObserverOutput[]=[],private timeoutMs=1500){
  if(new Set(outputs.map(o=>o.handler.id)).size!==outputs.length)throw new Error('Duplicate observer output id');
  this.outputs=outputs;
 }
 async emit(level:LogLevel,kind:EventKind,source:string,message:string,data:Record<string,unknown>={}) {
  if(this.inFlight>=32){this.health.dropped++;return;}
  this.inFlight++;
  const event:ObserverEvent={id:randomUUID(),at:new Date().toISOString(),level,kind,source:source.slice(0,80),message:String(sanitize(message)),data:sanitize(data) as Record<string,unknown>};
  try {await Promise.all(this.outputs.map(async output=>{
   if(output.enabled===false||output.levels&&!output.levels.includes(level)||output.kinds&&!output.kinds.includes(kind)||output.sources&&!output.sources.includes(source))return;
   const minute=Math.floor(Date.now()/60000),budget=this.budgets.get(output.handler.id);
   const next=budget?.minute===minute?budget:{minute,count:0};this.budgets.set(output.handler.id,next);
   if(next.count++ >= (output.maxPerMinute??600)){this.health.dropped++;return;}
   const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
   try {await Promise.race([Promise.resolve().then(()=>output.handler.write(structuredClone(event),controller.signal)),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('Observer timeout'));},this.timeoutMs);})]);}
   catch {this.health.failed++;}finally{clearTimeout(timer);}
  }));}finally{this.inFlight--;}
 }
 private writeLog(level:LogLevel,values:unknown[]){
  const [first,...rest]=values;
  return this.emit(level,'log','app',typeof first==='string'?first:'Application log',{values:typeof first==='string'?rest:values});
 }
 log(...values:unknown[]){return this.writeLog('info',values);}
 info(...values:unknown[]){return this.writeLog('info',values);}
 debug(...values:unknown[]){return this.writeLog('debug',values);}
 warn(...values:unknown[]){return this.writeLog('warn',values);}
 warning(...values:unknown[]){return this.warn(...values);}
 error(...values:unknown[]){return this.writeLog('error',values);}
 countView(message:string,{url,apiUrl,source='spa'}:ViewOptions){
  return this.emit('info','pageview',source,message,{path:safePath(url),...(apiUrl?{endpointPath:safePath(apiUrl)}:{})});
 }
 recordRequest({method,url,durationMs,status}:RequestMetric){
  if(!Number.isFinite(durationMs)||durationMs<0||!Number.isInteger(status)||status<100||status>599)throw new TypeError('Invalid request metric');
  return this.emit(status>=500?'error':status>=400?'warn':'info','request','api','HTTP request',{method:method.toUpperCase(),path:safePath(url),status,durationMs});
 }
 /** Measures the operation only, preserving its return value or original exception. */
 async measure<T>(name:string,operation:()=>T|Promise<T>,options:{source?:string}={}):Promise<T>{
  const start=performance.now();let failed=false;
  try{return await operation();}catch(error){failed=true;throw error;}
  finally{await this.emit(failed?'error':'info','timing',options.source??'app',name,{name,durationMs:performance.now()-start,failed});}
 }

}
/** Daily partitions + seven-day TTL; bounded reads explicitly report partial results. */
export class ObserverStore implements ObserverOutputHandler {
 readonly id='store';
 constructor(private store:NoSQL){}
 async write(event:ObserverEvent){await this.store.transact([{row:{pk:'OBSERVER#'+event.at.slice(0,10),sk:event.at+'#'+event.id,version:1,ttl:Math.floor(Date.parse(event.at)/1000)+7*86400,data:event},expected:null}]);}
 async report(day:string){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(Date.parse(day+'T00:00:00Z'))||day!==new Date(day).toISOString().slice(0,10))throw new HttpError(400,'Invalid day');
  const events:ObserverEvent[]=[];let cursor:string|undefined;
  for(let i=0;i<20;i++){const page=await this.store.list('OBSERVER#'+day,cursor);events.push(...page.items.filter(r=>!r.ttl||r.ttl>Date.now()/1000).map(r=>r.data as ObserverEvent));cursor=page.cursor;if(!cursor)break;}
  const counts={requests:0,errors:0,spa:0,ssr:0},hours=Array.from({length:24},(_,hour)=>({hour,requests:0,views:0})),pages=new Map<string,{source:string;path:string;views:number}>();
  const requestMetrics=new Map<string,any>(),operationMetrics=new Map<string,any>();
  function aggregate(map:Map<string,any>,key:string,label:string,ms:unknown,failed:boolean,source:string){
   if(typeof ms!=='number'||!Number.isFinite(ms)||ms<0)return;
   const metric=map.get(key)??{name:label,source,count:0,totalMs:0,minMs:ms,maxMs:ms,errors:0};
   metric.count++;metric.totalMs+=ms;metric.minMs=Math.min(metric.minMs,ms);metric.maxMs=Math.max(metric.maxMs,ms);if(failed)metric.errors++;map.set(key,metric);
  }
  const metrics=(map:Map<string,any>)=>[...map.values()].map(({totalMs,...m})=>({...m,averageMs:Math.round(totalMs/m.count*100)/100})).sort((a,b)=>b.count-a.count);
  let duration=0;
  for(const event of events){const hour=hours[new Date(event.at).getUTCHours()];if(event.level==='error')counts.errors++;
   if(event.kind==='request'){counts.requests++;duration+=Number(event.data.durationMs)||0;const label=String(event.data.method)+' '+String(event.data.path);aggregate(requestMetrics,label,label,event.data.durationMs,Number(event.data.status)>=500,event.source);if(hour)hour.requests++;}
   if(event.kind==='timing')aggregate(operationMetrics,event.source+':'+String(event.data.name),String(event.data.name),event.data.durationMs,event.data.failed===true,event.source);
   if(event.kind==='pageview'&&(event.source==='spa'||event.source==='ssr')){counts[event.source]++;if(hour)hour.views++;const path=String(event.data.path),key=event.source+path,p=pages.get(key)??{source:event.source,path,views:0};p.views++;pages.set(key,p);}
  }
  return {day,counts,requestMetrics:metrics(requestMetrics),operationMetrics:metrics(operationMetrics),averageMs:counts.requests?Math.round(duration/counts.requests):0,hours,pages:[...pages.values()].sort((a,b)=>b.views-a.views).slice(0,30),events:events.sort((a,b)=>b.at.localeCompare(a.at)).slice(0,100),partial:!!cursor};
 }
}
export function observerFeature(observer:Observer,storage:ObserverStore):Feature {
 const rates=new Map<string,{minute:number;count:number}>();
 return {id:'observer',migrations:[],admin:{id:'observer',title:'Observer',resource:'observer.read',path:'/observer/report',component:'observer',ownerOnly:true,fields:[],actions:[]},endpoints:[
 {method:'GET',path:'/observer/report',resource:'observer.read',access:'owner',handle:async c=>({...await storage.report(c.request.query.day??new Date().toISOString().slice(0,10)),health:{...observer.health},outputs:observer.outputs.map(o=>({id:o.handler.id,enabled:o.enabled!==false,levels:o.levels??['debug','info','warn','error'],kinds:o.kinds??['log','request','pageview','timing']}))})},
 {method:'POST',path:'/observer/events',resource:'observer.pageview',access:'guest',handle:async c=>{
  const {source,path,message}=c.request.body;
  if(message!==undefined&&(typeof message!=='string'||message.length>200))throw new HttpError(400,'Invalid page message');
  if(!['spa','ssr'].includes(source)||typeof path!=='string'||path.length>160||!/^\/[a-zA-Z0-9/_-]*$/.test(path))throw new HttpError(400,'Invalid page event');
  const minute=Math.floor(Date.now()/60000),key=createHash('sha256').update(c.request.ip??'unknown').digest('hex');
  if(rates.size>2000)for(const [k,v]of rates)if(v.minute!==minute)rates.delete(k);
  if(rates.size>=4000&&!rates.has(key))throw new HttpError(429,'Too many events');
  const entry=rates.get(key),rate=entry?.minute===minute?entry:{minute,count:0};rates.set(key,rate);if(rate.count++>=60)throw new HttpError(429,'Too many events');
  await observer.countView(message??'Page viewed',{source,url:path});return {ok:true};
 }}]};
}
