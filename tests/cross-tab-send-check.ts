import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext,type Context} from 'node:vm';
import {parseHTML} from 'linkedom';

type Value=Record<string,any>;
const workerSource=readFileSync('extension/service-worker.js','utf8');
const handoffSource=workerSource.slice(workerSource.indexOf('const handoffWrites ='),workerSource.indexOf('chrome.runtime.onMessage.addListener'));
const listenerSource=workerSource.slice(workerSource.indexOf('chrome.runtime.onMessage.addListener'),workerSource.indexOf('chrome.tabs.onRemoved.addListener'));
const pageSource=readFileSync('extension/page-probe.js','utf8');
const sourceUrl='https://chatgpt.com/c/shared-source';
const storage:Value={};
const pages=new Map<number,{context:Context;editor:HTMLElement;url:string}>();
const clicks:number[]=[];
let listener:(message:Value,sender:Value,respond:(result:Value)=>void)=>unknown;
let worker!:Context;
let failWrite=false;

function addPage(tabId:number,url=sourceUrl) {
  const {document,window}=parseHTML('<html><body><form data-composer-body><div id="prompt-textarea" contenteditable="true">доделай е2е</div><button type="submit">Send</button></form></body></html>');
  Object.defineProperty(window.HTMLElement.prototype,'getClientRects',{value:()=>[{width:240,height:32}],configurable:true});
  const editor=document.querySelector<HTMLElement>('#prompt-textarea')!;
  const controller={view:{dom:editor},getPlainText:()=>editor.textContent,getChatGptPrompt:()=>({prompt:editor.textContent}),submitReady:true,pendingSubmit:null};
  (document.querySelector('form') as unknown as Value).__reactFiber$test={memoizedProps:{composerController:controller}};
  document.querySelector('button')!.addEventListener('click',()=>{clicks.push(tabId);editor.textContent='';});
  pages.set(tabId,{context:createContext({document,location:{href:url}}),editor,url});
}

function boot() {
  const chrome={runtime:{getManifest:()=>({version:'fixture'}),onMessage:{addListener:(fn:typeof listener)=>{listener=fn;}}},
    storage:{local:{
      get:async(keys:string|string[]|null)=>structuredClone(keys===null?storage:Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(key=>[key,storage[key]]))),
      set:async(value:Value)=>{if(failWrite)throw Error('Synthetic disk failure');Object.assign(storage,structuredClone(value));}
    }},tabs:{get:async(tabId:number)=>({id:tabId,url:pages.get(tabId)!.url})},
    scripting:{executeScript:async({target,func,args}:{target:{tabId:number};func:Function;args:unknown[]})=>{
      const page=pages.get(target.tabId)!;
      page.context.args=args;
      return [{result:runInContext(`(${func.toString()})(...args)`,page.context)}];
    }}};
  worker=createContext({chrome,console:{error(){}},URL,setTimeout,clearTimeout,
    messageChatUrl:(message:Value)=>message.url,
    statusReceipt:()=>({epoch:'fixture',order:1}),
    visitChatNotifications:async()=>({}),broadcastChatStatus:async()=>{}});
  for(const code of [readFileSync('extension/journal-store.js','utf8'),readFileSync('extension/request-receipts.js','utf8'),readFileSync('extension/handoff-title.js','utf8'),readFileSync('extension/goal-policy.js','utf8'),readFileSync('extension/goal-store.js','utf8'),'const goalController=ChatGPTGoalStore.create({storage:chrome.storage.local,tabs:chrome.tabs,appendJournal});',pageSource,handoffSource,listenerSource])runInContext(code,worker);
}

