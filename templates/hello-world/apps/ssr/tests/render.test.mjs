import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(import.meta.url);
test('production Next.js renders API content in HTML and refreshes it per request',{timeout:30000},async()=>{
 let title='Rendered without JavaScript';
 const api=createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({title,content:'From the selected API adapter'}));});
 api.listen(0,'127.0.0.1');await once(api,'listening');
 const reservation=createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');const port=reservation.address().port;await new Promise(r=>reservation.close(r));
 const child=spawn(process.execPath,[require.resolve('next/dist/bin/next'),'start','--hostname','127.0.0.1','--port',String(port)],{env:{...process.env,RT_APP_ENVIRONMENT:'local',RT_APP_API_URL:`http://127.0.0.1:${api.address().port}`},stdio:'ignore'});
 try {
  let response;
  for(let i=0;i<100;i++){try{response=await fetch(`http://127.0.0.1:${port}`);break;}catch{await delay(100);}}
  assert.equal(response?.status,200);
  assert.match(await response.text(),/<h1>Rendered without JavaScript<\/h1>/);
  title='Updated from API';const html=await(await fetch(`http://127.0.0.1:${port}`)).text();assert.match(html,/<h1>Updated from API<\/h1>/);
 }finally{if(child.exitCode===null){const done=once(child,'exit');child.kill('SIGTERM');await done;}await new Promise(r=>api.close(r));}
});
