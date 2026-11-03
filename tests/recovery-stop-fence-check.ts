import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
const url='https://chatgpt.com/c/recovery';
async function check(mode:'normal'|'no-cache'|'no-cache-race'|'request-race'|'wrong-runtime'|'route-changed'){
 const callbacks:Record<string,Function>={},storage:Record<string,any>={};let stops=0;
 const event=(name:string)=>({addListener:(fn:Function)=>{callbacks[name]=fn;}});
 const context=createContext({URL,Date,Math,console,setTimeout,clearTimeout});
 const chrome={runtime:{id:'test',getManifest:()=>({version:'fixture'}),onMessage:event('message'),onInstalled:event('install'),onStartup:event('startup')},
 storage:{local:{get:async(keys:string|string[]|null)=>structuredClone(Object.fromEntries((keys===null?Object.keys(storage):Array.isArray(keys)?keys:[keys]).map(key=>[key,storage[key]]))),set:async(values:Record<string,unknown>)=>{
 Object.assign(storage,structuredClone(values));
 if((mode==='request-race'||mode==='no-cache-race')&&Object.values(values).some((value:any)=>value?.kind==='recovery.stop_intent'))runInContext("manualRequestReceiptsByTab.set(7,{startedAt:124,requestId:'new-request',url:'https://chatgpt.com/c/recovery'})",context);
 }}},webRequest:{onBeforeRequest:event('before'),onCompleted:event('complete'),onErrorOccurred:event('failed')},
 tabs:{get:async()=>({id:7,url:mode==='route-changed'?'https://chatgpt.com/c/other':url}),query:async()=>[],sendMessage:async()=>{},onRemoved:event('removed')},notifications:{onClicked:event('clicked')},
 scripting:{executeScript:async(options:any)=>{if(options.world==='ISOLATED')return [{result:{attemptId:'123',requestId:mode==='wrong-runtime'?'new-request':'request-a'}}];
 stops++;assert.equal(options.args[4],'/c/recovery|user-1','MAIN stop is bound to the exact latest user key');return [{result:{ok:true,stopped:true}}];}}};
 Object.assign(context,{chrome,importScripts:(name:string)=>runInContext(readFileSync('extension/'+name,'utf8'),context)});
 runInContext(readFileSync('extension/service-worker.js','utf8'),context);
 if(mode!=='no-cache'&&mode!=='no-cache-race')runInContext("manualRequestReceiptsByTab.set(7,{startedAt:123,requestId:'request-a',url:'https://chatgpt.com/c/recovery'})",context);
 const result=await new Promise<any>(resolve=>callbacks.message({type:'CHATGPT_STOP_RECOVERY',operationId:'operation-a',url,attemptId:'123',requestId:'request-a',promptKey:'/c/recovery|user-1',alertIndex:0},{frameId:0,tab:{id:7,url}},resolve));
 assert.equal(stops,mode==='normal'||mode==='no-cache'?1:0,mode);
 assert.equal(result.ok,mode==='normal'||mode==='no-cache',mode);
}
for(const mode of ['normal','no-cache','no-cache-race','request-race','wrong-runtime','route-changed'] as const)await check(mode);
console.log('Recovery Stop: exact request/prompt, changed request during journal, isolated runtime and route fences passed.');
