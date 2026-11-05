import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync('extension/service-worker.js','utf8');
const code=source.slice(source.indexOf('async function readRestartErrorReceipt('),source.indexOf('async function reconcileGoalPromptBinding('));
const url='https://chatgpt.com/c/error-fixture',promptKey='/c/error-fixture|user';
async function fixture(extra:any={}) {
 const checkpoint={state:'active',url,promptKey,startedAt:1000000,requestId:'request',...extra.checkpoint};
 const view={revision:1,status:{kind:'loading',eventAt:1000000,receipt:{epoch:'epoch',order:1}},...extra.view};
 let reads=0,probes=0;
 const fn=new Function('completionCheckpointRead','readChatStatus','chrome','inspectCompletedTurn','ChatGPTHandoffTitle','latestRequestReceipt','inspectBoundNativeTurn',code+';return readRestartErrorReceipt;')(
  async()=>{reads++;return reads===2&&extra.checkpointChanged?{...checkpoint,promptKey:'changed'}:checkpoint;},
  async()=>reads>=2&&extra.viewChanged?{...view,revision:2}:view,
  {tabs:{get:async()=>({url:extra.url||url})},scripting:{executeScript:async()=>{probes++;return [{result:{ok:true,isLatest:true,isReadOnly:false,
   hasError:true,generating:false,turnStatus:'complete',userId:'user',promptKey,lastUserSentAtMs:999990,...extra.native}}];}}},
  ()=>{},{chatUrl:(u:string)=>u},async()=>extra.newRequest?{requestId:'new'}:null,async()=>({ok:true,isLatest:true,isReadOnly:false,hasError:true,generating:false,turnStatus:'complete',userId:'user',promptKey,lastUserSentAtMs:999990,...extra.native}));
 const result=await fn(7,url,{requestId:'request',attemptId:'1000000',...extra.message});return {result,probes};
}
assert.equal((await fixture({checkpoint:{httpCompleted:true},native:{hasError:false,terminalEmptyResponse:true,nativeConversationInactive:true}})).result.notificationOnly,true);
assert.equal((await fixture({native:{hasError:false,terminalEmptyResponse:true,nativeConversationInactive:true}})).result,null);
const valid=await fixture();assert.equal(valid.result.notificationOnly,true);assert.equal(valid.result.requestId,'request');
for(const extra of [{message:{requestId:'other'}},{message:{attemptId:'1000001'}},{checkpoint:{state:'completed'}},
 {checkpoint:{url:'https://chatgpt.com/c/other'}},{view:{status:{kind:'error',eventAt:1000000}}},
 {native:{isLatest:false}},{native:{isReadOnly:true}},{native:{hasError:false}},{native:{generating:true}},
 {native:{turnStatus:'in_progress'}},{native:{promptKey:'other'}},{native:{lastUserSentAtMs:1}},
 {checkpointChanged:true},{viewChanged:true},{newRequest:true},{url:'https://chatgpt.com/c/other'}]) {
 assert.equal((await fixture(extra)).result,null,JSON.stringify(extra));
}
assert.match(source,/if\(isError&&!completionRequest\)completionRequest=await readRestartErrorReceipt/);
console.log('Restart error notification: exact native terminal failure/checkpoint/generation proof, no retry release, race and stale-error fences passed.');
