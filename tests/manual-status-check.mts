import assert from 'node:assert/strict';
import {setImmediate as flush} from 'node:timers/promises';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
import {parseHTML} from 'linkedom';
interface Message {type:string;[key:string]:unknown}
interface IntentEvent {isTrusted:boolean;target:Element;key?:string;shiftKey?:boolean;isComposing?:boolean}
const {document,window}=parseHTML('<html><head></head><body><main></main><form><div id="prompt-textarea" contenteditable="true">Private draft</div><button data-testid="send-button">Send</button></form></body></html>');
Object.defineProperty(window.HTMLElement.prototype,'getClientRects',{value:()=>[{}],configurable:true});
const callbacks=new Map<string,Array<(event:IntentEvent)=>void>>();
const original=document.addEventListener.bind(document);
document.addEventListener=((type:string,fn:(event:IntentEvent)=>void,...options:unknown[])=>{
 const list=callbacks.get(type)||[];list.push(fn);callbacks.set(type,list);
 // Capture real handlers without modifying production code or synthesizing trusted DOM events.
}) as typeof document.addEventListener;
const durable:Record<string,any>={};
let now=1000000;let revision=1;const sent:Message[]=[],listeners:Array<(message:Message)=>void>=[];
const location={href:'https://chatgpt.com/c/example',pathname:'/c/example'};
const world=createContext({document,window,location,URL,AbortController,crypto:globalThis.crypto,
 Node:window.Node,Element:window.Element,MutationObserver:window.MutationObserver,performance,
 Date:class extends Date{static now(){return now;}},
 setInterval:()=>1,clearInterval:()=>{},setTimeout:()=>1,clearTimeout:()=>{},
 chrome:{storage:{local:{get:async(keys:string|string[])=>structuredClone(Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(key=>[key,durable[key]]))),set:async(value:Record<string,unknown>)=>Object.assign(durable,structuredClone(value))}},runtime:{id:'test',getManifest:()=>({version:'fixture'}),onMessage:{addListener:(fn:(m:Message)=>void)=>listeners.push(fn),removeListener:()=>{}},
 sendMessage:async(message:Message)=>{sent.push(message);if(message.type==='CHATGPT_LOG_EVENT')return runInContext('appendJournal('+JSON.stringify(message.event)+',{id:7,url:'+JSON.stringify(location.href)+'})',world);if(message.type==='CHATGPT_STATUS_GET')return {ok:true,url:location.href,revision,status:{kind:'success'}};if(message.type==='CHATGPT_MANUAL_SEND'){await runInContext('appendJournal('+JSON.stringify({kind:'retry.preparation_superseded',sourceUrl:location.href,startedAt:message.startedAt})+',{id:7,url:'+JSON.stringify(location.href)+'})',world);return {ok:true,url:message.url,revision:++revision,status:{kind:'loading',eventAt:message.startedAt,receipt:world.__chatgptNotifierRequestReceipt}};}return {ok:true,record:null,state:null};}}}});
