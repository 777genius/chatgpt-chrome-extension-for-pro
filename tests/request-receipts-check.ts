import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
import {setImmediate as flush} from 'node:timers/promises';
const url='https://chatgpt.com/c/requests';
const storage:Record<string,any>={'chatgpt-status:migration':{schema:1}};
const tab={id:7,url,active:false,windowId:1};
let notices=0;
function boot(){
 const callbacks:Record<string,Function>={},signals:any[]=[];
 const event=(name:string)=>({addListener:(fn:Function)=>callbacks[name]=fn});
 const chrome={storage:{local:{get:async(keys:string|string[]|null)=>structuredClone(Object.fromEntries((keys===null?Object.keys(storage):Array.isArray(keys)?keys:[keys]).map(k=>[k,storage[k]]))),set:async(value:Record<string,unknown>)=>Object.assign(storage,structuredClone(value))}},
  runtime:{id:'test',getManifest:()=>({version:'test'}),getURL:(p:string)=>p,getContexts:async()=>[{}],sendMessage:async()=>{},onMessage:event('message'),onInstalled:event('installed'),onStartup:event('startup')},
  tabs:{get:async()=>({...tab}),query:async()=>[],sendMessage:async(_id:number,message:any)=>{signals.push(message);},onRemoved:event('removed')},windows:{get:async()=>({focused:false})},
  scripting:{executeScript:async()=>[{result:{ok:true}}]},webRequest:{onBeforeRequest:event('before'),onCompleted:event('complete'),onErrorOccurred:event('error')},
  notifications:{getAll:async()=>({}),create:async(id:string)=>{notices++;return id;},clear:async()=>true,onClicked:event('clicked')}};
 const context=createContext({chrome,console,URL,setTimeout,clearTimeout});
 Object.assign(context,{importScripts:(name:string)=>runInContext(readFileSync('extension/'+name,'utf8'),context)});
 runInContext(readFileSync('extension/service-worker.js','utf8'),context);
 const request=(type:string,extra:Record<string,unknown>={})=>new Promise<any>(resolve=>{const result=callbacks.message({type,url,...extra},{frameId:0,tab:{...tab}},resolve);if(result!==true)resolve(undefined);});
 const start=(requestId:string,startedAt=500)=>callbacks.before({tabId:7,requestId,method:'POST',timeStamp:startedAt,documentUrl:url,url:'https://chatgpt.com/backend-api/f/conversation'});
 return {context,callbacks,signals,request,start};
}
let h=boot();h.start('older');h.start('newer');await flush();await flush();
assert.equal((await h.request('CHATGPT_STATUS_GET')).status.kind,'loading');
const secondReceipt=storage['chatgpt-status:'+url].status.receipt;
const oldStop=await h.request('CHATGPT_GENERATION_STOPPED',{startedAt:500,requestId:'older'});
assert.equal(oldStop.status.kind,'loading','an old STOP cannot clear an equal-timestamp newer request');
assert.deepEqual(oldStop.status.receipt,secondReceipt);
assert.equal(storage['chatgpt-completion-checkpoint:7'].state,'active','old stop cannot finish the newer checkpoint');
assert.equal((await h.request('CHATGPT_MANUAL_SEND',{startedAt:500,requestId:'older'})).ok,true,'overlapping manual ACK resolves its own retained receipt');
assert.equal((await h.request('CHATGPT_MANUAL_SEND',{startedAt:500,requestId:'older'})).ok,false,'each request ACK is consumed once');
h=boot();
assert.equal((await h.request('CHATGPT_MANUAL_SEND',{startedAt:500,requestId:'newer'})).ok,true,'unconsumed exact ACK survives worker restart');
assert.equal((await h.request('CHATGPT_MANUAL_SEND',{startedAt:500,requestId:'older'})).ok,false,'consumed ACK stays consumed across restart');
assert.equal((await h.request('CHATGPT_MANUAL_SEND',{startedAt:500})).ok,false,'timestamp alone cannot acknowledge an identified request');
const complete=(requestId:string)=>h.request('CHATGPT_RESPONSE_COMPLETE',{requestId,attemptId:'500',completionStartedAt:500,completionKey:requestId,response:'Synthetic finished answer'});
await complete('older');await flush();
assert.equal(notices,0,'old completion cannot hijack the latest loader after worker restart');
h.callbacks.complete({tabId:7,requestId:'older',method:'POST',statusCode:200,url:'https://chatgpt.com/backend-api/f/conversation'});await flush();await flush();
assert.equal(storage['chatgpt-completion-checkpoint:7'].httpCompleted,false,'old transport completion does not complete the latest checkpoint');
assert.ok(h.signals.some(signal=>signal.type==='CHATGPT_CONVERSATION_REQUEST_COMPLETED'&&signal.requestId==='older'),'older transport signals retain exact request identity');
await complete('newer');await flush();
assert.equal(notices,1,'latest request still completes after older signals');
assert.equal(storage['chatgpt-status:'+url].status.kind,'success');
h.start('stoppable',600);await flush();await flush();h=boot();
assert.equal((await h.request('CHATGPT_GENERATION_STOPPED',{startedAt:600,requestId:'stoppable'})).status,null,'exact STOP survives worker restart');
await runInContext("withChatStatus('https://chatgpt.com/c/requests',record=>{record.status={kind:'deferred',eventAt:700,receipt:statusReceipt()};record.revision++;return {write:true};})",h.context);
assert.equal((await h.request('CHATGPT_GENERATION_STOPPED',{startedAt:700})).status.kind,'deferred','unbound cancelled send cannot consume a waiting scheduled card');
h.start('epoch-a',800);await flush();await flush();h=boot();
h.start('epoch-b',801);await flush();await flush();h=boot();
assert.equal((await h.request('CHATGPT_MANUAL_SEND',{startedAt:800,requestId:'epoch-a'})).status.eventAt,801,'an ACK from a different prior worker epoch cannot replace a newer loader');
assert.equal((await h.request('CHATGPT_MANUAL_SEND',{startedAt:801,requestId:'epoch-b'})).ok,true,'the exact latest receipt still acknowledges after another restart');
for(let i=0;i<140;i++)await runInContext(`rememberRequestReceipt(9,{startedAt:${i},requestId:'bounded-${i}',receipt:{epoch:'test',order:${i+1}},url:'${url}'})`,h.context);
assert.equal(storage['chatgpt-request-receipts'].length,128,'ephemeral receipt cache has a fixed global bound');
assert.ok(Object.keys(storage).some(key=>key.startsWith('chatgpt-journal:')),'cache maintenance preserves the durable journal');
console.log('Request receipts: equal timestamps, overlapping ACKs, worker restart, exact STOP, stale completion and bounded cache passed.');
