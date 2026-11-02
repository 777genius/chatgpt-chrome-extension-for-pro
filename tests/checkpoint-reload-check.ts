import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext,type Context} from 'node:vm';
import {parseHTML} from 'linkedom';
const url='https://chatgpt.com/c/reload',tabUrl=url+'/?view=test#fragment';
const storage:Record<string,any>={'chatgpt-status:migration':{schema:1}};
const {document,window}=parseHTML('<html><body><main></main><form><div id="prompt-textarea" contenteditable="true">KEEP PRIVATE DRAFT</div><button data-testid="send-button">Send</button></form></body></html>');
Object.defineProperty(window.HTMLElement.prototype,'getClientRects',{value:()=>[{}],configurable:true});
let clock=Date.now(),finished=false,worker:Context;
let content!:Context;
let restoreRace=false;
let messageHandler:Function=()=>{},beforeRequest:Function=()=>{},notifications=0;
let contentListeners=new Set<Function>();
const timers=new Set<ReturnType<typeof setInterval>>();
const tab={id:7,url:tabUrl,active:false,windowId:1};
const native=()=>({ok:true,url,promptKey:'/c/reload/|conversation-turn-1',userId:'user-id',assistantKey:finished?'conversation-turn-2':'',assistantId:finished?'assistant-id':'',isLatest:true,isReadOnly:false,hasError:false,generating:!finished,turnStatus:finished?'complete':'in_progress',assistantCompleted:finished,assistantPhase:'final_answer'});
function bootWorker(){
 const event=(name:string)=>({addListener:(fn:Function)=>{if(name==='message')messageHandler=fn;if(name==='before')beforeRequest=fn;}});
 const chrome={runtime:{id:'test',getManifest:()=>({version:'1.5.1'}),getURL:(p:string)=>'chrome-extension://test/'+p,getContexts:async()=>[{}],sendMessage:async()=>{},onMessage:event('message'),onInstalled:event('install'),onStartup:event('startup')},
 storage:{local:{get:async(keys:string|string[]|null)=>structuredClone(Object.fromEntries((keys===null?Object.keys(storage):Array.isArray(keys)?keys:[keys]).map(k=>[k,storage[k]]))),set:async(value:Record<string,unknown>)=>Object.assign(storage,structuredClone(value))}},
 webRequest:{onBeforeRequest:event('before'),onCompleted:event('completed'),onErrorOccurred:event('failed')},
 tabs:{get:async()=>{if(restoreRace){restoreRace=false;const key='chatgpt-completion-checkpoint:7';storage[key]={...storage[key],startedAt:storage[key].startedAt+1,attemptId:String(storage[key].startedAt+1)};storage['chatgpt-status:'+url].status.eventAt=storage[key].startedAt;}return {...tab};},query:async()=>[],sendMessage:async(_id:number,message:unknown)=>{for(const fn of contentListeners)fn(message,{},()=>{});},onRemoved:event('removed')},windows:{get:async()=>({focused:false})},
 scripting:{executeScript:async(options:any)=>{if(options.func?.name==='inspectCompletedTurn')return [{result:native()}];return [{result:runInContext('('+options.func.toString()+')(...'+JSON.stringify(options.args||[])+')',content)}];}},
 notifications:{getAll:async()=>({}),create:async(id:string)=>{notifications++;return id;},clear:async()=>true,onClicked:event('clicked')}};
 worker=createContext({chrome,console,URL,setTimeout,clearTimeout});Object.assign(worker,{importScripts:(p:string)=>runInContext(readFileSync('extension/'+p,'utf8'),worker)});
 runInContext(readFileSync('extension/service-worker.js','utf8'),worker);
}
function bootContent(initialAttempt?:number){
 contentListeners=new Set();
 const runtime={id:'test',onMessage:{addListener:(fn:Function)=>contentListeners.add(fn),removeListener:(fn:Function)=>contentListeners.delete(fn)},sendMessage:(message:any)=>new Promise(resolve=>{let answered=false;const result=messageHandler(message,{frameId:0,tab:{...tab}},(answer:unknown)=>{answered=true;resolve(answer);});if(result!==true&&!answered)resolve(undefined);})};
 content=createContext({document,window,location:{href:tabUrl,origin:'https://chatgpt.com',pathname:'/c/reload/'},chrome:{runtime},URL,AbortController,crypto:globalThis.crypto,Node:window.Node,Element:window.Element,HTMLTextAreaElement:window.HTMLTextAreaElement,Event:window.Event,MutationObserver:window.MutationObserver,performance:{now:()=>clock},Date:class extends Date{static now(){return clock;}},
 setTimeout,clearTimeout,setInterval:(fn:Function)=>{const id=setInterval(()=>{clock+=500;fn();},10);timers.add(id);return id;},clearInterval:(id:ReturnType<typeof setInterval>)=>{clearInterval(id);timers.delete(id);}});
 if(initialAttempt!==undefined){content.__chatgptNotifierAttemptId=String(initialAttempt);content.__chatgptNotifierRequestStartedAt=initialAttempt;}
 for(const p of ['memory-maintenance.js','handoff-title.js','completion-state.js','content-script.js'])runInContext(readFileSync('extension/'+p,'utf8'),content);
}
const pause=()=>new Promise(r=>setTimeout(r,80));
try{
 bootWorker();bootContent();await pause();
 const click=new window.Event('click',{bubbles:true});Object.defineProperty(click,'isTrusted',{value:true});document.querySelector('[data-testid=send-button]')!.dispatchEvent(click);
 document.querySelector('main')!.innerHTML='<article data-turn="user" data-testid="conversation-turn-1">USER MESSAGE</article>';
 const stop=document.createElement('button');stop.setAttribute('data-testid','stop-button');document.body.append(stop);
 const startedAt=clock+1;clock=startedAt;
 beforeRequest({tabId:7,requestId:'actual-request-1',method:'POST',timeStamp:startedAt,documentUrl:tabUrl,url:'https://chatgpt.com/backend-api/f/conversation'});
 await pause();
 const key='chatgpt-completion-checkpoint:7';
 assert.equal(storage[key].state,'active');assert.equal(storage[key].promptKey,'/c/reload/|conversation-turn-1');assert.equal(storage[key].requestId,'actual-request-1');
 assert.equal(JSON.stringify(storage[key]).includes('KEEP PRIVATE DRAFT'),false,'checkpoint never stores draft text');
 runInContext('globalThis.__chatgptNotifierDispose()',content);
 bootWorker();bootContent(startedAt-100);await pause();
 assert.equal(notifications,0,'an in-flight reload keeps observing without producing an early completion');
 assert.equal(storage[key].state,'active');
 assert.equal(content.__chatgptNotifierRequestStartedAt,startedAt,'in-flight reload restores the exact original timing start');
 runInContext('globalThis.__chatgptNotifierDispose()',content);
 finished=true;stop.remove();document.querySelector('main')!.insertAdjacentHTML('beforeend','<article data-turn="assistant" data-testid="conversation-turn-2">Finished during reload</article>');
 bootWorker();bootContent();await pause();await pause();
 assert.equal(notifications,1,'new worker and new isolated context recover a response completed during downtime');
 assert.equal(storage[key].state,'complete');assert.equal(storage['chatgpt-status:'+url].status.kind,'success');
 assert.equal(document.querySelector('#prompt-textarea')!.textContent,'KEEP PRIVATE DRAFT','restoration never sends or changes the draft');
 runInContext('globalThis.__chatgptNotifierDispose()',content);bootWorker();bootContent();await pause();
 assert.equal(notifications,1,'a second full reload cannot replay the terminal completion');
 const restore=()=>new Promise<any>(resolve=>messageHandler({type:'CHATGPT_COMPLETION_CHECKPOINT',action:'restore',url},{frameId:0,tab:{...tab}},resolve));
 storage[key]={...storage[key],state:'active'};
 assert.equal((await restore()).ok,false,'terminal UI status itself fences restoration if terminal checkpoint write was interrupted');
 storage['chatgpt-status:'+url].status={kind:'loading',eventAt:startedAt,receipt:{epoch:'fixture',order:1}};
 storage[key]={...storage[key],state:'stopped'};
 assert.equal((await restore()).ok,false,'a stopped checkpoint cannot restore even if a stale loading record survives');
 storage[key]={...storage[key],state:'active'};restoreRace=true;
 assert.equal((await restore()).ok,false,'a newer request appearing during restore fences the old binding');
 console.log('Durable checkpoint: full content/worker reload, downtime completion, timing, draft preservation and terminal dedupe passed.');
}finally{if(content)runInContext('globalThis.__chatgptNotifierDispose?.()',content);for(const id of timers)clearInterval(id);}
