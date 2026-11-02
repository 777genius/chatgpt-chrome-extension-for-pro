import assert from 'node:assert/strict';
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
let now=1000000;const sent:Message[]=[],listeners:Array<(message:Message)=>void>=[];
const location={href:'https://chatgpt.com/c/example',pathname:'/c/example'};
const world=createContext({document,window,location,URL,AbortController,crypto:globalThis.crypto,
 Node:window.Node,Element:window.Element,MutationObserver:window.MutationObserver,performance,
 Date:class extends Date{static now(){return now;}},
 setInterval:()=>1,clearInterval:()=>{},setTimeout:()=>1,clearTimeout:()=>{},
 chrome:{runtime:{id:'test',onMessage:{addListener:(fn:(m:Message)=>void)=>listeners.push(fn),removeListener:()=>{}},
 sendMessage:async(message:Message)=>{sent.push(message);return {ok:true,record:null,state:null};}}}});
for(const file of ['memory-maintenance.js','handoff-title.js','content-script.js'])runInContext(readFileSync(`extension/${file}`,'utf8'),world);
const editor=document.querySelector('#prompt-textarea')!,button=document.querySelector('button')!;
const fire=(type:string,event:IntentEvent)=>{for(const fn of callbacks.get(type)||[])fn(event);};
const start=(at=++now)=>{world.__chatgptNotifierAttemptId=String(at);for(const fn of listeners)fn({type:'CHATGPT_CONVERSATION_REQUEST_STARTED',startedAt:at});};
const resets=()=>sent.filter(m=>m.type==='CHATGPT_MANUAL_SEND');
fire('keydown',{isTrusted:true,key:'Enter',target:editor as unknown as Element});
assert.equal(resets().length,0,'Enter newline alone must preserve indicator');
start();await Promise.resolve();assert.equal(resets().length,1,'actual manual request acknowledges indicator');
start();assert.equal(resets().length,1,'one intent acknowledges only one request');
fire('click',{isTrusted:false,target:button as unknown as Element});start();assert.equal(resets().length,1,'automatic clicks cannot reset indicator');
button.setAttribute('disabled','');fire('click',{isTrusted:true,target:button as unknown as Element});start();assert.equal(resets().length,1,'disabled send button cannot arm acknowledgement');button.removeAttribute('disabled');
fire('keydown',{isTrusted:true,key:'Enter',shiftKey:true,target:editor as unknown as Element});start();assert.equal(resets().length,1,'shift enter does not acknowledge');
fire('click',{isTrusted:true,target:button as unknown as Element});now+=10001;start();assert.equal(resets().length,1,'expired manual intent cannot acknowledge a later request');
fire('click',{isTrusted:true,target:button as unknown as Element});location.href='https://chatgpt.com/c/other';location.pathname='/c/other';start();assert.equal(resets().length,1,'intent belongs to exact chat');
fire('click',{isTrusted:true,target:button as unknown as Element});start();assert.equal(resets().length,2);
assert.equal(resets()[1].url,location.href);assert.equal(resets()[1].startedAt,now,'reset carries the exact request timestamp for the worker fence');assert.equal(editor.textContent,'Private draft','indicator logic never writes or sends draft');
(world.__chatgptNotifierDispose as ()=>void)();document.addEventListener=original;
console.log('Manual status reset: trusted send plus actual request, synthetic/disabled/newline/stale/route guards passed.');
