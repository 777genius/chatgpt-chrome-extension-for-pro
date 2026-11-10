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
let claim:any={operationId:'op-1',tabId:7,sourceUrl:url,phase:'consumed',retryUserId:'user-old'};
let tabUrl=url,changeDuringProbe=false;
const ctx=createContext({Number,Math,JOURNAL_META:'journal-meta',messageChatUrl:(m:any)=>m.url,latestRequestReceipt:async()=>({...receipt}),
  ChatGPTHandoffTitle:{chatUrl:(value:string)=>value},inspectCompletedTurn:()=>{},
  chrome:{storage:{local:{get:async()=>({'journal-meta':{retrySendClaims:{key:claim}}})}},tabs:{get:async()=>({url:tabUrl})},scripting:{executeScript:async()=>{if(changeDuringProbe)receipt={...receipt,requestId:'req-new'};return [{result:{...native}}]}}}});
const listener=runInContext(`(message,sender,sendResponse)=>{${source.slice(start,end)}sendResponse({ok:false})}`,ctx);
const check=(overrides:any={})=>new Promise<any>(resolve=>listener({type:'CHATGPT_RETRY_CONFIRMATION',url,operationId:'op-1',promptKey,text:'доделай е2е',...overrides},{tab:{id:7,url},frameId:0},resolve));
assert.equal((await check()).ok,true,'fresh exact native turn confirms the bound request');
native.userSentAtMs=50000;assert.equal((await check()).ok,false,'old identical message with shifted DOM key must not confirm');
native.userSentAtMs=100001;native.userId='user-old';assert.equal((await check()).ok,false,'the previously failed user remains rejected even with a nearby timestamp');native.userId='user-new';
claim.phase='reserved';assert.equal((await check()).ok,false,'the durable one-shot claim must be consumed');claim.phase='consumed';
native.userSentAtMs=100001;native.userText='different';assert.equal((await check()).ok,false,'different message is not the retry');
native.userText='доделай е2е';assert.equal((await check({operationId:'old-op'})).ok,false,'different operation is not accepted');
native.userId='';assert.equal((await check()).ok,false,'native identity is required');native.userId='user-new';
tabUrl='https://chatgpt.com/c/another';assert.equal((await check()).ok,false,'route change cancels proof');tabUrl=url;
changeDuringProbe=true;assert.equal((await check()).ok,false,'a later request cannot confirm the earlier send');
console.log('Retry confirmation: old repeated text, missing identity, changed request and changed route fail closed.');