async function append(tabId:number,kind:string,operationId:string,extra:Value={}) {
  worker.event={kind,operationId,sourceUrl:pages.get(tabId)!.url,...extra};
  worker.tab={id:tabId,url:pages.get(tabId)!.url};
  return runInContext('appendJournal(event,tab)',worker) as Promise<Value>;
}
function message(tabId:number,value:Value) {
  return new Promise<Value>(resolve=>listener(value,{tab:{id:tabId,url:pages.get(tabId)!.url},frameId:0},resolve));
}
function send(tabId:number,operationId:string,extra:Value={}) {
  return message(tabId,{type:'CHATGPT_COMPOSER_CONTROL',options:{action:'send',url:pages.get(tabId)!.url,text:'доделай е2е',operationId,...extra}});
}
const intent=(tabId:number,id:string,promptKey='/c/shared-source|user-turn-0')=>append(tabId,'retry.send_intent',id,{promptKey});
const plan=(tabId:number,id:string,promptKey='/c/shared-source|user-turn-0')=>message(tabId,{type:'CHATGPT_LOG_EVENT',event:{kind:'retry.planned',operationId:id,sourceUrl:pages.get(tabId)!.url,promptKey}});

addPage(7);addPage(8,sourceUrl+'/?model=fixture');boot();
const plans=await Promise.all([plan(7,'retry-a'),plan(8,'retry-b')]);
assert.equal(plans.filter(result=>result.ok).length,1,'two tabs observing the same failed native turn reserve only one preparation');
assert.equal(plans.find(result=>!result.ok)!.duplicate,true,'losing tab stops quietly before any backup, STOP, or editor effect');
const winner=plans[0]!.ok?7:8,loser=winner===7?8:7;
const winnerId=winner===7?'retry-a':'retry-b';
await append(winner,'draft.saved',winnerId,{draft:'Exact owner draft'});
const beforeDuplicate=structuredClone(storage['chatgpt-journal:meta'].retryDraftByChat);
assert.equal((await plan(loser,'different-prompt-while-preparing','/c/shared-source|user-turn-2')).duplicate,true,'a different prompt cannot replace another active preparation backup');
assert.deepEqual(storage['chatgpt-journal:meta'].retryDraftByChat,beforeDuplicate);
await intent(winner,winnerId);
assert.equal((await send(winner,winnerId,{expectedEffort:'max'})).ok,false,'retry cannot inject a handoff effort constraint');
assert.equal((await send(winner,winnerId,{expectedModel:'gpt-6-pro'})).ok,false,'retry cannot inject a handoff model constraint');
const results=await Promise.all([send(winner,winnerId),send(loser,'retry-loser')]);
assert.equal(results.filter(result=>result.clicked).length,1,'only the reserved preparation reaches an actual click');
assert.equal(clicks.length,1);
assert.equal((await send(winner,winnerId)).ok,false,'existing one-operation/one-click guard remains active');
assert.equal((await plan(loser,'different-prompt-after-authorizing','/c/shared-source|user-turn-2')).duplicate,true,'draft preparation remains owned until exact restoration/finish');
await append(winner,'retry.failed',winnerId,{clicked:true,confirmed:false});
await append(winner,'retry.finished',winnerId,{clicked:true,confirmed:false});
boot();
assert.equal((await plan(loser,'retry-after-reload')).duplicate,true,'unknown outcome and worker reload cannot reopen the failed turn in another tab');
assert.equal((await plan(loser,'different-prompt-unknown','/c/shared-source|user-turn-2')).duplicate,true,'unknown send with an unrestored backup remains protected');
assert.equal(clicks.length,1);

await append(winner,'retry.confirmed',winnerId);
worker.draftRecord=await runInContext(`readRetryDraft('${sourceUrl}')`,worker);
worker.restoreTab={id:loser,url:pages.get(loser)!.url};
const restoration=await runInContext(`claimRetryDraft('${sourceUrl}',draftRecord.operationId,draftRecord.savedSequence,restoreTab)`,worker) as Value;
assert.equal(restoration.record.draft,'Exact owner draft','another tab can recover only the winning operation exact draft after a reload');
assert.equal(restoration.claimed,true);
await intent(loser,'retry-next-turn','/c/shared-source|user-turn-2');
assert.equal((await send(loser,'retry-next-turn')).clicked,true,'a distinct later user turn can authorize its own retry');
await append(loser,'retry.confirmed','retry-next-turn',{newPromptKey:'/c/shared-source|user-turn-3'});
await append(loser,'retry.finished','retry-next-turn',{clicked:true,confirmed:true});
assert.equal(clicks.length,2);
addPage(9,'https://chatgpt.com/c/other-source');
await intent(9,'retry-other-chat');
assert.equal((await send(9,'retry-other-chat')).clicked,true,'equal DOM turn keys in another chat do not share a claim');

