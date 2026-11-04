import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync('extension/service-worker.js','utf8');
const body=source.slice(source.indexOf('async function inspectBoundNativeTurn('),source.indexOf('// Notification-only recovery.'));
const url='https://chatgpt.com/c/alias-fixture',promptKey='/c/alias-fixture|user';
async function fixture(extra:any={}) {
 let probes=0,cpReads=0,proof:any=null;
 const native={ok:true,nativeConversationInactive:false,nativeTurnStatus:'complete',assistantId:'',hasError:false,generating:false,
  isLatest:true,isReadOnly:false,nativeConversationId:'local-chatgpt:fixture',userId:'user',userText:'exact first message',userSentAtMs:1000000,promptKey,...extra.native};
 const binding={url,tabId:7,userId:'user',userText:'exact first message',userSentAtMs:1000000,startedAt:1000001,requestId:'request',...extra.binding};
 const cp={state:'active',url,promptKey,startedAt:1000001,requestId:'request',httpCompleted:true,...extra.checkpoint};
 const fn=new Function('chrome','inspectCompletedTurn','goalController','completionCheckpointRead','ChatGPTHandoffTitle',body+';return inspectBoundNativeTurn;')(
  {tabs:{get:async()=>({url:extra.url||url})},scripting:{executeScript:async(o:any)=>{probes++;if(probes===1)return [{result:native}];proof=o.args[4];return [{result:{...native,nativeConversationInactive:true,terminalEmptyResponse:true,userId:extra.secondUser||'user'}}];}}},
  ()=>{},{get:async()=>extra.noGoal?null:{manualStart:binding}},async()=>{cpReads++;return cpReads>1&&extra.changedCheckpoint?{...cp,promptKey:'changed'}:cp;},{chatUrl:(u:string)=>u});
 const result=await fn(7,url);return {result,probes,proof};
}
const valid=await fixture();assert.equal(valid.result.terminalEmptyResponse,true);assert.equal(valid.proof.alias,'local-chatgpt:fixture');
for(const extra of [{noGoal:true},{native:{nativeConversationId:'foreign'}},{native:{generating:true}},
 {binding:{url:'other'}},{binding:{tabId:8}},{binding:{userId:'other'}},{binding:{userText:'other'}},{binding:{userSentAtMs:999}},
 {checkpoint:{httpCompleted:false}},{checkpoint:{requestId:'other'}},{checkpoint:{promptKey:'other'}},
 {changedCheckpoint:true},{url:'other'},{secondUser:'other'}]) {
 const t=await fixture(extra);assert.notEqual(t.result.terminalEmptyResponse,true,JSON.stringify(extra));
}
console.log('Native local alias: exact accepted first user/text/time/request/checkpoint proof only; foreign/stale/active cases refused.');
