import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
const url='https://chatgpt.com/c/recovery',startedAt=123;
const callbacks:Record<string,Function>={};
const event=(name:string)=>({addListener:(fn:Function)=>{callbacks[name]=fn;}});
const storage:Record<string,any>={'chatgpt-status:migration':{schema:1},['chatgpt-status:'+url]:{url,revision:2,sequence:0,notifications:[],status:{kind:'loading',eventAt:startedAt,receipt:{epoch:'prior',order:1}}}};
let native={ok:true,url,promptKey:'/c/recovery|user-2',userId:'user-id',turnStatus:'complete',generating:false,isLatest:true,isReadOnly:false,hasError:false};
let replaceOnProbe=false;
const chrome={runtime:{id:'test',getManifest:()=>({version:'1.5.0'}),onMessage:event('message'),onInstalled:event('install'),onStartup:event('startup')},
 storage:{local:{get:async(key:string|string[]|null)=>Object.fromEntries((key===null?Object.keys(storage):Array.isArray(key)?key:[key]).map(k=>[k,structuredClone(storage[k])])),set:async(value:Record<string,unknown>)=>Object.assign(storage,structuredClone(value))}},
 webRequest:{onBeforeRequest:event('before'),onCompleted:event('complete'),onErrorOccurred:event('failed')},
 tabs:{get:async()=>({id:7,url}),query:async()=>[],sendMessage:async()=>{},onRemoved:event('removed')},
 scripting:{executeScript:async(options:any)=>{if(options.world==='ISOLATED')return [{result:{attempt:String(startedAt),startedAt}}];
 if(replaceOnProbe){replaceOnProbe=false;runInContext("manualRequestReceiptsByTab.set(7,{startedAt:999,url:'https://chatgpt.com/c/recovery'})",context);}
 return [{result:structuredClone(native)}];}},notifications:{onClicked:event('click')}};
const context=createContext({chrome,console,URL,setTimeout,clearTimeout});
Object.assign(context,{importScripts:(name:string)=>runInContext(readFileSync('extension/'+name,'utf8'),context)});
runInContext(readFileSync('extension/service-worker.js','utf8'),context);
const probe=()=>new Promise<any>(resolve=>callbacks.message({type:'CHATGPT_COMPLETION_PROBE',url,startedAt},{frameId:0,tab:{id:7,url}},resolve));
assert.equal((await probe()).ok,false,'already completed scheduler cannot seed a missing request map');
assert.equal(runInContext('manualRequestReceiptsByTab.size',context),0);
native={...native,turnStatus:'in_progress',generating:true};
replaceOnProbe=true;
assert.equal((await probe()).ok,false,'a new request arriving during native inspection fences recovery');
runInContext('manualRequestReceiptsByTab.clear()',context);
assert.equal((await probe()).ok,true,'durable loading plus same live attempt and native progress can restore observation');
assert.equal(runInContext('manualRequestReceiptsByTab.get(7).recoveredPromptKey',context),native.promptKey);
native={...native,promptKey:'/c/recovery|different-user',turnStatus:'complete',generating:false};
assert.equal((await probe()).ok,false,'restored observer remains bound to its exact current user');
assert.equal(storage['chatgpt-status:'+url].revision,2,'recovery observes only; it does not write terminal status');
console.log('Completion recovery: durable loading, native progress, request race and exact prompt passed.');