addPage(10,'https://chatgpt.com/c/legacy-unbound-fixture');
if(process.env.CHATGPT_TEST_COMPILED_DISTRIBUTION==='1') {
  await assert.rejects(append(10,'retry.send_intent','legacy-unbound'),
    /Исходный пользовательский запрос автоповтора не подтверждён/,
    'migrated runtime rejects an unbound intent before reserving the chat');
} else {
  await append(10,'retry.send_intent','legacy-unbound');
}
assert.equal((await send(10,'legacy-unbound')).ok,false,'unbound intent cannot authorize an automatic click');
await append(10,'retry.failed','legacy-unbound',{clicked:false,confirmed:false});
addPage(16,'https://chatgpt.com/c/wrong-source-fixture');
await intent(16,'wrong-source','/c/wrong-source-fixture|user-turn-4');
pages.get(16)!.url='https://chatgpt.com/c/switched-chat';
assert.equal((await send(16,'wrong-source')).ok,false,'caller cannot move a persisted retry authorization to a different chat');

addPage(11,'https://chatgpt.com/c/write-fixture');
await intent(11,'retry-write-failure');failWrite=true;
assert.equal((await send(11,'retry-write-failure')).ok,false);
failWrite=false;
assert.equal((await send(11,'retry-write-failure')).clicked,true,'failed atomic claim write grants no click and consumes no durable authorization');

addPage(12,'https://chatgpt.com/c/no-click-fixture');
await intent(12,'retry-no-click');pages.get(12)!.editor.textContent='Owner changed draft';
const refused=await send(12,'retry-no-click');
assert.equal(refused.ok,false);assert.equal(Boolean(refused.unknown),false);
pages.get(12)!.editor.textContent='доделай е2е';
assert.equal((await send(12,'retry-no-click')).ok,false,'positive no-click proof does not rearm the consumed operation');
await append(12,'retry.failed','retry-no-click',{clicked:false,confirmed:false});
await append(12,'retry.finished','retry-no-click',{clicked:false,confirmed:false});
await assert.rejects(intent(12,'retry-no-click'),/уже запускался/,'duplicate delivery of a consumed intent cannot rearm its old operation');
boot();await intent(12,'retry-after-no-click');
assert.equal((await send(12,'retry-after-no-click')).clicked,true,'a proven pre-click refusal releases only the failed-turn claim for a later authorized attempt');

addPage(13,'https://chatgpt.com/c/manual-fixture');
await plan(13,'crashed-preparation');await append(13,'draft.saved','crashed-preparation',{draft:'Crash backup'});
boot();await append(13,'retry.manual_reset','manual-keydown');
assert.equal((await message(13,{type:'CHATGPT_LOG_EVENT',event:{kind:'retry.manual_reset',sourceUrl:pages.get(13)!.url}})).ok,false,'a page event cannot reset state without a real manual request');
assert.equal((await message(13,{type:'CHATGPT_LOG_EVENT',event:{kind:'retry.preparation_superseded',sourceUrl:pages.get(13)!.url}})).ok,false);
assert.equal((await plan(13,'after-enter','/c/manual-fixture|new-turn')).duplicate,true,'raw Enter/reset without a request cannot supersede an old preparation');
const manual={type:'CHATGPT_MANUAL_SEND',url:pages.get(13)!.url,requestId:'manual-request',startedAt:100};
assert.equal((await message(13,manual)).ok,false,'unconfirmed manual message cannot release the preparation');
worker.receipt={requestId:'manual-request',startedAt:100,url:pages.get(13)!.url,receipt:{epoch:'fixture',order:2}};
await runInContext('rememberRequestReceipt(13,receipt)',worker);
assert.equal((await message(13,manual)).ok,true,'only the consumed real request receipt supersedes the old preparation');
assert.equal((await plan(13,'after-real-send','/c/manual-fixture|new-turn')).ok,true);