runInContext(readFileSync('extension/journal-store.js','utf8'),world);
for(const event of [{kind:'draft.saved',draft:'Private draft'},{kind:'draft.replaced'},{kind:'error.detected',action:'retry',promptKey:'/c/example|user',attemptId:'old'},{kind:'retry.blocked',reason:'Unknown previous send'}])await runInContext('appendJournal('+JSON.stringify({...event,sourceUrl:location.href,operationId:'draft-op'})+',{id:7,url:'+JSON.stringify(location.href)+'})',world);
for(const file of ['memory-maintenance.js','handoff-title.js','status-indicator.js','content-script.js'])runInContext(readFileSync(`extension/${file}`,'utf8'),world);
const editor=document.querySelector('#prompt-textarea')!,button=document.querySelector('button')!;
const fire=(type:string,event:IntentEvent)=>{for(const fn of callbacks.get(type)||[])fn(event);};
let requestSequence=0;
const start=(at=++now,deliver=true)=>{const requestId=`manual-request-${++requestSequence}`;world.__chatgptNotifierAttemptId=String(at);world.__chatgptNotifierRequestStartedAt=at;world.__chatgptNotifierRequestId=requestId;world.__chatgptNotifierRequestReceipt={epoch:'manual',order:requestSequence};const message={type:'CHATGPT_CONVERSATION_REQUEST_STARTED',startedAt:at,requestId};if(deliver)for(const fn of listeners)fn(message);return message;};
const resets=()=>sent.filter(m=>m.type==='CHATGPT_MANUAL_SEND');
await flush();
assert.ok(document.querySelector('[data-chatgpt-notifier-status]'),'completed response starts with a green indicator');
fire('keydown',{isTrusted:true,key:'Enter',target:editor as unknown as Element});
assert.equal(resets().length,0,'Enter newline alone must preserve indicator');
await flush();
assert.equal(durable['chatgpt-journal:meta'].retryDraftByChat[location.href].phase,'saved','Enter without a request must not supersede the saved owner draft');
assert.equal(durable['chatgpt-journal:meta'].retryByChat.example.blocked,true,'newline must not reset the durable retry budget or unknown-outcome block');
start();await flush();assert.equal(resets().length,1,'actual manual request acknowledges indicator');assert.equal(await runInContext('readRetryState('+JSON.stringify(location.href)+')',world),null,'actual manual request resets older durable retries through the public state API');assert.equal(durable['chatgpt-journal:meta'].retryDraftByChat[location.href].phase,'superseded');
assert.match(decodeURIComponent(document.querySelector('[data-chatgpt-notifier-status]')!.getAttribute('href')!),/#2563eb/,'manual send replaces green with a waiting loader');
start();assert.equal(resets().length,1,'one intent acknowledges only one request');
fire('click',{isTrusted:false,target:button as unknown as Element});start();assert.equal(resets().length,1,'automatic clicks cannot reset indicator');
button.setAttribute('disabled','');fire('click',{isTrusted:true,target:button as unknown as Element});start();assert.equal(resets().length,1,'disabled send button cannot arm acknowledgement');button.removeAttribute('disabled');
fire('keydown',{isTrusted:true,key:'Enter',shiftKey:true,target:editor as unknown as Element});start();assert.equal(resets().length,1,'shift enter does not acknowledge');
fire('click',{isTrusted:true,target:button as unknown as Element});now+=10001;start();assert.equal(resets().length,1,'expired manual intent cannot acknowledge a later request');
fire('click',{isTrusted:true,target:button as unknown as Element});location.href='https://chatgpt.com/c/other';location.pathname='/c/other';start();assert.equal(resets().length,1,'intent belongs to exact chat');
for(const fn of listeners)fn({type:'CHATGPT_HANDOFF_ROUTE_CHANGED'});await flush();
fire('click',{isTrusted:true,target:button as unknown as Element});start();assert.equal(resets().length,2);
assert.equal(resets()[1].url,location.href);assert.equal(resets()[1].startedAt,now,'reset carries the exact request timestamp for the worker fence');assert.equal(editor.textContent,'Private draft','indicator logic never writes or sends draft');
await flush();
for(const fn of listeners)fn({type:'CHATGPT_STATUS_CHANGED',url:location.href,revision:++revision,status:{kind:'success'}});
assert.ok(document.querySelector('[data-chatgpt-notifier-status]'));
fire('click',{isTrusted:true,target:button as unknown as Element});
const actualStart=now+100;now+=30000;start(actualStart);
assert.equal(resets().length,3,'a timely real send must reset even when confirmation arrives after 30 seconds');
assert.equal(resets()[2].startedAt,actualStart);
await flush();
assert.match(decodeURIComponent(document.querySelector('[data-chatgpt-notifier-status]')!.getAttribute('href')!),/#2563eb/,'delayed confirmation also replaces green with the waiting loader');
fire('click',{isTrusted:false,target:button as unknown as Element});start(now+1);
assert.equal(resets().length,3,'late delivery does not weaken the trusted-manual guard');
fire('click',{isTrusted:true,target:button as unknown as Element});
const delayed=start(++now,false);start(now,false);
for(const fn of listeners)fn(delayed);
assert.equal(resets().length,4,'an overlapping newer POST does not discard the older trusted manual ACK');
assert.equal(resets()[3].requestId,delayed.requestId,'delayed ACK carries its captured request ID rather than the current global ID');
await flush();
for(const fn of listeners)fn({type:'CHATGPT_STATUS_CHANGED',url:location.href,revision:++revision,status:{kind:'loading',eventAt:now,receipt:world.__chatgptNotifierRequestReceipt}});
const stop=document.createElement('button');stop.setAttribute('data-testid','stop-button');document.body.append(stop);
fire('click',{isTrusted:false,target:stop as unknown as Element});
assert.equal(sent.filter(m=>m.type==='CHATGPT_GENERATION_STOPPED').length,0,'an automatic recovery stop must not cancel the loading indicator');
fire('click',{isTrusted:true,target:stop as unknown as Element});
assert.equal(sent.filter(m=>m.type==='CHATGPT_GENERATION_STOPPED').length,1,'manual stop requests cancellation of this exact loading request');
assert.equal(sent.find(m=>m.type==='CHATGPT_GENERATION_STOPPED')!.requestId,world.__chatgptNotifierRequestId,'STOP captures the exact current request ID');
assert.equal(editor.textContent,'Private draft');
(world.__chatgptNotifierDispose as ()=>void)();document.addEventListener=original;
console.log('Manual status reset: trusted send plus actual request, synthetic/disabled/newline/stale/route guards passed.');
