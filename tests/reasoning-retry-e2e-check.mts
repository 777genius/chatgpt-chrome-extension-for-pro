import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
import {parseHTML} from 'linkedom';
import {setImmediate as nextTurn} from 'node:timers/promises';
const url='https://chatgpt.com/c/reasoning-test',promptKey='/c/reasoning-test|conversation-turn-0',draft='  Keep my draft\nexactly  ';
const {document,window}=parseHTML(`<html><body><main><article data-testid="conversation-turn-0" data-turn="user">Original request</article></main><form><div id="prompt-textarea" contenteditable="true"></div><button data-testid="send-button" type="button">Send</button></form></body></html>`);
Object.defineProperty(window.HTMLElement.prototype,'getClientRects',{value(){return [{width:100,height:30}];}});
const editor=document.querySelector('#prompt-textarea')!;editor.textContent=draft;
Object.assign(document,{createRange:()=>({selectNodeContents(){}}),execCommand:(_:string,__:boolean,text:string)=>{editor.textContent=text;return true}});
Object.assign(window,{getSelection:()=>({removeAllRanges(){},addRange(){}})});
const data:Record<string,any>={},events:any[]=[],sends:string[]=[];let now=1000000,ctx:any;
const checkpoint={state:'active',url,startedAt:now,attemptId:String(now),requestId:'original',baselineKey:'',promptKey,httpCompleted:false,requestFailedAt:now+1};
const chrome={storage:{local:{get:async(k:any)=>structuredClone(Object.fromEntries((Array.isArray(k)?k:[k]).map(x=>[x,data[x]]))),set:async(v:any)=>Object.assign(data,structuredClone(v))}},runtime:{id:'fixture',getManifest:()=>({version:'fixture'}),onMessage:{addListener(){},removeListener(){}},sendMessage:async(m:any)=>{
 if(m.type==='CHATGPT_COMPLETION_CHECKPOINT')return m.action==='restore'?{ok:true,record:checkpoint}:{ok:true};
 if(m.type==='CHATGPT_RETRY_STATE')return {ok:true,state:await runInContext('readRetryState(location.href)',ctx)};
 if(m.type==='CHATGPT_GOAL_RECOVER')return {ok:false};
 if(m.type==='CHATGPT_HANDOFF_GET')return {ok:true,record:null};
 if(m.type==='CHATGPT_RECONCILE_LEGACY_HANDOFF_STATUS')return {ok:true,changed:false};
 if(m.type==='CHATGPT_COMPLETION_PROBE')return {ok:true,reasoningFailed:true,terminalEmptyResponse:false,isLatest:true,isReadOnly:false,generating:false,hasError:false,promptKey,userId:'original-user'};
 if(m.type==='CHATGPT_WAIT'){now+=m.delayMs;await nextTurn();return {ok:true};}
 if(m.type==='CHATGPT_LOG_EVENT'){events.push(m.event);ctx.ev=m.event;return runInContext('appendJournal(ev,{id:7,url:location.href})',ctx);}
 if(m.type==='CHATGPT_RETRY_DRAFT_GET')return {ok:true,record:await runInContext('readRetryDraft(location.href)',ctx)};
 if(m.type==='CHATGPT_RETRY_DRAFT_CLAIM'){ctx.claim=m;return runInContext('claimRetryDraft(location.href,claim.operationId,claim.savedSequence,{id:7,url:location.href})',ctx);}
 if(m.type==='CHATGPT_RETRY_CONFIRMATION')return {ok:true};
 if(m.type==='CHATGPT_COMPOSER_CONTROL'){
  if(m.options.action!=='send')return {ok:true,matches:true,ready:true};
  ctx.authorization={kind:'send.authorized',operationId:m.options.operationId,sourceUrl:url};await runInContext('appendJournal(authorization,{id:7,url:location.href})',ctx);
  sends.push(editor.textContent!);editor.textContent='';document.querySelector('main')!.insertAdjacentHTML('beforeend','<article data-testid="conversation-turn-1" data-turn="user">доделай е2е</article>');
  runInContext("globalThis.__chatgptNotifierAttemptId='1000500';globalThis.__chatgptNotifierRequestStartedAt=1000500;globalThis.__chatgptNotifierRequestId='retry-request'",ctx);
  return {ok:true,clicked:true};
 }
 return {ok:true};
}}};
ctx=createContext({URL,document,window,Node:window.Node,Element:window.Element,HTMLTextAreaElement:window.HTMLTextAreaElement,MutationObserver:window.MutationObserver,Event:window.Event,AbortController,crypto:globalThis.crypto,location:{origin:'https://chatgpt.com',href:url,pathname:'/c/reasoning-test'},Date:class extends Date{static now(){return now}},performance:{now:()=>now},setTimeout,clearTimeout,setInterval:(fn:Function)=>setInterval(()=>{now+=500;fn()},10),clearInterval,chrome});
for(const file of ['memory-maintenance.js','handoff-title.js','goal-policy.js','journal-store.js','completion-state.js','content-script.js'])runInContext(readFileSync('extension/'+file,'utf8'),ctx);
try{
 const deadline=Date.now()+8000;while(!events.some(e=>e.kind==='retry.finished')&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));
 assert.ok(events.some(e=>e.kind==='error.detected'&&e.action==='retry'&&e.error==='Обдумывание не удалось'),'native reasoning failure enters retry path');
 assert.deepEqual(sends,['доделай е2е'],'one protected continuation is sent');
 assert.equal(events.filter(e=>e.kind==='retry.confirmed').length,1);assert.equal(events.filter(e=>e.kind==='draft.restored').length,1);assert.equal(editor.textContent,draft,'exact original draft is restored');
 runInContext('globalThis.__chatgptNotifierDispose?.()',ctx);runInContext(readFileSync('extension/content-script.js','utf8'),ctx);
 await new Promise(r=>setTimeout(r,150));assert.equal(sends.length,1,'content restart cannot replay the completed retry');assert.equal(editor.textContent,draft);
} finally {runInContext('globalThis.__chatgptNotifierDispose?.()',ctx)}
console.log('Reasoning failure E2E: native failure observation, one guarded retry, confirmation and exact draft restoration passed.');
