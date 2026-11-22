import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';

const source=readFileSync('extension/service-worker.js','utf8');
const start=source.indexOf('    const prepareEvent=async()=>{',source.indexOf("message?.type === 'CHATGPT_LOG_EVENT'"));
const end=source.indexOf('    prepareEvent().catch(',start);
assert.ok(start>0&&end>start);
const url='https://chatgpt.com/c/proof',prompt='/c/proof|native:0:user';
async function verify(change:(x:any)=>void=()=>{}) {
 const x:any={event:{kind:'retry.planned',sourceUrl:url,requestId:'req',attemptId:'1000',promptKey:prompt,retryUserId:'forged',legacyRetryProof:{userId:'forged'}},
  native:{ok:true,isLatest:true,isReadOnly:false,userId:'user',promptKey:prompt},
  receipt:{requestId:'req',startedAt:1000,url,submittedUserId:'user'},
  journal:{ok:true,events:[{kind:'request.started',tabId:7,sourceUrl:url,requestId:'req',eventAt:1000,sequence:12}]},route:url};
 change(x);
 const ctx=createContext({event:x.event,sender:{tab:{id:7,url}},ChatGPTHandoffTitle:{chatUrl:(v:string)=>v},
  latestRequestReceipt:async()=>structuredClone(x.receipt),readJournal:async()=>structuredClone(x.journal),inspectCompletedTurn:()=>{},
  chrome:{scripting:{executeScript:async()=>[{result:structuredClone(x.native)}]},tabs:{get:async()=>({url:x.route})}}});
 runInContext(source.slice(start,end),ctx);
 return JSON.parse(JSON.stringify(await runInContext('prepareEvent()',ctx)));
}
const verified=await verify();
assert.equal(verified.retryUserId,'user');
assert.deepEqual(verified.legacyRetryProof,{requestId:'req',startedAt:1000,userId:'user',requestSequence:12},'an in-memory receipt without a tabId is still bound to the worker-owned tab map');
for(const change of [
 (x:any)=>x.receipt.submittedUserId='other', (x:any)=>x.receipt.requestId='other',
 (x:any)=>x.receipt.startedAt=1001, (x:any)=>x.receipt.tabId=8, (x:any)=>x.receipt.url='https://chatgpt.com/c/other',
 (x:any)=>x.native.isLatest=false, (x:any)=>x.native.isReadOnly=true,
 (x:any)=>x.native.promptKey='/c/proof|other', (x:any)=>x.route='https://chatgpt.com/c/other'
]) {
 const result=await verify(change);assert.equal(result.retryUserId,undefined);assert.equal(result.legacyRetryProof,undefined,'untrusted claims cannot substitute for native and receipt proof');
}
for(const change of [(x:any)=>x.journal.ok=false,(x:any)=>x.journal.events=[],(x:any)=>x.journal.events.push({...x.journal.events[0],sequence:13}),
 (x:any)=>x.journal.events[0].operationId='automatic']) {
 const result=await verify(change);assert.equal(result.retryUserId,'user');assert.equal(result.legacyRetryProof,undefined,'a legacy exception requires one exact manual request record');
}
console.log('Retry native proof: actual worker correlates request, current native user and a unique manual journal record; untrusted identity is stripped.');
