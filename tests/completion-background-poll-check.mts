import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
import {parseHTML} from 'linkedom';

const {document,window}=parseHTML('<html><head></head><body><main><article data-testid="conversation-turn-0" data-turn="user">old</article><article data-testid="conversation-turn-1" data-turn="assistant">old answer</article></main><form><div id="prompt-textarea" contenteditable="true">saved draft</div><button data-testid="send-button">send</button></form></body></html>');
Object.defineProperty(window.HTMLElement.prototype,'getClientRects',{value(){return [{width:240,height:32}];}});
Object.defineProperty(document,'visibilityState',{value:'hidden',writable:true,configurable:true});
let now=1000000,listener:Function=()=>{},nativeComplete=false;
const waits:Function[]=[],messages:any[]=[];
const context=createContext({document,window,Node:window.Node,Element:window.Element,HTMLTextAreaElement:window.HTMLTextAreaElement,
 URL,AbortController,crypto:globalThis.crypto,Event:window.Event,MutationObserver:window.MutationObserver,
 location:{origin:'https://chatgpt.com',href:'https://chatgpt.com/c/exact',pathname:'/c/exact'},
 Date:class extends Date{static now(){return now;}},performance:{now:()=>now},
 setTimeout:()=>1,clearTimeout:()=>{},setInterval:()=>1,clearInterval:()=>{},
 chrome:{runtime:{id:'test',onMessage:{addListener:(fn:Function)=>{listener=fn;},removeListener(){}},sendMessage:(m:any)=>{
  if(m.type==='CHATGPT_WAIT'&&m.delayMs===3000)return new Promise(resolve=>waits.push(resolve));
  if(m.type==='CHATGPT_COMPLETION_CHECKPOINT')return Promise.resolve({ok:false});
  if(m.type==='CHATGPT_RETRY_STATE')return Promise.resolve({ok:true,state:null});
  if(m.type==='CHATGPT_COMPLETION_PROBE')return Promise.resolve({ok:true,url:'https://chatgpt.com/c/exact',promptKey:'/c/exact|conversation-turn-2',assistantKey:'conversation-turn-3',userId:'user',isLatest:true,isReadOnly:false,generating:false,hasError:false,turnStatus:nativeComplete?'complete':'in_progress',assistantCompleted:nativeComplete,assistantPhase:'final_answer'});
  if(m.type==='CHATGPT_RESPONSE_COMPLETE')messages.push(m);
  return Promise.resolve({ok:true});
 }}}});
for(const file of ['memory-maintenance.js','handoff-title.js','completion-state.js','content-script.js'])runInContext(readFileSync('extension/'+file,'utf8'),context);
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const click=new window.Event('click',{bubbles:true});Object.defineProperty(click,'isTrusted',{value:true});
document.querySelector('[data-testid=send-button]')!.dispatchEvent(click);
runInContext("globalThis.__chatgptNotifierAttemptId='1000000';globalThis.__chatgptNotifierRequestStartedAt=1000000",context);
listener({type:'CHATGPT_CONVERSATION_REQUEST_STARTED',startedAt:1000000});
document.querySelector('main')!.insertAdjacentHTML('beforeend','<article data-testid="conversation-turn-2" data-turn="user">new</article><article data-testid="conversation-turn-3" data-turn="assistant">final</article>');
await flush();
assert.equal(waits.length,1,'one worker wait is armed while the page is hidden');
const stale=waits.shift()!;
Object.defineProperty(document,'visibilityState',{value:'visible',writable:true,configurable:true});
document.dispatchEvent(new window.Event('visibilitychange'));
stale({ok:true});await flush();
assert.equal(waits.length,0,'an old hidden wait cannot schedule another poll after focus');
Object.defineProperty(document,'visibilityState',{value:'hidden',writable:true,configurable:true});
document.dispatchEvent(new window.Event('visibilitychange'));await flush();
assert.equal(waits.length,1,'hiding again starts one current poll');
const tick=async()=>{const resolve=waits.shift();assert.ok(resolve);now+=3000;resolve({ok:true});await flush();};
await tick();assert.equal(messages.length,0,'an incomplete native answer cannot be delivered');
nativeComplete=true;
await tick();await tick();
assert.equal(messages.length,1,'a native final answer is observed without page timers or a focus event');
assert.equal(messages[0].response,'final');
assert.equal(document.querySelector('#prompt-textarea')!.textContent,'saved draft');
assert.equal(waits.length,0,'the poll retires immediately after completion');
runInContext('globalThis.__chatgptNotifierDispose?.()',context);
console.log('Hidden completion: worker-backed observation, native completion fence, one delivery and untouched draft passed.');