const handoff=(tabId:number,id:string,source=sourceUrl)=>message(tabId,{type:'CHATGPT_HANDOFF_BEGIN',record:{reasoningEffort:'max',reasoningModel:'gpt-6-thinking',id,sourceUrl:source,sourceTitle:'Fixture task',text:'Full synthetic handoff history',prompt:'Synthetic handoff payload'}});
const begun=await Promise.all([handoff(7,'handoff-a'),handoff(8,'handoff-b',sourceUrl+'/')]);
assert.equal(begun.filter(result=>result.ok).length,1,'parallel BEGIN in two tabs claims one canonical source chat');
const handoffRecords=[storage['chatgpt-handoff:7'],storage['chatgpt-handoff:8']].filter(Boolean);
assert.equal(handoffRecords.length,1);
assert.equal(handoffRecords[0].text,'Full synthetic handoff history');
boot();
assert.equal((await handoff(9,'handoff-after-reload')).ok,false,'source claim survives worker reload and another tab');
assert.equal((await handoff(9,'handoff-next-source','https://chatgpt.com/c/next-source')).ok,true,'a different source can still hand off');
const handoffEvents=Object.entries(storage).filter(([key,value])=>key.startsWith('chatgpt-journal:event:')&&value.kind==='handoff.navigating').map(([,value])=>value);
assert.equal(handoffEvents.length,2,'rejected duplicates do not replace or remove the durable accepted histories');
assert.ok(handoffEvents.every(event=>event.text==='Full synthetic handoff history'));
const importedSequence=++storage['chatgpt-journal:meta'].sequence;
storage[`chatgpt-journal:event:${String(importedSequence).padStart(12,'0')}`]={kind:'handoff.imported',operationId:'pre-journal-handoff',sourceUrl:'https://chatgpt.com/c/imported-source',sequence:importedSequence,tabId:14,recordedAt:1,text:'Original imported history'};
const immutableEvents=structuredClone(Object.fromEntries(Object.entries(storage).filter(([key])=>key.startsWith('chatgpt-journal:event:'))));
delete storage['chatgpt-journal:meta'].handoffSourceClaimSchema;
delete storage['chatgpt-journal:meta'].handoffSourceClaims;
boot();
assert.equal((await handoff(10,'legacy-handoff-other-tab')).ok,false,'upgrade replays the old immutable navigating event before a new tab can repeat that source');
assert.equal(storage['chatgpt-journal:meta'].handoffSourceClaimSchema,1,'a refused legacy duplicate still saves the one-time replay checkpoint');
assert.equal((await handoff(10,'legacy-imported-other-tab','https://chatgpt.com/c/imported-source')).ok,false,'pre-journal handoff imported into immutable history also retains its source claim');
assert.deepEqual(Object.fromEntries(Object.entries(storage).filter(([key])=>key.startsWith('chatgpt-journal:event:'))),immutableEvents,'legacy source migration never rewrites or deletes history');
const legacyUrl='https://chatgpt.com/c/legacy-retry';
function legacyRetry(kind:string,operationId:string,promptKey:string,extra:Value={}) {
  const sequence=++storage['chatgpt-journal:meta'].sequence;
  storage[`chatgpt-journal:event:${String(sequence).padStart(12,'0')}`]={kind,operationId,promptKey,sourceUrl:legacyUrl,tabId:14,sequence,recordedAt:sequence,...extra};
}
for(const kind of ['retry.planned','retry.send_intent','send.authorized'])legacyRetry(kind,'legacy-unknown','/c/legacy-retry|old-turn');
legacyRetry('retry.failed','legacy-unknown','/c/legacy-retry|old-turn',{clicked:true,confirmed:false});
for(const kind of ['retry.planned','retry.send_intent','send.authorized'])legacyRetry(kind,'legacy-no-click','/c/legacy-retry|refused-turn');
legacyRetry('retry.failed','legacy-no-click','/c/legacy-retry|refused-turn',{clicked:false,confirmed:false});
const legacyEvents=structuredClone(Object.fromEntries(Object.entries(storage).filter(([key])=>key.startsWith('chatgpt-journal:event:'))));
delete storage['chatgpt-journal:meta'].retrySendClaimSchema;
storage['chatgpt-journal:meta'].active[14]={operationId:'legacy-unknown',kind:'retry.send_intent',consumed:true,at:1};
addPage(15,legacyUrl);boot();
assert.equal((await plan(15,'new-operation-old-failure','/c/legacy-retry|old-turn')).duplicate,true,'upgrade blocks a new tab/new operation for a historically authorized unknown send');
assert.equal(storage['chatgpt-journal:meta'].retrySendClaimSchema,1);
assert.deepEqual(Object.fromEntries(Object.entries(storage).filter(([key])=>key.startsWith('chatgpt-journal:event:'))),legacyEvents,'retry claim migration never changes immutable events');
assert.equal((await plan(15,'new-distinct-failure','/c/legacy-retry|new-turn')).ok,true,'historical consumed claim does not lock a distinct failed user turn');
await append(15,'retry.finished','new-distinct-failure',{clicked:false,confirmed:false});
assert.equal((await plan(15,'new-after-proven-refusal','/c/legacy-retry|refused-turn')).ok,true,'historical explicit no-click proof releases only that failed-turn claim');
await append(15,'retry.finished','new-after-proven-refusal',{clicked:false,confirmed:false});
assert.equal((await plan(15,'legacy-no-click','/c/legacy-retry|refused-turn')).duplicate,true,'historical no-click proof never rearms its consumed operation ID');
for(const key of Object.keys(storage))delete storage[key];
const initializedSource='https://chatgpt.com/c/initialized-legacy';
storage['chatgpt-handoff:16']={id:'pre-journal-a',sourceUrl:initializedSource,text:'Legacy recovery copy A',stage:'sent'};
storage['chatgpt-handoff:17']={id:'pre-journal-b',sourceUrl:initializedSource,text:'Legacy recovery copy B',stage:'failed'};
const originalCopies=structuredClone(storage);
addPage(18,initializedSource);boot();
await runInContext("initializeJournal('legacy-import-fixture')",worker);
assert.equal((await handoff(18,'repeat-after-initialization',initializedSource)).ok,false,'first journal initialization imports and claims a legacy source before a new tab can repeat it');
const initializedImports=Object.entries(storage).filter(([key,value])=>key.startsWith('chatgpt-journal:event:')&&value.kind==='handoff.imported').map(([,value])=>value);
assert.equal(initializedImports.length,2,'multiple old recovery copies of the same source all remain imported');
assert.deepEqual(initializedImports.map(event=>event.text).sort(),['Legacy recovery copy A','Legacy recovery copy B']);
for(const [key,value] of Object.entries(originalCopies))assert.deepEqual(storage[key],value,'initialization never replaces an original saved recovery copy');
console.log('PASS: cross-tab one-click retry/handoff claims, canonical URLs, durable unknown/reload refusal, later turn/source allowance, exact histories and atomic write failure');

assert.equal((await message(9,{type:'CHATGPT_HANDOFF_BEGIN',record:{id:'invalid-effort',sourceUrl:'https://chatgpt.com/c/invalid-effort',text:'History',reasoningEffort:''}})).ok,false,'new handoff must persist an explicit syntactically valid source mode');
