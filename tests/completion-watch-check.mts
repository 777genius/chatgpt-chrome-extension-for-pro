import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
import {parseHTML} from 'linkedom';
const {document,window}=parseHTML('<html><head></head><body><main><article data-testid="conversation-turn-0" data-turn="user">old</article><article data-testid="conversation-turn-1" data-turn="assistant">old answer</article></main><form><div id="prompt-textarea" contenteditable="true">draft</div><button data-testid="send-button">send</button></form></body></html>');
Object.defineProperty(window.HTMLElement.prototype,'getClientRects',{value(){return [{width:240,height:32}];}});
let now=1000000,listener:Function=()=>{},nativeComplete=false,nativeEmpty=false;
let retryGate:Promise<any>|null=null;const retryEvents:any[]=[];
const messages:any[]=[];
const context=createContext({document,window,Node:window.Node,Element:window.Element,HTMLTextAreaElement:window.HTMLTextAreaElement,
 URL,AbortController,crypto:globalThis.crypto,Event:window.Event,MutationObserver:window.MutationObserver,
 location:{origin:'https://chatgpt.com',href:'https://chatgpt.com/c/exact',pathname:'/c/exact'},
 Date:class extends Date{static now(){return now;}},performance:{now:()=>now},setTimeout,clearTimeout,
 setInterval:(fn:Function)=>setInterval(()=>{now+=500;fn();},10),clearInterval,
 chrome:{runtime:{id:'test',onMessage:{addListener:(fn:Function)=>{listener=fn;},removeListener(){}},sendMessage:async(message:any)=>{
 if(message.type==='CHATGPT_RETRY_STATE')return retryGate||{ok:true,state:null};
 if(message.type==='CHATGPT_COMPLETION_PROBE'&&nativeEmpty)return {ok:true,promptKey:'/c/exact|conversation-turn-2',userId:'new-user',isLatest:true,isReadOnly:false,generating:false,hasError:false,turnStatus:'complete',terminalEmptyResponse:true,nativeConversationInactive:true};
 if(message.type==='CHATGPT_COMPLETION_PROBE'){if(nativeComplete)assert.equal(message.boundPromptKey,'/c/exact|conversation-turn-2','the surviving content watcher supplies its already-bound user key');return {ok:true,url:'https://chatgpt.com/c/exact',promptKey:'/c/exact|conversation-turn-2',assistantKey:'conversation-turn-3',isLatest:true,isReadOnly:false,generating:!!document.querySelector('[data-testid=stop-button]'),hasError:false,turnStatus:nativeComplete?'complete':'in_progress',assistantCompleted:nativeComplete,assistantPhase:'final_answer'};}
 if(message.type==='CHATGPT_LOG_EVENT'){retryEvents.push(message.event);return {ok:true};}
 if(message.type==='CHATGPT_RESPONSE_COMPLETE')messages.push(message);
 return {ok:true};
 }}}});
for(const file of ['memory-maintenance.js','handoff-title.js','completion-state.js','content-script.js'])runInContext(readFileSync('extension/'+file,'utf8'),context);
const event=new window.Event('click',{bubbles:true});Object.defineProperty(event,'isTrusted',{value:true});
document.querySelector('[data-testid=send-button]')!.dispatchEvent(event);
runInContext(`globalThis.__chatgptNotifierAttemptId='1000000';globalThis.__chatgptNotifierRequestStartedAt=1000000`,context);
listener({type:'CHATGPT_CONVERSATION_REQUEST_STARTED',startedAt:1000000});
await new Promise(r=>setTimeout(r,70));
assert.equal(messages.length,0,'old complete response cannot complete the new request before its user turn mounts');
document.querySelector('main')!.insertAdjacentHTML('beforeend','<article data-testid="conversation-turn-2" data-turn="user">new</article><article data-testid="conversation-turn-3" data-turn="assistant">final</article>');
await new Promise(r=>setTimeout(r,70));
assert.equal(messages.length,0,'absence of Stop and stable text cannot override native in_progress');
nativeComplete=true;
// Deliberately no REQUEST_COMPLETED: the observed regression has failed/open SSE.
listener({type:'CHATGPT_CONVERSATION_REQUEST_FAILED',startedAt:1000000});
await new Promise(r=>setTimeout(r,70));
assert.equal(messages.length,1,'native final completion ends loading even without HTTP completed');
assert.equal(messages[0].response,'final');assert.equal(messages[0].completionStartedAt,1000000);
runInContext('globalThis.__chatgptNotifierDispose?.()',context);
messages.length=0;nativeComplete=false;
const stop=document.createElement('button');stop.setAttribute('data-testid','stop-button');document.body.append(stop);
runInContext(readFileSync('extension/content-script.js','utf8'),context);
await new Promise(r=>setTimeout(r,50));
now+=11*60*1000;
await new Promise(r=>setTimeout(r,40));
assert.equal(messages.length,0,'recovered native in-progress request must survive more than the old ten-minute cap');
stop.remove();nativeComplete=true;
await new Promise(r=>setTimeout(r,70));
assert.equal(messages.length,1,'upgrade recovers an ongoing request from native progress and completes it later');
runInContext('globalThis.__chatgptNotifierDispose?.()',context);
console.log('completion watcher: current prompt, native final and failed transport passed');

// A terminal empty answer cannot race ahead of a slow durable retry restore.
let releaseRetry:(value:any)=>void=()=>{};
retryGate=new Promise(resolve=>{releaseRetry=resolve;});nativeComplete=false;nativeEmpty=true;retryEvents.length=0;
document.querySelector('main')!.innerHTML='<article data-testid="conversation-turn-0" data-turn="user">old</article><article data-testid="conversation-turn-1" data-turn="assistant">old answer</article>';
now=2000000;runInContext(readFileSync('extension/content-script.js','utf8'),context);
document.querySelector('#prompt-textarea')!.textContent='new request';
document.querySelector('[data-testid=send-button]')!.dispatchEvent(event);
document.querySelector('#prompt-textarea')!.textContent='';
runInContext("globalThis.__chatgptNotifierAttemptId='2000000';globalThis.__chatgptNotifierRequestStartedAt=2000000;globalThis.__chatgptNotifierRequestId='new-request'",context);
listener({type:'CHATGPT_CONVERSATION_REQUEST_STARTED',startedAt:2000000,requestId:'new-request'});
document.querySelector('main')!.insertAdjacentHTML('beforeend','<article data-testid="conversation-turn-2" data-turn="user">new request</article>');
await new Promise(r=>setTimeout(r,100));
assert.equal(retryEvents.some(e=>e.kind==='retry.planned'),false,'no preparation may bypass a pending durable policy read');
releaseRetry({ok:true,state:{blocked:true,reason:'Fixture retry budget stopped',failures:[]}});
await new Promise(r=>setTimeout(r,150));
assert.equal(retryEvents.some(e=>e.kind==='retry.planned'),false,'restored sticky stop still forbids a retry');
assert.ok(retryEvents.some(e=>e.kind==='retry.blocked'),'the native failure is handled with the restored policy');
assert.ok(retryEvents.some(e=>e.kind==='error.detected'&&e.action==='retry'),'native failures count in the same durable error budget');
runInContext('globalThis.__chatgptNotifierDispose?.()',context);
console.log('Terminal empty failure: delayed durable budget restore cannot be bypassed.');
