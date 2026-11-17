import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';
const source=readFileSync('extension/service-worker.js','utf8');
const start=source.indexOf("  if(message?.type==='CHATGPT_RETRY_CONFIRMATION') {");
const end=source.indexOf("  if(message?.type==='CHATGPT_COMPLETION_PROBE') {",start);
assert.ok(start>=0&&end>start);
const url='https://chatgpt.com/c/confirmation-fixture',promptKey='/c/confirmation-fixture|new-user';
let receipt:any={operationId:'op-1',requestId:'req-1',startedAt:100000,url};
let native:any={ok:true,isLatest:true,isReadOnly:false,userId:'user-new',promptKey,userSentAtMs:100001,userText:'доделай е2е'};
let claim:any={operationId:'op-1',tabId:7,sourceUrl:url,phase:'consumed',retryUserId:'user-old',at:80000};
let tabUrl=url,changeDuringProbe=false,journalChangeDuringProbe=false;
let journal:any={ok:true,meta:{sequence:1},events:[{sequence:1,kind:'request.started',tabId:7,operationId:'op-1',requestId:'req-1',eventAt:100000,sourceUrl:url}]};
const ctx=createContext({Number,Math,JOURNAL_META:'journal-meta',messageChatUrl:(m:any)=>m.url,latestRequestReceipt:async()=>({...receipt}),
  readJournal:async()=>structuredClone(journal),
  ChatGPTHandoffTitle:{chatUrl:(value:string)=>value},inspectCompletedTurn:()=>{},
  chrome:{storage:{local:{get:async()=>({'journal-meta':{sequence:journal.meta.sequence,retrySendClaims:{key:claim}}})}},tabs:{get:async()=>({url:tabUrl})},scripting:{executeScript:async()=>{if(changeDuringProbe)receipt={...receipt,requestId:'req-new'};if(journalChangeDuringProbe)journal.meta.sequence++;return [{result:{...native}}]}}}});
const listener=runInContext(`(message,sender,sendResponse)=>{${source.slice(start,end)}sendResponse({ok:false})}`,ctx);
const check=(overrides:any={})=>new Promise<any>(resolve=>listener({type:'CHATGPT_RETRY_CONFIRMATION',url,operationId:'op-1',promptKey,text:'доделай е2е',...overrides},{tab:{id:7,url},frameId:0},resolve));
assert.equal((await check()).ok,true,'fresh exact native turn confirms the bound request');
receipt.url='';assert.equal((await check()).ok,true,'empty receipt URL requires an exact durable chat and request binding');
for(const scenario of ['wrong-chat','missing','duplicate','later-request','other-tab-later','sequence-gap','storage-error']) {
 const saved=structuredClone(journal);
 if(scenario==='wrong-chat')journal.events[0].sourceUrl='https://chatgpt.com/c/other';
 if(scenario==='missing'){journal.events=[];journal.meta.sequence=0;}
 if(scenario==='duplicate'){journal.events.push({...journal.events[0],sequence:2});journal.meta.sequence=2;}
 if(scenario==='later-request'){journal.events.push({sequence:2,kind:'request.started',tabId:7,requestId:'new'});journal.meta.sequence=2;}
 if(scenario==='other-tab-later'){journal.events.push({sequence:2,kind:'request.started',tabId:8,sourceUrl:url,requestId:'new'});journal.meta.sequence=2;}
 if(scenario==='sequence-gap')journal.events[0].sequence=2;
 if(scenario==='storage-error')journal.storageError='unavailable';
 assert.equal((await check()).ok,false,scenario);journal=saved;
}
receipt.url='https://chatgpt.com/c/other';assert.equal((await check()).ok,false,'a conflicting nonempty URL is not replaced');receipt.url=url;
receipt.url='';journalChangeDuringProbe=true;assert.equal((await check()).ok,false,'a concurrent journal write requires fresh proof');journalChangeDuringProbe=false;journal.meta.sequence=1;receipt.url=url;
native.userSentAtMs=84000;assert.equal((await check()).ok,true,'a delayed network request may follow the native message by more than ten seconds');native.userSentAtMs=100001;
native.userSentAtMs=50000;assert.equal((await check()).ok,false,'old identical message with shifted DOM key must not confirm');
native.userSentAtMs=100001;native.userId='user-old';assert.equal((await check()).ok,false,'the previously failed user remains rejected even with a nearby timestamp');native.userId='user-new';
claim.phase='reserved';assert.equal((await check()).ok,false,'the durable one-shot claim must be consumed');claim.phase='consumed';
native.userSentAtMs=100001;native.userText='different';assert.equal((await check()).ok,false,'different message is not the retry');
native.userText='доделай е2е';assert.equal((await check({operationId:'old-op'})).ok,false,'different operation is not accepted');
receipt.submittedUserId='other-user';assert.equal((await check()).ok,false,'captured request user ID must agree');delete receipt.submittedUserId;
native.userId='';assert.equal((await check()).ok,false,'native identity is required');native.userId='user-new';
tabUrl='https://chatgpt.com/c/another';assert.equal((await check()).ok,false,'route change cancels proof');tabUrl=url;
changeDuringProbe=true;assert.equal((await check()).ok,false,'a later request cannot confirm the earlier send');
console.log('Retry confirmation: old repeated text, missing identity, changed request and changed route fail closed.');
